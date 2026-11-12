import { problem } from './storage.mjs';

export const MODEL_REQUEST_TIMEOUT_MS = 10 * 60_000;

// Some fetch implementations abort the HTTP request but not an already-open
// response reader. Bound both awaits explicitly and never expose abort reasons
// supplied by a transport or caller (they can include request credentials).
function waitWithAbort(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); handler(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function cancelBody(body) {
  try { void body?.cancel().catch(() => {}); } catch { /* best-effort cleanup */ }
}

/** Compatible with the reference application's Responses endpoint; credentials stay in memory. */
export function normalizeModelSettings(input = {}) {
  let url;
  try { url = new URL(input.baseUrl || 'https://api.openai.com/v1'); } catch { throw problem('模型服务地址无效。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || url.href.length > 1000) throw problem('模型服务需使用 HTTPS；本机服务可用 HTTP，地址不能含凭据或参数。');
  const model = String(input.model || '').trim();
  if (model.length > 120 || /[\x00-\x1f]/.test(model)) throw problem('模型名称无效。');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\x00-\x1f]/.test(input.apiKey))) throw problem('模型密钥格式无效。');
  return { baseUrl: url.href.replace(/\/+$/, ''), model, apiKey: input.apiKey?.trim() || '' };
}

async function responseText(response, limit, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw problem('模型返回了空响应。');
  let text = '', bytes = 0; const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await waitWithAbort(() => reader.read(), signal); if (done) break;
      bytes += value.length;
      if (bytes > limit) throw problem('模型响应超过 2 MiB。');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    // Cancellation must not itself wait indefinitely on a broken response body.
    try { void reader.cancel().catch(() => {}); } catch { /* already released */ }
    try { reader.releaseLock(); } catch { /* outstanding reader cleanup */ }
  }
}

export async function requestModel({ settings, input, instructions, tools, signal, fetchImpl = globalThis.fetch, timeoutMs = MODEL_REQUEST_TIMEOUT_MS }) {
  const config = normalizeModelSettings(settings);
  if (!config.model) throw problem('请先配置模型服务和模型名称。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) throw problem('模型请求超时参数无效。');
  const timeout = new AbortController(), timeoutReason = new Error('model-request-deadline');
  const combined = AbortSignal.any([signal, timeout.signal].filter(Boolean));
  const timer = setTimeout(() => timeout.abort(timeoutReason), timeoutMs);
  const abortProblem = () => combined.reason === timeoutReason
    ? problem('模型请求超时，尚未收到完整回复；草稿已保留，请重试。', 408)
    : problem('任务已取消。');
  try {
  let response;
  try {
    response = await waitWithAbort(async () => {
      const incoming = await fetchImpl(`${config.baseUrl}/responses`, { method: 'POST', signal: combined, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, instructions, input, tools, tool_choice: 'auto', parallel_tool_calls: false, stream: false, store: false }) });
      // A nonconforming transport may finish after cancellation. Its response
      // must not leave an unread network stream behind or execute late tools.
      if (combined.aborted) cancelBody(incoming.body);
      return incoming;
    }, combined);
  } catch {
    if (combined.aborted) throw abortProblem();
    throw problem('无法连接模型服务，请检查地址、网络和代理配置。');
  }
  if (!response.ok) {
    cancelBody(response.body);
    const explanation = response.status === 401 || response.status === 403 ? '请检查 API 密钥与模型权限。' : response.status === 429 ? '请求过多或额度不足。' : response.status === 404 ? '请确认地址支持 /responses 接口。' : '服务暂时不可用。';
    throw problem(`模型请求失败（HTTP ${response.status}）。${explanation}`);
  }
  let text;
  try { text = await responseText(response, 2 * 1024 * 1024, combined); }
  catch (error) {
    if (combined.aborted) throw abortProblem();
    if (error.statusCode) throw error;
    throw problem('模型响应读取中断，请检查网络后重试。');
  }
  let result;
  try { result = JSON.parse(text); }
  catch { throw problem('模型未返回有效的 Responses JSON。'); }
  if (!result || typeof result !== 'object' || result.status !== 'completed' || !Array.isArray(result.output) || result.output.length > 64) throw problem('模型响应未完整结束，本轮未继续执行工具。');
  for (const item of result.output) {
    if (!item || typeof item !== 'object' || (item.content !== undefined && !Array.isArray(item.content))) throw problem('模型响应内容格式无效。');
    if (item.type === 'function_call' && (typeof item.name !== 'string' || typeof item.call_id !== 'string' || typeof item.arguments !== 'string')) throw problem('模型工具调用格式无效。');
    for (const part of item.content ?? []) {
      if (!part || typeof part !== 'object') throw problem('模型响应内容格式无效。');
      if (part.type === 'refusal') throw problem('模型拒绝了本次请求，请调整描述。');
      if (part.type === 'output_text' && typeof part.text !== 'string') throw problem('模型响应内容格式无效。');
    }
  }
  if (!result.output.some(item => item.type === 'function_call' || item.content?.some(part => part.type === 'output_text' && part.text?.trim()))) throw problem('模型没有返回文本或工具调用。');
  return result;
  } finally { clearTimeout(timer); }
}
