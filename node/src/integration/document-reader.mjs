import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

// Parse vendor documents away from the Agent loop. These are resource limits,
// not an OS security sandbox. Only extracted text crosses back to the model.
export const DOCUMENT_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  zipEntries: 2048,
  zipEntryBytes: 8 * 1024 * 1024,
  zipExpandedBytes: 32 * 1024 * 1024,
  pdfPages: 200,
  textCharacters: 1024 * 1024,
  timeoutMs: 15_000,
  pageCharacters: 24_000,
  maxPageCharacters: 48_000,
});
export const DOCUMENT_EXTENSIONS = new Set(['.docx', '.pdf']);
const cache = new Map();
let activeParsers = 0;

export function extractSdkDocument(data, format, { timeoutMs = DOCUMENT_LIMITS.timeoutMs, signal } = {}) {
  if (!DOCUMENT_EXTENSIONS.has(format)) return Promise.reject(new Error('暂不支持此文档格式。'));
  if (data.byteLength > DOCUMENT_LIMITS.fileBytes) return Promise.reject(new Error('SDK 文档单文件最多 16 MiB。'));
  if (signal?.aborted) return Promise.reject(new Error('文档读取已取消。'));
  const key = format + createHash('sha256').update(data).digest('hex');
  if (cache.has(key)) {
    const value = cache.get(key); cache.delete(key); cache.set(key, value);
    return Promise.resolve(structuredClone(value));
  }
  if (activeParsers >= 2) return Promise.reject(new Error('已有两份文档正在解析，请稍后重试。'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-reader-worker.mjs', import.meta.url), {
      workerData: { data: new Uint8Array(data), format, limits: DOCUMENT_LIMITS },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      // Keep parser warnings and document-derived data out of application logs.
      stdout: true, stderr: true,
    });
    activeParsers++;
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).finally(() => {
        activeParsers--;
        if (error) reject(error);
        else {
          // Small in-memory LRU only. No extracted document is persisted or
          // shared across machines; each read still validates the source hash.
          cache.set(key, result);
          while (cache.size > 4) cache.delete(cache.keys().next().value);
          resolve(structuredClone(result));
        }
      });
    };
    const abort = () => finish(new Error('文档读取已取消。'));
    const timer = setTimeout(() => finish(new Error('文档解析超过 15 秒，已停止；请拆分文档后重新导入。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', result => {
      if (result?.error) finish(new Error(String(result.error).slice(0, 400)));
      else if (typeof result?.content !== 'string' || result.content.length > DOCUMENT_LIMITS.textCharacters) finish(new Error('文档解析结果无效。'));
      else finish(null, result);
    });
    worker.once('error', () => finish(new Error('文档解析失败或超出内存限制；原始文件未被修改。')));
    worker.once('exit', () => finish(new Error('文档解析进程意外退出；原始文件未被修改。')));
  });
}

export function paginateSdkText(content, { offset = 0, limit = DOCUMENT_LIMITS.pageCharacters } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > DOCUMENT_LIMITS.maxPageCharacters) {
    throw new Error('文档读取范围无效：offset 必须为非负整数，limit 为 1–48000 字符。');
  }
  if (offset > content.length) throw new Error('读取位置超出文档范围。');
  const end = Math.min(content.length, offset + limit);
  return { content: content.slice(offset, end), offset, next_offset: end < content.length ? end : null,
    total_characters: content.length, offset_unit: 'UTF-16 code units' };
}
