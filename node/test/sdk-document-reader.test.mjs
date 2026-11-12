import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zip, docx, pdf } from './helpers/sdk-document-fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { DOCUMENT_LIMITS, extractSdkDocument, paginateSdkText } from '../src/integration/document-reader.mjs';
import { readSdkText, parseToolArguments, sdkFileReadingInfo } from '../src/integration/agent-tools.mjs';
import { createIntegrationService } from '../src/integration/service.mjs';

async function workspace(t, name, data) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sdk-doc-reader-'));
  const root = path.join(directory, 'draft', 'sdk'); await mkdir(root, { recursive: true });
  await writeFile(path.join(root, name), data);
  const state = { files: [{ path: name, size: data.length, text: false, sha256: createHash('sha256').update(data).digest('hex') }] };
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'sdk-doc-reader-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root, state };
}

test('old imports with text=false can read actual DOCX and paginate without binary model payloads', async t => {
  const original = '双目相机：左 rtsp://camera:1254，右 rtsp://camera:1256。\n'.repeat(700);
  const { directory, state, root } = await workspace(t, 'protocol.docx', docx(original));
  assert.equal(sdkFileReadingInfo(state.files[0]).readable, true);
  const first = await readSdkText(directory, state, 'protocol.docx', { limit: 200 });
  assert.equal(first.format, 'docx'); assert.equal(first.untrusted_sdk_material, true);
  assert.equal(first.content.length, 200); assert.equal(first.next_offset, 200);
  assert.ok(first.content.includes('rtsp://camera:1254')); assert.equal(first.text_truncated, false);
  const second = await readSdkText(directory, state, 'protocol.docx', { offset: first.next_offset, limit: 200 });
  assert.equal(second.offset, 200); assert.equal(second.content, (original + '\n\n').slice(200, 400));
  assert.ok(!JSON.stringify(first).includes('base64'));
  await writeFile(path.join(root, 'protocol.docx'), docx('changed vendor docs'));
  await assert.rejects(readSdkText(directory, state, 'protocol.docx'), /已改变/);
});

test('large native SDK header is readable in bounded pages and remains hash checked', async t => {
  const original = '// SDK declarations\n'.repeat(6000) + 'enum device_format { RGB = 22 };';
  const { directory, state, root } = await workspace(t, 'Types.h', Buffer.from(original));
  state.files[0].text = true;
  assert.ok(state.files[0].size > 96 * 1024);
  const first = await readSdkText(directory, state, 'Types.h', { limit: 48000 });
  assert.equal(first.content, original.slice(0, 48000));
  assert.equal(first.next_offset, 48000);
  const last = await readSdkText(directory, state, 'Types.h', { offset: 96000, limit: 48000 });
  assert.match(last.content, /RGB = 22/);
  assert.equal(last.next_offset, null);
  await writeFile(path.join(root, 'Types.h'), original + 'changed');
  await assert.rejects(readSdkText(directory, state, 'Types.h'), /已改变/);
});

test('PDF text layer carries page numbers and explicitly marks a scan-only page', async t => {
  const data = pdf(['LEFT RTSP rtsp://camera:1254', '', 'RIGHT RTSP rtsp://camera:1256']);
  const { directory, state } = await workspace(t, 'guide.pdf', data);
  const result = await readSdkText(directory, state, 'guide.pdf');
  assert.equal(result.page_count, 3); assert.equal(result.text_pages, 2);
  assert.equal(result.pages[1].has_text, false); assert.match(result.content, /未执行 OCR/);
  assert.match(result.content, /PDF 第 3 页/); assert.match(result.content, /rtsp:\/\/camera:1256/);
  assert.equal(result.next_offset, null);
});

test('document extraction rejects malformed archives, ZIP traversal, expansion bombs and page excess', async () => {
  await assert.rejects(extractSdkDocument(Buffer.from('not a zip'), '.docx'), /格式损坏/);
  await assert.rejects(extractSdkDocument(zip({ '../escape.txt': 'x', 'word/document.xml': '<x/>' }), '.docx'), /格式损坏|无效/);
  await assert.rejects(extractSdkDocument(zip({ 'word/document.xml': 'x'.repeat(DOCUMENT_LIMITS.zipEntryBytes + 1) }), '.docx'), /解压大小/);
  await assert.rejects(extractSdkDocument(Buffer.from('not a pdf'), '.pdf'), /PDF 标识/);
  await assert.rejects(extractSdkDocument(pdf(Array(201).fill('page')), '.pdf'), /200 页/);
});

test('parser deadlines/cancellation and read-range bounds do not leave a stuck Agent operation', async () => {
  await assert.rejects(extractSdkDocument(docx('timeout fixture'), '.docx', { timeoutMs: 1 }), /超过 15 秒/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractSdkDocument(docx('cancel fixture'), '.docx', { signal: controller.signal }), /取消/);
  const recovered = await extractSdkDocument(docx('subsequent request works'), '.docx');
  assert.match(recovered.content, /subsequent request works/);
  assert.throws(() => paginateSdkText('abc', { offset: 4 }), /超出/);
  assert.throws(() => parseToolArguments({ name: 'read_sdk_file', arguments: JSON.stringify({ path: 'a.pdf', limit: 48001 }) }), /约定/);
});

test('Agent tools list DOCX/PDF as readable and send only extracted text to Responses', async t => {
  const { directory } = await workspace(t, 'unused.txt', Buffer.from('fixture'));
  let request = 0; const bodies = [];
  const tool = (name, args, id) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
  const service = await createIntegrationService({ root: path.join(directory, 'workspaces'), pluginsRoot: path.join(directory, 'plugins'),
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      const output = request++ === 0 ? [tool('list_sdk_files', {}, 'list'), tool('read_sdk_file', { path: 'guide.pdf' }, 'read')] :
        [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已读取 PDF 中的左目 RTSP 地址。' }] }];
      return new Response(JSON.stringify({ status: 'completed', output }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  t.after(() => service.close());
  const imported = await service.importFiles({ name: 'document fixture', files: [{ path: 'guide.pdf', content_base64: pdf(['LEFT rtsp://camera:1254']).toString('base64') }] });
  assert.equal(imported.files[0].readable, true);
  await service.chat({ workspace_id: imported.id, message: '请读相机协议' }, { baseUrl: 'https://model.example/v1', model: 'fixture' });
  assert.equal((await service.waitForIdle(imported.id)).task.status, 'completed');
  const outputs = bodies[1].input.filter(value => value.type === 'function_call_output').map(value => JSON.parse(value.output));
  assert.equal(outputs[0].files[0].document_format, 'pdf');
  assert.match(outputs[1].content, /rtsp:\/\/camera:1254/);
  assert.ok(!JSON.stringify(bodies).includes('JVBERi0'));
});
