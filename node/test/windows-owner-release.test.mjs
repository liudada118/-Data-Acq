import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { releaseWindowsPortOwner } from '../src/serial/windows-owner-release.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const testScript = path.join(root, 'test/fixtures/windows-owner-release-test.ps1');

test('release validates FILETIME without numeric rounding and protects this process and supplied pids', async () => {
  for (const owner of [null, {}, { pid: 0, creationTime: '1' }, { pid: -1, creationTime: '1' },
    { pid: 12345, creationTime: 123456789012345678 }, { pid: 12345, creationTime: '0' },
    { pid: 12345, creationTime: '18446744073709551616' }, { pid: 12345, creationTime: '1;exit' }]) {
    assert.equal((await releaseWindowsPortOwner(owner)).reason, 'invalid_owner');
  }
  const creationTime = '123456789012345678';
  assert.equal((await releaseWindowsPortOwner({ pid: process.pid, creationTime })).reason, 'protected_process');
  assert.equal((await releaseWindowsPortOwner({ pid: process.ppid, creationTime })).reason, 'protected_process');
  assert.equal((await releaseWindowsPortOwner({ pid: 4, creationTime })).reason, 'protected_process');
  assert.equal((await releaseWindowsPortOwner({ pid: 12345, creationTime }, { protectedPids: [12345] })).reason, 'protected_process');
  await assert.rejects(releaseWindowsPortOwner({ pid: 12345, creationTime }, { protectedPids: ['12345'] }), TypeError);
});

test('native refusal policy covers access denial, changed identity, critical/session guards, and single-handle termination',
  { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-File', testScript, '-Action', 'policy', '-SourcePath', path.join(root, 'src/serial/windows-owner-release.cs')],
    { timeout: 8000, windowsHide: true, maxBuffer: 32768 });
    const { passed } = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    assert.equal(passed.length, 14);
    for (const name of ['open_access_denied', 'token_access_denied', 'creation_time_changed', 'owner_sid_changed',
      'session_zero', 'critical_process', 'critical_check_failed', 'protected_pid', 'bounded_wait_timeout', 'single_handle_success'])
      assert.ok(passed.includes(name), name);
  });

test('native release rejects stale identity and only terminates a disposable child created by this test',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000);'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    await once(child.stdout, 'data');
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-File', testScript, '-Action', 'creation', '-TargetPid', String(child.pid)],
    { timeout: 8000, windowsHide: true, maxBuffer: 32768 });
    const { creationTime } = JSON.parse(stdout.trim());
    const stale = await releaseWindowsPortOwner({ pid: child.pid, creationTime: (BigInt(creationTime) + 1n).toString() });
    assert.equal(stale.released, false); assert.equal(stale.reason, 'owner_changed');
    assert.equal(child.exitCode, null, 'stale identity must leave child running');
    const protectedResult = await releaseWindowsPortOwner({ pid: child.pid, creationTime }, { protectedPids: [child.pid] });
    assert.equal(protectedResult.reason, 'protected_process'); assert.equal(child.exitCode, null);
    const released = await releaseWindowsPortOwner({ pid: child.pid, creationTime });
    assert.deepEqual(released, { released: true, pid: child.pid, creationTime, reason: 'released' });
    await exited;
    assert.notEqual(child.exitCode, null);
  });
