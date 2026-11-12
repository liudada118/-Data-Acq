import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, access, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import koffi from 'koffi';
import { createManagedNative } from '../src/plugins/native.mjs';
import { MAX_FRAME_BYTES } from '../src/plugins/contract.mjs';
import { probePackage } from '../src/plugins/manager.mjs';

const execFileAsync = promisify(execFile);

async function temporaryPackage(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'capture-native-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('capture-native-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'sdk'));
  return directory;
}

test('native frame copy owns its bytes after SDK memory changes and is freed', () => {
  const host = createManagedNative({ directory: os.tmpdir() });
  const expected = [0, 255, 12, 64, 128, 33, 200, 17];
  const pointer = koffi.alloc('uint8_t', expected.length);
  let copied;
  try {
    koffi.encode(pointer, 'uint8_t', expected, expected.length);
    copied = host.api.copy(pointer, expected.length);
    assert.ok(Buffer.isBuffer(copied));
    assert.deepEqual([...copied], expected);
    koffi.encode(pointer, 'uint8_t', Array(expected.length).fill(7), expected.length);
    assert.deepEqual([...copied], expected, 'copy must not retain a view into reusable native frame memory');
    copied[0] = 45;
    assert.deepEqual([...koffi.decode(pointer, 'uint8_t', expected.length)], Array(expected.length).fill(7));
  } finally {
    koffi.free(pointer);
    host.close();
  }
  assert.deepEqual([...copied], [45, ...expected.slice(1)], 'owned bytes remain valid after native memory is freed');
});

