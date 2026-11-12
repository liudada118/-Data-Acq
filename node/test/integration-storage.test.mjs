import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, PACKAGE_LIMITS, inspectTree, hashFile, copyTree, assertDiskSpace } from '../src/integration/storage.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sdk-storage-test-'));
  const source = path.join(directory, 'source'), target = path.join(directory, 'target');
  await mkdir(source);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'sdk-storage-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, source, target };
}
async function interceptReads(callback, action) {
  const original = fs.createReadStream;
  fs.createReadStream = (filename, options) => callback(original, filename, options);
  syncBuiltinESMExports();
  try { return await action(); }
  finally { fs.createReadStream = original; syncBuiltinESMExports(); }
}
const digest = data => createHash('sha256').update(data).digest('hex');

test('desktop limits reserve two draft files without widening upload/text/parser limits', async t => {
  assert.equal(LIMITS.files, 10_000); assert.equal(LIMITS.bytes, 8 * 1024 ** 3); assert.equal(LIMITS.fileBytes, 2 * 1024 ** 3);
  assert.equal(LIMITS.stateBytes, 16 * 1024 ** 2); assert.equal(LIMITS.uploadBytes, 32 * 1024 ** 2);
  assert.equal(LIMITS.textBytes, 96 * 1024); assert.equal(LIMITS.sourceBytes, 256 * 1024);
  assert.equal(PACKAGE_LIMITS.files, LIMITS.files + 2); assert.equal(PACKAGE_LIMITS.bytes, LIMITS.bytes + 2 * LIMITS.sourceBytes);
  const { source } = await fixture(t);
  await writeFile(path.join(source, 'a.dll'), '12'); await writeFile(path.join(source, 'b.h'), '34');
  const sourceLimits = { files: 2, bytes: 4, fileBytes: 2 };
  assert.equal((await inspectTree(source, { limits: sourceLimits })).bytes, 4);
  await writeFile(path.join(source, 'plugin.json'), '{}'); await writeFile(path.join(source, 'adapter.mjs'), '{}');
  const packageLimits = { ...sourceLimits, files: sourceLimits.files + 2, bytes: sourceLimits.bytes + 2 * LIMITS.sourceBytes };
  assert.equal((await inspectTree(source, { limits: packageLimits })).files.length, 4);
});

test('metadata preflight reports exact count/bytes/path and never hashes a partially oversized tree', async t => {
  const { source } = await fixture(t);
  await writeFile(path.join(source, 'a.dll'), '1234'); await writeFile(path.join(source, 'z-large.bin'), '123456');
  const cases = [
    { limits: { files: 1, bytes: 10, fileBytes: 6 }, pattern: /文件数量限制.*2 个文件.*1 个.*z-large\.bin/ },
    { limits: { files: 2, bytes: 9, fileBytes: 6 }, pattern: /总大小限制.*10 字节.*9 字节.*z-large\.bin/ },
    { limits: { files: 2, bytes: 10, fileBytes: 5 }, pattern: /单文件大小限制.*z-large\.bin.*6 字节.*5 字节/ },
  ];
  for (const item of cases) {
    let reads = 0;
    await interceptReads((original, filename, options) => { reads++; return original(filename, options); }, async () => {
      await assert.rejects(inspectTree(source, { limits: item.limits }), error => {
        assert.equal(error.statusCode, 413); assert.ok(error.message.includes(source)); assert.match(error.message, item.pattern); return true;
      });
    });
    assert.equal(reads, 0, 'no content reads are allowed before the full metadata tree passes');
  }
  assert.equal((await inspectTree(source, { limits: { files: 2, bytes: 10, fileBytes: 6 } })).bytes, 10);
});

test('binary SDK and headers are preserved exactly, only existing credential rules are excluded', async t => {
  const { source, target } = await fixture(t);
  const binary = Buffer.from([0, 1, 2, 255, 128, 0]);
  await mkdir(path.join(source, 'lib')); await mkdir(path.join(source, 'include'));
  await writeFile(path.join(source, 'lib', 'driver.dll'), binary);
  await writeFile(path.join(source, 'include', 'camera.h'), '#define CAMERA 1');
  await writeFile(path.join(source, 'installer.exe'), binary);
  await writeFile(path.join(source, '.env.local'), 'test credential fixture');
  const tree = await inspectTree(source, { excludeSecrets: true, limits: LIMITS });
  assert.deepEqual(tree.files.map(file => file.path).sort(), ['include/camera.h', 'installer.exe', 'lib/driver.dll']);
  assert.deepEqual(tree.skipped, ['.env.local']);
  await copyTree(source, target, tree.files);
  assert.deepEqual(await readFile(path.join(target, 'lib', 'driver.dll')), binary);
  assert.equal(await readFile(path.join(target, 'include', 'camera.h'), 'utf8'), '#define CAMERA 1');
  assert.equal(tree.files.find(file => file.path === 'lib/driver.dll').sha256, digest(binary));
  await assert.rejects(copyTree(source, target, tree.files), error => error.code === 'EEXIST');
});

