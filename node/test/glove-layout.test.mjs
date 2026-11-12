import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureGloveLayout, glovePreviewFromLayout, legacyGloveLayout040 } from '../src/glove-layout.mjs';
import { SdkController } from '../src/capture/sdk.mjs';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { ReplayReader } from '../src/replay/reader.mjs';
import { readRecords } from '../src/exports/reader.mjs';

const moduleUrl = new URL('../core/glove.js', import.meta.resolve('shroom-sdk/node')).href;
const { createGlovePressureFrame } = await import(moduleUrl);
const raw = Uint8Array.from({ length: 256 }, (_, i) => i);
const frame = (side, values = raw) => ({ ...createGlovePressureFrame(values, { side }), side,
  product: 'handGloveSegmented', protocol: 'segmented', imu: { raw: new Uint8Array(16) } });

test('both official SDK physical regions match saved raw ADC indices and fixed 0.4.0 reconstruction', () => {
  for (const side of ['left', 'right']) {
    const sdkFrame = frame(side), result = captureGloveLayout(sdkFrame, raw, side);
    assert.deepEqual(result.layout, legacyGloveLayout040(side));
    assert.deepEqual(result.extra.glove, glovePreviewFromLayout(result.layout, raw, side));
    const indices = [];
    for (const [id, finger] of Object.entries(result.extra.glove.fingers)) {
      assert.deepEqual(finger.values, Array.from(sdkFrame.fingers[id].raw));
      assert.equal(finger.pulp, sdkFrame.fingers[id].pulp.raw[0]);
      indices.push(...finger.source_indices, finger.pulp_source_index);
    }
    indices.push(...result.extra.glove.palm.source_indices);
    assert.equal(indices.length, 137); assert.equal(new Set(indices).size, 137);
    assert.deepEqual(result.extra.glove.palm.values, Array.from(sdkFrame.palm.raw));
    assert.deepEqual(result.extra.glove.palm.row_lengths, [12, 15, 15, 15, 15]);
    assert.notEqual(result.extra.glove.fingers.little.values[0], sdkFrame.pressureMatrix[0], 'legacy matrix is a different mapping');
    const next = captureGloveLayout(frame(side, Uint8Array.from(raw, value => 255 - value)), Uint8Array.from(raw, value => 255 - value), side, result.layout);
    assert.equal(next.layout, result.layout, 'unchanged static mapping is reused');
  }
});

test('glove validation rejects shape, side, source-index, value and within-connection mapping changes', () => {
  const first = captureGloveLayout(frame('left'), raw, 'left');
  for (const corrupt of [
    value => { value.side = 'right'; },
    value => { value.fingers.thumb.raw[0] ^= 1; },
    value => { value.fingers.thumb.matrix[0][0] ^= 1; },
    value => { value.fingers.thumb.sourceIndices[0] = 256; },
    value => { value.palm.rowLengths[0] = 15; },
    value => { delete value.fingers.middle; },
  ]) {
    const invalid = frame('left'); corrupt(invalid);
    assert.throws(() => captureGloveLayout(invalid, raw, 'left'), /SDK glove/);
  }
  const changed = frame('left');
  const region = changed.fingers.thumb;
  [region.sourceIndices[0], region.sourceIndices[1]] = [region.sourceIndices[1], region.sourceIndices[0]];
  [region.raw[0], region.raw[1]] = [region.raw[1], region.raw[0]];
  [region.matrix[0][0], region.matrix[0][1]] = [region.matrix[0][1], region.matrix[0][0]];
  assert.throws(() => captureGloveLayout(changed, raw, 'left', first.layout), /mapping changed/);
  const duplicate = structuredClone(first.layout); duplicate.fingers.thumb.pulp_source_index = duplicate.fingers.thumb.source_indices[0];
  assert.throws(() => glovePreviewFromLayout(duplicate, raw, 'left'), /duplicate/);
  assert.throws(() => glovePreviewFromLayout(first.layout, raw, 'right'), /hand side/);
  assert.equal(captureGloveLayout({ pressureMatrix: new Uint8Array(195) }, raw, 'left'), null);
  assert.throws(() => captureGloveLayout({ pressureMatrix: new Uint8Array(195) }, raw, 'left', first.layout), /regions/);
});

test('malformed SDK finger data rejects pressure and IMU together and clears stale preview', async t => {
  const batches = [], errors = []; let callback;
  const sdk = new SdkController({ origin: process.hrtime.bigint(), ensureLicense: async () => {}, onBatch: value => batches.push(value), onError: value => errors.push(value) });
  sdk.state.loaded = true; sdk.state.version = '0.4.0';
  sdk.module = { Shroom: { connectGlove: async options => { callback = options.onData; return { close: async () => {} }; } } };
  t.after(() => sdk.disconnect());
  await sdk.connect({ product: 'glove', path: 'SYNTHETIC_ONLY', side: 'left' });
  callback(frame('left'));
  assert.equal(batches.length, 2);
  const corrupt = frame('left'); corrupt.fingers.middle.pulp.matrix[0][0] ^= 1; callback(corrupt);
  assert.equal(errors.length, 1); assert.equal(batches.length, 2);
  assert.equal(sdk.previews[sdk.pressureId], undefined);
});

