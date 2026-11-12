import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApplication } from '../src/server.mjs';

const owner = { pid: 310000001, name: 'HttpSerialFixture.exe', creationTime: '134066123456789000',
  isCritical: false, sessionId: 1, currentUserOwned: true };
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t, portOwnership = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synapse-port-ownership-http-'));
  const scans = [], releases = [];
  const app = await createApplication({ port: 0, sdkPath: false,
    dataDir: path.join(directory, 'sessions'), outputDir: path.join(directory, 'exports'),
    portOwnership: {
      queryOwners: async (port, options) => { scans.push({ port, options }); return { owners: [{ ...owner }], complete: true }; },
      releaseOwner: async (target, options) => { releases.push({ target, options }); return { released: true }; },
      ...portOwnership,
    } });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('synapse-port-ownership-http-'));
    await rm(directory, { recursive: true, force: true });
  });
  const get = route => fetch(app.url + route);
  const post = (route, value, headers = {}) => fetch(app.url + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  async function inspect() {
    const response = await post('/api/sdk/port/inspect', { port: 'com00018' });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json(); assert.equal(result.port, 'COM18'); return result;
  }
  const release = token => post('/api/sdk/port/release', { port: 'COM18', release_token: token, confirm: true });
  return { app, scans, releases, get, post, inspect, release };
}

test('HTTP ownership routes validate requests and prevent release throughout a real simulated recording', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/sdk/port/inspect', { port: 'COM18;anything' })).status, 400);
  assert.equal((await f.post('/api/sdk/port/inspect', null)).status, 400);
  assert.equal((await fetch(f.app.url + '/api/sdk/port/inspect', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await f.post('/api/sdk/port/inspect', { port: 'COM18' }, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.get('/api/sdk/port/inspect')).status, 404);
  assert.equal(f.scans.length, 0);
  const initial = await f.inspect();
  const token = initial.owners[0].release_token;
  assert.ok(token);
  assert.equal((await f.post('/api/sdk/port/release', { port: 'COM18', release_token: token })).status, 400);
  assert.equal((await f.post('/api/sdk/port/release', { port: 'COM19', release_token: token, confirm: true })).status, 409);
  assert.equal((await f.release('invented-token')).status, 409);
  assert.equal(f.releases.length, 0);
  const started = await f.post('/api/sessions/start', { name: 'Ownership lock fixture', device_ids: ['sim-imu'] });
  assert.equal(started.status, 201, await started.clone().text());
  const session = await started.json();
  const denied = await f.release(token);
  assert.equal(denied.status, 409);
  assert.match((await denied.json()).error, /停止并保存录制/);
  const whileRecording = await f.inspect();
  assert.equal(whileRecording.owners[0].can_release, false);
  assert.equal(whileRecording.owners[0].release_token, undefined);
  assert.equal((await (await f.get('/api/status')).json()).session_id, session.session_id);
  assert.equal(f.releases.length, 0);
  const stopped = await f.post('/api/sessions/stop', { session_id: session.session_id });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).session.finalized, true);
  const fresh = await f.inspect();
  const released = await f.release(fresh.owners[0].release_token);
  assert.equal(released.status, 200, await released.clone().text());
  assert.equal((await released.json()).released, true);
  assert.equal(f.releases.length, 1);
  assert.equal((await f.release(fresh.owners[0].release_token)).status, 409);
  assert.equal(f.releases.length, 1);
});

test('HTTP release and recording start share a transition lock in both directions', { timeout: 20000 }, async t => {
  const releaseEntered = deferred(), releaseFinished = deferred();
  let releaseCalls = 0;
  const f = await fixture(t, { releaseOwner: async () => {
    releaseCalls++; releaseEntered.resolve(); await releaseFinished.promise; return { released: true };
  } });
  const first = await f.inspect();
  const pendingRelease = f.release(first.owners[0].release_token);
  await releaseEntered.promise;
  const blockedStart = await f.post('/api/sessions/start', { device_ids: ['sim-imu'] });
  assert.equal(blockedStart.status, 409);
  assert.equal((await (await f.get('/api/status')).json()).session_id, null);
  assert.equal((await f.release(first.owners[0].release_token)).status, 409);
  assert.equal(releaseCalls, 1);
  releaseFinished.resolve();
  assert.equal((await pendingRelease).status, 200);

  const beforeStart = await f.inspect();
  const startEntered = deferred(), startAllowed = deferred();
  const originalStart = f.app.capture.start.bind(f.app.capture);
  f.app.capture.start = async input => { startEntered.resolve(); await startAllowed.promise; return originalStart(input); };
  const pendingStart = f.post('/api/sessions/start', { device_ids: ['sim-imu'] });
  await startEntered.promise;
  assert.equal((await f.release(beforeStart.owners[0].release_token)).status, 409);
  assert.equal(releaseCalls, 1);
  startAllowed.resolve();
  const started = await pendingStart;
  assert.equal(started.status, 201, await started.clone().text());
  const session = await started.json();
  assert.equal((await f.release(beforeStart.owners[0].release_token)).status, 409);
  assert.equal((await f.post('/api/sessions/stop', { session_id: session.session_id })).status, 200);
});

test('HTTP helper refusal remains a failed release and does not consume an unrelated program', { timeout: 20000 }, async t => {
  let calls = 0;
  const f = await fixture(t, { releaseOwner: async target => {
    assert.equal(target.pid, owner.pid); calls++; return { released: false, reason: 'owner_changed' };
  } });
  const result = await f.inspect();
  const response = await f.release(result.owners[0].release_token);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /身份已变化/);
  assert.notEqual(body.released, true);
  assert.equal(calls, 1);
  assert.equal((await f.release(result.owners[0].release_token)).status, 409);
  assert.equal(calls, 1);
});
