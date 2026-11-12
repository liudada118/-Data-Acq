import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createIntegrationService } from '../src/integration/service.mjs';
import { LIMITS } from '../src/integration/storage.mjs';

const manifest = {
  api_version: 1, id: 'draft-patch-fixture', name: 'Draft patch fixture', version: '1.0.0', entry: 'adapter.mjs',
  streams: [{ id: 'rgb', name: 'Unused test stream', kind: 'camera', dtype: 'uint8', shape: [1, 1, 3] }],
};
const adapter = `// duplicate-marker duplicate-marker
export function createAdapter() {
  return {
    probe() { return { ok: true, message: 'original-probe-note' }; },
    start() { throw new Error('Test fixture must never start acquisition'); },
    stop() {},
  };
}
`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'integration-patch-test-'));
  const root = path.join(directory, 'workspaces'), pluginsRoot = path.join(directory, 'plugins');
  let queuedCall, toolResult, requestIndex = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://draft-patch.invalid/v1/responses');
    const body = JSON.parse(options.body);
    assert.ok(body.tools.some(tool => tool.name === 'replace_draft_text'));
    assert.ok(queuedCall, 'only deterministic test Responses are allowed');
    let output;
    if (requestIndex++ === 0) {
      output = [{ type: 'function_call', call_id: 'patch-fixture-call', name: 'replace_draft_text', arguments: JSON.stringify(queuedCall) }];
    } else {
      assert.equal(requestIndex, 2, 'one tool request and one final answer per patch');
      const result = body.input.findLast(item => item.type === 'function_call_output' && item.call_id === 'patch-fixture-call');
      assert.ok(result, 'service must return the actual tool result to the model');
      toolResult = JSON.parse(result.output);
      output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: toolResult.error ? '替换被拒绝。' : '局部修改完成，请重新测试。' }] }];
    }
    return new Response(JSON.stringify({ status: 'completed', output }), { headers: { 'Content-Type': 'application/json' } });
  };
  const service = await createIntegrationService({ root, pluginsRoot, fetchImpl });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('integration-patch-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const imported = await service.importFiles({ name: 'Patch SDK fixture', files: [
    { path: 'README.md', content_base64: Buffer.from('Documentation-only fixture. No devices or vendor code.').toString('base64') },
  ] });
  const workspace_id = imported.id;
  await service.writeDraft({ workspace_id, path: 'plugin.json', content: JSON.stringify(manifest, null, 2) });
  await service.writeDraft({ workspace_id, path: 'adapter.mjs', content: adapter });
  const tested = await service.test({ workspace_id });
  assert.equal(tested.test.passed, true, tested.error);
  const patch = async args => {
    queuedCall = args; toolResult = undefined; requestIndex = 0;
    await service.chat({ workspace_id, message: '仅修改指定的唯一代码段。' }, {
      baseUrl: 'https://draft-patch.invalid/v1', model: 'deterministic-patch-model',
    });
    const state = await service.waitForIdle(workspace_id);
    assert.equal(state.task.status, 'completed', state.error);
    assert.equal(requestIndex, 2);
    assert.ok(toolResult);
    return { state, result: toolResult };
  };
  const snapshot = async () => ({
    state: await service.status({ workspace_id }),
    files: await Promise.all(['adapter.mjs', 'plugin.json', 'sdk/README.md'].map(name => readFile(path.join(root, workspace_id, 'draft', name), 'utf8'))),
    names: (await readdir(path.join(root, workspace_id, 'draft'))).sort(),
  });
  return { service, workspace_id, patch, snapshot, tested, root, pluginsRoot };
}

