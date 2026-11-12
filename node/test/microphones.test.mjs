import { packageEntry } from './helpers/package-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { createApplication } from '../src/server.mjs';
import { CameraManager, WAV_MAX_DATA_BYTES, AUDIO_SEGMENT_MAX_BYTES, AUDIO_SEGMENT_MAX_DURATION_MS } from '../src/cameras.mjs';
import { loadSession } from '../src/exports/reader.mjs';

const values = [-32768, -23456, -1, 0, 1, 12345, 32767];
const pcm = Buffer.alloc(values.length * 2);
values.forEach((value, index) => pcm.writeInt16LE(value, index * 2));
async function eventually(check) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await delay(20); }
  assert.fail('Timed out waiting for microphone state');
}
async function application(t, sdkPath = false, segmentLimits = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synapse-microphone-'));
  const dataDir = path.join(directory, 'sessions');
  const app = await createApplication({ port: 0, sdkPath, dataDir, outputDir: path.join(directory, 'exports') });
  Object.assign(app.cameras, segmentLimits);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const get = async route => (await fetch(app.url + route)).json();
  const post = (route, value, token) => fetch(app.url + route, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { 'X-Camera-Token': token } : {}),
  }, body: JSON.stringify(value) });
  const register = async (id = 'mic', extra = {}) => {
    const response = await post('/api/cameras/register', { kind: 'audio', instance_id: id, label: `Microphone ${id}`,
      sample_rate: 48000, channels: 1, encoding: 'pcm_s16le', ...extra });
    assert.equal(response.status, 201, await response.clone().text()); return response.json();
  };
  const start = async (mic, more = [], sourceMore = []) => {
    const response = await post('/api/sessions/start', { device_ids: [mic.device.id, ...more], camera_sources: [
      { instance_id: mic.device.metadata.instance_id, token: mic.token, mime_type: 'audio/wav' }, ...sourceMore,
    ] });
    assert.equal(response.status, 201, await response.clone().text()); return response.json();
  };
  const chunk = (mic, session, index, bytes) => fetch(`${app.url}/api/cameras/${mic.device.metadata.instance_id}/chunks?session_id=${session.session_id}&index=${index}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Camera-Token': mic.token }, body: bytes,
  });
  const finalize = (mic, session, nextIndex, bytes, extra = {}) => post(`/api/cameras/${mic.device.metadata.instance_id}/finalize`, {
    session_id: session.session_id, next_index: nextIndex, bytes,
    started_at: '2026-11-05T01:00:00.000Z', stopped_at: '2026-11-05T01:00:05.000Z', duration_ms: 5000, ...extra,
  }, mic.token);
  const stop = async session => {
    const response = await post('/api/sessions/stop', { session_id: session.session_id });
    assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).session;
  };
  return { app, directory, dataDir, get, post, register, start, chunk, finalize, stop };
}
function checkWav(file, expected, sampleRate = 48000) {
  assert.equal(file.toString('ascii', 0, 4), 'RIFF'); assert.equal(file.readUInt32LE(4), expected.length + 36);
  assert.equal(file.toString('ascii', 8, 12), 'WAVE'); assert.equal(file.toString('ascii', 12, 16), 'fmt ');
  assert.equal(file.readUInt32LE(16), 16); assert.equal(file.readUInt16LE(20), 1); assert.equal(file.readUInt16LE(22), 1);
  assert.equal(file.readUInt32LE(24), sampleRate); assert.equal(file.readUInt32LE(28), sampleRate * 2);
  assert.equal(file.readUInt16LE(32), 2); assert.equal(file.readUInt16LE(34), 16);
  assert.equal(file.toString('ascii', 36, 40), 'data'); assert.equal(file.readUInt32LE(40), expected.length);
  assert.equal(file.length, expected.length + 44); assert.deepEqual(file.subarray(44), expected);
}
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0); let offset = buffer.readUInt32LE(end + 16); const result = new Map();
  for (let n = 0; n < buffer.readUInt16LE(end + 10); n++) {
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const nameSize = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString();
    const local = buffer.readUInt32LE(offset + 42), begin = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(begin, begin + size); result.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameSize + extra + comment;
  }
  return result;
}
function upload(app, mic, session, index) {
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const request = http.request(`${app.url}/api/cameras/${mic.device.metadata.instance_id}/chunks?session_id=${session.session_id}&index=${index}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Camera-Token': mic.token },
  }, response => { const buffers = []; response.on('data', chunk => buffers.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(buffers)) })); });
  request.on('error', reject); return { request, result };
}

