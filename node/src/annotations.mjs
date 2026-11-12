import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, open, rename, unlink } from 'node:fs/promises';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_ANNOTATIONS = 10000;
const MAX_HISTORY = 30000;
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const clone = value => structuredClone(value);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function text(value, limit, field, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw error(`${field} 格式或长度无效。`);
  return value.trim();
}
export function validateExperiment(value = {}) {
  if (!isObject(value)) throw error('实验信息必须是对象。');
  const result = {};
  for (const key of ['project', 'task', 'subject', 'scene', 'trial']) result[key] = text(value[key], 160, key);
  result.notes = text(value.notes, 2000, '备注');
  const tags = value.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 32) throw error('整段标签最多 32 个。');
  result.tags = [...new Set(tags.map(tag => text(tag, 80, '整段标签')).filter(Boolean))];
  return result;
}
export function validateLabels(value = []) {
  if (!Array.isArray(value) || value.length > 64) throw error('标签字典最多 64 项。');
  const ids = new Set(), shortcuts = new Set();
  return value.map(item => {
    if (!isObject(item) || !SAFE_ID.test(item.id ?? '') || ids.has(item.id)) throw error('标签 ID 无效或重复。');
    ids.add(item.id);
    const name = text(item.name, 80, '标签名称');
    if (!name || !['point', 'interval'].includes(item.kind) || !/^#[0-9a-f]{6}$/i.test(item.color ?? '')) throw error('标签名称、类型或颜色无效。');
    const shortcut = text(item.shortcut, 1, '快捷键').toLowerCase();
    if (shortcut && (!/^[a-z0-9]$/.test(shortcut) || shortcuts.has(shortcut))) throw error('快捷键必须是单个字母或数字，且不能重复。');
    if (shortcut) shortcuts.add(shortcut);
    return { id: item.id, name, color: item.color.toLowerCase(), shortcut, kind: item.kind };
  });
}
function ns(value, field = '标注时间') {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(value)) throw error(`${field} 必须是非负纳秒十进制字符串。`);
  return BigInt(value);
}
function durationNs(manifest) {
  if (typeof manifest.duration_ns === 'string') return ns(manifest.duration_ns, '会话时长');
  const seconds = manifest.duration_s ?? manifest.duration_seconds ?? 0;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1e8) throw error('会话时长无效。');
  return BigInt(Math.round(seconds * 1e9));
}
function emptyDocument(manifest) {
  return { schema_version: 1, session_id: manifest.id, revision: 0,
    experiment: validateExperiment(manifest.experiment), labels: validateLabels(manifest.labels),
    annotations: [], history: [] };
}
async function folderPath(dataDir, id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw error('无效的会话 ID。');
  const root = await realpath(dataDir);
  const candidate = path.join(root, id);
  const info = await lstat(candidate).catch(cause => { if (cause.code === 'ENOENT') throw error('会话不存在。', 404); throw cause; });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(candidate) !== candidate) throw error('无效的会话路径。', 403);
  return candidate;
}
function validateDocument(value, manifest) {
  if (!isObject(value) || value.schema_version !== 1 || value.session_id !== manifest.id ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.annotations) ||
      value.annotations.length > MAX_ANNOTATIONS || !Array.isArray(value.history) || value.history.length > MAX_HISTORY)
    throw error('标注文件格式无效，原文件已保留。');
  validateExperiment(value.experiment); validateLabels(value.labels);
  const ids = new Set();
  const knownStreams = new Set(manifest.device_ids ?? []);
  const finalLimit = manifest.finalized && ['complete', 'completed'].includes(manifest.status) ? durationNs(manifest) : null;
  for (const item of value.annotations) {
    if (!isObject(item) || !SAFE_ID.test(item.id ?? '') || ids.has(item.id) || !SAFE_ID.test(item.label_id ?? '') ||
      !['point', 'interval'].includes(item.kind) || !/^#[0-9a-f]{6}$/i.test(item.color ?? '') ||
      !Array.isArray(item.stream_ids) || item.stream_ids.some(id => !knownStreams.has(id))) throw error('标注文件条目无效，原文件已保留。');
    ids.add(item.id);
    text(item.label_name, 80, '标签名称'); text(item.note, 2000, '标注备注');
    const start = ns(item.start_ns), end = item.end_ns === null ? null : ns(item.end_ns);
    if (end !== null && end < start || item.kind === 'point' && end !== start) throw error('标注时间区间无效。');
    if (finalLimit !== null && (start > finalLimit || end !== null && end > finalLimit)) throw error('标注时间超出录制范围，原文件已保留。');
  }
  return value;
}
/** One atomic sidecar snapshot; never silently replace malformed annotations. */
export async function readAnnotationDocument(dataDir, manifest) {
  const folder = await folderPath(dataDir, manifest.id);
  const filename = path.join(folder, 'annotations.json');
  const info = await lstat(filename).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
  if (!info) return emptyDocument(manifest);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) throw error('标注文件过大或路径无效。');
  let document;
  try { document = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw error('标注文件无法解析，原文件已保留。'); }
  return validateDocument(document, manifest);
}
async function save(dataDir, manifest, document) {
  validateDocument(document, manifest);
  const data = JSON.stringify(document, null, 2) + '\n';
  const opened = document.annotations.filter(item => item.end_ns === null);
  // Reserve room for automatic closure, including before/after audit entries. Annotation
  // edits are infrequent and bounded; this work never runs on the sample ingestion path.
  const closureReserve = opened.reduce((bytes, item) => bytes + 3 * Buffer.byteLength(JSON.stringify(item)) + 2048, 0);
  if (document.history.length + opened.length > MAX_HISTORY || Buffer.byteLength(data) + closureReserve > MAX_FILE)
    throw error('标注历史达到容量上限，请先结束已打开区间或开始新会话。', 413);
  const folder = await folderPath(dataDir, manifest.id);
  const filename = path.join(folder, 'annotations.json');
  const prior = await lstat(filename).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
  if (prior && (!prior.isFile() || prior.isSymbolicLink())) throw error('无效的标注文件路径。', 403);
  const temporary = path.join(folder, `.annotations-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx'); await handle.writeFile(data, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, filename);
  } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
function revision(document, input) {
  if (!Number.isSafeInteger(input?.revision) || input.revision !== document.revision) throw error('标签已被其他操作修改，请刷新后重试。', 409);
}
function audit(document, action, before, after, reason) {
  if (document.history.length >= MAX_HISTORY) throw error('标注修改历史已满，请开始新会话。', 413);
  document.revision++;
  document.history.push({ revision: document.revision, at: new Date().toISOString(), action,
    ...(before !== undefined ? { before: clone(before) } : {}), ...(after !== undefined ? { after: clone(after) } : {}), ...(reason ? { reason } : {}) });
}
function streams(input, manifest) {
  const value = input ?? [];
  if (!Array.isArray(value) || value.length > 64 || value.some(id => typeof id !== 'string' || !manifest.device_ids.includes(id))) throw error('标注数据流不属于当前会话。');
  return [...new Set(value)];
}

export class AnnotationStore {
  constructor({ dataDir, capture }) { this.dataDir = dataDir; this.capture = capture; this.queues = new Map(); this.pending = 0; this.closed = false; }
  run(id, action) {
    if (this.closed) return Promise.reject(error('标注服务已关闭。', 503));
    if (this.pending >= 128) return Promise.reject(error('标注操作过多，请稍后重试。', 503));
    this.pending++;
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.queues.set(id, next);
    return next.finally(() => { this.pending--; if (this.queues.get(id) === next) this.queues.delete(id); });
  }
  async initSession(manifest) {
    return this.run(manifest.id, async () => {
      const document = await readAnnotationDocument(this.dataDir, manifest);
      // A generated session ID must be fresh; existing data is never replaced here.
      if (document.revision || document.annotations.length) throw error('会话标签已存在。', 409);
      await save(this.dataDir, manifest, document); return document;
    });
  }
  read(id) { return this.run(id, async () => readAnnotationDocument(this.dataDir, await this.capture.getSession(id))); }
  mutate(id, input) {
    return this.run(id, async () => {
      if (!isObject(input)) throw error('标注请求必须是对象。');
      const live = ['mark', 'begin', 'end'].includes(input.op);
      const clock = live ? await this.capture.annotationClock(id) : null;
      const manifest = clock?.manifest ?? await this.capture.getSession(id);
      if (!live && !manifest.finalized) throw error('停止录制后才能修改或删除标注。', 409);
      const document = await readAnnotationDocument(this.dataDir, manifest);
      revision(document, input);
      if (!['mark', 'begin', 'end', 'upsert', 'delete'].includes(input.op)) throw error('未知标注操作。');
      const index = document.annotations.findIndex(item => item.id === input.id);
      const prior = index >= 0 ? document.annotations[index] : null;
      if (input.op === 'delete') {
        if (!prior) throw error('标注不存在。', 404);
        document.annotations.splice(index, 1); audit(document, 'delete', prior);
      } else if (input.op === 'end') {
        if (!prior || prior.kind !== 'interval' || prior.end_ns !== null) throw error('没有匹配的未结束区间。', 409);
        const next = { ...prior, end_ns: clock.time_ns, updated_at: new Date().toISOString() };
        if (ns(next.end_ns) < ns(prior.start_ns)) throw error('结束时间早于开始时间。');
        document.annotations[index] = next; audit(document, 'end', prior, next);
      } else {
        const label = document.labels.find(item => item.id === input.label_id);
        if (!label) throw error('标签不在当前会话字典中。');
        if (input.op === 'mark' && label.kind !== 'point' || input.op === 'begin' && label.kind !== 'interval') throw error('标注操作与标签类型不一致。');
        if (input.op === 'upsert' && input.id && !prior) throw error('标注不存在。', 404);
        const start = live ? ns(clock.time_ns) : ns(input.start_ns);
        const end = label.kind === 'point' ? start : live ? null : ns(input.end_ns);
        if (end !== null && end < start || !live && (start > durationNs(manifest) || end > durationNs(manifest))) throw error('标注时间必须在录制范围内，且结束时间不能早于开始时间。');
        const streamIds = streams(input.stream_ids, manifest);
        if (input.op === 'begin' && document.annotations.some(item => item.label_id === label.id && item.end_ns === null && JSON.stringify(item.stream_ids) === JSON.stringify(streamIds))) throw error('该标签已有未结束区间，请先结束。', 409);
        if (!prior && document.annotations.length >= MAX_ANNOTATIONS) throw error('标注数量达到上限，请开始新会话。', 413);
        const now = new Date().toISOString();
        const item = { id: prior?.id ?? `ann-${randomUUID()}`, label_id: label.id, label_name: label.name, color: label.color,
          kind: label.kind, start_ns: start.toString(), end_ns: end?.toString() ?? null, stream_ids: streamIds,
          note: text(input.note, 2000, '标注备注'), source: live ? 'live' : 'review', created_at: prior?.created_at ?? now, updated_at: now };
        if (prior) document.annotations[index] = item; else document.annotations.push(item);
        audit(document, input.op, prior ?? undefined, item);
      }
      await save(this.dataDir, manifest, document); return document;
    });
  }
  context(id, input) {
    return this.run(id, async () => {
      const manifest = await this.capture.getSession(id);
      if (!manifest.finalized) throw error('停止录制后才能修改实验信息或标签字典。', 409);
      const document = await readAnnotationDocument(this.dataDir, manifest);
      revision(document, input);
      const before = { experiment: clone(document.experiment), labels: clone(document.labels) };
      if (input.experiment !== undefined) document.experiment = validateExperiment(input.experiment);
      if (input.labels !== undefined) document.labels = validateLabels(input.labels);
      if (document.annotations.some(item => !document.labels.some(label => label.id === item.label_id))) throw error('已有标注使用的标签不能从字典中删除。');
      audit(document, 'context', before, { experiment: document.experiment, labels: document.labels });
      await save(this.dataDir, manifest, document); return document;
    });
  }
  finalize(manifest, reason = 'recording-stop') {
    if (!manifest?.id) return Promise.resolve(null);
    return this.run(manifest.id, async () => {
      const document = await readAnnotationDocument(this.dataDir, manifest);
      const opened = document.annotations.filter(item => item.kind === 'interval' && item.end_ns === null);
      if (!opened.length) return document;
      let end = durationNs(manifest);
      if (reason === 'recovery') for (const item of document.annotations) {
        const known = ns(item.end_ns ?? item.start_ns); if (known > end) end = known;
      }
      for (const prior of opened) {
        const item = { ...prior, end_ns: (end < ns(prior.start_ns) ? ns(prior.start_ns) : end).toString(),
          updated_at: new Date().toISOString(), closed_reason: reason };
        document.annotations[document.annotations.indexOf(prior)] = item;
        audit(document, 'auto-end', prior, item, reason);
      }
      await save(this.dataDir, manifest, document); return document;
    });
  }
  async recover(manifests) {
    for (const manifest of manifests) if (manifest.finalized) {
      // Corrupt sidecars are surfaced on access, never overwritten or allowed to prevent service startup.
      await this.finalize(manifest, 'recovery').catch(() => {});
    }
  }
  async close() { await Promise.allSettled([...this.queues.values()]); this.closed = true; }
}
