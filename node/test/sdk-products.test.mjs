import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Shroom } from 'shroom-sdk/node';
import { SdkController } from '../src/capture/sdk.mjs';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { readRecords } from '../src/exports/reader.mjs';

// Contract fixtures deliberately use synthetic mappings. Physical mapping/firmware
// acceptance is separate; these exercise the adapter without opening a serial port.
function bodyFrame() {
  const raw = Uint8Array.from({ length: 1024 }, (_, index) => index % 256);
  const shapes = { back: [6, 10], chest: [6, 10], rightArm: [6, 7], rightShoulder: [6, 3],
    leftArm: [6, 7], leftShoulder: [6, 3], backPantsRight: [8, 5], backPantsLeft: [8, 5], frontPantsLeft: [8, 5], frontPantsRight: [8, 5] };
  let offset = 0;
  const regions = {};
  for (const [id, [rows, cols]] of Object.entries(shapes)) {
    const sourceIndices = Uint16Array.from({ length: rows * cols }, (_, index) => offset + index);
    const values = Uint8Array.from(sourceIndices, index => raw[index]);
    regions[id] = { name: id, rows, cols, sourceIndices, raw: values };
    offset += rows * cols;
  }
  return { product: 'humanBody', raw, pressure: raw.slice(), pressureMatrix: raw.slice(), rows: 32, cols: 32, regions, timestamp: 1700000000123 };
}
function insoleFrame(side = 'left', protocol = '12bit') {
  const wide = protocol === '12bit';
  const pressure = wide ? Uint16Array.from({ length: 256 }, (_, i) => i === 255 ? 4095 : i * 13) : Uint8Array.from({ length: 256 }, (_, i) => i);
  const raw = new Uint8Array(wide ? 512 : 256), view = new DataView(raw.buffer);
  for (let i = 0; i < 256; i++) { if (wide) view.setUint16(i * 2, pressure[i], true); else raw[i] = pressure[i]; }
  const sourceIndices = Uint16Array.from({ length: 112 }, (_, index) => side === 'left' ? index : 255 - index);
  const positions = Array.from({ length: 112 }, (_, index) => ({ row: Math.floor(index / 8), col: index % 8, xMm: (index % 8) * 5, yMm: -Math.floor(index / 8) * 15 }));
  return { product: 'jqInsole', side, protocol, bitDepth: wide ? 12 : 8, fullScale: wide ? 4095 : 255,
    raw, pressure, pressureMatrix: pressure.slice(), rows: 16, cols: 16,
    sensors: { rows: 14, cols: 8, sourceIndices, positions, raw: (wide ? Uint16Array : Uint8Array).from(sourceIndices, index => pressure[index]) },
    imu: { raw: Uint8Array.from({ length: wide ? 40 : 16 }, (_, index) => index) }, timestamp: 1700000000123,
    ...(wide ? {} : { sequence: 241 }) };
}
function controller(t, options = {}) {
  const batches = [], errors = [], calls = [];
  const controller = new SdkController({ origin: process.hrtime.bigint(), onBatch: batch => batches.push(batch), onError: error => errors.push(error), ensureLicense: async () => {}, ...options });
  controller.module = { Shroom: { connectProduct: async options => { calls.push(options); return { state: 'open', close: async () => {} }; } } };
  controller.state.loaded = true; controller.state.version = '0.3.0';
  t.after(() => controller.disconnect());
  return { controller, batches, errors, calls };
}

test('installed SDK exposes body and insole through the public product registry and connector', () => {
  const products = Shroom.listDeviceProducts();
  assert.ok(products.some(product => product.product === 'humanBody' && product.sensorPoints === 1024 && product.mappedSensorPoints === 400));
  assert.ok(products.some(product => product.product === 'jqInsole' && product.sensorPoints === 256 && product.mappedSensorPoints === 112));
  assert.equal(typeof Shroom.connectProduct, 'function');
});