test('microphone-only recording builds true PCM16 WAV, derives duration from samples and exports unchanged media in all formats', async t => {
  const f = await application(t), mic = await f.register(), session = await f.start(mic);
  assert.equal(mic.device.id, 'microphone-mic'); assert.equal(mic.device.mode, 'browser-microphone');
  assert.equal(mic.device.kind, 'audio'); assert.equal(mic.device.sample_rate_known, true);
  assert.equal((await f.get('/api/health')).mode, 'browser-microphone');
  assert.deepEqual(session.session.streams, []); assert.equal(session.session.media_streams[0].bytes, 44);
  const a = await f.chunk(mic, session, 0, pcm.subarray(0, 6)); assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { next_index: 1, bytes_written: 50, payload_bytes: 6, sample_count: 3 });
  assert.equal((await f.chunk(mic, session, 1, pcm.subarray(6))).status, 200);
  const during = await f.get('/api/status');
  assert.equal(during.camera_stop_requires_owner, true); assert.equal(during.media_chunk_counts[mic.device.id], 2);
  assert.equal(during.bytes_written, pcm.length + 44);
  assert.equal((await f.finalize(mic, session, 2, pcm.length)).status, 200);
  assert.equal((await f.get('/api/status')).camera_stop_requires_owner, false);
  const saved = await f.stop(session), media = saved.media_streams[0];
  assert.equal(saved.status, 'complete'); assert.equal(saved.source, 'browser-microphone'); assert.equal(saved.raw_record_count, 0);
  assert.equal(media.sample_count, values.length); assert.equal(media.payload_bytes, pcm.length);
  assert.equal(media.duration_ms, values.length / 48000 * 1000); assert.equal(media.client_duration_ms, 5000);
  const filename = path.join(f.dataDir, saved.id, media.file), file = await readFile(filename); checkWav(file, pcm);
  assert.equal(JSON.stringify(saved).includes(mic.token), false);
  assert.equal((await stat(filename)).size, media.bytes);
  const range = await fetch(`${f.app.url}/api/files/${saved.id}/${media.file}`, { headers: { Range: 'bytes=0-43' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), file.subarray(0, 44));
  const replay = await f.get(`/api/sessions/${saved.id}/replay?time_s=0`);
  assert.equal(replay.media_streams[0].kind, 'audio'); assert.equal(replay.media_streams[0].mime_type, 'audio/wav');
  for (const format of ['wav', 'npz', 'csv', 'json']) {
    const job = await f.app.exports.createJob({ session_id: saved.id, format });
    await eventually(() => ['complete', 'error'].includes(f.app.exports.getJob(job.id).status));
    assert.equal(f.app.exports.getJob(job.id).status, 'complete', f.app.exports.getJob(job.id).error);
    const archive = unzip(await readFile((await f.app.exports.download(job.id)).path));
    assert.deepEqual(packageEntry(archive, media.file), file);
    assert.equal(JSON.parse(archive.get('schema.json')).media_streams[0].sample_count, values.length);
  }
  const corrupt = Buffer.from(file); corrupt.writeUInt32LE(123, 24); await writeFile(filename, corrupt);
  await assert.rejects(loadSession(f.dataDir, saved.id), /WAV header/);
});

