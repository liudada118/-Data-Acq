import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Shroom } from 'shroom-sdk/node';
import { SdkController } from '../src/capture/sdk.mjs';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { readRecords } from '../src/exports/reader.mjs';

// Exercise the installed package's real decoder, replacing only serial I/O.
// These synthetic bytes verify software compatibility, not physical glove wiring.
const productModuleUrl = new URL('../core/product.js', import.meta.resolve('shroom-sdk/node')).href;
const { createProductParser, prepareProductConnection } = await import(productModuleUrl);
const tail = Buffer.from([0xaa, 0x55, 0x03, 0x99]);
const pressure = Uint8Array.from({ length: 256 }, (_, index) => index);
const imu = Uint8Array.from({ length: 16 }, (_, index) => 240 + index);
const segmentedFirst = Buffer.concat([Buffer.from([1, 99]), pressure.slice(0, 128), tail]);
const segmentedLast = Buffer.concat([Buffer.from([2, 99]), pressure.slice(128), imu, tail]);
const fullPacket = Buffer.concat([Buffer.from([253, 99]), pressure, imu, tail]);

function controller(t) {
  const batches = [], errors = [], calls = [];
  const sdk = new SdkController({ origin: process.hrtime.bigint(), onBatch: value => batches.push(value),
    onError: error => errors.push(error), ensureLicense: async () => {} });
  sdk.state.loaded = true; sdk.state.version = Shroom.version;
  const connect = async (entry, options) => { calls.push({ entry, options }); return { state: 'open', close: async () => {} }; };
  sdk.module = { Shroom: { connectGlove: options => connect('connectGlove', options), connectProduct: options => connect('connectProduct', options) } };
  t.after(() => sdk.disconnect());
  return { sdk, batches, errors, calls };
}

test('glove protocol selection preserves explicit full-packet products after SDK default changes', async t => {
  const { sdk, calls } = controller(t);
  for (const [product, gloveProtocol, expected] of [
    ['glove', undefined, 'segmented'], ['glove', 'full-packet', 'full-packet'],
    ['handGloveFullPacket', undefined, 'full-packet'], ['handGloveSegmented', undefined, 'segmented'],
  ]) {
    const info = await sdk.connect({ product, gloveProtocol, path: 'SYNTHETIC_ONLY', side: 'left' });
    const call = calls.at(-1);
    assert.equal(info.protocol, expected); assert.equal(info.gloveProtocol, expected); assert.equal(info.baudRate, 921600);
    assert.equal(call.entry, expected === 'segmented' ? 'connectGlove' : 'connectProduct');
    assert.equal(call.options.product, expected === 'full-packet' ? 'handGloveFullPacket' : undefined);
    assert.equal(call.options.side, 'left'); assert.equal(call.options.reconnect, false);
    // SDK product connectors enforce the fixed baud rate; don't pass unsupported options.
    assert.equal(call.options.baudRate, undefined); assert.equal(call.options.protocol, undefined);
    for (const descriptor of sdk.descriptors()) {
      assert.equal(descriptor.metadata.protocol, expected); assert.equal(descriptor.metadata.baud_rate, 921600);
    }
    await sdk.disconnect();
  }
  for (const options of [
    { product: 'glove', gloveProtocol: 'auto' },
    { product: 'handGloveFullPacket', gloveProtocol: 'segmented' },
    { product: 'handGloveSegmented', gloveProtocol: 'full-packet' },
    { product: 'insole', gloveProtocol: 'segmented' },
  ]) await assert.rejects(sdk.connect({ path: 'SYNTHETIC_ONLY', side: 'left', ...options }), error => error.statusCode === 400);
  assert.equal(calls.length, 4, 'invalid protocol requests never reach a connector');
});

