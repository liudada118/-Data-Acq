import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createModelCatalog, normalizeModelCatalog, MAX_CATALOG_BYTES, MODEL_CATALOG_URL } from '../electron/integration-model-catalog.mjs';

const catalogFixture = () => ({ schemaVersion: 1, version: 'fixture-2026-11-11', providers: [
  { id: 'vendor', label: 'Fixture provider', baseUrl: 'https://model.example/v1/', defaultModel: 'model-a',
    models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }], hint: 'Public fixture metadata' },
  { id: 'custom', label: 'Custom', baseUrl: '', defaultModel: 'custom-model', models: [{ id: 'custom-model', label: 'Custom model' }] },
] });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });
async function temporary(t) {
  const prefix = path.join(os.tmpdir(), 'sdk-model-catalog-test-');
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(prefix) && path.dirname(resolved) === path.resolve(os.tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('catalog normalization exposes public metadata only and rejects malformed schemas or destinations', () => {
  const fixture = catalogFixture();
  fixture.apiKey = 'top-level-must-not-appear';
  fixture.providers[0].apiKey = 'provider-must-not-appear';
  fixture.providers[0].headers = { Authorization: 'must-not-appear' };
  fixture.providers[0].models[0].script = 'must-not-appear';
  const clean = normalizeModelCatalog(fixture);
  assert.equal(clean.providers[0].baseUrl, 'https://model.example/v1');
  assert.equal(JSON.stringify(clean).includes('must-not-appear'), false);
  const variants = [
    { ...catalogFixture(), schemaVersion: 2 },
    { ...catalogFixture(), providers: [] },
    { ...catalogFixture(), providers: [catalogFixture().providers[0]] },
    { ...catalogFixture(), providers: [catalogFixture().providers[0], catalogFixture().providers[0], catalogFixture().providers[1]] },
    { ...catalogFixture(), version: 'invalid\nversion' },
  ];
  for (const baseUrl of ['http://remote.example/v1', 'file:///local', 'https://user:password@example.com/v1', 'https://model.example/v1?key=abc', 'https://model.example/v1#fragment']) {
    const value = catalogFixture(); value.providers[0].baseUrl = baseUrl; variants.push(value);
  }
  for (const patch of [
    { defaultModel: 'missing-model' }, { id: '../bad' }, { label: 'control\u0000character' },
    { models: [{ id: 'model-a', label: 'A' }, { id: 'model-a', label: 'Duplicate' }] },
  ]) { const value = catalogFixture(); Object.assign(value.providers[0], patch); variants.push(value); }
  const custom = catalogFixture(); custom.providers[1].baseUrl = 'https://redirect.example'; variants.push(custom);
  for (const value of variants) assert.throws(() => normalizeModelCatalog(value));
});

test('directory GET is credential-free, caches sanitized metadata and never modifies saved model settings', async t => {
  const cacheDir = await temporary(t), calls = [], fixture = catalogFixture();
  const settingsFile = path.join(cacheDir, 'sdk-agent-model.json');
  const savedSettings = JSON.stringify({ baseUrl: 'https://existing.example/v1', model: 'existing-model', encryptedKey: 'fixture-ciphertext' });
  await writeFile(settingsFile, savedSettings);
  fixture.secret = 'must-not-cache'; fixture.providers[0].apiKey = 'must-not-cache';
  const service = createModelCatalog({ cacheDir, now: () => 1000, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return jsonResponse(fixture);
  } });
  t.after(() => service.dispose());
  const first = await service.load();
  assert.equal(first.source, 'remote'); assert.equal(first.version, fixture.version);
  assert.equal(calls[0].url, MODEL_CATALOG_URL);
  assert.equal(MODEL_CATALOG_URL, 'https://shroom.jq-industries.com/api/agent/model-catalog');
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, undefined);
  first.providers[0].baseUrl = 'https://mutated.example';
  assert.equal(service.snapshot().providers[0].baseUrl, 'https://model.example/v1');
  await service.load(); assert.equal(calls.length, 1);
  await service.load({ refresh: true }); assert.equal(calls.length, 2);
  const cache = await readFile(path.join(cacheDir, 'sdk-agent-model-catalog.json'), 'utf8');
  assert.equal(cache.includes('must-not-cache'), false);
  assert.equal(await readFile(settingsFile, 'utf8'), savedSettings);
  const restored = createModelCatalog({ cacheDir, now: () => 2000, fetchImpl: async () => { throw new Error('private upstream detail'); } });
  t.after(() => restored.dispose());
  assert.equal(restored.snapshot().source, 'cache');
  const offline = await restored.load({ refresh: true });
  assert.equal(offline.version, fixture.version); assert.match(offline.warning, /保留最近可用列表/);
  assert.equal(offline.warning.includes('private'), false);
  assert.equal(await readFile(settingsFile, 'utf8'), savedSettings);
});