test('microphone, camera and installed SDK Mock share one session without fake microphone mdaq streams', async t => {
  const f = await application(t, ''), mic = await f.register();
  await f.app.capture.sdkConnect({ product: 'mock' });
  const response = await f.post('/api/cameras/register', { instance_id: 'video', label: 'Opaque test video', width: 320, height: 240, frame_rate: 30 });
  const camera = await response.json(); assert.equal(response.status, 201);
  const session = await f.start(mic, ['camera-video', 'sdk-pressure'], [{ instance_id: 'video', token: camera.token, mime_type: 'video/webm' }]);
  assert.equal((await f.chunk(mic, session, 0, pcm)).status, 200);
  const video = await fetch(`${f.app.url}/api/cameras/video/chunks?session_id=${session.session_id}&index=0`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', 'X-Camera-Token': camera.token }, body: Buffer.from('opaque video fixture'),
  });
  assert.equal(video.status, 200);
  await eventually(() => f.app.capture.status().record_counts['sdk-pressure'] >= 2);
  assert.equal((await f.finalize(mic, session, 1, pcm.length)).status, 200);
  assert.equal((await f.post('/api/cameras/video/finalize', { session_id: session.session_id, next_index: 1,
    started_at: '2026-11-05T01:00:00Z', stopped_at: '2026-11-05T01:00:01Z', duration_ms: 1000 }, camera.token)).status, 200);
  const saved = await f.stop(session);
  assert.equal(saved.status, 'complete'); assert.equal(saved.source, 'mixed');
  assert.deepEqual(saved.streams.map(stream => stream.id), ['sdk-pressure']); assert.equal(saved.media_streams.length, 2);
  assert.deepEqual(new Set(saved.device_ids), new Set(['microphone-mic', 'camera-video', 'sdk-pressure']));
  assert.ok(saved.assets.some(asset => asset.role === 'browser-microphone-audio'));
  assert.ok(saved.assets.some(asset => asset.role === 'browser-camera-video'));
});

test('microphone upload order is enforced and finalize waits for a complete sample across a WAV rollover', async t => {
  const f = await application(t, false, { audioSegmentMaxBytes: pcm.length }), mic = await f.register(), session = await f.start(mic);
  assert.equal((await f.chunk(mic, session, 1, pcm)).status, 409);
  assert.equal((await f.chunk(mic, session, 0, pcm)).status, 200);
  const pending = upload(f.app, mic, session, 1); pending.request.write(pcm.subarray(0, 1));
  await eventually(() => Boolean(f.app.cameras.active.entries.get('mic').pending));
  assert.equal(f.app.cameras.update().media_streams[0].segments.length, 1, 'Do not rotate until the complete PCM upload is available');
  assert.equal((await f.chunk(mic, session, 1, pcm)).status, 409);
  const finish = f.finalize(mic, session, 2, pcm.length * 2);
  await eventually(() => Boolean(f.app.cameras.active.entries.get('mic').finalizing));
  pending.request.end(pcm.subarray(1));
  assert.equal((await pending.result).status, 200); assert.equal((await finish).status, 200);
  const saved = await f.stop(session); assert.equal(saved.status, 'complete');
  assert.equal(saved.media_streams[0].segments.length, 2);
  for (const segment of saved.media_streams[0].segments) checkWav(await readFile(path.join(f.dataDir, saved.id, segment.file)), pcm);
});

test('direct session stop drains in-flight PCM and repairs an unfinalized WAV as incomplete', async t => {
  const f = await application(t, false, { audioSegmentMaxBytes: pcm.length }), mic = await f.register(), session = await f.start(mic);
  assert.equal((await f.chunk(mic, session, 0, pcm)).status, 200);
  const pending = upload(f.app, mic, session, 1); pending.request.write(pcm.subarray(0, 4));
  await eventually(() => Boolean(f.app.cameras.active.entries.get('mic').pending));
  const stop = f.stop(session); await eventually(() => f.app.cameras.active.closing);
  pending.request.end(pcm.subarray(4)); assert.equal((await pending.result).status, 200);
  const saved = await stop; assert.equal(saved.status, 'incomplete'); assert.equal(saved.media_streams[0].finalized, false);
  const segments = saved.media_streams[0].segments;
  assert.deepEqual(segments.map(segment => segment.finalized), [true, false]);
  assert.equal(segments[0].error, null); assert.match(segments[1].error, /not finalized/);
  for (const segment of segments) checkWav(await readFile(path.join(f.dataDir, saved.id, segment.file)), pcm);
});

