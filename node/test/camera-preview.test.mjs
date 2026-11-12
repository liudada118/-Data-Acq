import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { CameraPreviewService, CAMERA_PREVIEW_MIME, MAX_CAMERA_PREVIEW_BYTES } from '../src/camera-preview.mjs';
import { createApplication } from '../src/server.mjs';

const camera = (id = 'plugin-camera-left') => ({ id, kind: 'camera', modality: 'camera', mode: 'sdk-plugin', connected: true,
  metadata: { encoding: 'mjpeg', pixel_format: 'mjpeg' } });
const frame = (sequence = 1, stream_id = 'plugin-camera-left') => ({ stream_id, sequence, width: 1600, height: 1200,
  timestamp_s: sequence / 30, payload: Buffer.from([0xff, 0xd8, sequence & 255, 0xff, 0xd9]) });

function fixture(devices = [camera()]) {
  const listeners = new Set(); let removed = 0;
  const capture = { devices: () => devices, subscribeCameraPreview(streamId, listener, fps) {
    const entry = { streamId, listener, fps }; listeners.add(entry);
    return () => { if (listeners.delete(entry)) removed++; };
  } };
  return { capture, listeners, get removed() { return removed; }, emit(value) {
    for (const entry of listeners) if (entry.streamId === value.stream_id) entry.listener(value);
  } };
}

class Response extends EventEmitter {
  constructor() { super(); this.chunks = []; this.block = false; this.destroyed = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() { this.flushed = true; }
  cork() {}
  uncork() {}
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return !this.block; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}

function packets(chunks) {
  const bytes = Buffer.concat(chunks), result = []; let offset = 0;
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset); assert.ok(length > 0 && length <= 4096); offset += 4;
    const header = JSON.parse(bytes.subarray(offset, offset + length).toString('utf8')); offset += length;
    const payload = bytes.subarray(offset, offset + header.payload_bytes); offset += header.payload_bytes;
    assert.equal(payload.length, header.payload_bytes); result.push({ header, payload });
  }
  assert.equal(offset, bytes.length); return result;
}

test('binary camera preview frames carry bounded JSON metadata and the unchanged JPEG bytes', () => {
  const source = fixture(), service = new CameraPreviewService(source), request = new EventEmitter(), response = new Response();
  service.open(request, response, 'plugin-camera-left', 24);
  assert.equal(response.status, 200); assert.equal(response.headers['Content-Type'], CAMERA_PREVIEW_MIME);
  assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(response.flushed, true);
  assert.equal([...source.listeners][0].fps, 24);
  // A GET request finishing does not mean its long-lived response was cancelled.
  request.emit('close'); assert.equal(source.listeners.size, 1);
  const value = frame(); source.emit(value);
  const [received] = packets(response.chunks);
  assert.deepEqual(received.header, { sequence: 1, width: 1600, height: 1200, timestamp_s: 1 / 30, payload_bytes: value.payload.length });
  assert.deepEqual(received.payload, value.payload);
  response.destroy(); assert.equal(source.listeners.size, 0); assert.equal(source.removed, 1);
  assert.equal(service.clients.size, 0); service.close(); assert.equal(source.removed, 1);
});

test('slow clients retain only the newest pending frame and never block another viewer', () => {
  const source = fixture(), service = new CameraPreviewService(source), slow = new Response(), fast = new Response();
  service.open(new EventEmitter(), slow, 'plugin-camera-left');
  service.open(new EventEmitter(), fast, 'plugin-camera-left');
  slow.block = true; source.emit(frame(1));
  for (let sequence = 2; sequence <= 100; sequence++) source.emit(frame(sequence));
  assert.equal(packets(slow.chunks).length, 1);
  const pending = [...service.clients].find(client => client.blocked).pending;
  assert.ok(pending.payload.byteLength <= MAX_CAMERA_PREVIEW_BYTES);
  assert.equal(packets(fast.chunks).length, 100);
  slow.block = false; slow.emit('drain');
  assert.deepEqual(packets(slow.chunks).map(item => item.header.sequence), [1, 100]);
  assert.equal([...service.clients].find(client => client.streamId === 'plugin-camera-left').pending, null);
  service.close(); assert.equal(source.removed, 2);
});

test('disconnection and shutdown cancel every subscription, including a blocked response', () => {
  const source = fixture(), service = new CameraPreviewService(source), request = new EventEmitter(), response = new Response();
  service.open(request, response, 'plugin-camera-left'); request.emit('aborted');
  assert.equal(source.removed, 1); assert.equal(response.listenerCount('drain'), 0);
  const blocked = new Response(); blocked.block = true;
  service.open(new EventEmitter(), blocked, 'plugin-camera-left'); source.emit(frame()); source.emit(frame(2));
  service.close(); service.close();
  assert.equal(blocked.destroyed, true); assert.equal(service.clients.size, 0); assert.equal(source.removed, 2);
  assert.throws(() => service.open(new EventEmitter(), new Response(), 'plugin-camera-left'), { statusCode: 503 });
});

