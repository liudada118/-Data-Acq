import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, statfs } from 'node:fs/promises';

export const LIMITS = Object.freeze({ files: 10_000, bytes: 8 * 1024 ** 3, fileBytes: 2 * 1024 ** 3,
  uploadBytes: 32 * 1024 * 1024, textBytes: 1024 * 1024, sourceBytes: 256 * 1024, stateBytes: 16 * 1024 * 1024 });
export const PACKAGE_LIMITS = Object.freeze({ files: LIMITS.files + 2, bytes: LIMITS.bytes + 2 * LIMITS.sourceBytes, fileBytes: LIMITS.fileBytes });
export const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.java', '.rs', '.toml', '.yaml', '.yml', '.cmake', '.xml']);
export function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\x00-\x1f<>:"|?*]/.test(value)) throw problem('文件路径无效。');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) throw problem('文件路径不能越出 SDK 目录。');
  return parts.join('/');
}
export function secretPath(value) {
  return value.split('/').some(part => /^\.(git|env)(\.|$)/i.test(part) || /^(credentials?|secrets?)(\.|$)/i.test(part) || /\.(pem|key|pfx|p12)$/i.test(part));
}
export async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filename);
}
export async function readJson(filename, limit = LIMITS.stateBytes) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw problem('本地配置文件无效。');
  return JSON.parse(await readFile(filename, 'utf8'));
}
function checkCancelled(signal) {
  if (signal?.aborted) throw problem('SDK 操作已取消。', 499);
}
function formatBytes(bytes) {
  const value = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB（${bytes} 字节）`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MiB（${bytes} 字节）`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB（${bytes} 字节）`;
  return `${bytes} 字节`;
}
function contained(root, value) {
  const relative = path.relative(root, value);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function sameFile(before, after) {
  return before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino && before.dev === after.dev;
}
export async function hashFile(filename, { signal } = {}) {
  checkCancelled(signal);
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(filename, { signal })) {
      checkCancelled(signal); hash.update(chunk);
    }
  } catch (error) { checkCancelled(signal); throw error; }
  checkCancelled(signal);
  return hash.digest('hex');
}

/** Metadata preflight rejects an oversized tree before any file is read/hash-copied. */
export async function inspectTree(directory, { excludeSecrets = false, limits = PACKAGE_LIMITS, signal } = {}) {
  checkCancelled(signal);
  if (!limits || ['files', 'bytes', 'fileBytes'].some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 0)) throw problem('SDK 导入限制配置无效。');
  const base = path.resolve(directory);
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw problem('请选择本地 SDK 文件夹，不能使用符号链接。');
  const realBase = await realpath(base);
  const files = [], skipped = [], seen = new Set(), snapshots = new Map(); let bytes = 0;
  async function walk(current, prefix = '', depth = 0) {
    checkCancelled(signal);
    if (depth > 24) throw problem('SDK 目录嵌套过深。');
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      checkCancelled(signal);
      const relative = safeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (excludeSecrets && secretPath(relative)) { skipped.push(relative); continue; }
      const full = path.join(current, entry.name), info = await lstat(full);
      if (info.isSymbolicLink()) throw problem(`SDK 包含符号链接，无法导入：${relative}`);
      const resolved = await realpath(full);
      if (!contained(realBase, resolved)) throw problem(`SDK 文件越出选定目录：${relative}`);
      if (info.isDirectory()) { await walk(full, relative, depth + 1); continue; }
      if (!info.isFile()) throw problem(`SDK 包含非常规文件：${relative}`);
      const key = relative.toLowerCase();
      if (seen.has(key)) throw problem('SDK 文件名存在大小写冲突。');
      seen.add(key);
      if (!Number.isSafeInteger(info.size) || info.size < 0) throw problem(`SDK 文件大小无效：${relative}`);
      const nextCount = files.length + 1, nextBytes = bytes + info.size;
      if (info.size > limits.fileBytes) throw problem(`SDK 目录「${base}」超过单文件大小限制：${relative} 为 ${formatBytes(info.size)}，上限 ${formatBytes(limits.fileBytes)}。`, 413);
      if (nextCount > limits.files) throw problem(`SDK 目录「${base}」超过文件数量限制：已发现 ${nextCount} 个文件，上限 ${limits.files} 个；触发文件：${relative}。`, 413);
      if (!Number.isSafeInteger(nextBytes) || nextBytes > limits.bytes) throw problem(`SDK 目录「${base}」超过总大小限制：已发现 ${formatBytes(nextBytes)}，上限 ${formatBytes(limits.bytes)}；触发文件：${relative}。`, 413);
      bytes = nextBytes;
      files.push({ path: relative, size: info.size, text: TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase()) });
      snapshots.set(relative, { info, resolved });
    }
  }
  await walk(base);
  // No hash starts until the entire metadata tree has passed its limits.
  for (const file of files) {
    checkCancelled(signal);
    const filename = path.join(base, file.path), snapshot = snapshots.get(file.path);
    const before = await lstat(filename), actual = await realpath(filename);
    if (!before.isFile() || before.isSymbolicLink() || !sameFile(snapshot.info, before) || actual !== snapshot.resolved || await realpath(base) !== realBase) throw problem(`SDK 扫描期间文件发生变化：${file.path}，请重试。`);
    file.sha256 = await hashFile(filename, { signal });
    const after = await lstat(filename);
    if (!after.isFile() || after.isSymbolicLink() || !sameFile(before, after) || await realpath(filename) !== actual) throw problem(`SDK 读取期间文件发生变化：${file.path}，请重试。`);
  }
  checkCancelled(signal);
  return { files, bytes, skipped };
}

/** Copy once while hashing. Caller owns the destination staging directory. */
export async function copyTree(source, destination, files, { signal } = {}) {
  checkCancelled(signal);
  const sourceBase = path.resolve(source), targetBase = path.resolve(destination);
  const sourceInfo = await lstat(sourceBase);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw problem('复制源必须是普通 SDK 目录。');
  const actualSource = await realpath(sourceBase);
  if (contained(sourceBase, targetBase) || contained(targetBase, sourceBase)) throw problem('SDK 源目录与复制目标不能相互包含。');
  await mkdir(targetBase, { recursive: true });
  const targetInfo = await lstat(targetBase), actualTarget = await realpath(targetBase);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink() || contained(actualSource, actualTarget) || contained(actualTarget, actualSource)) throw problem('SDK 复制目标目录无效。');
  const seen = new Set();
  async function verifiedSource(relative) {
    const rootInfo = await lstat(sourceBase);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(sourceBase) !== actualSource) throw problem('复制期间 SDK 源目录发生变化。');
    let current = sourceBase, info;
    for (const part of relative.split('/')) {
      current = path.join(current, part); info = await lstat(current);
      if (info.isSymbolicLink()) throw problem(`复制时 SDK 文件或目录变成了符号链接：${relative}`);
    }
    if (!info.isFile() || !contained(actualSource, await realpath(current))) throw problem(`SDK 复制源越出原目录或不是普通文件：${relative}`);
    return info;
  }
  for (const file of files) {
    checkCancelled(signal);
    const relative = safeRelative(file.path), key = relative.toLowerCase(), input = path.join(sourceBase, relative), target = path.join(targetBase, relative);
    if (seen.has(key) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw problem('SDK 复制清单无效或包含重复文件。');
    seen.add(key);
    const before = await verifiedSource(relative);
    if (before.size !== file.size) throw problem(`SDK 在导入过程中发生变化：${relative} 的实际大小 ${formatBytes(before.size)} 与清单 ${formatBytes(file.size)} 不一致。`);
    let parent = targetBase;
    for (const part of relative.split('/').slice(0, -1)) {
      parent = path.join(parent, part); await mkdir(parent, { recursive: true });
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw problem(`SDK 复制目标包含非目录或符号链接：${relative}`);
    }
    if (await realpath(targetBase) !== actualTarget || !contained(actualTarget, await realpath(parent))) throw problem('SDK 复制目标越出原目录。');
    const hash = createHash('sha256'); let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      try {
        checkCancelled(signal); bytes += chunk.length;
        if (bytes > file.size) throw problem(`SDK 在复制时增大，已停止：${relative} 超过清单大小 ${formatBytes(file.size)}。`);
        hash.update(chunk); callback(null, chunk);
      } catch (error) { callback(error); }
    } });
    try {
      await pipeline(createReadStream(input, { signal }), meter, createWriteStream(target, { flags: 'wx', mode: before.mode & 0o777 }), { signal });
    } catch (error) { checkCancelled(signal); throw error; }
    checkCancelled(signal);
    const after = await verifiedSource(relative);
    if (!sameFile(before, after) || bytes !== file.size || hash.digest('hex') !== file.sha256) throw problem(`SDK 在导入过程中发生变化：${relative}，请重试。`);
    if (!contained(actualTarget, await realpath(target))) throw problem('SDK 复制目标越出原目录。');
  }
}

/** statfs uses available blocks for the current user, not all free filesystem blocks. */
export async function assertDiskSpace(directory, bytes, { reserveBytes = 512 * 1024 * 1024, statfsImpl = statfs } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || !Number.isSafeInteger(bytes + reserveBytes)) throw problem('SDK 磁盘空间检查参数无效。');
  const target = path.resolve(directory);
  let info;
  try { info = await statfsImpl(target, { bigint: true }); }
  catch { throw problem(`无法检查 SDK 目标目录「${target}」的可用磁盘空间，请检查目录与磁盘状态。`); }
  if (!info || typeof info !== 'object') throw problem(`SDK 目标目录「${target}」的磁盘空间信息无效。`);
  const integer = value => typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : null;
  const blocks = integer(info.bavail), blockSize = integer(info.bsize);
  if (blocks === null || blockSize === null || blocks < 0n || blockSize <= 0n) throw problem(`SDK 目标目录「${target}」的磁盘空间信息无效。`);
  const available = blocks * blockSize, required = BigInt(bytes) + BigInt(reserveBytes);
  if (available < required) throw problem(`SDK 目标目录「${target}」磁盘空间不足：可用 ${formatBytes(available)}，本次所需 ${formatBytes(required)}（包含保留空间 ${formatBytes(reserveBytes)}）。请释放空间或更换保存位置。`, 507);
  return { available_bytes: available <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(available) : available.toString(), required_bytes: Number(required), reserve_bytes: reserveBytes };
}
export function treeRevision(files) {
  return createHash('sha256').update(files.map(file => `${file.path}\0${file.size}\0${file.sha256}`).sort().join('\n')).digest('hex');
}