test('PCM alignment, mismatched final byte counts and recorder errors never finalize or damage acknowledged data', async t => {
  const f = await application(t), mic = await f.register();
  for (const reason of ['alignment', 'byte-count', 'browser-error']) {
    const session = await f.start(mic); assert.equal((await f.chunk(mic, session, 0, pcm)).status, 200);
    if (reason === 'alignment') assert.equal((await f.chunk(mic, session, 1, Buffer.from([1]))).status, 400);
    else if (reason === 'byte-count') assert.equal((await f.finalize(mic, session, 1, pcm.length + 2)).status, 409);
    else {
      assert.equal((await f.post('/api/cameras/mic/error', { session_id: session.session_id, error: 'AudioWorklet overflow' }, mic.token)).status, 200);
      assert.equal((await f.finalize(mic, session, 1, pcm.length)).status, 409);
    }
    const saved = await f.stop(session); assert.equal(saved.status, 'incomplete'); assert.equal(saved.media_streams[0].finalized, false);
    assert.equal(saved.media_streams[0].sample_count, values.length);
    checkWav(await readFile(path.join(f.dataDir, saved.id, saved.media_streams[0].file)), pcm);
  }
});

test('expired microphone owner permits recovery stop and application shutdown keeps partial WAV recoverable', async t => {
  const f = await application(t), mic = await f.register(), session = await f.start(mic);
  await f.chunk(mic, session, 0, pcm);
  f.app.cameras.leases.get('mic').seen -= 21000; f.app.cameras.sweep();
  await eventually(() => f.app.capture.status().error?.includes('heartbeat expired'));
  assert.equal((await f.get('/api/status')).camera_stop_requires_owner, false);
  assert.equal((await f.finalize(mic, session, 1, pcm.length)).status, 409);
  const saved = await f.stop(session); assert.equal(saved.status, 'incomplete');
  const next = await f.register(), nextSession = await f.start(next);
  const pending = upload(f.app, next, nextSession, 0); pending.request.write(pcm.subarray(0, 4));
  await eventually(() => Boolean(f.app.cameras.active.entries.get('mic').pending));
  let closed = false;
  const closing = f.app.close().then(() => { closed = true; });
  await eventually(() => f.app.cameras.active.closing);
  await delay(30); assert.equal(closed, false, 'Shutdown must await accepted PCM before closing HTTP sockets');
  pending.request.end(pcm.subarray(4)); assert.equal((await pending.result).status, 200);
  await closing;
  const final = JSON.parse(await readFile(path.join(f.dataDir, nextSession.session_id, 'manifest.json'), 'utf8'));
  assert.equal(final.status, 'incomplete'); assert.equal(final.finalized, true);
  checkWav(await readFile(path.join(f.dataDir, final.id, final.media_streams[0].file)), pcm);
});

test('invalid audio settings and unsafe segment limits are refused; default WAV boundaries are below RIFF limits', async t => {
  const f = await application(t);
  for (const extra of [{ sample_rate: 0 }, { sample_rate: 48000.5 }, { channels: 2 }, { encoding: 'float32' }]) {
    const response = await f.post('/api/cameras/register', { kind: 'audio', instance_id: 'invalid', label: 'Invalid', sample_rate: 48000, channels: 1, ...extra });
    assert.equal(response.status, 400);
  }
  const manager = new CameraManager({ dataDir: f.dataDir });
  try {
    assert.equal(manager.audioSegmentMaxBytes, AUDIO_SEGMENT_MAX_BYTES);
    assert.equal(manager.audioSegmentMaxDurationMs, AUDIO_SEGMENT_MAX_DURATION_MS);
    assert.equal(manager.audioSegmentLimit({ channels: 1, sample_rate: 48000 }), 48000 * 2 * 3600);
    assert.equal(manager.audioSegmentLimit({ channels: 1, sample_rate: 384000 }), 1024 * 1024 * 1024);
    assert.ok(manager.audioSegmentLimit({ channels: 1, sample_rate: 384000 }) < WAV_MAX_DATA_BYTES);
    for (const limits of [{ audioSegmentMaxBytes: 3 }, { audioSegmentMaxBytes: WAV_MAX_DATA_BYTES + 2 },
      { audioSegmentMaxDurationMs: 0 }, { audioSegmentMaxDurationMs: Infinity }])
      assert.throws(() => new CameraManager({ dataDir: f.dataDir, ...limits }), /Invalid audio segment limits/);
    const tiny = new CameraManager({ dataDir: f.dataDir, audioSegmentMaxBytes: 8, audioSegmentMaxDurationMs: 1 });
    assert.equal(tiny.audioSegmentLimit({ channels: 1, sample_rate: 48000 }), 8); await tiny.close();
  } finally { await manager.close(); }
});