test('preview rejects unsupported sources, invalid identities/rates, and excess clients before subscribing', () => {
  const devices = [camera(), camera('plugin-camera-right'), camera('plugin-camera-third'),
    { ...camera('rgb'), metadata: { encoding: 'rgb8' } }, { ...camera('offline'), connected: false },
    { ...camera('browser'), mode: 'browser-camera' }, { ...camera('pressure'), kind: 'pressure', modality: 'pressure' }];
  const source = fixture(devices), service = new CameraPreviewService(source);
  const open = (id, fps) => service.open(new EventEmitter(), new Response(), id, fps);
  for (const id of ['', '..', 'bad/path', 'x'.repeat(101)]) assert.throws(() => open(id), { statusCode: 400 });
  assert.throws(() => open('missing'), { statusCode: 404 });
  assert.throws(() => open('offline'), { statusCode: 409 });
  for (const id of ['rgb', 'browser', 'pressure']) assert.throws(() => open(id), { statusCode: 415 });
  for (const fps of [0, 31, 2.5, 'NaN', Infinity]) assert.throws(() => open('plugin-camera-left', fps), { statusCode: 400 });
  assert.equal(source.listeners.size, 0);
  for (let index = 0; index < 4; index++) open('plugin-camera-left');
  assert.throws(() => open('plugin-camera-left'), { statusCode: 429 });
  for (let index = 0; index < 4; index++) open('plugin-camera-right');
  assert.throws(() => open('plugin-camera-third'), { statusCode: 429 });
  service.close(); assert.equal(source.listeners.size, 0);
});

test('oversized or malformed frames are skipped without queuing bytes or changing valid packets', () => {
  const source = fixture(), service = new CameraPreviewService(source), response = new Response();
  service.open(new EventEmitter(), response, 'plugin-camera-left');
  const value = frame();
  for (const changed of [ { payload: Buffer.alloc(MAX_CAMERA_PREVIEW_BYTES + 1) }, { payload: Buffer.alloc(0) },
    { sequence: -1 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { sequence: '1' }, { width: 0 },
    { timestamp_s: NaN }, { payload: [] } ]) source.emit({ ...value, ...changed });
  assert.equal(response.chunks.length, 0);
  source.emit(value); assert.equal(packets(response.chunks).length, 1); service.close();
});

test('HTTP streaming uses the existing local-origin boundary and closes an active stream during application shutdown', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shroom-camera-preview-'));
  let app, clientRequest, incoming;
  t.after(async () => { incoming?.destroy(); clientRequest?.destroy(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  app = await createApplication({ port: 0, sdkPath: false, dataDir: path.join(root, 'sessions'), outputDir: path.join(root, 'exports') });
  const source = fixture();
  app.capture.devices = source.capture.devices;
  app.capture.subscribeCameraPreview = source.capture.subscribeCameraPreview;
  const endpoint = `${app.url}/api/preview/cameras/plugin-camera-left?fps=30`;
  const forbidden = await fetch(endpoint, { headers: { Origin: 'https://example.invalid' } });
  assert.equal(forbidden.status, 403); assert.equal(source.listeners.size, 0);
  assert.equal((await fetch(`${app.url}/api/preview/cameras/unknown`)).status, 404);
  const wrongHost = await new Promise((resolve, reject) => {
    http.get(endpoint, { headers: { Host: 'example.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).once('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${app.url}/api/preview/cameras/plugin-camera-left?fps=99`)).status, 400);
  incoming = await new Promise((resolve, reject) => {
    clientRequest = http.get(endpoint, resolve); clientRequest.once('error', reject);
  });
  assert.equal(incoming.headers['content-type'], CAMERA_PREVIEW_MIME);
  const chunks = []; incoming.on('error', () => {});
  const gotBytes = new Promise(resolve => incoming.on('data', chunk => {
    chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (bytes.length < 4) return;
    const headerLength = bytes.readUInt32LE(0);
    if (bytes.length < 4 + headerLength) return;
    const header = JSON.parse(bytes.subarray(4, 4 + headerLength));
    if (bytes.length >= 4 + headerLength + header.payload_bytes) resolve();
  }));
  source.emit(frame()); await gotBytes;
  const expected = frame(), received = packets(chunks);
  assert.equal(received[0].header.payload_bytes, expected.payload.length); assert.deepEqual(received[0].payload, expected.payload);
  assert.equal(source.listeners.size, 1);
  const closed = new Promise(resolve => incoming.once('close', resolve));
  await app.close(); await closed;
  assert.equal(source.listeners.size, 0); assert.equal(source.removed, 1); assert.equal(app.server.listening, false);
});