test('body connection stores ten physical layouts before becoming recordable and retains all 1024 ADC channels', async t => {
  const { controller: sdk, batches, calls } = controller(t);
  const info = await sdk.connect({ product: 'humanBody', path: 'FIXTURE_BODY' });
  assert.equal(info.product, 'body'); assert.equal(info.connected, true); assert.equal(info.ready, false);
  assert.equal(sdk.descriptors()[0].connected, false);
  assert.equal(calls[0].product, 'body'); assert.equal(calls[0].reconnect, false);
  assert.equal(Object.hasOwn(calls[0], 'side'), false);
  const frame = bodyFrame(); calls[0].onData(frame);
  assert.equal(sdk.info().ready, true); assert.equal(sdk.descriptors()[0].connected, true);
  const layout = sdk.descriptors()[0].metadata.pressure_layout;
  assert.equal(layout.type, 'regions'); assert.equal(layout.regions.length, 10);
  assert.equal(new Set(layout.regions.flatMap(region => region.source_indices)).size, 400);
  assert.equal(batches.length, 1); assert.deepEqual(batches[0].payload, Buffer.from(frame.raw));
  assert.equal(sdk.previews['sdk-pressure'].pressure.values.length, 1024);
  assert.equal(sdk.previews['sdk-pressure'].pressure.regions.reduce((sum, region) => sum + region.values.length, 0), 400);
  const before = batches.length;
  for (const name of ['', 'x'.repeat(81)]) {
    const badName = bodyFrame(); badName.regions.back.name = name;
    assert.throws(() => sdk.frame(badName, 'body'), /region shape/);
    assert.equal(batches.length, before);
  }
  const malformed = bodyFrame(); malformed.regions.chest.sourceIndices[0] = 0;
  calls[0].onData(malformed);
  assert.equal(batches.length, before); assert.match(sdk.info().error, /mapped ADC|distinct/);
});

test('12-bit insole preserves values above 255 as little-endian uint16 and retains source coordinates and IMU bytes', async t => {
  const { controller: sdk, batches, calls } = controller(t, { instanceId: 'right-foot' });
  await sdk.connect({ product: 'jqInsole', side: 'right', path: 'FIXTURE_INSOLE', baudRate: 1500000 });
  assert.equal(calls[0].product, 'insole'); assert.equal(calls[0].side, 'right');
  assert.equal(calls[0].protocol, '12bit'); assert.equal(calls[0].baudRate, 1500000); assert.equal(calls[0].reconnect, false);
  const frame = insoleFrame('right'); calls[0].onData(frame);
  const pressure = sdk.descriptors()[0], imu = sdk.descriptors()[1];
  assert.equal(pressure.dtype, 'uint16'); assert.deepEqual(pressure.shape, [256]);
  assert.equal(pressure.metadata.full_scale, 4095); assert.equal(pressure.metadata.baud_rate, 1500000);
  assert.equal(pressure.metadata.pressure_layout.positions.length, 112);
  assert.equal(pressure.metadata.pressure_layout.source_indices[0], 255);
  assert.equal(pressure.metadata.pressure_layout.positions[8].y_mm, -15);
  assert.deepEqual(imu.shape, [40]); assert.equal(imu.preview_supported, false);
  assert.equal(batches.length, 2); assert.equal(batches[0].payload.length, 512);
  assert.equal(batches[0].payload.readUInt16LE(510), 4095);
  assert.equal(batches[0].payload.readUInt16LE(200), 1300);
  assert.deepEqual(batches[0].payload, Buffer.from(frame.raw));
  assert.deepEqual(batches[1].payload, Buffer.from(frame.imu.raw));
  assert.equal(batches[0].deviceTimeNs, batches[1].deviceTimeNs);
  assert.equal(sdk.previews['sdk-right-foot-pressure'].pressure.points[0].value, 4095);
  assert.equal(sdk.info().protocol, '12bit'); assert.equal(sdk.info().baudRate, 1500000);
});

test('8-bit insole uses 256 ADC bytes and 16 IMU bytes; invalid compound frames append neither stream', async t => {
  const { controller: sdk, batches, calls } = controller(t);
  await sdk.connect({ product: 'insole', side: 'left', protocol: '8bit', path: 'FIXTURE_INSOLE' });
  const good = insoleFrame('left', '8bit'); calls[0].onData(good);
  assert.equal(sdk.descriptors()[0].dtype, 'uint8'); assert.equal(sdk.descriptors()[0].metadata.full_scale, 255);
  assert.equal(batches[0].payload.length, 256); assert.equal(batches[1].payload.length, 16);
  assert.equal(batches[0].metadata.sdk_sequence, 241);
  const bad = insoleFrame('left', '8bit'); bad.imu.raw = new Uint8Array(15);
  calls[0].onData(bad);
  assert.equal(batches.length, 2); assert.equal(sdk.info().frames, 1); assert.equal(sdk.info().connected, false);
  assert.match(sdk.info().error, /IMU/);
});