test('WAV rollover preserves every PCM sample, unique assets, cumulative counters and exact sample offsets', async t => {
  const f = await application(t, false, { audioSegmentMaxBytes: 8 }), mic = await f.register(), session = await f.start(mic);
  const chunks = [pcm.subarray(0, 4), pcm.subarray(4, 8), pcm.subarray(8), pcm.subarray(0, 4)];
  for (const [index, chunk] of chunks.entries()) {
    const response = await f.chunk(mic, session, index, chunk); assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).payload_bytes, chunks.slice(0, index + 1).reduce((sum, item) => sum + item.length, 0));
  }
  assert.equal((await f.chunk(mic, session, 3, pcm.subarray(0, 2))).status, 409);
  const current = f.app.cameras.update(), stream = current.media_streams[0];
  assert.equal(stream.segments.length, 3); assert.deepEqual(stream.segments.map(segment => segment.start_sample), [0, 4, 7]);
  assert.deepEqual(stream.segments.map(segment => segment.finalized), [true, true, false]);
  assert.equal(stream.file, 'microphone-mic.wav');
  const tampered = structuredClone(current); tampered.media_streams[0].segments[1].file = '../outside.wav';
  await assert.rejects(f.app.capture.mediaUpdate(tampered), /Invalid PCM media counters/);
  const wrongOffset = structuredClone(current); wrongOffset.media_streams[0].segments[1].start_sample++;
  await assert.rejects(f.app.capture.mediaUpdate(wrongOffset), /Invalid PCM media counters/);
  assert.equal((await f.finalize(mic, session, chunks.length, 18)).status, 200);
  const saved = await f.stop(session), media = saved.media_streams[0];
  assert.equal(saved.status, 'complete'); assert.equal(media.chunks, 4); assert.equal(media.sample_count, 9);
  assert.equal(media.payload_bytes, 18); assert.equal(media.bytes, 18 + 3 * 44);
  assert.equal(saved.bytes_written, media.bytes); assert.equal(media.duration_ms, 9 / 48000 * 1000);
  assert.deepEqual(saved.assets.map(asset => asset.file), ['microphone-mic.wav', 'microphone-mic-000002.wav', 'microphone-mic-000003.wav']);
  assert.deepEqual(saved.assets.map(asset => asset.segment_index), [0, 1, 2]);
  const payloads = [];
  for (const segment of media.segments) {
    const file = await readFile(path.join(f.dataDir, saved.id, segment.file));
    const expected = Buffer.concat(chunks).subarray(segment.start_sample * 2, (segment.start_sample + segment.sample_count) * 2);
    checkWav(file, expected); payloads.push(file.subarray(44));
    assert.equal(segment.bytes, file.length); assert.equal(segment.finalized, true); assert.equal(segment.error, null);
    assert.equal(segment.duration_ms, segment.sample_count / 48000 * 1000);
  }
  assert.deepEqual(Buffer.concat(payloads), Buffer.concat(chunks));
});

