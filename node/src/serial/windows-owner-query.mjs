import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const helperFile = fileURLToPath(new URL('./windows-owner-query.ps1', import.meta.url))
  .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');

export function normalizeWindowsPortName(port) {
  if (typeof port !== 'string' || port.length > 24) return null;
  const value = port.trim().replace(/^\\\\\.\\/, '').toUpperCase();
  return /^COM[1-9]\d{0,4}$/.test(value) ? value : null;
}

const unknown = reason => ({ owners: [], complete: false, reason });
const bounded = (value, fallback, min, max) => Number.isFinite(value)
  ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;

function readResult(stdout) {
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (!result || typeof result !== 'object' || !Array.isArray(result.owners)
    || result.owners.length > 128 || typeof result.complete !== 'boolean') {
    throw new Error('Invalid owner-query result');
  }
  const devicePath = typeof result.devicePath === 'string' && result.devicePath.startsWith('\\')
    && result.devicePath.length <= 32768 ? result.devicePath : undefined;
  if ((result.owners.length || result.complete) && !devicePath) throw new Error('Missing exact device mapping');
  const seen = new Set();
  const owners = [];
  let complete = result.complete;
  for (const owner of result.owners) {
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 0x7fffffff) {
      throw new Error('Invalid owner identity');
    }
    if (seen.has(owner.pid)) continue;
    seen.add(owner.pid);
    const executable = typeof owner.executable === 'string' && owner.executable.length <= 32768
      ? owner.executable : null;
    const creationTime = typeof owner.creationTime === 'string' && /^\d{1,20}$/.test(owner.creationTime)
      ? owner.creationTime : null;
    const startTime = typeof owner.startTime === 'string' && owner.startTime.length <= 40
      && Number.isFinite(Date.parse(owner.startTime)) ? owner.startTime : null;
    if (!executable || !creationTime || !startTime) complete = false;
    owners.push({
      pid: owner.pid,
      name: typeof owner.name === 'string' && owner.name.length <= 260 ? owner.name : `PID ${owner.pid}`,
      executable,
      startTime,
      creationTime,
      sessionId: Number.isInteger(owner.sessionId) && owner.sessionId >= 0 ? owner.sessionId : null,
      isCritical: typeof owner.isCritical === 'boolean' ? owner.isCritical : null,
      currentUserOwned: typeof owner.currentUserOwned === 'boolean' ? owner.currentUserOwned : null,
    });
  }
  const reason = typeof result.reason === 'string' && /^[a-z_,]{1,512}$/.test(result.reason)
    ? result.reason : complete ? undefined : 'scan_incomplete';
  return { owners, complete, ...(reason ? { reason } : {}), ...(devicePath ? { devicePath } : {}) };
}

/**
 * Read-only, best-effort Windows handle scan. Owners are included only after an
 * exact QueryDosDevice/NtQueryObject path match. Empty results with complete=false
 * do NOT mean a port is free. No inspected process is stopped or reconfigured.
 *
 * creationTime is a decimal Windows FILETIME, suitable for a later identity
 * check against the same open process handle before any user-approved action.
 */
export async function queryWindowsPortOwners(port, {
  timeoutMs = 8000,
  scanTimeoutMs = 4000,
  preferredPids = [],
  platform = process.platform,
  runHelper = executeFile,
} = {}) {
  const normalized = normalizeWindowsPortName(port);
  if (!normalized) return unknown('invalid_port');
  if (platform !== 'win32') return unknown('unsupported_platform');
  const timeout = bounded(timeoutMs, 8000, 2000, 15000);
  const scanTimeout = bounded(scanTimeoutMs, 4000, 100, Math.min(10000, timeout - 1000));
  const preferred = Array.isArray(preferredPids)
    ? [...new Set(preferredPids.filter(pid => Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff))].slice(0, 16)
    : [];
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperFile,
    '-Port', normalized, '-ScanTimeoutMs', String(scanTimeout)];
  if (preferred.length) args.push('-PreferredPids', preferred.join(','));
  try {
    const { stdout } = await runHelper(powershell, args, {
      windowsHide: true,
      shell: false,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return readResult(stdout);
  } catch (error) {
    if (error?.killed || error?.code === 'ETIMEDOUT') return unknown('helper_timeout');
    if (error?.code === 'ENOENT') return unknown('helper_unavailable');
    // Do not pass subprocess stderr, environment data or compiler dumps to the UI.
    return unknown('helper_failed');
  }
}
