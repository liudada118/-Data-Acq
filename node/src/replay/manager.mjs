import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { SAFE_ID, SessionError } from '../exports/reader.mjs';

/** A bounded, read-only worker keeps indexing and decoding off the HTTP thread. */
export class ReplayManager {
  constructor({ dataDir, capacity = 8, timeoutMs = 120000 } = {}) {
    this.dataDir = path.resolve(dataDir); this.capacity = capacity; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.counter = 0; this.closed = false;
  }
  async init() {
    if (this.closed) throw new SessionError('回放服务已关闭。', 503);
    if (this.ready) return this.ready;
    this.worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { dataDir: this.dataDir }, execArgv: [] });
    this.ready = new Promise((resolve, reject) => {
      // `online` precedes ESM imports; wait for our module's ready message so an
      // import failure cannot be reported to the HTTP service as successful init.
      const timeout = setTimeout(() => {
        reject(new SessionError('回放进程启动超时。', 503)); void this.worker.terminate();
      }, 15000);
      this.worker.once('message', message => {
        clearTimeout(timeout);
        if (message.ready) resolve(this); else reject(new SessionError('回放进程启动失败。', 503));
      });
      this.worker.once('error', error => { clearTimeout(timeout); reject(error); });
      this.worker.once('exit', () => { clearTimeout(timeout); reject(new SessionError('回放进程在启动时退出。', 503)); });
    });
    this.worker.on('message', message => {
      if (message.ready) return;
      const task = this.pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer); this.pending.delete(message.id);
      if (message.error) task.reject(new SessionError(message.error, message.statusCode ?? 400));
      else task.resolve(message.result);
    });
    const failed = error => {
      this.failure = error;
      for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
      this.pending.clear();
    };
    this.worker.on('error', error => failed(new SessionError(`回放进程异常：${error.message}`, 503)));
    this.worker.on('exit', code => { if (!this.closed) failed(new SessionError(`回放进程已退出 (${code})。`, 503)); });
    return this.ready;
  }
  async frame(sessionId, timeSeconds) {
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) throw new SessionError('无效录制 ID。');
    if (timeSeconds === null || timeSeconds === '' || !Number.isFinite(Number(timeSeconds)) || Number(timeSeconds) < 0)
      throw new SessionError('回放时间必须是非负秒数。');
    if (this.closed || this.failure) throw this.failure ?? new SessionError('回放服务已关闭。', 503);
    await this.init();
    if (this.closed || this.failure) throw this.failure ?? new SessionError('回放服务已关闭。', 503);
    if (this.pending.size >= this.capacity) throw new SessionError('回放请求较多，请等待当前加载完成。', 429);
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => {
        // A timed-out worker job still consumes capacity until its reply arrives.
        // Otherwise repeated retries could build an unbounded hidden worker queue.
        reject(new SessionError('回放索引耗时较长，请稍后重试。', 504));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, sessionId, timeSeconds: Number(timeSeconds) }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer); task.reject(new SessionError('回放服务正在关闭。', 503));
    }
    this.pending.clear();
    if (this.worker) await this.worker.terminate();
  }
}
