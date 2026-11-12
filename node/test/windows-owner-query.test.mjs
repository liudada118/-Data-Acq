import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWindowsPortName, queryWindowsPortOwners } from '../src/serial/windows-owner-query.mjs';

const exactOwner = {
  pid: 1234, name: 'serial-viewer.exe', executable: 'C:\\Apps\\serial-viewer.exe',
  startTime: '2026-11-04T03:01:57.1301721Z', creationTime: '134382349171301721',
  sessionId: 1, isCritical: false, currentUserOwned: true,
};
const answer = changes => ({
  owners: [exactOwner], complete: true, devicePath: '\\Device\\Serial19', ...changes,
});
const from = result => async () => ({ stdout: JSON.stringify(result) });

test('serial names are canonicalized and shell/path fragments are rejected before launching a helper', async () => {
  assert.equal(normalizeWindowsPortName(' com29 '), 'COM29');
  assert.equal(normalizeWindowsPortName('\\\\.\\COM29'), 'COM29');
  for (const port of ['', null, 'COM0', 'COM029', 'COM29; Stop-Process', 'COM29\nwhoami', 'C:\\COM29', 'COM29$(whoami)']) {
    const result = await queryWindowsPortOwners(port, { platform: 'win32', runHelper: () => assert.fail('must not launch') });
    assert.deepEqual(result, { owners: [], complete: false, reason: 'invalid_port' });
  }
});

test('unsupported platforms report unknown without invoking Windows tools', async () => {
  assert.deepEqual(await queryWindowsPortOwners('COM29', {
    platform: 'linux', runHelper: () => assert.fail('must not launch'),
  }), { owners: [], complete: false, reason: 'unsupported_platform' });
});

test('native exact-owner identity survives parsing including precision-preserving FILETIME', async () => {
  assert.deepEqual(await queryWindowsPortOwners('COM29', { platform: 'win32', runHelper: from(answer()) }), answer());
});

test('an exact owner is retained when protected or stalled processes make the scan incomplete', async () => {
  const expected = answer({ complete: false, reason: 'process_access_denied,process_query_timeout' });
  assert.deepEqual(await queryWindowsPortOwners('COM29', { platform: 'win32', runHelper: from(expected) }), expected);
});

test('unknown process identity never becomes an actionable successful scan', async () => {
  const result = await queryWindowsPortOwners('COM29', { platform: 'win32', runHelper: from(answer({
    owners: [{ pid: 1234, name: null, currentUserOwned: null, isCritical: null }],
  })) });
  assert.equal(result.complete, false);
  assert.equal(result.owners[0].creationTime, null);
  assert.equal(result.owners[0].isCritical, null);
  assert.equal(result.owners[0].currentUserOwned, null);
  assert.equal(result.owners[0].name, 'PID 1234');
});

test('timeouts and malformed native output report unknown and do not leak stderr', async () => {
  const failures = [
    [{ killed: true, stderr: 'secret' }, 'helper_timeout'],
    [{ code: 'ENOENT', stderr: 'secret' }, 'helper_unavailable'],
    [{ code: 1, stderr: 'secret' }, 'helper_failed'],
  ];
  for (const [failure, reason] of failures) {
    const result = await queryWindowsPortOwners('COM29', { platform: 'win32', runHelper: async () => { throw failure; } });
    assert.deepEqual(result, { owners: [], complete: false, reason });
  }
  for (const result of ['not JSON', null, { owners: [], complete: 'true' }, { owners: [], complete: true }, answer({ devicePath: null }), answer({ owners: [{ pid: -1 }] })]) {
    assert.deepEqual(await queryWindowsPortOwners('COM29', { platform: 'win32', runHelper: from(result) }),
      { owners: [], complete: false, reason: 'helper_failed' });
  }
});

test('helper execution is hidden, shell-free, bounded and accepts only numeric PID hints', async () => {
  await queryWindowsPortOwners('COM29', {
    platform: 'win32', timeoutMs: 999999, scanTimeoutMs: 999999,
    preferredPids: [1234, '12;whoami', -1, 1234, 42],
    runHelper: async (executable, args, options) => {
      assert.match(executable, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 15000);
      assert.equal(options.maxBuffer, 1048576);
      assert.equal(args[args.indexOf('-Port') + 1], 'COM29');
      assert.equal(args[args.indexOf('-ScanTimeoutMs') + 1], '10000');
      assert.equal(args[args.indexOf('-PreferredPids') + 1], '1234,42');
      return { stdout: JSON.stringify(answer()) };
    },
  });
});