test('real SDK segmented parser supplies both raw streams only after 130 + 146 byte pairing', async t => {
  const { sdk, batches, errors, calls } = controller(t);
  await sdk.connect({ product: 'glove', path: 'SYNTHETIC_ONLY', side: 'left' });
  const connection = prepareProductConnection({ product: 'glove', side: 'left' }, 'node');
  assert.equal(connection.info.product, 'handGloveSegmented');
  assert.equal(connection.serialOptions.baudRate, 921600);
  const parser = connection.parser, emit = bytes => {
    for (const frame of parser.push(bytes)) calls[0].options.onData(frame);
  };
  emit(segmentedFirst.subarray(0, 57)); emit(segmentedFirst.subarray(57));
  assert.equal(batches.length, 0); assert.equal(sdk.info().frames, 0);
  emit(segmentedLast.subarray(0, 23)); emit(segmentedLast.subarray(23));
  assert.deepEqual(errors, []); assert.equal(batches.length, 2); assert.equal(sdk.info().frames, 1);
  assert.deepEqual(batches[0].payload, Buffer.from(pressure)); assert.deepEqual(batches[1].payload, Buffer.from(imu));
  assert.equal(batches[0].deviceTimeNs, batches[1].deviceTimeNs);
  assert.equal(batches[0].metadata.protocol, 'segmented'); assert.equal(batches[0].metadata.packet_type, 99);
  assert.equal(batches[0].metadata.sdk_sequence, null, 'segmented firmware has no source sequence');
  assert.equal(sdk.previews[sdk.pressureId].pressure.values.length, 195);
  assert.equal(sdk.previews[sdk.imuId].raw.values.length, 16);
  emit(segmentedLast);
  assert.equal(batches.length, 2, 'an unpaired repeated tail never duplicates a capture frame');
});

test('real SDK full-packet parser retains source sequence and right-hand mapping', async t => {
  const { sdk, batches, calls, errors } = controller(t);
  await sdk.connect({ product: 'handGloveFullPacket', path: 'SYNTHETIC_ONLY', side: 'right' });
  const parser = createProductParser(calls[0].options.product, { side: 'right' });
  const frames = parser.push(fullPacket);
  assert.equal(frames.length, 1); assert.equal(frames[0].side, 'right');
  calls[0].options.onData(frames[0]);
  assert.deepEqual(errors, []); assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].payload, Buffer.from(pressure)); assert.deepEqual(batches[1].payload, Buffer.from(imu));
  assert.equal(batches[0].metadata.sdk_sequence, 253); assert.equal(batches[0].metadata.protocol, 'full-packet');
  assert.deepEqual(sdk.previews[sdk.pressureId].pressure.values, Array.from(frames[0].pressureMatrix));
});

test('segmented SDK parser frames persist raw pressure, IMU and protocol metadata through the capture process', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sdk-segmented-capture-'));
  const sdkPath = path.join(directory, 'sdk'); await mkdir(path.join(sdkPath, 'node'), { recursive: true });
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
import { createProductParser } from ${JSON.stringify(productModuleUrl)};
export const Shroom={version:'${Shroom.version}-decoder-serial-fixture',mock(){},getLicenseStatus(){return{valid:true}},async listPorts(){return[]},
async connectGlove(options){
  const parser=createProductParser('glove',{side:options.side});
  const first=Uint8Array.from(${JSON.stringify(Array.from(segmentedFirst))});
  const last=Uint8Array.from(${JSON.stringify(Array.from(segmentedLast))});
  const emit=()=>{parser.push(first);for(const frame of parser.push(last)) options.onData(frame)};
  emit(); const timer=setInterval(emit,20); return{state:'open',async close(){clearInterval(timer)}};
}};`);
  const dataDir = path.join(directory, 'sessions'), engine = new CaptureEngine({ dataDir, sdkPath });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.init();
  await engine.sdkConnect({ product: 'glove', path: 'SYNTHETIC_ONLY', side: 'left' });
  const session = await engine.start({ device_ids: ['sdk-pressure', 'sdk-imu-raw'] });
  for (let attempts = 0; attempts < 100 && !(engine.status().record_counts['sdk-pressure'] >= 3); attempts++) await delay(20);
  const saved = await engine.stop();
  assert.equal(saved.status, 'complete'); assert.equal(saved.dropped_records, 0);
  const pressureStream = saved.streams.find(stream => stream.id === 'sdk-pressure');
  const imuStream = saved.streams.find(stream => stream.id === 'sdk-imu-raw');
  assert.ok(pressureStream.records >= 3); assert.equal(pressureStream.records, imuStream.records);
  assert.equal(pressureStream.metadata.protocol, 'segmented'); assert.equal(imuStream.metadata.baud_rate, 921600);
  const folder = path.join(dataDir, session.id), pressureRecords = [], imuRecords = [];
  for await (const record of readRecords(folder, pressureStream)) pressureRecords.push(record);
  for await (const record of readRecords(folder, imuStream)) imuRecords.push(record);
  assert.deepEqual(pressureRecords[0].payload, Buffer.from(pressure));
  assert.deepEqual(imuRecords[0].payload, Buffer.from(imu));
  const metadata = (await readFile(path.join(folder, 'sdk-frames.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(metadata.length >= 6);
  for (const frame of metadata) { assert.equal(frame.sdk_sequence, null); assert.equal(frame.protocol, 'segmented'); assert.equal(frame.packet_type, 99); }
});
