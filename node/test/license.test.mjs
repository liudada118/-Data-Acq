import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activateSdkLicense } from '../src/capture/license.mjs';

const valid = { valid: true, productType: 'shroom-sdk', mode: 'online', expiresAt: 1, leaseExpiresAt: 1, products: [], allProducts: true, features: [] };
async function fixture(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'node-license-test-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const calls = [];
  return { homeDir, calls, Shroom: { async activateLicense(key, options) { calls.push({ key, options }); return valid; } } };
}

test('public API receives trimmed key and reuses a stable installation id', async t => {
  const { homeDir, calls, Shroom } = await fixture(t);
  const env = { SHROOM_LICENSE_KEY: ' fixture-only-license \n' };
  assert.equal(await activateSdkLicense(Shroom, { homeDir, env }), valid);
  await activateSdkLicense(Shroom, { homeDir, env });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, 'fixture-only-license');
  assert.equal(calls[0].options.mode, 'online');
  assert.match(calls[0].options.deviceId, /^[a-f0-9]{64}$/);
  assert.equal(calls[0].options.deviceId, calls[1].options.deviceId);
  assert.equal(await readFile(path.join(homeDir, '.shroom-sdk', 'device-id'), 'utf8'), calls[0].options.deviceId);
});

test('missing or empty key causes no activation or installation-id creation', async t => {
  const { homeDir, calls, Shroom } = await fixture(t);
  for (const env of [{}, { SHROOM_LICENSE_KEY: '  ' }]) {
    await assert.rejects(activateSdkLicense(Shroom, { homeDir, env }), error => error.code === 'LICENSE_REQUIRED' && error.statusCode === 422);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(stat(path.join(homeDir, '.shroom-sdk')), { code: 'ENOENT' });
});

test('existing id is reused and explicit id does not change an existing file', async t => {
  const { homeDir, calls, Shroom } = await fixture(t);
  const directory = path.join(homeDir, '.shroom-sdk');
  await mkdir(directory);
  const savedId = 'a'.repeat(64), override = 'b'.repeat(64);
  await writeFile(path.join(directory, 'device-id'), savedId + '\n');
  await activateSdkLicense(Shroom, { homeDir, env: { SHROOM_LICENSE_KEY: 'fixture' } });
  assert.equal(calls[0].options.deviceId, savedId);
  await activateSdkLicense(Shroom, { homeDir, env: { SHROOM_LICENSE_KEY: 'fixture', SHROOM_DEVICE_ID: override } });
  assert.equal(calls[1].options.deviceId, override);
  assert.equal(await readFile(path.join(directory, 'device-id'), 'utf8'), savedId + '\n');
});

test('file license and offline options use the public API; explicit key takes precedence', async t => {
  const { homeDir, calls, Shroom } = await fixture(t);
  const keyFile = path.join(homeDir, 'fixture-license.txt'), publicKeyFile = path.join(homeDir, 'fixture-public.pem');
  await writeFile(keyFile, '\uFEFF fixture-file-key \r\n');
  await writeFile(publicKeyFile, ' fixture-public-key \n');
  const env = { SHROOM_LICENSE_FILE: keyFile, SHROOM_LICENSE_MODE: 'offline', SHROOM_LICENSE_PUBLIC_KEY_FILE: publicKeyFile, SHROOM_LICENSE_SERVER: 'https://license.example.invalid', SHROOM_DEVICE_ID: 'c'.repeat(64) };
  await activateSdkLicense(Shroom, { homeDir, env });
  assert.deepEqual(calls[0], { key: 'fixture-file-key', options: { mode: 'offline', serverUrl: env.SHROOM_LICENSE_SERVER, publicKey: 'fixture-public-key', deviceId: env.SHROOM_DEVICE_ID } });
  await activateSdkLicense(Shroom, { homeDir, env: { ...env, SHROOM_LICENSE_KEY: 'fixture-env-key', SHROOM_LICENSE_FILE: 'missing-file' } });
  assert.equal(calls[1].key, 'fixture-env-key');
  await assert.rejects(stat(path.join(homeDir, '.shroom-sdk')), { code: 'ENOENT' });
});

test('invalid configuration and invalid existing installation id fail without overwriting', async t => {
  const { homeDir, calls, Shroom } = await fixture(t);
  for (const config of [{ SHROOM_LICENSE_MODE: 'unknown' }, { SHROOM_DEVICE_ID: 'D'.repeat(64) }, { SHROOM_DEVICE_ID: '' }]) {
    await assert.rejects(activateSdkLicense(Shroom, { homeDir, env: { SHROOM_LICENSE_KEY: 'fixture', ...config } }));
  }
  const directory = path.join(homeDir, '.shroom-sdk');
  await mkdir(directory);
  await writeFile(path.join(directory, 'device-id'), 'existing-invalid-id');
  await assert.rejects(activateSdkLicense(Shroom, { homeDir, env: { SHROOM_LICENSE_KEY: 'fixture' } }), error => error.code === 'LICENSE_DEVICE_REQUIRED');
  assert.equal(await readFile(path.join(directory, 'device-id'), 'utf8'), 'existing-invalid-id');
  assert.equal(calls.length, 0);
});

test('oversized or malformed UTF-8 files fail before activation', async t => {
  const { homeDir, calls, Shroom } = await fixture(t);
  const keyFile = path.join(homeDir, 'fixture-license');
  for (const content of [Buffer.alloc(65537, 65), Buffer.from([0xc3, 0x28]), Buffer.alloc(16385, 65)]) {
    await writeFile(keyFile, content);
    await assert.rejects(activateSdkLicense(Shroom, { homeDir, env: { SHROOM_LICENSE_FILE: keyFile } }));
  }
  assert.equal(calls.length, 0);
  await assert.rejects(stat(path.join(homeDir, '.shroom-sdk')), { code: 'ENOENT' });
});

test('activation failures and invalid results never expose file keys or SDK error details', async t => {
  const { homeDir } = await fixture(t);
  const key = 'file-key-must-not-escape', keyFile = path.join(homeDir, 'fixture-license');
  await writeFile(keyFile, key);
  const env = { SHROOM_LICENSE_FILE: keyFile, SHROOM_DEVICE_ID: 'e'.repeat(64) };
  for (const activateLicense of [
    async () => { throw Object.assign(new Error(`failure ${key}`), { code: 'LICENSE_EXPIRED', cause: key, details: { key } }); },
    async () => ({ valid: false, code: 'LICENSE_REJECTED', message: key }),
    async () => { throw Object.assign(new Error(key), { code: key }); },
  ]) {
    await assert.rejects(activateSdkLicense({ activateLicense }, { homeDir, env }), error => {
      assert.equal(error.statusCode, 422);
      assert.equal(error.stage, 'license');
      assert.ok(!String(error.stack).includes(key));
      assert.ok(!JSON.stringify(error).includes(key));
      assert.equal(error.cause, undefined);
      assert.equal(error.details, undefined);
      return true;
    });
  }
});

test('concurrent first activations use one installation id', async t => {
  const { homeDir, calls, Shroom } = await fixture(t);
  await Promise.all(Array.from({ length: 4 }, () => activateSdkLicense(Shroom, { homeDir, env: { SHROOM_LICENSE_KEY: 'fixture' } })));
  assert.equal(new Set(calls.map(call => call.options.deviceId)).size, 1);
});