test('a malformed first glove frame cannot make the device ready to record', async t => {
  let callback; const batches = [];
  const sdk = new SdkController({ origin: process.hrtime.bigint(), ensureLicense: async () => {}, onBatch: value => batches.push(value), onError: () => {} });
  sdk.state.loaded = true; sdk.state.version = '0.4.0';
  sdk.module = { Shroom: { connectGlove: async options => { callback = options.onData; return { close: async () => {} }; } } };
  t.after(() => sdk.disconnect());
  await sdk.connect({ product: 'glove', path: 'SYNTHETIC_ONLY', side: 'left' });
  assert.equal(sdk.info().ready, false); assert.equal(sdk.descriptors()[0].connected, false);
  const corrupt = frame('left'); corrupt.palm.raw[0] ^= 1; callback(corrupt);
  assert.equal(sdk.info().ready, false); assert.equal(sdk.descriptors()[0].connected, false); assert.equal(batches.length, 0);
});

test('two-hand captured mapping persists and replay matches the official live regions without changing 256-byte recordings', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glove-regions-record-'));
  const sdkPath = path.join(directory, 'sdk'); await mkdir(path.join(sdkPath, 'node'), { recursive: true });
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node/index.js'), `import { createGlovePressureFrame } from ${JSON.stringify(moduleUrl)};
export const Shroom={version:'0.4.0',mock(){},getLicenseStatus(){return{valid:true}},async listPorts(){return[]},async connectGlove(options){
const raw=Uint8Array.from({length:256},(_,i)=>options.side==='left'?i:255-i);
const emit=()=>options.onData({...createGlovePressureFrame(raw,{side:options.side}),side:options.side,product:'handGloveSegmented',protocol:'segmented',imu:{raw:new Uint8Array(16)}});
let timer;const first=setTimeout(()=>{emit();timer=setInterval(emit,15)},150);return{state:'open',async close(){clearTimeout(first);clearInterval(timer)}};}};`);
  const dataDir = path.join(directory, 'sessions'), engine = new CaptureEngine({ dataDir, sdkPath });
  t.after(async () => { await engine.close(); assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  await engine.init();
  for (const side of ['left', 'right']) await engine.sdkConnect({ instance_id: side, product: 'glove', path: `SYNTHETIC_${side}`, side });
  const ids = ['sdk-left-pressure', 'sdk-right-pressure'];
  await assert.rejects(engine.start({ name: '首帧前禁止开始', device_ids: ids }), /Unknown device/);
  for (let attempts = 0; attempts < 100 && !ids.every(id => engine.devices().find(device => device.id === id)?.connected); attempts++) await delay(20);
  await engine.start({ name: '合成手套映射验证', device_ids: ids });
  for (let attempts = 0; attempts < 100 && !ids.every(id => engine.status().record_counts[id] >= 3); attempts++) await delay(20);
  const saved = await engine.stop();
  assert.equal(saved.status, 'complete'); assert.equal(saved.dropped_records, 0);
  const replay = await new ReplayReader({ dataDir }).frame(saved.id, saved.duration_s);
  for (const side of ['left', 'right']) {
    const id = `sdk-${side}-pressure`, stream = saved.streams.find(stream => stream.id === id);
    assert.deepEqual(stream.metadata.pressure_layout, legacyGloveLayout040(side));
    const expectedRaw = side === 'left' ? raw : Uint8Array.from(raw, value => 255 - value);
    for await (const record of readRecords(path.join(dataDir, saved.id), stream)) assert.deepEqual(record.payload, Buffer.from(expectedRaw));
    assert.equal(replay.streams[id].representation, 'sdk-glove-regions');
    assert.deepEqual(replay.streams[id].pressure.glove, engine.preview().streams[id].pressure.glove);
    assert.equal(replay.streams[id].pressure.values.length, 256);
  }
  const filename = path.join(dataDir, saved.id, 'manifest.json');
  const legacy = JSON.parse(await readFile(filename, 'utf8'));
  for (const stream of legacy.streams) delete stream.metadata.pressure_layout;
  await writeFile(filename, JSON.stringify(legacy));
  const rebuilt = await new ReplayReader({ dataDir }).frame(saved.id, saved.duration_s);
  assert.deepEqual(rebuilt.streams[ids[0]].pressure.glove, replay.streams[ids[0]].pressure.glove);
  assert.match(rebuilt.streams[ids[0]].note, /旧录制.*0.4.0.*重建/);
  legacy.streams[0].metadata.sdk_version = '0.99.0'; delete legacy.streams[1].metadata.side;
  await writeFile(filename, JSON.stringify(legacy));
  const unknown = await new ReplayReader({ dataDir }).frame(saved.id, saved.duration_s);
  for (const id of ids) { assert.equal(unknown.streams[id].representation, 'raw-scan-order'); assert.equal(unknown.streams[id].pressure.glove, undefined); }
  const corrupt = structuredClone(saved); corrupt.streams[0].metadata.pressure_layout.palm.source_indices[0] = 256;
  await writeFile(filename, JSON.stringify(corrupt));
  await assert.rejects(new ReplayReader({ dataDir }).frame(saved.id, saved.duration_s), /手套映射无效/);
});
