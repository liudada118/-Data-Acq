import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./windows-owner-release.ps1', import.meta.url))
  .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
const reasons = new Set(['released', 'invalid_owner', 'protected_process', 'owner_changed', 'already_exited',
  'access_denied', 'different_user', 'critical_process', 'session_zero', 'owner_unverifiable',
  'termination_failed', 'wait_timeout', 'helper_failed']);

function validPid(value) { return Number.isInteger(value) && value > 0 && value <= 0xffffffff; }
function creationKey(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) return null;
  const number = BigInt(value);
  return number > 0n && number <= 0xffffffffffffffffn ? number.toString() : null;
}

/**
 * Call only after explicit UI confirmation and a fresh exact-port owner query.
 * This helper checks process identity again; it does not query or close COM handles.
 */
export async function releaseWindowsPortOwner(owner, { protectedPids = [] } = {}) {
  const pid = owner?.pid, creationTime = creationKey(owner?.creationTime);
  const result = reason => ({ released: false, pid: validPid(pid) ? pid : null, creationTime, reason });
  if (!validPid(pid) || !creationTime) return result('invalid_owner');
  if (!Array.isArray(protectedPids) || protectedPids.length > 256 || protectedPids.some(value => !validPid(value)))
    throw new TypeError('protectedPids must be a bounded array of process identifiers');
  const protectedIds = [...new Set([4, process.pid, process.ppid, ...protectedPids].filter(validPid))];
  if (protectedIds.includes(pid)) return result('protected_process');
  if (process.platform !== 'win32') return result('unsupported_platform');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    let child, stdout = '', stderrBytes = 0, settled = false, timer;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-File', helper, '-OwnerPid', String(pid), '-CreationTime', creationTime,
        '-ProtectedPids', protectedIds.join(','), '-WaitMs', '2000'],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { finish(result('helper_failed')); return; }
    timer = setTimeout(() => { child.kill(); finish(result('helper_timeout')); }, 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > 32768) { child.kill(); finish(result('helper_failed')); }
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16384) { child.kill(); finish(result('helper_failed')); }
    });
    child.once('error', () => finish(result('helper_failed')));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) { finish(result('helper_failed')); return; }
      try {
        const value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (value?.pid !== pid || value.creationTime !== creationTime || typeof value.released !== 'boolean' ||
            !reasons.has(value.reason) || value.released !== (value.reason === 'released')) throw new Error();
        if (value.win32Error !== undefined && (!Number.isInteger(value.win32Error) || value.win32Error < 0)) throw new Error();
        finish({ released: value.released, pid, creationTime, reason: value.reason,
          ...(value.win32Error ? { win32Error: value.win32Error } : {}) });
      } catch { finish(result('helper_failed')); }
    });
  });
}
