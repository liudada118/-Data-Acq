import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createIntegrationService } from '../src/integration/service.mjs';
import { AGENT_TOOLS, parseToolArguments, readSdkText } from '../src/integration/agent-tools.mjs';
import { normalizeModelSettings } from '../src/integration/provider.mjs';
import { safeRelative } from '../src/integration/storage.mjs';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { docx, pdf } from './helpers/sdk-document-fixtures.mjs';
import { HX_D350_MANIFEST, HX_D350_ADAPTER } from '../src/integration/recipes/hx-d350-rtsp.mjs';

const manifest = { api_version: 1, id: 'test-sdk-camera', name: 'SDK fixture (tests only)', version: '1.0.0', entry: 'adapter.mjs',
  streams: [{ id: 'rgb', name: 'SDK camera fixture', kind: 'camera', dtype: 'uint8', shape: [2, 2, 3], sample_rate: 50 }], config_fields: [] };
const sdkSource = `export const version = 'fixture-1';
export function getFrame() { return Buffer.from([1,2,3,4,5,6,7,8,9,10,11,12]); }
`;
const adapter = `import {version,getFrame} from './sdk/index.mjs';
export function createAdapter({emit}) {
 let timer, sequence=0;
 return { probe(){ if(version!=='fixture-1') throw new Error('SDK version mismatch'); return {ok:true,message:'SDK fixture module loaded; no hardware connected'}; },
 start(){ timer=setInterval(()=>emit({stream_id:'rgb',payload:getFrame(),sequence:sequence++,device_time_ns:'9000000'}),20); },
 stop(){clearInterval(timer);} };
}`;
const call = (name, args, index) => ({ type: 'function_call', call_id: `call-${index}`, name, arguments: JSON.stringify(args) });
const answer = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('native SDK research can continue beyond twelve model calls while retaining a bounded loop', async t => {
  let requests = 0, finish = true;
  const { service, sdk } = await fixture(t, { fetchImpl: async () => {
    requests++;
    const output = finish && requests === 15 ? [answer('完成多文件 ABI 查阅。')] : [call('read_test_report', {}, requests)];
    return new Response(JSON.stringify({ status: 'completed', output }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const imported = await service.importDirectory({ path: sdk });
  const settings = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture' };
  await service.chat({ workspace_id: imported.id, message: '查阅原生SDK' }, settings);
  assert.equal((await service.waitForIdle(imported.id)).task.status, 'completed');
  assert.equal(requests, 15);
  requests = 0; finish = false;
  await service.chat({ workspace_id: imported.id, message: '检查模型调用上限' }, settings);
  const stopped = await service.waitForIdle(imported.id);
  assert.equal(stopped.task.status, 'failed'); assert.match(stopped.error, /32 次/);
  assert.equal(requests, 32);
});

test('document-reading Agent discovers generic RTSP capabilities and accepts model-generated draft through test/install', async t => {
  let turn = 0, seenDocs = false;
  assert.ok(!AGENT_TOOLS.some(tool => tool.name === 'read_adapter_recipe'));
  assert.throws(() => parseToolArguments(call('read_adapter_recipe', { id: 'hx-d350-rtsp' }, 0)), /不允许/);
  const { service, engine } = await fixture(t, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    const outputs = body.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
    let output;
    if (turn++ === 0) output = [call('read_sdk_file', { path: 'protocol.docx' }, 1), call('read_sdk_file', { path: 'guide.pdf' }, 2), call('read_runtime_capabilities', {}, 3)];
    else if (turn === 2) {
      seenDocs = outputs.some(item => item.format === 'docx' && item.content.includes('1254')) && outputs.some(item => item.format === 'pdf' && item.page_count === 1);
      const capabilities = outputs.find(item => item.media?.adapter_context?.includes('media'));
      assert.ok(capabilities); assert.equal(capabilities.recipes, undefined);
      assert.ok(!outputs.some(item => item.files?.['adapter.mjs']));
      // Deterministic model-response fixture only: the production Agent receives
      // generic host APIs, never these prewritten device-specific source files.
      const generated = { 'plugin.json': JSON.stringify(HX_D350_MANIFEST, null, 2), 'adapter.mjs': HX_D350_ADAPTER };
      output = Object.entries(generated).map(([path, content], index) => call('write_draft_file', { path, content }, 5 + index));
    } else output = [answer('## 已生成双路草稿\n\n左右文档有冲突，使用端口名。请测试后安装；硬件未验证。')];
    return new Response(JSON.stringify({ status: 'completed', output }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const imported = await service.importFiles({ name: 'RTSP docs fixture', files: [
    { path: 'protocol.docx', content_base64: docx('RIGHT rtsp://camera:1254 LEFT rtsp://camera:1256').toString('base64') },
    { path: 'guide.pdf', content_base64: pdf(['LEFT rtsp://camera:1254 RIGHT rtsp://camera:1256']).toString('base64') },
  ] });
  await service.chat({ workspace_id: imported.id, message: '接入双路相机' }, { baseUrl: 'https://fixture.invalid/v1', model: 'fixture' });
  const done = await service.waitForIdle(imported.id);
  assert.equal(done.task.status, 'completed'); assert.ok(seenDocs);
  const tested = await service.test({ workspace_id: imported.id });
  assert.equal(tested.test.passed, true, tested.error); assert.equal(tested.test.hardware_verified, false);
  await service.install({ workspace_id: imported.id }); await engine.init();
  const catalog = await engine.pluginCatalog();
  assert.equal(catalog.plugins[0].id, HX_D350_MANIFEST.id);
  assert.deepEqual(catalog.plugins[0].streams.map(item => item.id), ['channel-1254', 'channel-1256']);
  assert.deepEqual(catalog.instances, []);
});

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sdk-agent-fixture-'));
  const sdk = path.join(directory, 'vendor-sdk'), root = path.join(directory, 'workspaces'), pluginsRoot = path.join(directory, 'plugins');
  await mkdir(sdk);
  await writeFile(path.join(sdk, 'index.mjs'), sdkSource);
  await writeFile(path.join(sdk, 'README.md'), 'Test SDK API: getFrame returns copied RGB8 2x2 Buffer; version is fixture-1.');
  const service = await createIntegrationService({ root, pluginsRoot, ...extra });
  const engine = new CaptureEngine({ dataDir: path.join(directory, 'sessions'), pluginRoot: pluginsRoot, sdkPath: false });
  t.after(async () => {
    await service.close(); await engine.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'sdk-agent-fixture-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, sdk, root, pluginsRoot, service, engine };
}

async function localModel(t, outputs) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, '/v1/responses'); assert.equal(request.headers.authorization, 'Bearer fixture-key-only');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const output = outputs[requests.length - 1];
    if (!output) { response.writeHead(500); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `response-${requests.length}`, status: 'completed', output }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { settings: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-test-fixture', apiKey: 'fixture-key-only' }, requests };
}

test('SDK import → real Responses tool loop → probe → atomic install → selectable camera → unified binary recording', async t => {
  const { sdk, root, pluginsRoot, directory, service, engine } = await fixture(t);
  const { settings, requests } = await localModel(t, [
    [call('list_sdk_files', {}, 1), call('read_sdk_file', { path: 'README.md' }, 2), call('read_sdk_file', { path: 'index.mjs' }, 3)],
    [call('write_draft_file', { path: 'plugin.json', content: JSON.stringify(manifest) }, 4)],
    [call('write_draft_file', { path: 'adapter.mjs', content: adapter }, 5)],
    [answer('适配器草稿已生成，请测试后安装；硬件尚未验证。')],
  ]);
  const imported = await service.importDirectory({ path: sdk });
  assert.equal(imported.files.length, 2); assert.equal(imported.status, 'imported');
  assert.deepEqual(await readdir(pluginsRoot), []);
  const started = await service.chat({ workspace_id: imported.id, message: '用这个 SDK 接入 RGB 摄像头。' }, settings);
  assert.equal(started.task.status, 'running');
  const drafted = await service.waitForIdle(imported.id);
  assert.equal(drafted.task.status, 'completed'); assert.equal(drafted.status, 'draft');
  assert.equal(drafted.generation.source, 'agent'); assert.equal(drafted.generation.model, settings.model);
  assert.equal(drafted.generation.revision, drafted.draft.revision);
  assert.ok(drafted.task.events.some(event => event.message.includes('read_sdk_file · README.md')));
  assert.equal(requests.length, 4); assert.equal(requests[0].store, false);
  assert.ok(requests[1].input.some(item => item.type === 'function_call_output' && item.output.includes('getFrame')));
  assert.equal((await service.readDraft({ workspace_id: imported.id, path: 'adapter.mjs' })).content, adapter);
  assert.ok(!(await readFile(path.join(root, imported.id, 'workspace.json'), 'utf8')).includes(settings.apiKey));
  const tested = await service.test({ workspace_id: imported.id });
  assert.equal(tested.test.passed, true); assert.equal(tested.test.hardware_verified, false);
  const installed = await service.install({ workspace_id: imported.id });
  assert.equal(installed.installed.plugin_id, manifest.id); assert.equal(installed.status, 'installed');
  const installation = JSON.parse(await readFile(path.join(pluginsRoot, manifest.id, '.installation.json'), 'utf8'));
  assert.equal(installation.generation.task_id, drafted.task.id);
  await engine.init();
  assert.equal((await engine.pluginCatalog()).plugins[0].name, manifest.name);
  const connection = await engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'sdkflow' });
  const recording = await engine.start({ name: 'SDK end-to-end fixture', device_ids: connection.stream_ids });
  await delay(160);
  const finished = await engine.stop();
  assert.equal(finished.status, 'complete'); assert.equal(finished.dropped_records, 0);
  assert.ok(finished.streams[0].records >= 3);
  const raw = await readFile(path.join(directory, 'sessions', recording.id, finished.streams[0].file));
  assert.equal(raw.subarray(0, 8).toString(), 'MDAQBIN1');
  assert.deepEqual([...raw.subarray(40, 52)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  await engine.pluginDisconnect({ instance_id: 'sdkflow' });
  assert.equal((await engine.pluginReload()).plugins[0].id, manifest.id);
});

test('changed draft cannot reuse old test; failed test preserves installed package; re-install keeps previous version', async t => {
  const { sdk, pluginsRoot, service } = await fixture(t);
  const state = await service.importDirectory({ path: sdk });
  await service.writeDraft({ workspace_id: state.id, path: 'plugin.json', content: JSON.stringify(manifest) });
  await service.writeDraft({ workspace_id: state.id, path: 'adapter.mjs', content: adapter });
  assert.equal((await service.test({ workspace_id: state.id })).test.passed, true);
  await service.install({ workspace_id: state.id });
  await service.writeDraft({ workspace_id: state.id, path: 'adapter.mjs', content: 'export function createAdapter(){ throw new Error("fixture bad SDK"); }' });
  assert.equal((await service.status({workspace_id:state.id})).generation.source, 'manual');
  await assert.rejects(service.install({ workspace_id: state.id }), /重新测试|先测试/);
  assert.equal((await service.test({ workspace_id: state.id })).test.passed, false);
  assert.equal(await readFile(path.join(pluginsRoot, manifest.id, 'adapter.mjs'), 'utf8'), adapter);
  await service.writeDraft({ workspace_id: state.id, path: 'adapter.mjs', content: adapter });
  await service.writeDraft({ workspace_id: state.id, path: 'plugin.json', content: JSON.stringify({ ...manifest, version: '1.0.1' }) });
  assert.equal((await service.test({ workspace_id: state.id })).test.passed, true);
  await service.install({ workspace_id: state.id });
  const versions = await readdir(path.join(pluginsRoot, '.history', manifest.id));
  assert.equal(versions.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(pluginsRoot, '.history', manifest.id, versions[0], 'plugin.json'), 'utf8')).version, '1.0.0');
});

test('SDK import and model tools reject path traversal, credentials and arbitrary execution', async t => {
  const { sdk, root, service } = await fixture(t);
  await writeFile(path.join(sdk, '.env.local'), 'PRIVATE=fixture-do-not-read');
  const state = await service.importDirectory({ path: sdk });
  assert.ok(state.skipped_files.includes('.env.local')); assert.equal(state.files.length, 2);
  for (const bad of ['../escape', '/etc/test', 'C:\\data\\x', 'a/../../b', 'CON.txt']) assert.throws(() => safeRelative(bad));
  await assert.rejects(service.importFiles({ name: 'bad', files: [{ path: '../escape', content_base64: 'eA==' }] }));
  await assert.rejects(readSdkText(path.join(root, state.id), state, '../workspace.json'));
  assert.throws(() => parseToolArguments(call('run_shell', { command: 'echo no' }, 0)), /不允许/);
  assert.throws(() => parseToolArguments(call('read_sdk_file', { path: 'README.md', extra: 'no' }, 0)), /约定/);
  await assert.rejects(service.writeDraft({ workspace_id: state.id, path: '../evil.mjs', content: '' }));
  assert.throws(() => normalizeModelSettings({ baseUrl: 'https://key:secret@example.com', model: 'x' }));
  assert.throws(() => normalizeModelSettings({ baseUrl: 'http://example.com', model: 'x' }));
});

test('reload failure rolls back installed package atomically', async t => {
  let rejectInstall = false;
  const { sdk, pluginsRoot, service } = await fixture(t, { onInstalled: async () => { if (rejectInstall) throw new Error('fixture backend busy'); } });
  const state = await service.importDirectory({ path: sdk });
  await service.writeDraft({ workspace_id: state.id, path: 'plugin.json', content: JSON.stringify(manifest) });
  await service.writeDraft({ workspace_id: state.id, path: 'adapter.mjs', content: adapter });
  await service.test({ workspace_id: state.id }); await service.install({ workspace_id: state.id });
  await service.writeDraft({ workspace_id: state.id, path: 'plugin.json', content: JSON.stringify({ ...manifest, version: '2.0.0' }) });
  await service.test({ workspace_id: state.id }); rejectInstall = true;
  await assert.rejects(service.install({ workspace_id: state.id }), /backend busy/);
  assert.equal(JSON.parse(await readFile(path.join(pluginsRoot, manifest.id, 'plugin.json'), 'utf8')).version, '1.0.0');
});

test('model cancellation releases task and never executes a late tool response', async t => {
  const { sdk, service } = await fixture(t, { fetchImpl: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) });
  const state = await service.importDirectory({ path: sdk });
  await service.chat({ workspace_id: state.id, message: 'prepare adapter' }, { baseUrl: 'https://example.invalid/v1', model: 'fixture' });
  await delay(10);
  const cancelled = await service.cancel({ workspace_id: state.id });
  assert.equal(cancelled.task.status, 'cancelled'); assert.equal(cancelled.draft.files.length, 0);
});

test('installation reserves workspace before awaiting and rejects concurrent edits or tests', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { sdk, service } = await fixture(t, { onInstalled: async () => { entered.resolve(); await release.promise; } });
  t.after(() => release.resolve());
  const state = await service.importDirectory({ path: sdk });
  await service.writeDraft({ workspace_id: state.id, path: 'plugin.json', content: JSON.stringify(manifest) });
  await service.writeDraft({ workspace_id: state.id, path: 'adapter.mjs', content: adapter });
  await service.test({ workspace_id: state.id });
  const installing = service.install({ workspace_id: state.id });
  try {
    // This call starts before install has even read its workspace.json.
    await assert.rejects(service.writeDraft({ workspace_id: state.id, path: 'adapter.mjs', content: 'broken' }), /正在适配或测试/);
    await entered.promise;
    await assert.rejects(service.test({ workspace_id: state.id }), /正在适配或测试/);
    await assert.rejects(service.chat({ workspace_id: state.id, message: 'change' }, { model: 'fixture' }), /正在适配或测试/);
  } finally { release.resolve(); }
  assert.equal((await installing).status, 'installed');
  assert.equal((await service.readDraft({ workspace_id: state.id, path: 'adapter.mjs' })).content, adapter);
});

test('altered imported docs are rejected before sending to a model and interrupted testing invalidates the old pass', async t => {
  const { sdk, root, service } = await fixture(t);
  const state = await service.importDirectory({ path: sdk });
  const directory = path.join(root, state.id), persisted = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8'));
  await writeFile(path.join(directory, 'draft', 'sdk', 'README.md'), 'altered docs');
  await assert.rejects(readSdkText(directory, persisted, 'README.md'), /已经改变|已改变/);
  persisted.status = 'testing'; persisted.test = { passed: true, revision: 'stale' };
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(persisted));
  const recovered = await service.status({ workspace_id: state.id });
  assert.equal(recovered.test, null); assert.match(recovered.error, /中断/);
});
