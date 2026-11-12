import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Real Chromium AudioWorklet smoke, using only a generated oscillator and temporary storage.
// Run: node scripts/check-microphone-browser.mjs [--keep-artifacts]
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'synapse-microphone-browser-'));
const executable = createRequire(import.meta.url)('electron');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [path.join(root, 'scripts/fixtures/microphone-browser-main.mjs'), `--fixture-dir=${directory}`], {
  cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45000);
try {
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8').catch(() => '{}'));
  if (result.code !== 0 || report.ok !== true) throw new Error(JSON.stringify({ ...report, exit: result,
    timedOut, fixtureDirectory: directory, stderr }, null, 2));
  const keep = process.argv.includes('--keep-artifacts');
  console.log(JSON.stringify({ ...report, ...(keep ? { fixtureDirectory: directory } : {}) }, null, 2));
  if (!keep) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('synapse-microphone-browser-'))
      throw new Error('Refusing to remove unexpected fixture directory');
    await rm(directory, { recursive: true, force: true });
  }
} finally { clearTimeout(timeout); }
