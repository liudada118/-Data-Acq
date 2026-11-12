import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { PluginManager } from '../src/plugins/manager.mjs';
import { validateManifest } from '../src/plugins/contract.mjs';
import { createStreamQuality } from '../src/plugins/stream-quality.mjs';

// Structural JPEG fixture only: no hardware, native DLL or entropy-decoding claim.
const JPEG = Buffer.from([255,216,255,192,0,17,8,0,2,0,3,3,1,17,0,2,17,0,3,17,0,
  255,218,0,12,3,1,0,2,0,3,0,0,63,0,42,255,0,42,255,217]);
const manifest = { api_version: 1, id: 'binary-preview-fixture', name: 'Synthetic preview camera', version: '1.0.0', entry: 'adapter.mjs',
  streams: [{ id: 'camera', name: 'Synthetic JPEG', kind: 'camera', encoding: 'mjpeg', dtype: 'uint8', shape: [2,3,3], sample_rate: 30 }] };
async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > deadline) assert.fail(message); await delay(10); }
}
async function temporary(t, prefix) {
  const folder = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { assert.ok(path.resolve(folder).startsWith(path.resolve(path.join(os.tmpdir(), prefix)))); await rm(folder, { recursive: true, force: true }); });
  return folder;
}

test('MJPEG snapshots carry metadata only; binary demand never changes accepted recording bytes', async () => {
  const recorded = [], previews = [];
  const manager = new PluginManager({ root: os.tmpdir(), onBatch: batch => recorded.push(batch), onCameraPreview: frame => previews.push(frame) });
  const validated = validateManifest(manifest), stream = validated.streams[0], streamId = 'plugin-fixture-camera';
  const instance = { manifest: validated, descriptors: [{ ...stream, id: streamId, metadata: { plugin_stream_id: stream.id } }],
    counters: new Map(), quality: new Map([[stream.id, createStreamQuality()]]), lastPreview: new Map(), lastCameraPreview: new Map(), previews: {}, received: 0, connected: true };
  manager.instances.set('fixture', instance);
  const accept = payload => manager.accept(instance, { stream_id: stream.id, payload, sample_count: 1 });
  accept(JPEG);
  assert.equal(previews.length, 0, 'no frame transfer without demand');
  assert.equal(instance.previews[streamId].camera.binary_preview, true);
  assert.equal(instance.previews[streamId].camera.preview_status, undefined, 'healthy binary preview has no error status');
  assert.equal(instance.previews[streamId].camera.jpeg_base64, undefined);
  assert.equal(instance.previews[streamId].camera.rgb_base64, undefined);
  manager.setCameraPreviewSubscriptions([{ stream_id: streamId, fps: 100 }]);
  assert.equal(manager.cameraPreviewSubscriptions.get(streamId), 30);
  accept(JPEG); accept(JPEG);
  assert.equal(previews.length, 1, 'high-frequency arrivals are throttled');
  accept(JPEG.subarray(0, -2));
  assert.equal(previews.length, 1, 'invalid JPEGs remain recorded but never become binary previews');
  assert.deepEqual(recorded.at(-1).payload, JPEG.subarray(0, -2));
  await delay(40); accept(JPEG);
  assert.equal(previews.length, 2); assert.deepEqual(previews[0].payload, JPEG);
  assert.equal(previews[0].width, 3); assert.equal(previews[0].height, 2);
  assert.ok(Number.isSafeInteger(previews[0].sequence));
  manager.setCameraPreviewSubscriptions([]);
  await delay(40); accept(JPEG);
  assert.equal(previews.length, 2, 'last unsubscribe stops binary delivery');
  assert.equal(recorded.length, 6, 'recording sees all original arrivals');
});

