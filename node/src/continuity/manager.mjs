import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { SAFE_ID, SessionError } from '../exports/reader.mjs';
import { inspectContinuitySource, validateThreshold } from './reader.mjs';

const now = () => new Date().toISOString();
const validId = value => { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new SessionError('录制 ID 无效。', 400); };

export class ContinuityManager {
  constructor({ dataDir, capacity = 8 }) { this.dataDir = path.resolve(dataDir); this.capacity = Number.isInteger(capacity) ? Math.max(1, Math.min(32, capacity)) : 8; this.jobs = new Map(); this.active = null; this.preparing = null; this.preparingSession = null; this.generation = 0; this.closing = false; }
  get activeSessionId() { return this.active?.job.session_id ?? null; }
  get(sessionId) { validId(sessionId); const job = this.jobs.get(sessionId); return job ? structuredClone(job) : null; }

  async start(sessionId, { threshold_ms = 100 } = {}) {
    validId(sessionId); const threshold = validateThreshold(threshold_ms);
    if (this.closing) throw new SessionError('时间连续性检查服务正在退出。', 503);
    if (this.active) {
      if (this.active.job.session_id === sessionId && this.active.job.threshold_ms === threshold) return this.get(sessionId);
      throw new SessionError('已有时间连续性检查在运行，请先取消或等待完成。', 409);
    }
    if (this.preparing) throw new SessionError('正在准备时间连续性检查，请稍候。', 409);
    const generation = this.generation;
    const preparation = inspectContinuitySource({ dataDir: this.dataDir, sessionId }); this.preparing = preparation; this.preparingSession = sessionId;
    let source; try { source = await preparation; } finally { if (this.preparing === preparation) { this.preparing = null; this.preparingSession = null; } }
    if (this.closing) throw new SessionError('时间连续性检查服务正在退出。', 503);
    if (generation !== this.generation) throw new SessionError('时间连续性检查已取消。', 409);
    const existing = this.jobs.get(sessionId);
    if (existing?.status === 'complete' && existing.threshold_ms === threshold && existing.source_fingerprint === source.fingerprint && !existing.report?.source_changed)
      return { ...this.get(sessionId), cache_hit: true };
    if (existing) this.jobs.delete(sessionId);
    while (this.jobs.size >= this.capacity) this.jobs.delete(this.jobs.keys().next().value);
    const job = { id: randomUUID(), session_id: sessionId, status: 'running', threshold_ms: threshold, progress: 0,
      scanned_bytes: 0, total_bytes: source.total_bytes, current_stream_id: null, created_at: now(), completed_at: null,
      error: null, report: null, cache_hit: false, source_fingerprint: source.fingerprint };
    this.jobs.set(sessionId, job);
    let worker;
    try { worker = new Worker(new URL('./worker.mjs', import.meta.url), { execArgv: [], workerData: { dataDir: this.dataDir, sessionId, threshold_ms: threshold } }); }
    catch (error) { Object.assign(job, { status: 'error', error: error.message, completed_at: now() }); return this.get(sessionId); }
    const active = { worker, job, done: null }; this.active = active;
    active.done = new Promise(resolve => {
      let result;
      worker.on('message', message => {
        if (job.status !== 'running') return;
        if (message.progress) Object.assign(job, message.progress, { progress: Math.max(job.progress, Math.min(0.99, message.progress.progress)) });
        if (message.report) result = { report: message.report };
        if (message.error) result = { error: String(message.error) };
      });
      worker.once('error', error => { result = { error: error.message }; });
      worker.once('exit', code => {
        if (job.status === 'running') {
          if (code === 0 && result?.report) Object.assign(job, { status: 'complete', report: result.report, progress: 1, current_stream_id: null, completed_at: now(), source_fingerprint: result.report.source_fingerprint });
          else Object.assign(job, { status: 'error', error: result?.error ?? `检查进程提前退出 (${code})`, current_stream_id: null, completed_at: now() });
        }
        if (this.active === active) this.active = null; resolve();
      });
    });
    return this.get(sessionId);
  }

  async cancel(sessionId) {
    validId(sessionId);
    if (this.preparingSession === sessionId) { this.generation++; await this.preparing?.catch(() => {}); }
    const active = this.active;
    if (active?.job.session_id === sessionId) {
      Object.assign(active.job, { status: 'cancelled', error: null, current_stream_id: null, completed_at: now() });
      await active.worker.terminate(); await active.done;
    }
    return this.get(sessionId);
  }
  async cancelActive() {
    if (this.preparing) { this.generation++; await this.preparing.catch(() => {}); }
    const sessionId = this.activeSessionId; return sessionId ? this.cancel(sessionId) : null;
  }
  async close() { this.closing = true; await this.preparing?.catch(() => {}); await this.cancelActive(); }
}
