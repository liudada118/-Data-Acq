import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApplication } from '../src/server.mjs';

test('real Electron utility process imports, tests and installs with a private credential bridge', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sdk-electron-test-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const vendor = path.join(directory, 'vendor-sdk');
  await mkdir(vendor); await writeFile(path.join(vendor, 'README.md'), '# Test-only SDK');
  const runner = path.join(directory, 'runner');
  await mkdir(runner);
  await writeFile(path.join(runner, 'package.json'), JSON.stringify({ type: 'module', main: fileURLToPath(new URL('./helpers/integration-electron-smoke.mjs', import.meta.url)) }));
  const application = await createApplication({ port: 0, sdkPath: false, dataDir: path.join(directory, 'sessions'), outputDir: path.join(directory, 'exports') });
  t.after(async () => {
    await application.close();
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'sdk-electron-test-')));
    await rm(directory, { recursive: true, force: true });
  });
  const executable = path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  env.ELECTRON_ENABLE_LOGGING = '1';
  env.SDK_AGENT_SMOKE_CONFIG = path.join(directory, 'smoke-config.json');
  await writeFile(env.SDK_AGENT_SMOKE_CONFIG, JSON.stringify({ temporary: directory, serviceUrl: application.url, nodeRoot: root }));
  const child = spawn(executable, [runner], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const timeout = setTimeout(() => child.kill(), 50000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  clearTimeout(timeout);
  assert.equal(code, 0, stderr); assert.match(stdout, /INTEGRATION_SMOKE_OK/);
  const catalog = await (await fetch(`${application.url}/api/plugins/catalog`)).json();
  assert.equal(catalog.plugins[0].id, 'electron-fixture');
  const stored = await readFile(path.join(directory, 'electron-profile', 'sdk-agent-model.json'), 'utf8');
  assert.equal(stored.includes('test-fixture-only'), false);
});
