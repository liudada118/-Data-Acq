import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { registerIntegration } from '../electron/integration.mjs';

function fixture() {
  const handlers = new Map(), requests = [], child = new EventEmitter();
  let dialogCalls = 0, forks = 0, select = () => Promise.resolve({ canceled: false, filePaths: ['D:\\vendor-sdk'] });
  child.postMessage = message => {
    requests.push(message);
    if (message.action === 'close') queueMicrotask(() => child.emit('message', { id: message.id, result: null }));
  };
  child.kill = () => queueMicrotask(() => child.emit('exit', 0));
  const root = path.join(os.tmpdir(), 'sdk-import-bridge-fixture-not-written');
  const bridge = registerIntegration({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    utilityProcess: { fork: () => { forks++; return child; } },
    safeStorage: {}, dialog: { showOpenDialog: () => { dialogCalls++; return select(); } },
    trustedSender: event => event?.trusted === true, getWindow: () => ({}),
    service: { dataDir: path.join(root, 'sessions'), url: 'http://127.0.0.1:1' }, root, userData: root,
    modelCatalogFetch: () => { throw new Error('Import tests must not request model services'); },
  });
  return { bridge, requests, handlers, child,
    choose: (...args) => handlers.get('integration:choose-sdk')(...args),
    invoke: (...args) => handlers.get('integration:invoke')(...args),
    select: fn => { select = fn; },
    respond: (request, result) => child.emit('message', { id: request.id, result }),
    fail: (request, message) => child.emit('message', { id: request.id, error: { message } }),
    get dialogCalls() { return dialogCalls; }, get forks() { return forks; },
  };
}
async function flushUntil(check) {
  for (let i = 0; i < 30; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('Bridge did not reach the expected IPC state');
}

test('SDK import remains locked across picker, worker startup, and long copy; failure releases the lock for retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.bridge.close());
  const selection = Promise.withResolvers(); f.select(() => selection.promise);
  let settled = false;
  const first = f.choose({ trusted: true });
  const failure = assert.rejects(first, /SDK 文件过大：Tools\/driver\.exe（256 MB）/).finally(() => { settled = true; });
  await assert.rejects(f.choose({ trusted: true }), /正在选择或导入/);
  assert.equal(f.dialogCalls, 1); assert.equal(f.forks, 0);

  selection.resolve({ canceled: false, filePaths: ['D:\\vendor-sdk'] });
  await flushUntil(() => f.requests.some(request => request.action === 'initialize'));
  await assert.rejects(f.choose({ trusted: true }), /正在选择或导入/);
  assert.equal(f.dialogCalls, 1); assert.equal(f.requests.length, 1);
  f.respond(f.requests[0], { ready: true });
  await flushUntil(() => f.requests.some(request => request.action === 'importDirectory'));
  const imported = f.requests.find(request => request.action === 'importDirectory');
  assert.deepEqual(imported.args, { path: 'D:\\vendor-sdk' });

  t.mock.timers.tick(180001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'large import must not fail locally after the old 180-second timeout');
  await assert.rejects(f.choose({ trusted: true }), /正在选择或导入/);
  assert.equal(f.dialogCalls, 1); assert.equal(f.requests.filter(request => request.action === 'importDirectory').length, 1);
  f.fail(imported, 'SDK 文件过大：Tools/driver.exe（256 MB）'); await failure;

  f.select(async () => ({ canceled: false, filePaths: ['D:\\another-sdk'] }));
  const retried = f.choose({ trusted: true });
  await flushUntil(() => f.requests.filter(request => request.action === 'importDirectory').length === 2);
  const next = f.requests.at(-1); assert.deepEqual(next.args, { path: 'D:\\another-sdk' });
  f.respond(next, { id: 'sdk-retry', status: 'imported' });
  assert.deepEqual(await retried, { id: 'sdk-retry', status: 'imported' });
  assert.equal(f.dialogCalls, 2); assert.equal(f.forks, 1);
});

test('cancelled or failed native selection releases import lock and renderer cannot submit an arbitrary import path', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.bridge.close());
  await assert.rejects(f.choose({ trusted: false }), /仅允许/);
  await assert.rejects(f.invoke({ trusted: true }, 'importDirectory', { path: 'C:\\private' }), /不支持/);
  assert.equal(f.dialogCalls, 0); assert.equal(f.forks, 0);
  f.select(async () => ({ canceled: true, filePaths: [] }));
  assert.equal(await f.choose({ trusted: true }), null);
  f.select(async () => { throw new Error('无法打开文件夹选择器'); });
  await assert.rejects(f.choose({ trusted: true }), /无法打开文件夹选择器/);
  f.select(async () => ({ canceled: false, filePaths: ['D:\\native-picker-choice'] }));
  const imported = f.choose({ trusted: true }, { path: 'C:\\renderer-path-must-be-ignored' });
  await flushUntil(() => f.requests.some(request => request.action === 'initialize'));
  f.respond(f.requests[0], { ready: true });
  await flushUntil(() => f.requests.some(request => request.action === 'importDirectory'));
  const request = f.requests.at(-1); assert.deepEqual(request.args, { path: 'D:\\native-picker-choice' });
  f.respond(request, { id: 'sdk-native' }); assert.deepEqual(await imported, { id: 'sdk-native' });
  assert.equal(f.dialogCalls, 3);
});
