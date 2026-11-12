import { packageEntry } from './helpers/package-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { readRecords } from '../src/exports/reader.mjs';

async function eventually(check, message) {
  for (let i = 0; i < 125; i++) { if (await check()) return; await delay(40); }
  assert.fail(message);
}
async function application(t, sdkPath = '') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-multi-sdk-'));
  const app = await createApplication({ sdkPath, port: 0, dataDir: path.join(directory, 'sessions'), outputDir: path.join(directory, 'exports'), webDir: path.join(directory, 'web') });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const get = async route => (await fetch(app.url + route)).json();
  const post = (route, body) => fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { app, directory, get, post };
}
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0);
  const count = buffer.readUInt16LE(end + 10), result = new Map();
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const compression = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const nameSize = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString();
    const local = buffer.readUInt32LE(offset + 42), begin = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const bytes = buffer.subarray(begin, begin + size);
    result.set(name, compression === 8 ? inflateRawSync(bytes) : bytes);
    offset += 46 + nameSize + extra + comment;
  }
  return result;
}

test('two installed SDK mock cards record independent streams, export NPZ and disconnect independently over HTTP', async t => {
  const { app, directory, get, post } = await application(t);
  for (const id of ['left-card', 'right-card']) {
    const response = await post('/api/sdk/connect', { instance_id: id, product: 'mock' });
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.equal(info.instance_id, id);
    assert.deepEqual(info.stream_ids, [`sdk-${id}-pressure`]);
    assert.equal(info.source, 'npm');
  }
  await eventually(async () => (await get('/api/sdk/info')).instances.filter(item => item.connected).every(item => item.frames >= 3), 'Both SDK mocks produce frames');
  const initial = await get('/api/sdk/info');
  assert.equal(initial.instance_id, 'default');
  assert.equal(initial.connected, false);
  assert.equal(initial.instances.filter(item => item.connected).length, 2);
  const health = await get('/api/health');
  assert.equal(health.mode, 'sdk-mock');
  assert.equal(health.hardware_connected, false);
  const ids = ['sdk-left-card-pressure', 'sdk-right-card-pressure'];
  const start = await post('/api/sessions/start', { device_ids: ids });
  assert.equal(start.status, 201);
  assert.equal((await post('/api/sdk/disconnect', { instance_id: 'left-card' })).status, 409);
  await eventually(() => ids.every(id => app.capture.status().record_counts[id] >= 4), 'Both selected streams recorded');
  const session = (await (await post('/api/sessions/stop', {})).json()).session;
  assert.equal(session.status, 'complete');
  assert.deepEqual(session.streams.map(item => item.id), ids);
  const folder = path.join(directory, 'sessions', session.id);
  const originals = new Map();
  for (const stream of session.streams) {
    assert.equal(stream.metadata.instance_id, stream.id === ids[0] ? 'left-card' : 'right-card');
    const records = [];
    for await (const record of readRecords(folder, stream)) records.push(record);
    assert.ok(records.length >= 4);
    originals.set(stream.id, Buffer.concat(records.map(record => record.payload)));
  }
  const metadata = (await readFile(path.join(folder, 'sdk-frames.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(new Set(metadata.map(item => item.instance_id)), new Set(['left-card', 'right-card']));
  const job = await app.exports.createJob({ session_id: session.id, format: 'npz' });
  await eventually(() => ['complete', 'error'].includes(app.exports.getJob(job.id).status), 'NPZ completes');
  assert.equal(app.exports.getJob(job.id).status, 'complete');
  const archive = unzip(await readFile((await app.exports.download(job.id)).path));
  for (const id of ids) {
    const npy = unzip(packageEntry(archive, `${id}.npz`)).get('data.npy');
    const headerLength = npy.readUInt16LE(8);
    assert.deepEqual(npy.subarray(10 + headerLength), originals.get(id));
  }
  const rightBefore = (await get('/api/sdk/info')).instances.find(item => item.instance_id === 'right-card').frames;
  const disconnected = await (await post('/api/sdk/disconnect', { instance_id: 'left-card' })).json();
  assert.equal(disconnected.instance_id, 'left-card');
  assert.equal(disconnected.has_device, false);
  await eventually(async () => (await get('/api/sdk/info')).instances.find(item => item.instance_id === 'right-card').frames > rightBefore, 'Other card continues after independent disconnect');
  assert.equal((await get('/api/sdk/info')).instances.some(item => item.instance_id === 'left-card'), false);
  assert.equal(app.capture.devices().some(item => item.id === ids[0]), false);
  assert.equal(app.capture.devices().find(item => item.id === ids[1]).connected, true);
  await app.capture.worker.terminate();
  const failed = await get('/api/sdk/info');
  assert.ok(failed.instances.every(item => !item.connected && !item.has_device && !item.connecting));
});

test('instance ids are bounded and eight active SDK cards can be replaced without accumulating history', async t => {
  const { app } = await application(t);
  for (const invalid of ['../escape', 'UPPER', '', 'x'.repeat(49), null]) {
    await assert.rejects(app.capture.sdkConnect({ instance_id: invalid, product: 'mock' }), error => error.statusCode === 400);
  }
  for (let i = 0; i < 8; i++) await app.capture.sdkConnect({ instance_id: `card-${i}`, product: 'mock' });
  await assert.rejects(app.capture.sdkConnect({ product: 'mock' }), error => error.statusCode === 409);
  await app.capture.sdkDisconnect({ instance_id: 'card-3' });
  const legacy = await app.capture.sdkConnect({ product: 'mock' });
  assert.deepEqual(legacy.stream_ids, ['sdk-pressure']);
  assert.equal((await app.capture.sdkInfo()).instances.filter(item => item.has_device).length, 8);
  assert.equal((await app.capture.sdkInfo()).instances.some(item => item.instance_id === 'card-3'), false);
  await assert.rejects(app.capture.sdkDisconnect({ instance_id: '../bad' }), error => error.statusCode === 400);
});

async function productFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'node-multi-product-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'node'));
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(directory, 'node', 'index.js'), `
let valid=false,activations=0;const devices=new Map();
export const Shroom={version:'multi-product-fixture',mock(){},getLicenseStatus(){return{valid};},async activateLicense(){
  activations++;for(const device of devices.values())device.fail();valid=true;return{valid:true};
},async listPorts(){const result=[{path:'FIXTURE_STATS',activations,open:[...devices].filter(([,d])=>d.state==='open').map(([p])=>p)}];if(devices.has('EXPIRE_ON_LIST'))valid=false;return result;},
async connectHandPad({path,onData,onStateChange,reconnect}){
  if(reconnect!==false)throw new Error('reconnect must remain false');if(!valid)throw new Error('fixture authorization required');
  let state='open',frames=0;const device={get state(){return state;},fail(){if(state!=='open')return;state='error';clearInterval(timer);onStateChange({state:'error'});},async close(){clearInterval(timer);state='closed';onStateChange({state:'closed'});if(path==='CLOSE_FAIL')throw new Error('fixture close failure');}};
  const timer=setInterval(()=>{if(state!=='open')return;onData({raw:new Uint8Array(1024).fill(42),pressureMatrix:new Uint8Array(1024).fill(42),rows:32,cols:32,timestamp:Date.now()});frames++;if(path.startsWith('FAIL_')&&frames===12)device.fail();},20);
  devices.set(path,device);onStateChange({state:'open'});return device;
}};`);
  return directory;
}
function fixtureLicense(t) {
  const previousKey = process.env.SHROOM_LICENSE_KEY, previousId = process.env.SHROOM_DEVICE_ID;
  process.env.SHROOM_LICENSE_KEY = 'test-only-no-network-key'; process.env.SHROOM_DEVICE_ID = 'a'.repeat(64);
  t.after(() => {
    if (previousKey === undefined) delete process.env.SHROOM_LICENSE_KEY; else process.env.SHROOM_LICENSE_KEY = previousKey;
    if (previousId === undefined) delete process.env.SHROOM_DEVICE_ID; else process.env.SHROOM_DEVICE_ID = previousId;
  });
}

test('product cards reserve equivalent COM paths and reuse only valid global authorization', async t => {
  fixtureLicense(t);
  const { app, get } = await application(t, await productFixture(t));
  const first = await app.capture.sdkConnect({ instance_id: 'first', product: 'hand', path: 'COM99901' });
  assert.equal(first.connected, true);
  for (const duplicate of [' com99901 ', '\\\\.\\COM99901']) {
    await assert.rejects(app.capture.sdkConnect({ instance_id: 'duplicate', product: 'hand', path: duplicate }), error => error.statusCode === 409);
  }
  await app.capture.sdkConnect({ instance_id: 'second', product: 'hand', path: 'EXPIRE_ON_LIST' });
  const stats = (await app.capture.sdkPorts())[0];
  assert.equal(stats.activations, 1, 'Second connection reuses valid authorization');
  assert.deepEqual(new Set(stats.open), new Set(['COM99901', 'EXPIRE_ON_LIST']));
  assert.equal((await get('/api/health')).hardware_connected, true, 'Nondefault hardware instances drive aggregate health');
  await app.capture.sdkConnect({ instance_id: 'third', product: 'hand', path: 'THIRD_FIXTURE_PORT' });
  assert.equal((await app.capture.sdkPorts())[0].activations, 2, 'Invalid status must activate again rather than reuse an object');
  assert.equal((await app.capture.sdkInfo()).instances.find(item => item.instance_id === 'third').connected, true);
});

test('an unselected card error leaves another recording healthy while a selected error marks incomplete', async t => {
  fixtureLicense(t);
  const { app } = await application(t, await productFixture(t));
  await app.capture.sdkConnect({ instance_id: 'unselected', product: 'hand', path: 'FAIL_UNSELECTED' });
  await app.capture.sdkConnect({ instance_id: 'selected', product: 'hand', path: 'KEEP_SELECTED' });
  await app.capture.start({ device_ids: ['sdk-selected-pressure'] });
  await eventually(async () => (await app.capture.sdkInfo()).instances.find(item => item.instance_id === 'unselected').error, 'Unselected card fails');
  assert.equal(app.capture.status().state, 'recording');
  assert.equal((await app.capture.stop()).status, 'complete');
  await app.capture.sdkDisconnect({ instance_id: 'unselected' });
  assert.equal((await app.capture.sdkInfo()).instances.find(item => item.instance_id === 'selected').connected, true);
  await app.capture.sdkConnect({ instance_id: 'failing', product: 'hand', path: 'FAIL_SELECTED' });
  await app.capture.start({ device_ids: ['sdk-failing-pressure'] });
  await eventually(() => app.capture.status().state === 'error', 'Selected card error reaches recording');
  const incomplete = await app.capture.stop();
  assert.equal(incomplete.status, 'incomplete');
  assert.match(incomplete.error, /failing/);
  assert.equal((await app.capture.sdkInfo()).instances.find(item => item.instance_id === 'selected').connected, true);
});

test('shutdown closes every card and an unselected close failure does not corrupt another stream manifest', async t => {
  fixtureLicense(t);
  const { app, directory } = await application(t, await productFixture(t));
  await app.capture.sdkConnect({ instance_id: 'close-fail', product: 'hand', path: 'CLOSE_FAIL' });
  await app.capture.sdkConnect({ instance_id: 'healthy', product: 'hand', path: 'KEEP_HEALTHY' });
  const session = await app.capture.start({ device_ids: ['sdk-healthy-pressure'] });
  await eventually(() => app.capture.status().record_counts['sdk-healthy-pressure'] > 2, 'Healthy records written');
  await app.close();
  const manifest = JSON.parse(await readFile(path.join(directory, 'sessions', session.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.finalized, true);
  assert.equal(manifest.error, null);
});
