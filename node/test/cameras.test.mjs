import { packageEntry, hasPackageEntry } from './helpers/package-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { createApplication } from '../src/server.mjs';
import { CAMERA_CHUNK_LIMIT } from '../src/cameras.mjs';

async function eventually(check) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await delay(20); }
  assert.fail('Timed out waiting for state');
}
async function application(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synapse-cameras-'));
  const options = { port: 0, sdkPath: false, dataDir: path.join(directory, 'sessions'), outputDir: path.join(directory, 'exports'), ...extra };
  const app = await createApplication(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const get = async route => (await fetch(app.url + route)).json();
  const post = (route, value, token) => fetch(app.url + route, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { 'X-Camera-Token': token } : {}),
  }, body: JSON.stringify(value) });
  const register = async (id = 'phone') => {
    const result = await post('/api/cameras/register', { instance_id: id, label: `Camera ${id}`, width: 1280, height: 720, frame_rate: 30 });
    assert.equal(result.status, 201); return result.json();
  };
  const start = async (camera, other = [], mime = 'video/webm;codecs=vp8') => {
    const result = await post('/api/sessions/start', { device_ids: [camera.device.id, ...other],
      camera_sources: [{ instance_id: camera.device.metadata.instance_id, token: camera.token, mime_type: mime }] });
    assert.equal(result.status, 201, await result.clone().text()); return result.json();
  };
  const chunk = (camera, session, index, bytes, mime = 'video/webm') => fetch(`${app.url}/api/cameras/${camera.device.metadata.instance_id}/chunks?session_id=${session.session_id}&index=${index}`, {
    method: 'POST', headers: { 'Content-Type': mime, 'X-Camera-Token': camera.token }, body: bytes,
  });
  const finalize = (camera, session, nextIndex) => post(`/api/cameras/${camera.device.metadata.instance_id}/finalize`, {
    session_id: session.session_id, next_index: nextIndex, started_at: '2026-11-04T00:00:00.000Z', stopped_at: '2026-11-04T00:00:01.000Z', duration_ms: 1000,
  }, camera.token);
  return { app, directory, options, get, post, register, start, chunk, finalize };
}
// These are deliberately opaque test bytes, not simulated or claimed camera frames.
const fixtureChunks = [Buffer.from('opaque encoded-video fixture header'), Buffer.from([0, 1, 2, 3, 254, 255])];
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0); let offset = buffer.readUInt32LE(end + 16);
  const result = new Map();
  for (let n = 0; n < buffer.readUInt16LE(end + 10); n++) {
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const nameSize = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString();
    const local = buffer.readUInt32LE(offset + 42), begin = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(begin, begin + size);
    result.set(name, method === 8 ? inflateRawSync(data) : data); offset += 46 + nameSize + extra + comment;
  }
  return result;
}
function openUpload(app, camera, session, index) {
  let resolve, reject;
  const result = new Promise((a, b) => { resolve = a; reject = b; });
  const request = http.request(`${app.url}/api/cameras/${camera.device.metadata.instance_id}/chunks?session_id=${session.session_id}&index=${index}`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', 'X-Camera-Token': camera.token },
  }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) })); });
  request.on('error', reject);
  return { request, result };
}

