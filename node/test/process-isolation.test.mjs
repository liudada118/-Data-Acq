import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../src/server.mjs';

async function eventually(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  assert.fail(message);
}

test('capture process failure leaves HTTP, static UI and exports usable and marks interrupted recording on restart', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'synapse-process-isolation-'));
  const options = { port: 0, dataDir: path.join(root, 'sessions'), outputDir: path.join(root, 'exports'), webDir: path.join(root, 'web') };
  await mkdir(options.webDir);
  await writeFile(path.join(options.webDir, 'index.html'), '<!doctype html><html><body>Capture isolation test</body></html>');
  let app;
  t.after(async () => { if (app) await app.close(); await rm(root, { recursive: true, force: true }); });
  app = await createApplication(options);
  const get = endpoint => fetch(app.url + endpoint, { signal: AbortSignal.timeout(2000) });
  const post = (endpoint, body) => fetch(app.url + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
  });
  const readJson = async endpoint => {
    const response = await get(endpoint);
    assert.equal(response.status, 200, endpoint);
    return response.json();
  };

  assert.ok(app.capture.child?.pid, 'capture runs in a child process');
  assert.notEqual(app.capture.child.pid, process.pid, 'capture PID differs from HTTP process');
  const connected = await post('/api/sdk/connect', { mode: 'mock' });
  assert.equal(connected.status, 200);
  await eventually(async () => (await readJson('/api/sdk/info')).frames >= 2, 'SDK mock should provide frames');
  assert.equal((await readJson('/api/sdk/info')).connected, true);

  // A completed recording and export remain useful if a later capture process fails.
  const firstStart = await post('/api/sessions/start', { name: 'Completed before capture failure', device_ids: ['sdk-pressure'] });
  assert.equal(firstStart.status, 201);
  const firstId = (await firstStart.json()).session_id;
  await eventually(async () => (await readJson('/api/status')).record_counts['sdk-pressure'] >= 3, 'first recording should contain frames');
  const stopped = await post('/api/sessions/stop', {});
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).session.status, 'complete');
  const accepted = await post('/api/export/jobs', { session_id: firstId, format: 'npz' });
  assert.equal(accepted.status, 202);
  const job = await accepted.json();

  const secondStart = await post('/api/sessions/start', { name: 'Interrupted by capture failure', device_ids: ['sdk-pressure', 'sim-imu'] });
  assert.equal(secondStart.status, 201);
  const secondId = (await secondStart.json()).session_id;
  await eventually(async () => (await readJson('/api/status')).record_counts['sdk-pressure'] >= 3, 'second recording should contain frames');
  assert.ok((await readJson('/api/preview')).streams['sdk-pressure']);

  // Terminate only the child created by this isolated test, simulating a fatal native-addon crash.
  const child = app.capture.child;
  const childExited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  await childExited;
  await eventually(async () => (await readJson('/api/status')).state === 'error', 'HTTP should report capture failure');
  const status = await readJson('/api/status');
  assert.equal(status.engine_alive, false);
  assert.equal(status.session_id, secondId, 'failed active session remains identifiable');
  assert.ok(status.error);
  const health = await readJson('/api/health');
  assert.equal(health.service, 'synapse-node');
  assert.equal(health.engine_alive, false);
  assert.ok(health.capture_error);
  assert.equal(health.mode, 'error');
  assert.equal(health.hardware_connected, false);
  const sdk = await readJson('/api/sdk/info');
  assert.equal(sdk.connected, false);
  assert.equal(sdk.has_device, false);
  assert.ok(sdk.error);
  const devices = (await readJson('/api/devices')).devices;
  assert.ok(devices.every(device => device.connected === false), 'no stale connected devices after process exit');
  const preview = await readJson('/api/preview');
  assert.deepEqual(preview.streams ?? {}, {}, 'stale live frames are cleared');
  for (const kind of ['pressure', 'audio', 'imu', 'camera']) assert.equal(preview[kind], undefined);
  assert.equal(preview.status.state, 'error');

  for (const [endpoint, body] of [
    ['/api/sessions/start', { device_ids: ['sim-imu'] }],
    ['/api/sessions/stop', {}],
    ['/api/sdk/connect', { mode: 'mock' }],
  ]) {
    const response = await post(endpoint, body);
    assert.equal(response.status, 503, endpoint);
    assert.ok((await response.json()).error);
  }
  assert.match(await (await get('/')).text(), /Capture isolation test/);
  assert.ok((await readJson('/api/export/formats')).formats.some(format => format.id === 'npz' && format.available));
  let completed;
  await eventually(async () => {
    completed = await readJson(`/api/export/jobs/${job.id}`);
    return ['complete', 'error'].includes(completed.status);
  }, 'independent export should finish after capture child dies');
  assert.equal(completed.status, 'complete', completed.error);
  const download = await get(completed.download_url);
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(await download.arrayBuffer()).readUInt32LE(0), 0x04034b50);

  const unfinished = JSON.parse(await readFile(path.join(options.dataDir, secondId, 'manifest.json'), 'utf8'));
  assert.equal(unfinished.finalized, false, 'abrupt exit must not falsely finalize an active recording');
  await app.close();
  app = await createApplication({ ...options, sdkPath: false });
  const recovered = await readJson(`/api/sessions/${secondId}`);
  assert.equal(recovered.status, 'incomplete');
  assert.equal(recovered.finalized, true);
  assert.ok(recovered.error);
  assert.equal((await readJson(`/api/sessions/${firstId}`)).status, 'complete');
  assert.equal((await get(completed.download_url)).status, 200);
  const invalidExport = await post('/api/export/jobs', { session_id: secondId, format: 'npz' });
  assert.equal(invalidExport.status, 400, 'incomplete capture cannot be silently exported as complete');
});
