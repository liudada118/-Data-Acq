import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureEngine } from '../src/capture/engine.mjs';

function useFixtureLicense(t) {
  const saved = { key: process.env.SHROOM_LICENSE_KEY, id: process.env.SHROOM_DEVICE_ID };
  process.env.SHROOM_LICENSE_KEY = 'fixture-only-not-a-real-license';
  process.env.SHROOM_DEVICE_ID = 'a'.repeat(64);
  t.after(() => {
    if (saved.key === undefined) delete process.env.SHROOM_LICENSE_KEY; else process.env.SHROOM_LICENSE_KEY = saved.key;
    if (saved.id === undefined) delete process.env.SHROOM_DEVICE_ID; else process.env.SHROOM_DEVICE_ID = saved.id;
  });
}

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-capture-'));
  const engine = new CaptureEngine({ dataDir: path.join(directory, 'sessions'), ...options });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.init();
  return { directory, engine };
}
function records(buffer) {
  assert.equal(buffer.subarray(0, 8).toString(), 'MDAQBIN1');
  let offset = 8, previous = -1n;
  const result = [];
  while (offset < buffer.length) {
    assert.ok(offset + 32 <= buffer.length);
    const sequence = buffer.readBigUInt64LE(offset), time = buffer.readBigInt64LE(offset + 8);
    assert.ok(sequence > previous); previous = sequence;
    const count = buffer.readUInt32LE(offset + 24), size = buffer.readUInt32LE(offset + 28);
    const payload = buffer.subarray(offset + 32, offset + 32 + size);
    assert.equal(payload.length, size);
    result.push({ sequence, time, count, payload });
    offset += 32 + size;
  }
  assert.equal(offset, buffer.length);
  return result;
}

test('four device recording drains and preserves exact binary counts across restart', async t => {
  const { directory, engine } = await setup(t);
  const ids = engine.devices().map(d => d.id);
  await assert.rejects(engine.start({ device_ids: [] }), /at least one/);
  const session = await engine.start({ name: '四路测试', device_ids: ids });
  await assert.rejects(engine.start({ device_ids: ids }), error => error.statusCode === 409);
  await delay(400);
  assert.equal(engine.status().state, 'recording');
  assert.equal(engine.preview().streams['sim-pressure'].pressure.values.length, 256);
  const finished = await engine.stop();
  assert.equal(finished.finalized, true);
  assert.equal(finished.status, 'complete');
  assert.equal(finished.dropped_records, 0);
  let bytes = 0;
  for (const stream of finished.streams) {
    const file = await readFile(path.join(directory, 'sessions', session.id, stream.file));
    bytes += file.length;
    const rows = records(file);
    assert.ok(rows.length > 0);
    assert.equal(rows.length, stream.records);
    assert.equal(rows.reduce((n, row) => n + row.count, 0), stream.samples);
    assert.equal(rows.reduce((n, row) => n + row.payload.length, 0), stream.payload_bytes);
  }
  assert.equal(bytes, finished.bytes_written);
  assert.deepEqual(await engine.getSession(session.id), finished);
  assert.deepEqual((await engine.listSessions())[0], finished);
  await assert.rejects(engine.getSession('../escape'));
  assert.equal(engine.status().state, 'idle');
});

test('bounded queue overload finalizes incomplete and supports another recording', async t => {
  const { engine } = await setup(t, { queueLimitBytes: 4096, queueCapacity: 64 });
  await engine.start({ device_ids: ['sim-camera'] });
  await delay(120);
  const session = await engine.stop();
  assert.equal(session.status, 'incomplete');
  assert.equal(session.finalized, true);
  assert.ok(session.dropped_records > 0);
  assert.match(session.error, /overflow/);
  await engine.start({ device_ids: ['sim-imu'] });
  await delay(50);
  assert.equal((await engine.stop()).status, 'complete');
});