test('browser camera-only capture preserves exact video, hides tokens and exports original media with metadata', async t => {
  const { app, directory, get, post, register, start, chunk, finalize } = await application(t);
  assert.equal((await get('/api/status')).camera_stop_requires_owner, false);
  const camera = await register();
  assert.equal((await get('/api/status')).camera_stop_requires_owner, false);
  assert.equal(camera.lease_timeout_ms, 20000); assert.equal(camera.chunk_limit_bytes, CAMERA_CHUNK_LIMIT);
  assert.equal((await get('/api/health')).mode, 'browser-camera');
  assert.equal((await get('/api/devices')).devices.find(device => device.id === camera.device.id).mode, 'browser-camera');
  assert.equal(JSON.stringify(await get('/api/cameras')).includes(camera.token), false);
  assert.equal((await post('/api/cameras/phone/heartbeat', {}, 'bad-token')).status, 403);
  assert.equal((await post('/api/sessions/start', { device_ids: [camera.device.id] })).status, 400);
  const session = await start(camera);
  assert.equal(session.status.camera_stop_requires_owner, true);
  assert.deepEqual(session.session.streams, []); assert.equal(session.session.media_streams.length, 1);
  assert.equal((await fetch(`${app.url}/api/files/${session.session_id}/camera-phone.webm.part`)).status, 409);
  for (const [index, bytes] of fixtureChunks.entries()) assert.equal((await chunk(camera, session, index, bytes)).status, 200);
  const status = await get('/api/status');
  assert.equal(status.media_chunk_counts[camera.device.id], 2); assert.equal(status.bytes_written, Buffer.concat(fixtureChunks).length);
  assert.equal((await finalize(camera, session, 2)).status, 200);
  assert.equal((await get('/api/status')).camera_stop_requires_owner, false);
  assert.equal((await chunk(camera, session, 2, Buffer.from('late'))).status, 409);
  const stopped = (await (await post('/api/sessions/stop', { session_id: session.session_id })).json()).session;
  assert.equal(stopped.status, 'complete'); assert.equal(stopped.raw_record_count, 0); assert.equal(stopped.record_count, 2);
  assert.equal(stopped.media_streams[0].file, 'camera-phone.webm');
  const folder = path.join(directory, 'sessions', session.session_id);
  const manifest = await readFile(path.join(folder, 'manifest.json'), 'utf8');
  assert.equal(manifest.includes(camera.token), false); assert.equal(manifest.includes('camera_sources'), false);
  assert.deepEqual(await readFile(path.join(folder, 'camera-phone.webm')), Buffer.concat(fixtureChunks));
  await assert.rejects(stat(path.join(folder, 'camera-phone.webm.part')), { code: 'ENOENT' });
  assert.equal((await fetch(`${app.url}/api/files/${session.session_id}/not-allowed.webm`)).status, 404);
  for (const format of ['json', 'npz']) {
    const job = await app.exports.createJob({ session_id: session.session_id, format });
    await eventually(() => ['complete', 'error'].includes(app.exports.getJob(job.id).status));
    assert.equal(app.exports.getJob(job.id).status, 'complete', app.exports.getJob(job.id).error);
    const archive = unzip(await readFile((await app.exports.download(job.id)).path));
    assert.deepEqual(packageEntry(archive, 'camera-phone.webm'), Buffer.concat(fixtureChunks));
    assert.equal(JSON.parse(archive.get('schema.json')).media_streams[0].chunks, 2);
    assert.ok(![...archive.keys()].some(key => key.endsWith('.npz')));
  }
});

test('camera and installed SDK Mock record one session; NPZ stays raw-only while media bytes are retained', async t => {
  const { app, register, start, chunk, finalize, post } = await application(t, { sdkPath: '' });
  await app.capture.sdkConnect({ product: 'mock' });
  const camera = await register(), session = await start(camera, ['sdk-pressure'], 'video/mp4');
  assert.equal((await chunk(camera, session, 0, fixtureChunks[0], 'video/mp4')).status, 200);
  await eventually(() => app.capture.status().record_counts['sdk-pressure'] >= 2);
  assert.equal((await finalize(camera, session, 1)).status, 200);
  const stopped = (await (await post('/api/sessions/stop', { session_id: session.session_id })).json()).session;
  assert.equal(stopped.status, 'complete'); assert.equal(stopped.source, 'mixed');
  assert.equal(stopped.streams.length, 1); assert.equal(stopped.media_streams[0].file, 'camera-phone.mp4');
  const job = await app.exports.createJob({ session_id: session.session_id, format: 'npz' });
  await eventually(() => ['complete', 'error'].includes(app.exports.getJob(job.id).status));
  assert.equal(app.exports.getJob(job.id).status, 'complete', app.exports.getJob(job.id).error);
  const archive = unzip(await readFile((await app.exports.download(job.id)).path));
  assert.ok(hasPackageEntry(archive, 'sdk-pressure.npz')); assert.deepEqual(packageEntry(archive, 'camera-phone.mp4'), fixtureChunks[0]);
});

