import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSerialPort, PortOwnershipService } from '../src/serial/port-ownership.mjs';

const owner = (patch = {}) => ({ pid: 310000001, name: 'SerialFixture.exe', executable: 'C:\\Fixtures\\SerialFixture.exe',
  creationTime: '134066123456789000', isCritical: false, sessionId: 1, currentUserOwned: true, ...patch });
const device = (id, port = 'COM18', patch = {}) => ({ instance_id: id, product: 'glove', path: port,
  connected: true, has_device: true, connecting: false, ...patch });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(options = {}) {
  const state = { status: { state: 'idle', session_id: null }, instances: [], now: 1000,
    scanResult: { owners: [owner()], complete: true }, releaseResult: { released: true }, scans: [], releases: [], disconnects: [] };
  const capture = { child: { pid: 310000002 }, status: () => state.status,
    sdkInfo: async () => ({ instances: structuredClone(state.instances) }),
    sdkDisconnect: async input => {
      state.disconnects.push(input);
      state.instances = state.instances.map(item => item.instance_id === input.instance_id
        ? { ...item, connected: false, has_device: false } : item);
    } };
  const service = new PortOwnershipService({ capture,
    queryOwners: async (port, scanOptions) => { state.scans.push({ port, options: scanOptions }); return structuredClone(state.scanResult); },
    releaseOwner: async (target, releaseOptions) => { state.releases.push({ target, options: releaseOptions }); return state.releaseResult; },
    now: () => state.now, tokenTtlMs: 100, ...options });
  return { state, capture, service };
}
async function ticket(service, port = 'COM18') {
  const result = await service.inspect({ port });
  assert.equal(result.owners[0]?.can_release, true);
  assert.equal(typeof result.owners[0]?.release_token, 'string');
  return result.owners[0].release_token;
}
const release = (service, token, extra = {}) => service.release({ port: 'COM18', release_token: token, confirm: true, ...extra });
async function rejectsStatus(promise, code, pattern) {
  await assert.rejects(promise, error => {
    assert.equal(error.statusCode, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('ownership accepts only normalized COM ports before reaching any native scan', async () => {
  for (const input of ['COM18', ' com00018 ', '\\\\.\\COM0018']) assert.equal(normalizeSerialPort(input), 'COM18');
  const f = fixture();
  for (const port of [undefined, null, 18, '', 'COM0', 'COM-1', 'COM123456', 'COM' + '0'.repeat(30) + '1', '/dev/ttyUSB0', 'COM18; taskkill', '../COM18'])
    await rejectsStatus(f.service.inspect({ port }), 400);
  assert.equal(f.state.scans.length, 0);
  assert.equal(f.state.releases.length, 0);
});

test('internal ownership releases only the selected SDK instance and never terminates a process', async () => {
  const f = fixture();
  f.state.instances = [device('left', 'COM0018'), device('right', 'COM19')];
  const token = await ticket(f.service, 'com18');
  assert.equal(f.state.scans.length, 0);
  const result = await release(f.service, token);
  assert.equal(result.released, true);
  assert.deepEqual(f.state.disconnects, [{ instance_id: 'left' }]);
  assert.equal(f.state.instances.find(item => item.instance_id === 'right').connected, true);
  assert.equal(f.state.releases.length, 0);
  await rejectsStatus(release(f.service, token), 409, /过期/);
  f.state.instances = [device('connecting', 'COM18', { connecting: true })];
  const pending = await f.service.inspect({ port: 'COM18' });
  assert.equal(pending.owners[0].can_release, false);
  assert.match(pending.owners[0].release_reason, /正在连接/);
  assert.equal(pending.owners[0].release_token, undefined);
});

test('recording, stopping and an error with an unsaved session block both release types', async t => {
  for (const internal of [false, true]) for (const status of [
    { state: 'recording', session_id: null }, { state: 'stopping', session_id: null },
    { state: 'error', session_id: 'session-unsaved' }, { state: 'idle', session_id: 'session-unsaved' },
  ]) await t.test(`${internal ? 'internal' : 'external'} ${status.state}/${status.session_id}`, async () => {
    const f = fixture();
    if (internal) f.state.instances = [device('left')];
    const token = await ticket(f.service);
    f.state.status = status;
    await rejectsStatus(release(f.service, token), 409, /停止并保存录制/);
    const result = await f.service.inspect({ port: 'COM18' });
    assert.equal(result.owners[0].can_release, false);
    assert.equal(result.owners[0].release_token, undefined);
    assert.equal(f.state.releases.length, 0);
    assert.equal(f.state.disconnects.length, 0);
  });
});

test('external release requires explicit confirmation, matching port and an unexpired one-use token', async () => {
  const f = fixture({ protectedPids: [310000003] });
  const token = await ticket(f.service);
  for (const confirm of [undefined, false, 'true', 1]) await rejectsStatus(release(f.service, token, { confirm }), 400, /确认/);
  await rejectsStatus(release(f.service, token, { port: 'COM19' }), 409, /过期/);
  await rejectsStatus(release(f.service, 'invented-token'), 409, /过期/);
  assert.equal(f.state.releases.length, 0);
  const result = await release(f.service, token);
  assert.equal(result.released, true);
  assert.equal(f.state.scans.length, 2, 'release checks current handles again');
  assert.ok(f.state.scans[1].options.preferredPids.includes(owner().pid));
  assert.equal(f.state.releases.length, 1);
  assert.equal(f.state.releases[0].target.creationTime, owner().creationTime);
  for (const pid of [process.pid, process.ppid, f.capture.child.pid, 310000003])
    assert.ok(f.state.releases[0].options.protectedPids.includes(pid));
  await rejectsStatus(release(f.service, token), 409, /过期/);
  assert.equal(f.state.releases.length, 1);
  const expired = await ticket(f.service);
  f.state.now += 100;
  await rejectsStatus(release(f.service, expired), 409, /过期/);
  assert.equal(f.state.releases.length, 1);
});

test('unknown ownership and protected, critical, other-user or unverified processes never get release credentials', async t => {
  for (const patch of [
    { pid: process.pid }, { pid: process.ppid }, { pid: 310000002 }, { pid: 310000003 }, { pid: 4 },
    { pid: undefined }, { pid: '123' }, { isCritical: true }, { isCritical: undefined },
    { sessionId: 0 }, { sessionId: undefined }, { currentUserOwned: false }, { currentUserOwned: undefined },
    { creationTime: undefined }, { creationTime: '0' }, { creationTime: 'not-verified' },
  ]) await t.test(JSON.stringify(patch), async () => {
    const f = fixture({ protectedPids: [310000003] });
    f.state.scanResult.owners = [owner(patch)];
    const result = await f.service.inspect({ port: 'COM18' });
    assert.equal(result.owners[0].can_release, false);
    assert.ok(result.owners[0].release_reason);
    assert.equal(result.owners[0].release_token, undefined);
    assert.equal(f.state.releases.length, 0);
  });
  const f = fixture();
  f.state.scanResult = { owners: [], complete: false, reason: 'Native handle scan could not confirm ownership.' };
  const unknown = await f.service.inspect({ port: 'COM18' });
  assert.equal(unknown.port, 'COM18');
  assert.deepEqual(unknown.owners, []);
  assert.equal(unknown.complete, false);
  assert.match(unknown.reason, /无法确认/);
  await rejectsStatus(release(f.service, 'invented-token'), 409);
  assert.equal(f.state.releases.length, 0);
});

test('a reused PID or changed handle owner cannot be released using an earlier inspection', async t => {
  for (const owners of [[], [owner({ creationTime: '134066123456789001' })], [owner({ pid: 310000009 })],
    [owner({ isCritical: undefined })], [owner({ currentUserOwned: false })]]) await t.test(JSON.stringify(owners), async () => {
    const f = fixture();
    const token = await ticket(f.service);
    f.state.scanResult = { owners, complete: true };
    await rejectsStatus(release(f.service, token), 409);
    assert.equal(f.state.releases.length, 0);
    await rejectsStatus(release(f.service, token), 409, /过期/);
  });
});

test('fresh checks reject newly connected internal devices, changed SDK products and recording races', async () => {
  const f = fixture();
  const token = await ticket(f.service);
  f.state.instances = [device('new-internal')];
  await rejectsStatus(release(f.service, token), 409, /占用方已变化/);
  assert.equal(f.state.scans.length, 1);
  assert.equal(f.state.releases.length, 0);

  const g = fixture(); g.state.instances = [device('left')];
  const internalToken = await ticket(g.service);
  g.state.instances = [device('left', 'COM18', { product: 'insole' })];
  await rejectsStatus(release(g.service, internalToken), 409, /状态已变化/);
  assert.equal(g.state.disconnects.length, 0);

  for (const mutation of ['connection', 'recording']) {
    const race = fixture();
    const oldToken = await ticket(race.service);
    race.service.queryOwners = async () => {
      if (mutation === 'connection') race.state.instances = [device('new-internal')];
      else race.state.status = { state: 'error', session_id: 'unsaved' };
      return race.state.scanResult;
    };
    await rejectsStatus(release(race.service, oldToken), 409);
    assert.equal(race.state.releases.length, 0);
  }
});

test('failed native release is not reported as success and cannot reuse its old token', async t => {
  for (const reason of ['owner_changed', 'access_denied', 'owner_unverifiable', 'timeout', 'unrecognized'])
    await t.test(reason, async () => {
      const f = fixture();
      const token = await ticket(f.service);
      f.state.releaseResult = { released: false, reason };
      await rejectsStatus(release(f.service, token), 409);
      assert.equal(f.state.releases.length, 1);
      assert.equal(f.service.releasing, false);
      await rejectsStatus(release(f.service, token), 409, /过期/);
      assert.equal(f.state.releases.length, 1);
    });
});

test('in-flight releases are serialized and invalidation revokes previously confirmed ownership', async () => {
  const admitted = deferred(), finish = deferred();
  const f = fixture({ releaseOwner: async () => { admitted.resolve(); await finish.promise; return { released: true }; } });
  const first = await ticket(f.service), second = await ticket(f.service);
  const pending = release(f.service, first);
  await admitted.promise;
  await rejectsStatus(release(f.service, second), 409, /正在释放/);
  finish.resolve();
  assert.equal((await pending).released, true);
  f.service.invalidate();
  await rejectsStatus(release(f.service, second), 409, /过期/);
  assert.equal(f.service.releasing, false);
});

test('connection revision changes and token expiry during awaited checks prevent the eventual release', async () => {
  for (const mutation of ['revision', 'expiry']) {
    const f = fixture();
    const token = await ticket(f.service);
    f.service.queryOwners = async () => {
      if (mutation === 'revision') f.service.invalidate();
      else f.state.now += 100;
      return f.state.scanResult;
    };
    await rejectsStatus(release(f.service, token), 409, /信息已变化/);
    assert.equal(f.state.releases.length, 0);
  }
  const f = fixture(); f.state.instances = [device('left')];
  const token = await ticket(f.service);
  const sdkInfo = f.capture.sdkInfo;
  f.capture.sdkInfo = async () => {
    const snapshot = await sdkInfo();
    f.service.invalidate();
    return snapshot;
  };
  await rejectsStatus(release(f.service, token), 409, /信息已变化/);
  assert.equal(f.state.disconnects.length, 0);
  assert.equal(f.state.releases.length, 0);
});
