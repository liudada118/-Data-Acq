import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const MODEL_CATALOG_URL = 'https://shroom.jq-industries.com/api/agent/model-catalog';
export const MAX_CATALOG_BYTES = 128 * 1024;
const builtin = JSON.parse(readFileSync(new URL('../src/integration/model-catalog-defaults.json', import.meta.url), 'utf8'));
const shortText = (value, length, empty = false) => {
  if (typeof value !== 'string' || value.length > length || /[\x00-\x1f\x7f]/.test(value) || (!empty && !value.trim())) throw new Error('Invalid model catalog text');
  return value.trim();
};

/** Only public display metadata and Responses base URLs cross the catalog boundary. */
export function normalizeModelCatalog(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.providers) || !input.providers.length || input.providers.length > 32) throw new Error('Invalid model catalog');
  const ids = new Set();
  const providers = input.providers.map(provider => {
    const id = shortText(provider?.id, 40);
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error('Invalid provider ID');
    ids.add(id);
    const address = shortText(provider.baseUrl, 1000, id === 'custom');
    let baseUrl = '';
    if (id === 'custom') { if (address) throw new Error('Custom provider cannot prescribe an endpoint'); }
    else {
      const url = new URL(address);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid provider URL');
      baseUrl = url.href.replace(/\/+$/, '');
    }
    if (!Array.isArray(provider.models) || !provider.models.length || provider.models.length > 100) throw new Error('Invalid provider models');
    const modelIds = new Set();
    const models = provider.models.map(model => {
      const modelId = shortText(model?.id, 120);
      if (modelIds.has(modelId)) throw new Error('Duplicate model ID');
      modelIds.add(modelId);
      return { id: modelId, label: shortText(model.label, 100) };
    });
    const defaultModel = shortText(provider.defaultModel, 120);
    if (!modelIds.has(defaultModel)) throw new Error('Invalid default model');
    return { id, label: shortText(provider.label, 100), baseUrl, defaultModel, models,
      ...(provider.hint === undefined ? {} : { hint: shortText(provider.hint, 500, true) }) };
  });
  if (!ids.has('custom')) throw new Error('Missing custom provider');
  return { schemaVersion: 1, version: shortText(input.version, 100), providers };
}

/** Fetch the Shroom directory without the user's model key, SDK documents or cookies. */
async function downloadCatalog(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal });
  if (!response.ok || !/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => {}); throw new Error('Catalog unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty catalog');
  let bytes = 0, content = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) throw new Error('Catalog exceeds size limit');
      content += decoder.decode(value, { stream: true });
    }
    return normalizeModelCatalog(JSON.parse(content + decoder.decode()));
  } finally { await reader.cancel().catch(() => {}); }
}

/** Remote → last valid cache → bundled defaults; refresh never changes saved connections. */
export function createModelCatalog({ cacheDir, fetchImpl = globalThis.fetch, url = MODEL_CATALOG_URL,
  now = Date.now, timeoutMs = 5000, refreshIntervalMs = 6 * 60 * 60 * 1000 } = {}) {
  const endpoint = new URL(url);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid catalog endpoint');
  const filename = path.join(cacheDir, 'sdk-agent-model-catalog.json');
  let catalog = normalizeModelCatalog(builtin), source = 'default', updatedAt = null, warning = '', pending, activeController, disposed = false, lastAttempt = null;
  try {
    if (statSync(filename).size > MAX_CATALOG_BYTES) throw new Error('Oversized cache');
    const saved = JSON.parse(readFileSync(filename, 'utf8'));
    if (saved.endpoint === endpoint.href && Number.isFinite(saved.updatedAt) && saved.updatedAt > 0) {
      catalog = normalizeModelCatalog(saved.catalog); source = 'cache'; updatedAt = Math.min(now(), saved.updatedAt);
    }
  } catch { /* A missing or invalid public cache must not block model configuration. */ }
  const snapshot = () => structuredClone({ ...catalog, source, updatedAt, ...(warning ? { warning } : {}) });
  function load(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'refresh') || (input.refresh !== undefined && typeof input.refresh !== 'boolean')) throw new Error('模型目录请求参数无效。');
    if (disposed) return Promise.resolve(snapshot());
    if (pending) return pending;
    const recent = Math.max(updatedAt ?? 0, lastAttempt ?? 0);
    if (!input.refresh && recent > 0 && now() - recent < refreshIntervalMs) return Promise.resolve(snapshot());
    lastAttempt = now();
    const controller = activeController = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Catalog timeout')); }, timeoutMs); });
    pending = (async () => {
      try {
        const next = await Promise.race([downloadCatalog(fetchImpl, endpoint.href, controller.signal), deadline]);
        if (!disposed) {
          catalog = next; source = 'remote'; updatedAt = now(); warning = '';
          try {
            await mkdir(cacheDir, { recursive: true });
            const temporary = `${filename}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify({ endpoint: endpoint.href, updatedAt, catalog }));
            await rename(temporary, filename);
          } catch { warning = '模型列表已更新，本机缓存暂时无法保存。'; }
        }
      } catch {
        if (!disposed) warning = source === 'default' ? '暂时无法更新模型列表，已使用内置选项。' : '暂时无法更新模型列表，已保留最近可用列表。';
      } finally { clearTimeout(timer); activeController = null; pending = null; }
      return snapshot();
    })();
    return pending;
  }
  return { load, snapshot, dispose() { disposed = true; activeController?.abort(); } };
}