test('out-of-order and concurrent chunks are rejected without changing acknowledged bytes; finalize waits for upload', async t => {
  const { app, register, start, chunk, finalize, post, directory } = await application(t);
  const camera = await register(), session = await start(camera);
  assert.equal((await chunk(camera, session, 1, Buffer.from('out-of-order'))).status, 409);
  const upload = openUpload(app, camera, session, 0); upload.request.write(fixtureChunks[0]);
  await eventually(() => Boolean(app.cameras.active.entries.get('phone').pending));
  assert.equal((await chunk(camera, session, 0, Buffer.from('concurrent'))).status, 409);
  const finalizing = finalize(camera, session, 1);
  await eventually(() => Boolean(app.cameras.active.entries.get('phone').finalizing));
  upload.request.end(fixtureChunks[1]);
  assert.equal((await upload.result).status, 200); assert.equal((await finalizing).status, 200);
  const stopped = (await (await post('/api/sessions/stop', { session_id: session.session_id })).json()).session;
  assert.equal(stopped.status, 'complete'); assert.equal(stopped.media_chunk_counts[camera.device.id], 1);
  assert.deepEqual(await readFile(path.join(directory, 'sessions', session.session_id, 'camera-phone.webm')), Buffer.concat(fixtureChunks));
});

test('oversized streamed chunk rolls back to committed bytes and persists incomplete session', async t => {
  const { app, register, start, chunk, post, directory } = await application(t);
  const camera = await register(), session = await start(camera);
  assert.equal((await chunk(camera, session, 0, fixtureChunks[0])).status, 200);
  const upload = openUpload(app, camera, session, 1);
  // Chunked transfer tests the streaming bound independently of Content-Length.
  const block = Buffer.alloc(1024 * 1024, 8);
  for (let n = 0; n < 17; n++) upload.request.write(block);
  upload.request.end();
  assert.equal((await upload.result).status, 413);
  const stopped = (await (await post('/api/sessions/stop', { session_id: session.session_id })).json()).session;
  assert.equal(stopped.status, 'incomplete'); assert.match(stopped.error, /16 MiB/);
  assert.equal(stopped.media_streams[0].chunks, 1);
  assert.deepEqual(await readFile(path.join(directory, 'sessions', session.session_id, 'camera-phone.webm.part')), fixtureChunks[0]);
});

test('stop waits for in-flight upload, preserves partial data and never claims unfinalized video is complete', async t => {
  const { app, register, start, post, directory } = await application(t);
  const camera = await register(), session = await start(camera);
  const upload = openUpload(app, camera, session, 0); upload.request.write(fixtureChunks[0]);
  await eventually(() => Boolean(app.cameras.active.entries.get('phone').pending));
  const stopping = post('/api/sessions/stop', { session_id: session.session_id });
  await eventually(() => app.cameras.active.closing);
  upload.request.end(fixtureChunks[1]); assert.equal((await upload.result).status, 200);
  const stopped = (await (await stopping).json()).session;
  assert.equal(stopped.status, 'incomplete'); assert.match(stopped.error, /not finalized/);
  assert.deepEqual(await readFile(path.join(directory, 'sessions', session.session_id, stopped.media_streams[0].file)), Buffer.concat(fixtureChunks));
});

test('aborted upload rolls back the unfinished chunk and browser error reports remain scoped to the selected source', async t => {
  const { app, register, start, chunk, post, directory } = await application(t);
  const camera = await register(), session = await start(camera);
  assert.equal((await chunk(camera, session, 0, fixtureChunks[0])).status, 200);
  const upload = openUpload(app, camera, session, 1);
  const aborted = upload.result.catch(error => error);
  upload.request.write(fixtureChunks[1]);
  await eventually(() => Boolean(app.cameras.active.entries.get('phone').pending));
  upload.request.destroy(new Error('Test interrupted upload'));
  assert.ok(await aborted instanceof Error);
  await eventually(() => Boolean(app.capture.status().error?.includes('Video upload failed')));
  const saved = (await (await post('/api/sessions/stop', { session_id: session.session_id })).json()).session;
  assert.equal(saved.status, 'incomplete'); assert.equal(saved.media_streams[0].chunks, 1);
  assert.deepEqual(await readFile(path.join(directory, 'sessions', session.session_id, saved.media_streams[0].file)), fixtureChunks[0]);
  const second = await start(camera);
  assert.equal((await post('/api/cameras/phone/error', { session_id: session.session_id, error: 'stale session' }, camera.token)).status, 409);
  assert.equal(app.capture.status().error, null);
  assert.equal((await post('/api/cameras/phone/error', { session_id: second.session_id, error: 'MediaRecorder stopped unexpectedly' }, camera.token)).status, 200);
  await eventually(() => Boolean(app.capture.status().error?.includes('MediaRecorder')));
  assert.equal((await (await post('/api/sessions/stop', { session_id: second.session_id })).json()).session.status, 'incomplete');
});

