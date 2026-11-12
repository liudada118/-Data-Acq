import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { requestModel, MODEL_REQUEST_TIMEOUT_MS } from '../src/integration/provider.mjs';

const secret = 'fixture-key-that-must-never-appear-in-errors';
const settings = { baseUrl: 'https://model.example/v1', model: 'fixture', apiKey: secret };
const success = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] };
const request = extra => requestModel({ settings, input: [{ role: 'user', content: 'fixture' }], instructions: 'fixture', tools: [], ...extra });
const safeError = (pattern, statusCode) => error => {
  assert.match(error.message, pattern);
  assert.equal(error.message.includes(secret), false);
  if (statusCode) assert.equal(error.statusCode, statusCode);
  return true;
};

test('default deadline is ten minutes and timeout override is not sent to the model', async () => {
  assert.equal(MODEL_REQUEST_TIMEOUT_MS, 600_000);
  let body;
  const result = await request({ timeoutMs: 200, fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify(success));
  } });
  assert.equal(result.output[0].content[0].text, 'done');
  assert.equal(body.timeoutMs, undefined); assert.equal(body.timeout, undefined);
  assert.equal(body.stream, false); assert.equal(body.store, false);
});

test('caller cancellation before headers is distinct and does not expose transport/abort secrets', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers();
  const pending = request({ signal: controller.signal, timeoutMs: 500, fetchImpl: async (_url, { signal }) => {
    entered.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(secret)), { once: true }));
  } });
  await entered.promise; controller.abort(secret);
  await assert.rejects(pending, safeError(/^任务已取消。$/));
  let called = false;
  await assert.rejects(request({ signal: controller.signal, fetchImpl: async () => { called = true; } }), safeError(/取消/));
  assert.equal(called, false);
});

test('deadline before headers also bounds a transport that ignores AbortSignal', async () => {
  let transportSignal;
  await assert.rejects(request({ timeoutMs: 20, fetchImpl: async (_url, { signal }) => {
    transportSignal = signal; return new Promise(() => {});
  } }), safeError(/模型请求超时/, 408));
  assert.equal(transportSignal.aborted, true);
});

test('caller cancellation after headers interrupts body reading even when stream cancellation stalls', async () => {
  const controller = new AbortController(), reading = Promise.withResolvers();
  let cancelled = false;
  const stream = new ReadableStream({
    start(writer) { writer.enqueue(new TextEncoder().encode(`{"status":"completed","partial":"${secret}`)); },
    pull() { reading.resolve(); return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  const pending = request({ signal: controller.signal, timeoutMs: 500, fetchImpl: async () => new Response(stream) });
  await reading.promise; controller.abort(secret);
  await assert.rejects(pending, safeError(/^任务已取消。$/));
  assert.equal(cancelled, true);
});

test('deadline after headers is a timeout, never malformed JSON, and cancels an incomplete body', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(writer) { writer.enqueue(new TextEncoder().encode(`{"private":"${secret}`)); },
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(request({ timeoutMs: 20, fetchImpl: async () => new Response(stream) }), safeError(/模型请求超时/, 408));
  assert.equal(cancelled, true);
});

test('real fetch headers can arrive promptly while an unfinished HTTP body reaches the request deadline', async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"status":"completed",');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(request({ settings: { ...settings, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, timeoutMs: 100 }), safeError(/模型请求超时/, 408));
});

test('malformed JSON, transport read failures and HTTP errors retain separate sanitized messages', async () => {
  await assert.rejects(request({ fetchImpl: async () => new Response(`<html>${secret}</html>`) }), safeError(/^模型未返回有效的 Responses JSON。$/));
  await assert.rejects(request({ fetchImpl: async () => new Response(new ReadableStream({ start(writer) { writer.error(new Error(secret)); } })) }), safeError(/响应读取中断/));
  await assert.rejects(request({ fetchImpl: async () => { throw new Error(secret); } }), safeError(/无法连接模型服务/));
  await assert.rejects(request({ fetchImpl: async () => new Response(secret, { status: 401 }) }), safeError(/HTTP 401/));
  await assert.rejects(request({ fetchImpl: async () => new Response('null') }), safeError(/响应未完整结束/));
});

test('oversized responses remain a size-limit failure rather than JSON or network errors', async () => {
  await assert.rejects(request({ fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), safeError(/响应超过 2 MiB/));
});