test('HTML, HTTP errors, bad JSON, invalid UTF-8 and oversized bodies preserve the last valid cache', async t => {
  const cacheDir = await temporary(t); let response = jsonResponse(catalogFixture());
  const service = createModelCatalog({ cacheDir, fetchImpl: async () => response });
  t.after(() => service.dispose());
  await service.load();
  const filename = path.join(cacheDir, 'sdk-agent-model-catalog.json');
  const saved = await readFile(filename, 'utf8');
  const invalidResponses = [
    new Response('<html>login required</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('sensitive failure details', { status: 503 }),
    new Response('{}'),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    jsonResponse({ schemaVersion: 99, providers: [] }),
    new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(MAX_CATALOG_BYTES + 1), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_CATALOG_BYTES + 1) } }),
  ];
  for (const invalid of invalidResponses) {
    response = invalid;
    const current = await service.load({ refresh: true });
    assert.equal(current.version, catalogFixture().version); assert.equal(current.source, 'remote');
    assert.match(current.warning, /保留最近可用列表/);
    assert.equal(await readFile(filename, 'utf8'), saved);
  }
});

test('missing, corrupt, oversized or foreign-endpoint caches fall back to bundled options', async t => {
  const cacheDir = await temporary(t), filename = path.join(cacheDir, 'sdk-agent-model-catalog.json');
  for (const content of [null, '{broken', 'x'.repeat(MAX_CATALOG_BYTES + 1), JSON.stringify({
    endpoint: 'https://different.example/catalog', updatedAt: 1000, catalog: catalogFixture(),
  }), JSON.stringify({ endpoint: MODEL_CATALOG_URL, updatedAt: 1000, catalog: { schemaVersion: 2 } })]) {
    if (content !== null) await writeFile(filename, content);
    const service = createModelCatalog({ cacheDir, fetchImpl: async () => { throw new Error('offline'); } });
    try {
      assert.equal(service.snapshot().source, 'default');
      const fallback = await service.load();
      assert.equal(fallback.source, 'default'); assert.match(fallback.warning, /内置选项/);
      assert.ok(fallback.providers.some(provider => provider.id === 'custom'));
    } finally { service.dispose(); }
  }
});

test('concurrent requests deduplicate, periodic refresh is bounded and timed-out results cannot replace defaults', async t => {
  const cacheDir = await temporary(t); let resolveFetch, calls = 0, time = 1000;
  const service = createModelCatalog({ cacheDir, now: () => time, refreshIntervalMs: 100,
    fetchImpl: () => { calls++; return new Promise(resolve => { resolveFetch = resolve; }); } });
  t.after(() => service.dispose());
  const one = service.load(), two = service.load({ refresh: true });
  assert.equal(one, two); assert.equal(calls, 1);
  resolveFetch(jsonResponse(catalogFixture())); await Promise.all([one, two]);
  time = 1099; await service.load(); assert.equal(calls, 1);
  time = 1100; const later = service.load(); assert.equal(calls, 2); resolveFetch(jsonResponse(catalogFixture())); await later;
  const timeoutDir = await temporary(t); let resolveLate, signal;
  const timed = createModelCatalog({ cacheDir: timeoutDir, timeoutMs: 15, fetchImpl: (_url, options) => {
    signal = options.signal; return new Promise(resolve => { resolveLate = resolve; });
  } });
  t.after(() => timed.dispose());
  const fallback = await timed.load(); assert.equal(signal.aborted, true); assert.equal(fallback.source, 'default');
  resolveLate(jsonResponse(catalogFixture())); await delay(5);
  assert.equal(timed.snapshot().source, 'default');
  await assert.rejects(readFile(path.join(timeoutDir, 'sdk-agent-model-catalog.json')), { code: 'ENOENT' });
});

test('catalog request schema and endpoint validation reject arbitrary inputs and dispose cancels pending fetch', async t => {
  const cacheDir = await temporary(t);
  for (const url of ['http://untrusted.example/catalog', 'file:///tmp/catalog', 'https://user:password@example.com/catalog', 'https://example.com/catalog?token=x'])
    assert.throws(() => createModelCatalog({ cacheDir, url }));
  let signal, calls = 0;
  const service = createModelCatalog({ cacheDir, fetchImpl: (_url, options) => {
    calls++; signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  for (const input of [null, [], { refresh: 'yes' }, { apiKey: 'must-not-forward' }, { url: 'https://override.example' }])
    assert.throws(() => service.load(input), /请求参数无效/);
  const pending = service.load(); service.dispose();
  await pending; assert.equal(signal.aborted, true);
  const final = await service.load({ refresh: true }); assert.equal(calls, 1); assert.equal(final.source, 'default');
});