test('lease expiry isolates unselected camera and marks selected recording incomplete; empty finalize fails', async t => {
  const { app, register, start, chunk, finalize, post, get } = await application(t);
  const camera = await register(), unused = await register('unused'), session = await start(camera, ['sim-imu']);
  app.cameras.leases.get('unused').seen -= 21000; app.cameras.sweep();
  assert.equal((await get('/api/cameras')).devices.find(d => d.id === unused.device.id).connected, false);
  assert.equal(app.capture.status().error, null);
  assert.equal((await chunk(camera, session, 0, fixtureChunks[0])).status, 200);
  app.cameras.leases.get('phone').seen -= 21000; app.cameras.sweep();
  await eventually(() => app.capture.status().error?.includes('heartbeat expired'));
  const stopped = (await (await post('/api/sessions/stop', { session_id: session.session_id })).json()).session;
  assert.equal(stopped.status, 'incomplete');
  const again = await register(), empty = await start(again);
  assert.equal((await finalize(again, empty, 0)).status, 409);
  assert.equal((await (await post('/api/sessions/stop', { session_id: empty.session_id })).json()).session.status, 'incomplete');
});

test('application close persists unfinished media and a clean restart exposes history without leases', async t => {
  const { app, register, start, chunk, options } = await application(t);
  const camera = await register(), session = await start(camera);
  await chunk(camera, session, 0, fixtureChunks[0]);
  await app.close();
  const restarted = await createApplication(options);
  try {
    const saved = await restarted.capture.getSession(session.session_id);
    assert.equal(saved.status, 'incomplete'); assert.equal(saved.finalized, true); assert.equal(saved.media_streams[0].chunks, 1);
    assert.deepEqual(restarted.cameras.devices(), []);
  } finally { await restarted.close(); }
});

test('camera metadata and lease validation reject traversal, stolen sources and over-capacity registration', async t => {
  const { post, register, start, app } = await application(t);
  const camera = await register();
  for (const id of ['../bad', 'UPPER', 'x'.repeat(49), 123, null])
    assert.equal((await post('/api/cameras/register', { instance_id: id, label: 'test', width: 640, height: 480, frame_rate: 30 })).status, 400);
  assert.equal((await post('/api/sessions/start', { device_ids: [camera.device.id], camera_sources: [{ instance_id: 'phone', token: 'wrong', mime_type: 'video/webm' }] })).status, 403);
  for (let n = 1; n < 8; n++) await register(`cam${n}`);
  assert.equal((await post('/api/cameras/register', { instance_id: 'ninth', label: 'test', width: 640, height: 480, frame_rate: 30 })).status, 409);
  const session = await start(camera);
  // Simulate a file preparation failure on a future start without touching real devices.
  await post('/api/sessions/stop', { session_id: session.session_id });
  const prepare = app.cameras.prepare.bind(app.cameras);
  app.cameras.prepare = async (created, sources) => {
    await writeFile(path.join(app.cameras.dataDir, created.id, sources[0].file), 'occupied');
    return prepare(created, sources);
  };
  const failed = await post('/api/sessions/start', { device_ids: [camera.device.id], camera_sources: [{ instance_id: 'phone', token: camera.token, mime_type: 'video/webm' }] });
  assert.equal(failed.status, 500); assert.equal(app.capture.status().session_id, null); assert.equal(app.cameras.active, null);
  const history = await app.capture.listSessions();
  assert.equal(history.length, 2); assert.ok(history.every(item => item.finalized && item.status === 'incomplete'));
  assert.ok(history.some(item => item.id === session.session_id));
});

test('missing browser track settings remain explicitly unknown without fabricating dimensions or frame rate', async t => {
  const { post, start, chunk, finalize } = await application(t);
  const response = await post('/api/cameras/register', { instance_id: 'unknown', label: 'Unknown settings', width: 0, height: 0, frame_rate: 0 });
  assert.equal(response.status, 201);
  const camera = await response.json();
  assert.equal(camera.device.width, 0); assert.equal(camera.device.height, 0); assert.equal(camera.device.sample_rate, 0);
  assert.equal(camera.device.metadata.width_known, false); assert.equal(camera.device.metadata.height_known, false);
  assert.equal(camera.device.metadata.frame_rate_known, false); assert.equal(camera.device.metadata.nominal_frame_rate, null);
  const session = await start(camera);
  assert.equal((await chunk(camera, session, 0, fixtureChunks[0])).status, 200);
  assert.equal((await finalize(camera, session, 1)).status, 200);
  const saved = (await (await post('/api/sessions/stop', { session_id: session.session_id })).json()).session;
  assert.equal(saved.status, 'complete'); assert.equal(saved.media_streams[0].width, 0);
  assert.equal(saved.media_streams[0].metadata.frame_rate_known, false);
});

