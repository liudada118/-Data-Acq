import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { startDesktopService } from '../electron/service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.DESKTOP_TEST_EXECUTABLE || process.execPath;
async function eventually(check) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await delay(25); }
  assert.fail('Desktop service did not reach the expected state');
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synapse-desktop-service-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function fixtureServer(t, health) {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    if (request.url === '/api/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(health)); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, port: server.address().port, count: () => requests };
}
const get = async (url, route) => (await fetch(url + route)).json();
const post = async (url, route, body) => {
  const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};

test('owned desktop service drains active recording and export, then releases Chromium preconnections and incomplete HTTP requests', async t => {
  const userData = await temporary(t), webDir = path.join(userData, 'web');
  await mkdir(webDir); await writeFile(path.join(webDir, 'index.html'), '<h1>Desktop fixture</h1>');
  const service = await startDesktopService({ executable, root, userData, webDir, port: 0, packaged: true, disableEnvFile: true, sdkPath: false });
  t.after(() => service.close());
  assert.equal(service.owned, true); assert.equal(service.dataDir, path.join(userData, 'data', 'sessions'));
  assert.equal(await (await fetch(service.url)).text(), '<h1>Desktop fixture</h1>');
  const health = await get(service.url, '/api/health');
  assert.equal(health.service, 'synapse-node'); assert.equal(health.engine_alive, true); assert.equal(health.sdk_loaded, false);
  const first = await post(service.url, '/api/sessions/start', { device_ids: ['sim-pressure'], name: 'Desktop export drain' });
  await eventually(async () => (await get(service.url, '/api/status')).record_counts['sim-pressure'] > 2);
  const saved = await post(service.url, '/api/sessions/stop', { session_id: first.session_id });
  assert.equal(saved.session.status, 'complete');
  const job = await post(service.url, '/api/export/jobs', { session_id: first.session_id, format: 'npz' });
  const active = await post(service.url, '/api/sessions/start', { device_ids: ['sim-imu'], name: 'Desktop shutdown drain' });
  await eventually(async () => (await get(service.url, '/api/status')).record_counts['sim-imu'] > 2);
  // Chromium can open sockets without sending a request. Node's close() and
  // closeIdleConnections() leave those open, even after every writer has drained.
  const authority = new URL(service.url), sockets = [];
  for (const prefix of ['', 'GET / HTTP/1.1\r\n',
    `POST /api/cameras/register HTTP/1.1\r\nHost: ${authority.host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`]) {
    const socket = net.createConnection({ host: authority.hostname, port: Number(authority.port) });
    socket.on('error', () => {}); sockets.push(socket);
    await once(socket, 'connect'); if (prefix) socket.write(prefix);
  }
  await delay(25);
  const firstClose = service.close(), secondClose = service.close();
  assert.equal(firstClose, secondClose);
  let closedWithoutClientHelp;
  try { closedWithoutClientHelp = await Promise.race([firstClose.then(() => true), delay(3000, false, { ref: false })]); }
  finally { for (const socket of sockets) socket.destroy(); await firstClose; }
  assert.equal(closedWithoutClientHelp, true, 'Saved backend waited for an idle/unfinished browser socket');
  assert.equal(service.exited, true);
  const manifest = JSON.parse(await readFile(path.join(service.dataDir, active.session_id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.finalized, true); assert.equal(manifest.status, 'complete'); assert.ok(manifest.record_counts['sim-imu'] > 2);
  const history = JSON.parse(await readFile(path.join(userData, 'data', 'exports', 'jobs.json'), 'utf8'));
  assert.equal(history.jobs.find(item => item.id === job.id).status, 'complete');
  await assert.rejects(fetch(service.url + '/api/health'));
});

test('backend exits after saved acknowledgement even when a library leaves a referenced timer', async t => {
  const directory = await temporary(t), preload = path.join(directory, 'leftover-library-handle.mjs');
  await writeFile(preload, 'setInterval(() => {}, 1000);');
  const child = fork(path.join(root, 'electron', 'backend.mjs'), [], {
    execPath: executable, execArgv: ['--import', pathToFileURL(preload).href],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
  });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  let acknowledgement;
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message.type === 'ready') resolve(message);
      if (message.type === 'closed') acknowledgement = message;
      if (message.type === 'startup-error') reject(new Error(message.error));
    });
    child.on('error', reject);
  });
  child.send({ type: 'initialize', config: { port: 0, dataDir: path.join(directory, 'sessions'),
    outputDir: path.join(directory, 'exports'), webDir: directory, sdkPath: false } });
  await ready; child.send({ type: 'stop' });
  const result = await Promise.race([exit, delay(3000, null, { ref: false })]);
  assert.deepEqual(acknowledgement, { type: 'closed', ok: true });
  assert.ok(result, 'Backend acknowledged completed saving but stayed alive on a leftover library handle');
  assert.deepEqual(result, [0, null]);
});