test('new products reject ambiguous options before opening a port and discard late callbacks after disconnect', async t => {
  const { controller: sdk, calls, batches } = controller(t);
  for (const options of [
    { product: 'insole' }, { product: 'insole', side: 'both' },
    { product: 'insole', side: 'left', protocol: '16bit' },
    { product: 'insole', side: 'left', baudRate: 12345 },
    { product: 'body', side: 'left' }, { product: 'body', protocol: '8bit' },
  ]) await assert.rejects(sdk.connect({ path: 'FIXTURE_ONLY', ...options }), error => error.statusCode === 400);
  assert.equal(calls.length, 0);
  await sdk.connect({ product: 'insole', side: 'left', path: 'FIXTURE_ONLY' });
  const old = calls[0];
  await sdk.disconnect();
  await sdk.connect({ product: 'body', path: 'FIXTURE_BODY' });
  old.onData(insoleFrame()); old.onError(new Error('late previous callback'));
  assert.equal(batches.length, 0); assert.equal(sdk.info().error, null);
  calls[1].onData(bodyFrame()); assert.equal(batches.length, 1);
});

test('new product child-process recording persists uint16, mappings and raw IMU without changing binary records', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'new-products-contract-'));
  const sdkPath = path.join(directory, 'sdk'); await mkdir(path.join(sdkPath, 'node'), { recursive: true });
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
${bodyFrame.toString()}
${insoleFrame.toString()}
export const Shroom={version:'0.3.0-contract-fixture',mock(){},getLicenseStatus(){return{valid:true}},async listPorts(){return[]},
async connectProduct(options){
  if(options.reconnect!==false)throw new Error('explicit reconnect required');
  const emit=()=>options.onData(options.product==='body'?bodyFrame():insoleFrame(options.side,options.protocol));
  const timer=setInterval(emit,20); return{state:'open',async close(){clearInterval(timer)}};
}};`);
  const dataDir = path.join(directory, 'sessions'), engine = new CaptureEngine({ dataDir, sdkPath });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.init();
  await engine.sdkConnect({ instance_id: 'body', product: 'body', path: 'FIXTURE_BODY' });
  await engine.sdkConnect({ instance_id: 'foot', product: 'insole', side: 'right', protocol: '12bit', path: 'FIXTURE_FOOT' });
  for (let count = 0; count < 100 && !engine.devices().filter(d => d.id.startsWith('sdk-')).every(d => d.connected); count++) await delay(20);
  const session = await engine.start({ device_ids: ['sdk-body-pressure', 'sdk-foot-pressure', 'sdk-foot-imu-raw'] });
  for (let count = 0; count < 100 && !(engine.status().record_counts['sdk-foot-pressure'] >= 3); count++) await delay(20);
  const saved = await engine.stop();
  assert.equal(saved.status, 'complete'); assert.equal(saved.dropped_records, 0);
  const body = saved.streams.find(s => s.id === 'sdk-body-pressure'), foot = saved.streams.find(s => s.id === 'sdk-foot-pressure'), imu = saved.streams.find(s => s.id === 'sdk-foot-imu-raw');
  assert.equal(body.metadata.pressure_layout.regions.length, 10);
  assert.equal(foot.metadata.pressure_layout.positions.length, 112);
  assert.equal(foot.dtype, 'uint16'); assert.equal(foot.byte_order, 'little'); assert.equal(foot.records, imu.records);
  const folder = path.join(dataDir, session.id);
  const frames = []; for await (const record of readRecords(folder, foot)) frames.push(record);
  assert.ok(frames.length >= 3); assert.equal(frames[0].payload.readUInt16LE(510), 4095);
  assert.deepEqual(frames[0].payload, Buffer.from(insoleFrame('right').raw));
  const disk = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'));
  assert.equal(disk.streams.find(s => s.id === foot.id).metadata.pressure_layout.source_indices[0], 255);
});