test('transport bounds each stream to one in-flight and one latest frame; cancellation releases queued frames', { timeout: 10000 }, async t => {
  const directory = await temporary(t, 'binary-preview-transport-');
  const filename = path.join(directory, 'transport-fixture.mjs');
  const transportUrl = new URL('../src/capture/transport.mjs', import.meta.url).href;
  await writeFile(filename, `const transport = await import(${JSON.stringify(transportUrl)});
    transport.setCameraPreviewStreams(['left','right']);
    process.on('message', message => {
      if (message.burst) {
        for (let sequence=0; sequence<10; sequence++) for (const stream_id of ['left','right'])
          transport.sendCameraPreview({stream_id,sequence,payload:Buffer.from([sequence])});
        transport.send({burst_done:true});
      }
      if (message.cancel) { transport.setCameraPreviewStreams([]); transport.send({cancel_done:true}); }
    }); transport.send({ready:true});`);
  const child = fork(filename, [], { execArgv: [], serialization: 'advanced', stdio: ['ignore','ignore','inherit','ipc'], windowsHide: true });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const messages = []; child.on('message', value => messages.push(value));
  child.send({ initialize: { dataDir: directory } });
  await until(() => messages.some(value => value.ready), 'transport did not initialize');
  child.send({ burst: true });
  await until(() => messages.some(value => value.burst_done), 'burst not delivered');
  assert.deepEqual(messages.filter(value => value.camera_preview).map(value => [value.camera_preview.stream_id, value.camera_preview.sequence]), [['left',0], ['right',0]]);
  child.send({ camera_preview_ack: 'left' });
  await until(() => messages.some(value => value.camera_preview?.sequence === 9), 'latest left frame missing');
  assert.deepEqual(messages.filter(value => value.camera_preview).map(value => [value.camera_preview.stream_id, value.camera_preview.sequence]), [['left',0], ['right',0], ['left',9]]);
  child.send({ cancel: true });
  await until(() => messages.some(value => value.cancel_done), 'cancel not processed');
  child.send({ camera_preview_ack: 'right' }); child.send({ camera_preview_ack: 'left' });
  await delay(50);
  assert.equal(messages.filter(value => value.camera_preview).length, 3, 'canceled right latest frame is released');
});

test('engine aggregates subscriber FPS and preserves a rapid replacement after final unsubscribe', async () => {
  const engine = new CaptureEngine({ dataDir: os.tmpdir(), sdkPath: false });
  const messages = [];
  engine.child = { connected: true, send: (message, callback) => { messages.push(message); callback?.(); } };
  engine.init = async () => engine;
  engine.fail = error => { throw error; };
  const low = engine.subscribeCameraPreview('plugin-fixture-camera', () => {}, 5);
  const high = engine.subscribeCameraPreview('plugin-fixture-camera', () => {}, 30);
  await delay(0);
  assert.deepEqual(messages.at(-1).camera_preview_subscriptions, [{ stream_id: 'plugin-fixture-camera', fps: 30 }]);
  high(); await delay(0);
  assert.deepEqual(messages.at(-1).camera_preview_subscriptions, [{ stream_id: 'plugin-fixture-camera', fps: 5 }]);
  low();
  const replacement = engine.subscribeCameraPreview('plugin-fixture-camera', () => {}, 12);
  await delay(0);
  assert.deepEqual(messages.at(-1).camera_preview_subscriptions, [{ stream_id: 'plugin-fixture-camera', fps: 12 }]);
  replacement(); replacement(); await delay(0);
  assert.deepEqual(messages.at(-1).camera_preview_subscriptions, []);
});