test('Electron plugin runtime copies native RGB frames and the 32 MiB limit without external buffers', { timeout: 30000 }, async () => {
  // Ordinary Node permits external ArrayBuffers, so it cannot catch the
  // Electron-only abort (exit 134) previously caused by koffi.view().
  const { default: executable } = await import('electron');
  const moduleUrl = new URL('../src/plugins/native.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const koffi = createRequire(process.argv[1])('koffi');
    const { createManagedNative } = await import(process.argv[1]);
    assert.ok(process.versions.electron, 'must exercise the actual desktop runtime');
    const host = createManagedNative({ directory: process.cwd() });
    const sizes = [8, 1600 * 1200 * 3, ${MAX_FRAME_BYTES}];
    for (const size of sizes) {
      const source = Buffer.alloc(size, 137);
      source[0] = 0; source[Math.floor(size / 2)] = 64; source[size - 1] = 255;
      const pointer = koffi.alloc('uint8_t', size);
      let copied;
      try {
        koffi.encode(pointer, 'uint8_t', source, size);
        copied = host.api.copy(pointer, size);
        assert.ok(Buffer.isBuffer(copied));
        assert.equal(copied.length, size);
        assert.deepEqual(copied, source);
        koffi.encode(pointer, 'uint8_t', 33);
        assert.equal(copied[0], 0, 'SDK memory reuse must not change the copy');
        copied[1] = 47;
        assert.equal(koffi.decode(pointer, 1, 'uint8_t'), 137, 'copy mutation must not change SDK memory');
        source[1] = 47;
        assert.throws(() => host.api.copy(pointer, ${MAX_FRAME_BYTES + 1}), /copy must be/);
      } finally { koffi.free(pointer); }
      assert.deepEqual(copied, source, 'bytes remain owned after freeing SDK memory');
    }
    host.close();
    console.log('ELECTRON_NATIVE_COPY_OK:' + JSON.stringify({ electron: process.versions.electron, sizes }));
  `;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await execFileAsync(executable, ['--input-type=module', '--eval', script, moduleUrl], {
    env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
  });
  assert.match(stdout, /ELECTRON_NATIVE_COPY_OK:/);
});

test('native copy rejects invalid pointers and byte limits before dereferencing memory', () => {
  const host = createManagedNative({ directory: os.tmpdir() });
  const pointer = koffi.alloc('uint8_t', 1);
  try {
    for (const length of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, MAX_FRAME_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => host.api.copy(pointer, length), /copy must be/);
    }
    for (const invalid of [0n, null, undefined, 42, '42', {}, Buffer.alloc(1)]) {
      assert.throws(() => host.api.copy(invalid, 1), /pointer is null or invalid/);
    }
    koffi.encode(pointer, 'uint8_t', 93);
    assert.deepEqual([...host.api.copy(pointer, 1)], [93]);
  } finally {
    koffi.free(pointer);
    host.close();
  }
  host.close();
  assert.throws(() => host.api.copy(pointer, 1), /host is closed/);
});

test('native libraries must be regular files inside sdk with safe relative paths', async t => {
  const directory = await temporaryPackage(t);
  const host = createManagedNative({ directory });
  t.after(() => host.close());
  for (const relative of ['../escape.dll', 'bin/../../escape.dll', '/absolute.dll', 'C:/absolute.dll',
    'C:\\absolute.dll', '//server/share/test.dll', 'bin\\escape.dll', 'bin//test.dll', 'bin/./test.dll', 'bad\0.dll']) {
    await assert.rejects(host.api.load(relative), /Invalid plugin relative path/);
  }
  await assert.rejects(host.api.load('bin/adapter.mjs'), /shared library/);
  await assert.rejects(host.api.load('missing.dll'), { code: 'ENOENT' });
  await mkdir(path.join(directory, 'sdk', 'directory.dll'));
  await assert.rejects(host.api.load('directory.dll'), /escapes imported/);
  await writeFile(path.join(directory, 'sdk', 'invalid.dll'), 'not a native library');
  await assert.rejects(host.api.load('invalid.dll'), /无法加载 SDK 动态库/);

  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'escape.dll'), 'must not load through junction');
  await symlink(outside, path.join(directory, 'sdk', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(host.api.load('alias/escape.dll'), /escapes imported/);
  host.close();
  await assert.rejects(host.api.load('missing.dll'), /host is closed/);
});

async function copyVersionOnlySdk(t, directory) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    t.skip('Orbbec fixture requires Windows x64');
    return false;
  }
  // Explicit opt-in path for other machines; the fallback is the user's already unpacked SDK.
  const sdk = process.env.ORBBEC_TEST_SDK_DIR ?? 'D:\\AA前端工作文档\\数采\\OrbbecSDK-Windows-x64';
  const sourceBin = path.join(sdk, 'bin');
  try { await access(path.join(sourceBin, 'OrbbecSDK.dll')); }
  catch (error) {
    if (process.env.ORBBEC_TEST_SDK_DIR || error.code !== 'ENOENT') throw error;
    t.skip('Set ORBBEC_TEST_SDK_DIR to an unpacked Windows x64 SDK to run the actual DLL probe');
    return false;
  }
  await mkdir(path.join(directory, 'sdk', 'bin'));
  // No examples, OpenCV GUI libraries, cameras or recording data are needed for Version.h.
  for (const name of ['OrbbecSDK.dll', 'concrt140.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'vcruntime140.dll']) {
    try { await copyFile(path.join(sourceBin, name), path.join(directory, 'sdk', 'bin', name)); }
    catch (error) { if (name === 'OrbbecSDK.dll' || error.code !== 'ENOENT') throw error; }
  }
  return true;
}

test('actual Orbbec version APIs load without opening a device, including async calls and close guards', { timeout: 20000 }, async t => {
  const directory = await temporaryPackage(t);
  if (!await copyVersionOnlySdk(t, directory)) return;
  // Run DLL lifetime checks in an owned child: Windows releases the copied DLL when the child exits.
  const moduleUrl = new URL('../src/plugins/native.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    const { createManagedNative } = await import(process.argv[1]);
    const host = createManagedNative({ directory: process.argv[2] });
    const library = await host.api.load('bin/OrbbecSDK.dll');
    assert.equal(await host.api.load('bin/OrbbecSDK.dll'), library);
    assert.equal(await host.api.load('BIN/orbbecsdk.DLL'), library);
    const getVersion = library.func('int ob_get_version(void)');
    const version = getVersion();
    const major = library.func('int ob_get_major_version(void)')();
    const minor = library.func('int ob_get_minor_version(void)')();
    const patch = library.func('int ob_get_patch_version(void)')();
    const stage = library.func('const char *ob_get_stage_version(void)')();
    assert.ok(Number.isInteger(version) && version > 0);
    assert.ok(Number.isInteger(major) && major > 0);
    assert.ok(Number.isInteger(minor) && minor >= 0);
    assert.ok(Number.isInteger(patch) && patch >= 0);
    assert.equal(typeof stage, 'string');
    assert.equal(await new Promise((resolve, reject) => getVersion.async((error, value) => error ? reject(error) : resolve(value))), version);
    host.close(); host.close();
    assert.throws(() => getVersion(), /host is closed/);
    assert.throws(() => getVersion.async(() => {}), /host is closed/);
    assert.throws(() => library.func('int ob_get_version(void)'), /host is closed/);
    assert.throws(() => host.api.copy(0n, 1), /host is closed/);
    await assert.rejects(host.api.load('bin/OrbbecSDK.dll'), /host is closed/);
    console.log('NATIVE_RESULT:' + JSON.stringify({ version, major, minor, patch, stage }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, directory], {
    windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  const resultLine = stdout.split(/\r?\n/).find(line => line.startsWith('NATIVE_RESULT:'));
  assert.ok(resultLine, 'child completed native function and lifecycle assertions');
  const result = JSON.parse(resultLine.slice('NATIVE_RESULT:'.length));
  t.diagnostic(`Loaded SDK ${result.major}.${result.minor}.${result.patch}${result.stage ? `-${result.stage}` : ''}; only version APIs were invoked`);
});

test('isolated plugin probe exposes managed native DLL loading and never calls acquisition start', { timeout: 20000 }, async t => {
  const directory = await temporaryPackage(t);
  if (!await copyVersionOnlySdk(t, directory)) return;
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({
    api_version: 1, id: 'fixture-native-probe', name: 'Test-only native version probe', version: '1.0.0', entry: 'adapter.mjs',
    streams: [{ id: 'rgb', name: 'Never-started test stream', kind: 'camera', dtype: 'uint8', shape: [1, 1, 3] }],
  }));
  // This is a contract fixture, not a vendor acquisition adapter; it has no device API bindings.
  await writeFile(path.join(directory, 'adapter.mjs'), `
    export function createAdapter({ native }) {
      return {
        async probe() {
          const library = await native.load('bin/OrbbecSDK.dll');
          return { ok: true, version: library.func('int ob_get_version(void)')(),
            native_platform: native.platform, native_arch: native.arch, hardware_verified: false };
        },
        start() { throw new Error('Version-only fixture must never start or open a device'); },
        stop() {},
      };
    }
  `);
  const result = await probePackage(directory);
  assert.equal(result.passed, true);
  assert.equal(result.probe_ran, true);
  assert.equal(result.hardware_verified, false);
  assert.equal(result.details.hardware_verified, false);
  assert.equal(result.details.native_platform, 'win32');
  assert.equal(result.details.native_arch, 'x64');
  assert.ok(Number.isInteger(result.details.version) && result.details.version > 0);
});
