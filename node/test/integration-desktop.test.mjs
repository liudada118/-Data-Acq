import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelSettingsStore, validateModelSettings } from '../electron/integration-settings.mjs';
import { createIntegrationMaintenance } from '../src/integration-maintenance.mjs';

test('model settings never expose stored credentials and refuse cross-provider reuse', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'model.json');
  const store = createModelSettingsStore({ filename, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(),
    decryptString: value => Buffer.from(value).reverse().toString(),
  } });
  const config = { baseUrl: 'https://model.example/v1', model: 'test-model', apiKey: 'test-only-credential' };
  assert.deepEqual(await store.save(config), { baseUrl: config.baseUrl, model: config.model, hasKey: true });
  assert.equal((await readFile(filename, 'utf8')).includes(config.apiKey), false);
  assert.equal((await store.privateValue()).apiKey, config.apiKey);
  assert.equal((await store.save({ ...config, apiKey: '', model: 'next-model' })).hasKey, true);
  await assert.rejects(store.save({ baseUrl: 'https://different.example', model: 'a' }), /重新输入密钥/);
  const changed = await store.save({ baseUrl: 'https://different.example', model: 'a', clearApiKey: true });
  assert.equal(changed.hasKey, false); assert.equal((await store.privateValue()).apiKey, '');
  await store.save({ ...config, clearApiKey: true, apiKey: 'replacement-fixture-key' });
  assert.equal((await store.privateValue()).apiKey, 'replacement-fixture-key');
  await store.save({ baseUrl: config.baseUrl, model: config.model, clearApiKey: true });
  assert.equal((await store.get()).hasKey, false);
  await assert.rejects(store.save({ ...config, clearApiKey: 'true' }), /选项无效/);
  assert.throws(() => validateModelSettings({ baseUrl: 'http://remote.example', model: 'x' }), /HTTPS/);
  assert.throws(() => validateModelSettings({ baseUrl: 'https://x.example/?key=value', model: 'x' }), /查询参数/);
});

test('SDK maintenance lease blocks starts, rejects stale releases and expires after owner loss', () => {
  let time = 1;
  const maintenance = createIntegrationMaintenance({ now: () => time, ttlMs: 100 });
  const idle = { state: 'idle', engine_alive: true, session_id: null };
  assert.throws(() => maintenance.acquire({ ...idle, session_id: 'recording' }, {}), /停止/);
  assert.throws(() => maintenance.acquire(idle, { instances: [{ connected: true }] }), /断开/);
  const lease = maintenance.acquire(idle, {});
  assert.throws(() => maintenance.assertAvailable(), /正在测试/);
  maintenance.assertAvailable(lease.token);
  assert.throws(() => maintenance.release('wrong'), /不匹配/);
  maintenance.release(lease.token);
  maintenance.assertAvailable();
  maintenance.acquire(idle, {});
  time = 102;
  maintenance.assertAvailable();
});