test('33ms synthetic source retains available preview frames and unsubscribing leaves recording byte-exact', { timeout: 15000 }, async t => {
  const directory = await temporary(t, 'binary-preview-capture-'), pluginRoot = path.join(directory, 'plugins'), packageDir = path.join(pluginRoot, manifest.id);
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(path.join(packageDir, manifest.entry), `export function createAdapter({emit}) {
    let timer, sequence=0, deadline; const payload=Buffer.from(${JSON.stringify(JPEG.toString('base64'))},'base64');
    // Accumulated 33ms source cadence avoids Windows rounding a bare 33ms
    // setInterval to approximately 47ms on hosts with coarse timer resolution.
    return { start(){deadline=performance.now(); timer=setInterval(()=>{
      const now=performance.now(); if(now<deadline)return; deadline+=33;
      if(now-deadline>33)deadline=now+33;
      emit({stream_id:'camera',sample_count:1,payload,sequence:sequence++});
    },2);}, stop(){clearInterval(timer);} };
  }`);
  const engine = new CaptureEngine({ dataDir: path.join(directory, 'sessions'), pluginRoot, sdkPath: false });
  t.after(() => engine.close());
  await engine.init();
  const connected = await engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'fixture' }), streamId = connected.stream_ids[0];
  const ipcFrames = [];
  engine.child.on('message', message => { if (message.camera_preview) ipcFrames.push(message.camera_preview); });
  await delay(100); assert.equal(ipcFrames.length, 0);
  const received = [];
  const cleanup = engine.subscribeCameraPreview(streamId, frame => received.push(frame), 30);
  await until(() => received.length > 0, 'binary subscription did not produce frames');
  const recording = await engine.start({ device_ids: [streamId] });
  const sourceBefore = (await engine.pluginCatalog()).instances[0].received_records;
  const before = received.length, startedAt = performance.now();
  await delay(1500);
  const sourceFrames = (await engine.pluginCatalog()).instances[0].received_records - sourceBefore;
  const elapsed = (performance.now() - startedAt) / 1000, previewFrames = received.length - before, rate = previewFrames / elapsed, sourceRate = sourceFrames / elapsed;
  t.diagnostic(`Accumulated 33ms source ${sourceRate.toFixed(2)}fps; binary ${rate.toFixed(2)}fps; retained ${previewFrames}/${sourceFrames}`);
  assert.ok(sourceFrames > 0);
  assert.ok(previewFrames + 1 >= sourceFrames * 0.9, `binary must retain at least 90% of available source frames (one IPC-boundary frame tolerance): ${previewFrames}/${sourceFrames}`);
  if (sourceRate >= 25) assert.ok(rate > 22, `adequate 33ms source should retain near-30fps cadence; got ${rate.toFixed(2)}fps from ${sourceRate.toFixed(2)}fps source`);
  assert.ok(rate < 34, `preview exceeds requested cadence: ${rate.toFixed(2)}fps`);
  cleanup(); const count = received.length;
  await delay(150); assert.equal(received.length, count, 'removed listener sees no late callbacks');
  const settledIpc = ipcFrames.length;
  await delay(120); assert.equal(ipcFrames.length, settledIpc, 'last unsubscribe stops IPC frame transmission');
  const stopped = await engine.stop();
  assert.equal(stopped.status, 'complete'); assert.equal(stopped.dropped_records, 0);
  const raw = await readFile(path.join(directory, 'sessions', recording.id, stopped.streams[0].file));
  let offset = 8, records = 0;
  while (offset < raw.length) {
    const bytes = raw.readUInt32LE(offset + 28);
    assert.deepEqual(raw.subarray(offset + 32, offset + 32 + bytes), JPEG);
    records++; offset += 32 + bytes;
  }
  assert.equal(offset, raw.length); assert.equal(records, stopped.streams[0].records); assert.ok(records > received.length - before);
  const snapshot = engine.preview().streams[streamId].camera;
  assert.equal(snapshot.binary_preview, true); assert.equal(snapshot.jpeg_base64, undefined); assert.equal(snapshot.rgb_base64, undefined);
  assert.equal(snapshot.preview_status, undefined);
  const live = received[0]; assert.deepEqual(live.payload, JPEG); assert.ok(Number.isSafeInteger(live.sequence));
  assert.equal(live.stream_id, streamId); assert.equal(live.width, 3); assert.equal(live.height, 2);
  const lastSubscription = engine.subscribeCameraPreview(streamId, () => {}, 10);
  await engine.pluginDisconnect({ instance_id: 'fixture' });
  assert.equal(engine.cameraPreviewListeners.size, 0, 'device disconnect clears subscribers');
  lastSubscription();
});