test('development attaches only to expected healthy data directory and never stops the existing instance', async t => {
  const directory = await temporary(t), expected = path.join(directory, 'data', 'annotations', 'sessions');
  const fixture = await fixtureServer(t, { service: 'synapse-node', engine_alive: true, data_dir: expected });
  const service = await startDesktopService({ executable, root: directory, userData: directory, port: fixture.port, disableEnvFile: true });
  assert.equal(service.owned, false); assert.equal(service.dataDir, expected);
  await service.close();
  assert.equal((await get(service.url, '/api/health')).service, 'synapse-node'); assert.equal(fixture.count(), 2);
});

test('occupied production port and mismatched or unhealthy development services are rejected without mutation', async t => {
  const directory = await temporary(t);
  for (const [packaged, health] of [
    [true, { service: 'synapse-node', engine_alive: true, data_dir: path.join(directory, 'data', 'sessions') }],
    [false, { service: 'synapse-node', engine_alive: true, data_dir: path.join(directory, 'different') }],
    [false, { service: 'other', engine_alive: true, data_dir: path.join(directory, 'data', 'annotations', 'sessions') }],
    [false, { service: 'synapse-node', engine_alive: false, data_dir: path.join(directory, 'data', 'annotations', 'sessions') }],
  ]) {
    const fixture = await fixtureServer(t, health);
    await assert.rejects(startDesktopService({ executable, root: directory, userData: directory, port: fixture.port, packaged, disableEnvFile: true }),
      error => error.code === (packaged ? 'DESKTOP_PORT_OCCUPIED' : 'DESKTOP_SERVICE_MISMATCH'));
    assert.equal(fixture.count(), 1); assert.equal(fixture.server.listening, true);
  }
});

test('packaged env file is loaded only into child and does not change parent environment', async t => {
  const userData = await temporary(t), sdk = path.join(userData, 'fixture-sdk');
  await mkdir(path.join(sdk, 'node'), { recursive: true });
  await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(sdk, 'node', 'index.js'), 'export const Shroom = { version: "desktop-env-fixture", mock() {}, async listPorts() { return []; } };');
  await writeFile(path.join(userData, '.env.local'), `SHROOM_SDK_PATH='${sdk.replaceAll('\\', '/')}'\nDESKTOP_FIXTURE_VALUE='child-only'\n`);
  const beforePath = process.env.SHROOM_SDK_PATH, beforeValue = process.env.DESKTOP_FIXTURE_VALUE;
  // Undefined removes this inherited key in the fork environment so the synthetic env file is exercised.
  const service = await startDesktopService({ executable, root, userData, port: 0, packaged: true, env: { SHROOM_SDK_PATH: undefined } });
  t.after(() => service.close());
  assert.equal((await get(service.url, '/api/sdk/info')).version, 'desktop-env-fixture');
  assert.equal(process.env.SHROOM_SDK_PATH, beforePath); assert.equal(process.env.DESKTOP_FIXTURE_VALUE, beforeValue);
});

test('parent IPC loss drains capture and causes the owned backend to exit', async t => {
  const directory = await temporary(t), dataDir = path.join(directory, 'sessions');
  const child = fork(path.join(root, 'electron', 'backend.mjs'), [], {
    execPath: executable, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json', windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => { if (message.type === 'ready') resolve(message); else if (message.type === 'startup-error') reject(new Error(message.error)); });
    child.on('error', reject);
  });
  child.send({ type: 'initialize', config: { port: 0, dataDir, outputDir: path.join(directory, 'exports'), webDir: path.join(root, 'ui', 'dist'), sdkPath: false } });
  const { url } = await ready;
  const active = await post(url, '/api/sessions/start', { device_ids: ['sim-pressure'] });
  await eventually(async () => (await get(url, '/api/status')).record_counts['sim-pressure'] > 1);
  child.disconnect();
  const [code] = await exit; assert.equal(code, 0);
  const saved = JSON.parse(await readFile(path.join(dataDir, active.session_id, 'manifest.json'), 'utf8'));
  assert.equal(saved.status, 'complete'); assert.equal(saved.finalized, true);
});

test('startup timeout terminates only owned unready child and malformed configuration fails before launch', async t => {
  const directory = await temporary(t);
  await mkdir(path.join(directory, 'electron'));
  await writeFile(path.join(directory, 'electron', 'backend.mjs'), 'process.on("message", () => {});');
  await assert.rejects(startDesktopService({ executable, root: directory, userData: directory, port: 0, packaged: true,
    disableEnvFile: true, startupTimeoutMs: 150 }), { code: 'DESKTOP_START_TIMEOUT' });
  await assert.rejects(startDesktopService({ executable, root: directory, userData: directory, port: -1, disableEnvFile: true }), { code: 'DESKTOP_CONFIG_INVALID' });
  assert.deepEqual(await readdir(directory), ['electron']);
});
