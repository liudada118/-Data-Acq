import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../src/server.mjs';
import { startupStatus } from '../src/startup-status.mjs';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { CameraManager } from '../src/cameras.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synapse-node-startup-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('synapse-node-startup-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, port: server.address().port, requests };
}

function healthResponse(response, health, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(health));
}

async function runCli(t, { port, dataDir, outputDir = path.join(dataDir, '..', 'exports') }) {
  const child = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, EXPORT_DIR: outputDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Duplicate-start CLI did not exit')); }, 8000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

test('duplicate CLI start reports existing URL and leaves the same-directory recording active', { timeout: 15000 }, async t => {
  const directory = await temporary(t), dataDir = path.join(directory, 'sessions');
  const app = await createApplication({ port: 0, sdkPath: false, dataDir, outputDir: path.join(directory, 'exports') });
  t.after(() => app.close());
  const active = await app.capture.start({ device_ids: ['sim-imu'], name: 'keep existing recording' });
  await delay(75);
  const before = app.capture.status();
  const result = await runCli(t, { port: app.port, dataDir });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已在运行/);
  assert.ok(result.stdout.includes(app.url));
  assert.match(result.stdout, /现有服务和录制继续运行/);
  assert.equal(result.stderr, '');
  const status = app.capture.status();
  assert.equal(status.session_id, active.id);
  assert.equal(status.state, 'recording');
  assert.ok(status.record_counts['sim-imu'] >= before.record_counts['sim-imu']);
  assert.equal(app.server.listening, true);
  const saved = await app.capture.stop();
  assert.equal(saved.finalized, true);
});

test('same-directory recognition normalizes trailing separators and Windows path case', async t => {
  const dataDir = await temporary(t);
  const claimedDirectory = (process.platform === 'win32' ? dataDir.toUpperCase() : dataDir) + path.sep;
  const existing = await fixture(t, (_request, response) => healthResponse(response,
    { service: 'synapse-node', engine_alive: true, data_dir: claimedDirectory }));
  const result = await runCli(t, { port: existing.port, dataDir });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(existing.requests, [{ method: 'GET', url: '/api/health' }]);
  assert.equal(existing.server.listening, true);
});

test('different directories, unrelated services, failed engines, non-JSON and failed health never get adopted', async t => {
  const dataDir = await temporary(t);
  const cases = [
    response => healthResponse(response, { service: 'synapse-node', engine_alive: true, data_dir: path.join(dataDir, 'other') }),
    response => healthResponse(response, { service: 'another-service', engine_alive: true, data_dir: dataDir }),
    response => healthResponse(response, { service: 'synapse-node', engine_alive: false, data_dir: dataDir }),
    response => healthResponse(response, { service: 'synapse-node', engine_alive: 'true', data_dir: dataDir }),
    response => healthResponse(response, { service: 'synapse-node', engine_alive: true, data_dir: 'relative/path' }),
    response => { response.writeHead(200); response.end('not JSON'); },
    response => healthResponse(response, { service: 'synapse-node', engine_alive: true, data_dir: dataDir }, 500),
  ];
  for (const send of cases) {
    const existing = await fixture(t, (_request, response) => send(response));
    const result = await runCli(t, { port: existing.port, dataDir });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /端口 .*已被占用/);
    assert.match(result.stderr, /现有服务未被停止/);
    assert.doesNotMatch(result.stdout, /已在运行/);
    assert.deepEqual(existing.requests, [{ method: 'GET', url: '/api/health' }]);
    assert.equal(existing.server.listening, true);
  }
});

test('occupied-port health checks never follow redirects', async t => {
  const dataDir = await temporary(t);
  const target = await fixture(t, (_request, response) => healthResponse(response,
    { service: 'synapse-node', engine_alive: true, data_dir: dataDir }));
  const redirect = await fixture(t, (_request, response) => {
    response.writeHead(307, { Location: `http://127.0.0.1:${target.port}/api/health` }); response.end();
  });
  const result = await runCli(t, { port: redirect.port, dataDir });
  assert.equal(result.code, 1);
  assert.deepEqual(redirect.requests, [{ method: 'GET', url: '/api/health' }]);
  assert.equal(target.requests.length, 0);
});

test('health timeouts bound both response headers and an unfinished JSON body', { timeout: 12000 }, async t => {
  const dataDir = await temporary(t);
  for (const headersStarted of [false, true]) {
    const existing = await fixture(t, (_request, response) => {
      if (headersStarted) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"service":'); }
    });
    const started = performance.now();
    const result = await runCli(t, { port: existing.port, dataDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /无法确认现有服务/);
    assert.ok(performance.now() - started < 6000, 'health validation must not hang the CLI');
    assert.deepEqual(existing.requests, [{ method: 'GET', url: '/api/health' }]);
  }
});

test('non-address-in-use errors never probe or report reuse', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('health must not be called'); });
  const status = await startupStatus(Object.assign(new Error('permission denied'), { code: 'EACCES' }), { port: 8787, dataDir: root });
  assert.equal(status.exitCode, 1); assert.equal(status.reused, false);
  assert.match(status.message, /permission denied/); assert.equal(fetch.mock.callCount(), 0);
  const dataDir = await temporary(t);
  const result = await runCli(t, { port: 'invalid', dataDir });
  assert.equal(result.code, 1); assert.match(result.stderr, /PORT 必须为有效端口/);
});

test('library bind failure cleans this attempt and skips capture initialization or persistent recovery', async t => {
  const directory = await temporary(t), dataDir = path.join(directory, 'sessions');
  const existing = await fixture(t, (_request, response) => { response.end('existing'); });
  const originalClose = CameraManager.prototype.close;
  const closed = [];
  t.mock.method(CameraManager.prototype, 'close', function () { closed.push(this); return originalClose.call(this); });
  const init = t.mock.method(CaptureEngine.prototype, 'init', () => { throw new Error('must reserve port before init'); });
  await assert.rejects(createApplication({ port: existing.port, sdkPath: false, dataDir, outputDir: path.join(directory, 'exports') }),
    { code: 'EADDRINUSE' });
  assert.equal(init.mock.callCount(), 0); assert.equal(closed.length, 1); assert.equal(closed[0].closed, true);
  assert.equal(existing.requests.length, 0, 'library creation must not probe or adopt other services');
  await assert.rejects(readFile(path.join(dataDir, 'manifest.json')), { code: 'ENOENT' });
  assert.equal(existing.server.listening, true);
});

test('initialization failure after binding releases its own port', async t => {
  const directory = await temporary(t), dataDir = path.join(directory, 'sessions');
  const outputDir = path.join(directory, 'output-is-a-file');
  await writeFile(outputDir, 'not a directory');
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  await assert.rejects(createApplication({ port, sdkPath: false, dataDir, outputDir }));
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => reserve.close(resolve));
});