test('copy hashes the source stream once and rejects changed contents or file size', async t => {
  const { source, target, directory } = await fixture(t);
  const filename = path.join(source, 'camera.dll'); await writeFile(filename, 'sdk-bytes');
  const tree = await inspectTree(source);
  const reads = [];
  await interceptReads((original, file, options) => { reads.push(file); return original(file, options); }, () => copyTree(source, target, tree.files));
  assert.deepEqual(reads, [filename], 'copy does not reread its target to hash it');
  await writeFile(filename, 'different'); // same byte count, different digest
  await assert.rejects(copyTree(source, path.join(directory, 'changed'), tree.files), /发生变化/);
  await writeFile(filename, 'sdk-bytes-grow');
  await assert.rejects(copyTree(source, path.join(directory, 'grown'), tree.files), /实际大小.*清单/);
});

test('a file that grows during streaming is stopped before bytes beyond its manifest reach the target', async t => {
  const { source, target } = await fixture(t);
  const filename = path.join(source, 'camera.dll'); await writeFile(filename, Buffer.alloc(512, 7));
  const tree = await inspectTree(source);
  await interceptReads((original, file, options) => {
    const stream = original(file, { ...options, highWaterMark: 32 });
    stream.once('data', () => fs.appendFileSync(filename, Buffer.alloc(64, 8)));
    return stream;
  }, async () => await assert.rejects(copyTree(source, target, tree.files), /复制时增大|发生变化/));
  assert.ok((await stat(path.join(target, 'camera.dll'))).size <= 512);
});

test('hash, preflight and copy respect aborts, including a cancellation during a copied stream', async t => {
  const { source, target } = await fixture(t);
  const filename = path.join(source, 'camera.dll'); await writeFile(filename, Buffer.alloc(65536, 7));
  const tree = await inspectTree(source), cancelled = new AbortController(); cancelled.abort('fixture');
  await assert.rejects(hashFile(filename, { signal: cancelled.signal }), /已取消/);
  await assert.rejects(inspectTree(source, { signal: cancelled.signal }), /已取消/);
  await assert.rejects(copyTree(source, target, tree.files, { signal: cancelled.signal }), /已取消/);
  await assert.rejects(stat(target), error => error.code === 'ENOENT');
  const controller = new AbortController();
  await interceptReads((original, file, options) => {
    const stream = original(file, { ...options, highWaterMark: 32 }); stream.once('data', () => controller.abort()); return stream;
  }, async () => await assert.rejects(copyTree(source, target, tree.files, { signal: controller.signal }), /已取消/));
  assert.ok((await stat(path.join(target, 'camera.dll'))).size < 65536);
});

test('copy rejects a parent-directory junction swapped in after inspection', async t => {
  const { source, target, directory } = await fixture(t);
  await mkdir(path.join(source, 'lib')); await writeFile(path.join(source, 'lib', 'camera.dll'), 'same bytes');
  const tree = await inspectTree(source);
  const outside = path.join(directory, 'external'); await mkdir(outside); await writeFile(path.join(outside, 'camera.dll'), 'same bytes');
  await rename(path.join(source, 'lib'), path.join(source, 'old-lib'));
  await symlink(outside, path.join(source, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyTree(source, target, tree.files), /符号链接/);
  assert.deepEqual(await readdir(target), []);
});

test('disk preflight uses available space and a reserve, rejects shortage before any writes', async t => {
  const { source } = await fixture(t);
  let called;
  const statfsImpl = async (directory, options) => { called = { directory, options }; return { bavail: 10n, bfree: 999n, bsize: 4n }; };
  const result = await assertDiskSpace(source, 30, { reserveBytes: 10, statfsImpl });
  assert.equal(result.available_bytes, 40); assert.equal(result.required_bytes, 40);
  assert.deepEqual(called, { directory: source, options: { bigint: true } });
  await assert.rejects(assertDiskSpace(source, 31, { reserveBytes: 10, statfsImpl }), error => {
    assert.equal(error.statusCode, 507); assert.match(error.message, /可用 40 字节.*所需 41 字节.*保留空间 10 字节/); return true;
  });
  assert.deepEqual(await readdir(source), []);
  await assert.rejects(assertDiskSpace(source, 1, { statfsImpl: async () => { throw new Error('fixture filesystem failure'); } }), /无法检查.*可用磁盘空间/);
  await assert.rejects(assertDiskSpace(source, 1, { reserveBytes: 0, statfsImpl: async () => ({ bavail: -1, bsize: 4 }) }), /空间信息无效/);
});