test('SDK absent is explicit and interrupted recording is recovered incomplete', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-recovery-'));
  const dataDir = path.join(directory, 'sessions');
  await mkdir(path.join(dataDir, 'session-interrupted'), { recursive: true });
  await writeFile(path.join(dataDir, 'session-interrupted', 'manifest.json'), JSON.stringify({ id: 'session-interrupted', started_at: new Date().toISOString(), status: 'recording', finalized: false }));
  const engine = new CaptureEngine({ dataDir, sdkPath: false });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.init();
  assert.equal((await engine.sdkInfo()).loaded, false);
  await assert.rejects(engine.sdkConnect({ product: 'mock' }), error => error.statusCode === 503);
  const session = await engine.getSession('session-interrupted');
  assert.equal(session.status, 'incomplete');
  assert.equal(session.finalized, true);
});

test('capture child failure rejects later requests and close does not wait for a dead child', async t => {
  const { engine } = await setup(t);
  await engine.worker.terminate();
  await assert.rejects(engine.listSessions(), /exited/);
  assert.equal(engine.status().state, 'error');
  assert.equal(engine.status().engine_alive, false);
  await engine.close();
});

test('SDK runs on a child main thread and abrupt exit rejects pending and future commands', async t => {
  const sdkPath = await mkdtemp(path.join(os.tmpdir(), 'node-main-thread-fixture-'));
  t.after(() => rm(sdkPath, { recursive: true, force: true }));
  await mkdir(path.join(sdkPath, 'node'));
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
import {isMainThread,threadId} from 'node:worker_threads';
export const Shroom={version:JSON.stringify({isMainThread,threadId,pid:process.pid}),mock(){},async listPorts(){return new Promise(()=>{});}};`);
  const { engine } = await setup(t, { sdkPath });
  const runtime = JSON.parse((await engine.sdkInfo()).version);
  assert.equal(runtime.isMainThread, true);
  assert.equal(runtime.threadId, 0);
  assert.equal(runtime.pid, engine.child.pid);
  assert.notEqual(runtime.pid, process.pid);
  const pendingRejected = assert.rejects(engine.sdkPorts(), error => error.statusCode === 503 && /exited/.test(error.message));
  await delay(40);
  await engine.worker.terminate();
  await pendingRejected;
  await assert.rejects(engine.listSessions(), error => error.statusCode === 503);
  assert.equal((await engine.sdkInfo()).connected, false);
  assert.equal((await engine.sdkInfo()).has_device, false);
  assert.ok(engine.devices().every(device => device.connected === false));
  assert.deepEqual(engine.preview().streams, {});
  await engine.close();
});

test('parent IPC disconnection drains recording and exits the owned capture child', async t => {
  const { engine, directory } = await setup(t);
  const session = await engine.start({ device_ids: ['sim-pressure'] });
  await delay(80);
  engine.child.disconnect();
  await engine.exited;
  const manifest = JSON.parse(await readFile(path.join(directory, 'sessions', session.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.finalized, true);
  assert.equal(manifest.status, 'complete');
  assert.ok(manifest.streams[0].records > 0);
});

test('injected SDK fixture exercises callback to raw ADC + metadata recording, never hardware', async t => {
  const sdkPath = await mkdtemp(path.join(os.tmpdir(), 'node-sdk-fixture-'));
  t.after(() => rm(sdkPath, { recursive: true, force: true }));
  await mkdir(path.join(sdkPath, 'node'));
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
export const Shroom = { version: 'test-fixture', async listPorts() { return []; }, mock() {
let callback; const timer=setInterval(()=>callback?.({raw:new Uint8Array(1024).fill(42),values:new Float32Array(1024).fill(42/255),rows:32,cols:32,timestamp:123456789}),20);
return {onFrame(fn){callback=fn;},onError(){},async close(){clearInterval(timer);}};
}};`);
  const { engine, directory } = await setup(t, { sdkPath });
  assert.equal((await engine.sdkInfo()).version, 'test-fixture');
  await engine.sdkConnect({ product: 'mock' });
  assert.equal(engine.devices().find(d => d.id === 'sdk-pressure').mode, 'sdk-mock');
  await delay(120);
  assert.equal(engine.preview().streams['sdk-pressure'].pressure.values.length, 1024);
  await engine.start({ device_ids: ['sdk-pressure', 'sim-imu'] });
  await assert.rejects(engine.sdkDisconnect(), error => error.statusCode === 409);
  await delay(100);
  const finished = await engine.stop();
  assert.equal(finished.status, 'complete');
  assert.equal(finished.source, 'mixed');
  assert.equal(finished.simulated, true);
  const sdk = finished.streams.find(d => d.id === 'sdk-pressure');
  const rows = records(await readFile(path.join(directory, 'sessions', finished.id, sdk.file)));
  assert.ok(rows.length > 0);
  assert.ok(rows[0].payload.every(v => v === 42));
  const metadata = (await readFile(path.join(directory, 'sessions', finished.id, 'sdk-frames.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(metadata.length, rows.length);
  assert.equal(metadata[0].sdk_timestamp_ms, 123456789);
  await engine.sdkDisconnect();
  assert.equal(engine.devices().some(d => d.id.startsWith('sdk-')), false);
});

test('product API fixture preserves glove ADC, raw IMU and SDK source sequence without inventing cadence', async t => {
  useFixtureLicense(t);
  const sdkPath = await mkdtemp(path.join(os.tmpdir(), 'node-glove-fixture-'));
  t.after(() => rm(sdkPath, { recursive: true, force: true }));
  await mkdir(path.join(sdkPath, 'node'));
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
export const Shroom = { version:'product-test-fixture', mock(){}, async activateLicense(){return{valid:true};}, async listPorts(){return[];}, async connectProduct({product,side,onData}) {
if(product!=='handGloveFullPacket') throw new Error('Expected explicit full-packet product');
if(side!=='left') throw new Error('Expected explicit side');
const emit=()=>onData({raw:Uint8Array.from({length:256},(_,i)=>i),pressureMatrix:new Uint8Array(195).fill(11),rows:13,cols:15,timestamp:1700000000123,sequence:253,packetType:2,imu:{raw:Uint8Array.from({length:16},(_,i)=>240+i)}});
emit();const timer=setInterval(emit,20);return{state:'open',async close(){clearInterval(timer);}};
}};`);
  const { engine, directory } = await setup(t, { sdkPath });
  await engine.sdkConnect({ product: 'handGloveFullPacket', path: 'TEST_FIXTURE_ONLY', side: 'left' });
  const devices = engine.devices();
  assert.equal(devices.find(d => d.id === 'sdk-pressure').sample_rate, 0);
  assert.equal(devices.find(d => d.id === 'sdk-imu-raw').preview_supported, false);
  await engine.start({ device_ids: ['sdk-pressure', 'sdk-imu-raw'] });
  await delay(100);
  const session = await engine.stop();
  assert.equal(session.status, 'complete');
  assert.equal(session.source, 'shroom-sdk');
  const folder = path.join(directory, 'sessions', session.id);
  const pressure = records(await readFile(path.join(folder, 'sdk-pressure.bin')));
  const imu = records(await readFile(path.join(folder, 'sdk-imu-raw.bin')));
  assert.equal(pressure.length, imu.length);
  assert.equal(pressure[0].payload.length, 256);
  assert.equal(pressure[0].payload[255], 255);
  assert.equal(imu[0].payload.length, 16);
  assert.equal(imu[0].payload[0], 240);
  assert.equal(imu[0].time, pressure[0].time);
  const metadata = JSON.parse((await readFile(path.join(folder, 'sdk-frames.jsonl'), 'utf8')).split('\n')[0]);
  assert.equal(metadata.sdk_sequence, 253);
  assert.equal(metadata.packet_type, 2);
  assert.equal(metadata.sdk_timestamp_ms, 1700000000123);
  await engine.start({ device_ids: ['sdk-imu-raw'] });
  await delay(60);
  const imuOnly = await engine.stop();
  const imuRows = (await readFile(path.join(directory, 'sessions', imuOnly.id, 'sdk-frames.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(imuRows.length, imuOnly.streams[0].records);
  assert.ok(imuRows.length > 0);
  assert.ok(imuRows.every(row => row.stream_id === 'sdk-imu-raw' && row.sdk_sequence === 253));
});

test('SDK shutdown failure still drains and finalizes recording incomplete', async t => {
  const sdkPath = await mkdtemp(path.join(os.tmpdir(), 'node-sdk-close-fixture-'));
  t.after(() => rm(sdkPath, { recursive: true, force: true }));
  await mkdir(path.join(sdkPath, 'node'));
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
export const Shroom={version:'close-failure-test-fixture',async listPorts(){return[];},mock(){
let callback;const timer=setInterval(()=>callback?.({raw:new Uint8Array(1024),values:new Float32Array(1024),rows:32,cols:32,timestamp:123}),20);
return {onFrame(fn){callback=fn;},onError(){},async close(){clearInterval(timer);throw new Error('fixture close failed');}};
}};`);
  const { engine, directory } = await setup(t, { sdkPath });
  await engine.sdkConnect({ product: 'mock' });
  const session = await engine.start({ device_ids: ['sdk-pressure'] });
  await delay(80);
  await engine.close();
  const manifest = JSON.parse(await readFile(path.join(directory, 'sessions', session.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.finalized, true);
  assert.equal(manifest.status, 'incomplete');
  assert.match(manifest.error, /fixture close failed/);
  assert.ok(manifest.streams[0].records > 0);
});

test('SDK opening callback failure closes owned device and never reports connected', async t => {
  useFixtureLicense(t);
  const sdkPath = await mkdtemp(path.join(os.tmpdir(), 'node-sdk-open-fixture-'));
  t.after(() => rm(sdkPath, { recursive: true, force: true }));
  await mkdir(path.join(sdkPath, 'node'));
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
import {writeFile} from 'node:fs/promises';
export const Shroom={version:'open-failure-test-fixture',mock(){},async activateLicense(){return{valid:true};},async listPorts(){return[];},async connectHandPad({onError}){
onError(new Error('fixture opening failure'));
return {state:'error',async close(){await writeFile(new URL('../closed.txt',import.meta.url),'closed');}};
}};`);
  const { engine } = await setup(t, { sdkPath });
  await assert.rejects(engine.sdkConnect({ product: 'hand', path: 'TEST_FIXTURE_ONLY' }), /opening failure/);
  assert.equal((await engine.sdkInfo()).connected, false);
  assert.equal(engine.devices().some(d => d.id.startsWith('sdk-')), false);
  assert.equal(await readFile(path.join(sdkPath, 'closed.txt'), 'utf8'), 'closed');
});

test('SDK info remains responsive while serialized license activation is pending', async t => {
  useFixtureLicense(t);
  const sdkPath = await mkdtemp(path.join(os.tmpdir(), 'node-sdk-latency-fixture-'));
  t.after(() => rm(sdkPath, { recursive: true, force: true }));
  await mkdir(path.join(sdkPath, 'node'));
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
export const Shroom={version:'latency-test-fixture',mock(){},async activateLicense(){await new Promise(resolve=>setTimeout(resolve,500));return{valid:true};},async listPorts(){return[];},async connectHandPad(){return{state:'open',async close(){}};}};`);
  const { engine } = await setup(t, { sdkPath });
  const connecting = engine.sdkConnect({ product: 'hand', path: 'TEST_FIXTURE_ONLY' });
  await delay(170);
  const info = await Promise.race([engine.sdkInfo(), delay(100).then(() => { throw new Error('SDK status blocked behind connection'); })]);
  assert.equal(info.connecting, true);
  assert.equal(info.connected, false);
  assert.equal((await connecting).connecting, false);
  assert.equal((await engine.sdkInfo()).connected, true);
});

test('SDK 0.2 product contracts disable reconnection and state-only disconnects make recordings incomplete', async t => {
  useFixtureLicense(t);
  const sdkPath = await mkdtemp(path.join(os.tmpdir(), 'node-sdk-state-fixture-'));
  t.after(() => rm(sdkPath, { recursive: true, force: true }));
  await mkdir(path.join(sdkPath, 'node'));
  await writeFile(path.join(sdkPath, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkPath, 'node', 'index.js'), `
let active;
function connect(options,glove) {
  if(options.reconnect!==false) throw new Error('Product reconnect must be explicitly false');
  if(typeof options.onStateChange!=='function') throw new Error('State callback is required');
  let state='open',emitted=0;
  const frame=glove?{raw:new Uint8Array(256),pressureMatrix:new Uint8Array(195),rows:13,cols:15,timestamp:1,sequence:1,packetType:2,imu:{raw:new Uint8Array(16)}}:{raw:new Uint8Array(1024),pressureMatrix:new Uint8Array(1024),rows:32,cols:32,timestamp:1};
  const emit=()=>{emitted++;options.onData(frame);};
  const timer=setInterval(emit,15);
  options.onStateChange({state:'open',path:options.path,attempt:0,maxAttempts:3});
  active={drop(){clearInterval(timer);const expectedFrames=emitted;state=glove?'error':'closed';options.onStateChange({state,path:options.path,attempt:0,maxAttempts:3});
    // A late frame or open callback must not clear the application error latch.
    options.onStateChange({state:'open',path:options.path,attempt:1,maxAttempts:3});emit();return expectedFrames;}};
  return {get state(){return state;},async close(){clearInterval(timer);state='closed';options.onStateChange({state:'closed',path:options.path,attempt:0,maxAttempts:3});}};
}
export const Shroom={version:'0.2-state-fixture',mock(){},async activateLicense(){return{valid:true};},async listPorts(){return[{path:'TEST_FIXTURE_ONLY',expectedFrames:active?.drop()}];},async connectGlove(options){return connect(options,true);},async connectProduct(options){if(options.product!=='handGloveFullPacket')throw new Error('Expected full-packet product');return connect(options,true);},async connectHandPad(options){return connect(options,false);}};`);
  const { engine, directory } = await setup(t, { sdkPath });
  for (const product of ['hand', 'handGloveFullPacket']) {
    await engine.sdkConnect({ product, path: 'TEST_FIXTURE_ONLY', side: 'left' });
    assert.equal((await engine.sdkInfo()).connected, true);
    // Connected transport alone is insufficient: glove recording waits until a
    // valid first frame has established its saved physical-region mapping.
    for (let attempt = 0; attempt < 100 && !engine.devices().find(device => device.id === 'sdk-pressure')?.connected; attempt++) await delay(10);
    assert.equal(engine.devices().find(device => device.id === 'sdk-pressure').connected, true);
    await engine.start({ device_ids: ['sdk-pressure'] });
    await delay(60);
    const ports = await engine.sdkPorts();
    const failed = await engine.sdkInfo();
    assert.equal(failed.connected, false);
    assert.equal(failed.connection_state, product === 'hand' ? 'closed' : 'error');
    assert.ok(failed.error);
    assert.equal(failed.frames, ports[0].expectedFrames);
    assert.equal(engine.devices().find(device => device.id === 'sdk-pressure').connected, false);
    assert.equal(engine.preview().streams['sdk-pressure'], undefined);
    assert.equal(engine.status().state, 'error');
    const session = await engine.stop();
    assert.equal(session.status, 'incomplete');
    assert.equal(session.finalized, true);
    assert.ok(session.streams[0].records > 0);
    await engine.sdkDisconnect();
  }
  // The same state API also emits closed on deliberate shutdown. That must preserve a healthy recording.
  await engine.sdkConnect({ product: 'hand', path: 'TEST_FIXTURE_ONLY' });
  const finalSession = await engine.start({ device_ids: ['sdk-pressure'] });
  await delay(50);
  await engine.close();
  const completed = JSON.parse(await readFile(path.join(directory, 'sessions', finalSession.id, 'manifest.json'), 'utf8'));
  assert.equal(completed.status, 'complete');
  assert.equal(completed.finalized, true);
});