test('a stale or unbound stop cannot close a newer camera recording before its final chunk', async t => {
  const { app, register, start, chunk, finalize, post, get } = await application(t);
  const camera = await register(), first = await start(camera);
  assert.equal((await chunk(camera, first, 0, fixtureChunks[0])).status, 200);
  assert.equal((await finalize(camera, first, 1)).status, 200);
  assert.equal((await post('/api/sessions/stop', { session_id: first.session_id })).status, 200);

  const second = await start(camera, ['sim-imu']);
  assert.equal((await chunk(camera, second, 0, fixtureChunks[0])).status, 200);
  const delayedStop = await post('/api/sessions/stop', { session_id: first.session_id });
  assert.equal(delayedStop.status, 409, 'an old page must not finalize the new recording');
  assert.equal((await post('/api/sessions/stop', {})).status, 409, 'camera stop must name its recording');
  assert.equal((await get('/api/status')).session_id, second.session_id);
  assert.equal(app.cameras.active.id, second.session_id);
  assert.equal(app.cameras.active.closing, false);
  assert.equal((await chunk(camera, first, 1, fixtureChunks[1])).status, 409, 'late old chunks remain rejected');
  assert.equal((await finalize(camera, first, 1)).status, 409, 'late old finalization remains rejected');
  assert.equal((await chunk(camera, second, 1, fixtureChunks[1])).status, 200);
  assert.equal((await finalize(camera, second, 2)).status, 200);
  const saved = await (await post('/api/sessions/stop', { session_id: second.session_id })).json();
  assert.equal(saved.session.status, 'complete');
  assert.equal(saved.session.media_streams[0].chunks, 2);
});

test('an orphaned multi-camera recording can be closed by session ID after all owners fail or expire', async t => {
  const { app, register, post, chunk, get, directory } = await application(t);
  const first = await register('first'), second = await register('second');
  await register('unused');
  const response = await post('/api/sessions/start', {
    device_ids: [first.device.id, second.device.id, 'sim-imu'],
    camera_sources: [first, second].map(camera => ({
      instance_id: camera.device.metadata.instance_id, token: camera.token, mime_type: 'video/webm',
    })),
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.equal(session.status.camera_stop_requires_owner, true);
  for (const camera of [first, second]) assert.equal((await chunk(camera, session, 0, fixtureChunks[0])).status, 200);

  assert.equal((await post('/api/cameras/first/error', {
    session_id: session.session_id, error: 'Browser encoder was lost',
  }, first.token)).status, 200);
  assert.equal((await get('/api/status')).camera_stop_requires_owner, true, 'a surviving camera still needs its recording page');
  // The original second page disappeared without disconnecting. A status read must observe lease expiry.
  app.cameras.leases.get('second').seen -= 21000;
  const orphan = await get('/api/status');
  assert.equal(orphan.session_id, session.session_id);
  assert.equal(orphan.camera_stop_requires_owner, false);
  assert.equal(app.cameras.leases.get('first').device.connected, true, 'a failed encoder no longer requires its owner');
  assert.equal(app.cameras.leases.get('unused').device.connected, true, 'an unselected preview does not block recovery');
  for (const route of ['/api/preview', '/api/snapshot'])
    assert.equal((await get(route)).status.camera_stop_requires_owner, false);

  assert.equal((await post('/api/sessions/stop', {})).status, 409);
  assert.equal((await post('/api/sessions/stop', { session_id: 'another-session' })).status, 409);
  assert.equal(app.cameras.active.closing, false);
  const stopped = await post('/api/sessions/stop', { session_id: session.session_id });
  assert.equal(stopped.status, 200);
  const saved = await stopped.json();
  assert.equal(saved.session.status, 'incomplete');
  assert.equal(saved.status.camera_stop_requires_owner, false);
  assert.equal(saved.status.session_id, null);
  for (const media of saved.session.media_streams) {
    assert.equal(media.finalized, false); assert.equal(media.chunks, 1);
    assert.deepEqual(await readFile(path.join(directory, 'sessions', session.session_id, media.file)), fixtureChunks[0]);
  }
});