test('Agent exact replacement edits either draft file, records its provenance and invalidates the previous passed test', async t => {
  const { service, workspace_id, patch, tested, pluginsRoot } = await fixture(t);
  const edited = await patch({ path: 'adapter.mjs', before: 'original-probe-note', after: 'agent-revised-note' });
  assert.equal(edited.result.saved, 'adapter.mjs');
  assert.equal(edited.result.executed, false);
  assert.equal((await service.readDraft({ workspace_id, path: 'adapter.mjs' })).content, adapter.replace('original-probe-note', 'agent-revised-note'));
  assert.notEqual(edited.state.draft.revision, tested.draft.revision);
  assert.equal(edited.result.revision, edited.state.draft.revision);
  assert.equal(edited.state.generation.source, 'agent');
  assert.equal(edited.state.generation.model, 'deterministic-patch-model');
  assert.equal(edited.state.generation.task_id, edited.state.task.id);
  assert.equal(edited.state.generation.revision, edited.state.draft.revision);
  assert.equal(edited.state.test, null);
  await assert.rejects(service.install({ workspace_id }), /先测试|重新测试/);
  assert.deepEqual(await readdir(pluginsRoot), [], 'patching never installs a plugin');

  const retested = await service.test({ workspace_id });
  assert.equal(retested.test.passed, true, retested.error);
  assert.equal(retested.test.revision, edited.state.draft.revision);
  const changedManifest = await patch({ path: 'plugin.json', before: 'Draft patch fixture', after: 'Agent revised fixture' });
  assert.equal(changedManifest.result.saved, 'plugin.json');
  assert.equal(JSON.parse((await service.readDraft({ workspace_id, path: 'plugin.json' })).content).name, 'Agent revised fixture');
  assert.notEqual(changedManifest.state.draft.revision, retested.draft.revision);
  assert.equal(changedManifest.state.test, null);
  assert.equal(changedManifest.state.generation.source, 'agent');
});

test('invalid or ambiguous patch targets preserve files, revision, provenance and the existing test', async t => {
  const { patch, snapshot } = await fixture(t);
  const cases = [
    { name: 'empty before', path: 'adapter.mjs', before: '', after: 'must not insert', error: /替换文本无效/ },
    { name: 'missing before', path: 'adapter.mjs', before: 'absent-source-segment', after: 'must not insert', error: /唯一匹配/ },
    { name: 'multiple matches', path: 'adapter.mjs', before: 'duplicate-marker', after: 'ambiguous change', error: /唯一匹配/ },
    { name: 'SDK source file', path: 'sdk/README.md', before: 'Documentation', after: 'modified vendor documentation', error: /参数不符合约定|只能查看/ },
    { name: 'new file', path: 'extra.mjs', before: 'anything', after: 'extra executable', error: /参数不符合约定|只能查看/ },
    { name: 'parent traversal', path: '../workspace.json', before: 'anything', after: 'outside draft', error: /参数不符合约定|只能查看/ },
  ];
  for (const { name, error, ...args } of cases) {
    await t.test(name, async () => {
      const before = await snapshot();
      const rejected = await patch(args);
      assert.match(rejected.result.error, error);
      const after = await snapshot();
      assert.deepEqual(after.files, before.files);
      assert.deepEqual(after.names, before.names);
      assert.deepEqual(after.state.draft, before.state.draft);
      assert.deepEqual(after.state.test, before.state.test);
      assert.deepEqual(after.state.generation, before.state.generation);
    });
  }
});

test('patch refuses a merged file above 256 KiB even when the replacement itself fits, without invalidating its test', async t => {
  const { patch, snapshot } = await fixture(t);
  const before = await snapshot();
  const search = 'original-probe-note';
  const replacement = 'x'.repeat(LIMITS.sourceBytes - Buffer.byteLength(adapter) + Buffer.byteLength(search) + 1);
  assert.ok(Buffer.byteLength(replacement) < LIMITS.sourceBytes);
  assert.equal(Buffer.byteLength(adapter.replace(search, replacement)), LIMITS.sourceBytes + 1);
  const rejected = await patch({ path: 'adapter.mjs', before: search, after: replacement });
  assert.match(rejected.result.error, /256 KiB/);
  const after = await snapshot();
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.names, before.names);
  assert.deepEqual(after.state.draft, before.state.draft);
  assert.deepEqual(after.state.test, before.state.test);
  assert.deepEqual(after.state.generation, before.state.generation);
});