test('sample-clock duration rotates WAV before the byte limit and never creates an empty tail on exact boundaries', async t => {
  const f = await application(t, false, { audioSegmentMaxBytes: 1024, audioSegmentMaxDurationMs: 1 });
  const mic = await f.register('mic', { sample_rate: 8000 }), session = await f.start(mic);
  const chunk = Buffer.alloc(8, 5);
  for (let index = 0; index < 4; index++) assert.equal((await f.chunk(mic, session, index, chunk)).status, 200);
  assert.equal((await f.finalize(mic, session, 4, 32)).status, 200);
  const saved = await f.stop(session), media = saved.media_streams[0];
  assert.equal(saved.status, 'complete'); assert.equal(media.segments.length, 2);
  assert.deepEqual(media.segments.map(segment => segment.duration_ms), [1, 1]);
  assert.deepEqual(media.segments.map(segment => segment.start_sample), [0, 8]);
  assert.equal(media.duration_ms, 2);
  for (const segment of media.segments) checkWav(await readFile(path.join(f.dataDir, saved.id, segment.file)), Buffer.concat([chunk, chunk]), 8000);
});

test('an aborted or misaligned rollover upload cannot rename or corrupt the last acknowledged WAV', async t => {
  const f = await application(t, false, { audioSegmentMaxBytes: pcm.length }), mic = await f.register();
  for (const reason of ['abort', 'alignment', 'oversized']) {
    const session = await f.start(mic); assert.equal((await f.chunk(mic, session, 0, pcm)).status, 200);
    const pending = upload(f.app, mic, session, 1);
    const failed = pending.result.catch(error => error);
    pending.request.write(pcm.subarray(0, 1));
    await eventually(() => Boolean(f.app.cameras.active.entries.get('mic').pending));
    if (reason === 'abort') pending.request.destroy();
    else if (reason === 'alignment') pending.request.end();
    else pending.request.end(Buffer.alloc(pcm.length));
    const result = await failed;
    if (reason !== 'abort') assert.equal(result.status, reason === 'alignment' ? 400 : 413);
    await eventually(() => Boolean(f.app.cameras.update().media_streams[0].error));
    const saved = await f.stop(session), media = saved.media_streams[0];
    assert.equal(saved.status, 'incomplete'); assert.equal(media.chunks, 1); assert.equal(media.segments.length, 1);
    assert.equal(media.file, 'microphone-mic.wav.part'); assert.equal(media.segments[0].finalized, false);
    assert.equal(media.payload_bytes, pcm.length); checkWav(await readFile(path.join(f.dataDir, saved.id, media.file)), pcm);
  }
});

test('failed storage on a new WAV segment preserves completed segments and rolls back only the unacknowledged chunk', async t => {
  const f = await application(t, false, { audioSegmentMaxBytes: pcm.length }), mic = await f.register(), session = await f.start(mic);
  assert.equal((await f.chunk(mic, session, 0, pcm)).status, 200);
  const openSegment = f.app.cameras.openAudioSegment.bind(f.app.cameras);
  f.app.cameras.openAudioSegment = async entry => {
    await openSegment(entry);
    const write = entry.handle.write.bind(entry.handle); let rejected = false;
    entry.handle.write = async (...args) => {
      if (args[3] >= 44 && !rejected) { rejected = true; await write(args[0], args[1], 2, args[3]); throw new Error('Injected PCM storage failure'); }
      return write(...args);
    };
  };
  assert.equal((await f.chunk(mic, session, 1, pcm)).status, 500);
  assert.equal((await f.finalize(mic, session, 1, pcm.length)).status, 409);
  const saved = await f.stop(session), media = saved.media_streams[0], [first, last] = media.segments;
  assert.equal(saved.status, 'incomplete'); assert.match(saved.error, /Injected PCM storage failure/);
  assert.equal(media.chunks, 1); assert.equal(media.sample_count, values.length); assert.equal(media.bytes, pcm.length + 88);
  assert.equal(first.finalized, true); assert.equal(first.error, null); assert.equal(last.finalized, false);
  assert.match(last.error, /Injected PCM storage failure/); assert.equal(last.start_sample, values.length); assert.equal(last.sample_count, 0);
  checkWav(await readFile(path.join(f.dataDir, saved.id, first.file)), pcm);
  checkWav(await readFile(path.join(f.dataDir, saved.id, last.file)), Buffer.alloc(0));
  assert.equal(saved.assets.length, 2);
});
