import { mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { exportFormats } from './formats.mjs';
import { loadSession, SAFE_ID, SessionError } from './reader.mjs';
import { checkExportSpace } from './space.mjs';
import { allocateExportArchiveName, createExportArchiveName } from './package-names.mjs';

const JOB_ID = /^[a-f0-9]{32}$/;
const timestamp = () => new Date().toISOString();
const clone = value => structuredClone(value);

async function savedRecordingName(dataDir, sessionId) {
  let handle;
  try {
    const directory = await realpath(path.join(dataDir, sessionId));
    if (path.dirname(directory) !== dataDir) return null;
    const filename = await realpath(path.join(directory, 'manifest.json'));
    if (path.dirname(filename) !== directory) return null;
    const info = await stat(filename), maximum = 4 * 1024 * 1024;
    if (!info.isFile() || info.size > maximum) return null;
    handle = await open(filename, 'r');
    const bytes = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > info.size) return null; // Changed during read; retain the old download name.
    const manifest = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!manifest || (manifest.session_id ?? manifest.id) !== sessionId) return null;
    return { recording_name: typeof manifest.name === 'string' ? manifest.name.slice(0, 2000) : null,
      recording_started_at: typeof manifest.started_at === 'string' ? manifest.started_at.slice(0, 100) : null };
  } catch { return null; }
  finally { await handle?.close(); }
}

export class ExportManager {
  constructor({ dataDir, outputDir, capacity = 8 }) {
    this.dataDir = path.resolve(dataDir); this.outputDir = path.resolve(outputDir);
    this.capacity = capacity; this.jobs = new Map(); this.queue = [];
    this.worker = null; this.closing = false; this.persisted = Promise.resolve(); this.closeWaiters = [];
    this.inspection = null;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true }); await mkdir(this.outputDir, { recursive: true });
    this.dataDir = await realpath(this.dataDir); this.outputDir = await realpath(this.outputDir);
    const history = path.join(this.outputDir, 'jobs.json');
    try {
      const resolved = await realpath(history);
      if (path.dirname(resolved) !== this.outputDir || (await stat(resolved)).size > 4 * 1024 * 1024)
        throw new Error('Invalid export history path or size');
      const saved = JSON.parse(await readFile(resolved, 'utf8'));
      if (saved.schema_version !== 1 || !Array.isArray(saved.jobs)) throw new Error('Invalid export history schema');
      const reservedNames = saved.jobs.slice(-100).filter(item => item?.filename_version === 1 && typeof item.filename === 'string').map(item => item.filename);
      for (const item of saved.jobs.slice(-100)) {
        if (!item || typeof item.id !== 'string' || !JOB_ID.test(item.id) || typeof item.session_id !== 'string' || !SAFE_ID.test(item.session_id) ||
            item.job_id !== item.id || !exportFormats().some(format => format.id === item.format) ||
            !['pending', 'running', 'complete', 'error'].includes(item.status)) continue;
        if (item.recovery !== undefined && typeof item.recovery !== 'boolean') continue;
        const recovery = item.recovery === true;
        let filename, naming = {};
        if (item.filename_version === undefined) {
          // Validate legacy history before migrating its display name from source metadata.
          filename = `${item.session_id}-${item.format}${recovery ? '-incomplete' : ''}-${item.id.slice(0, 8)}.zip`;
        } else if (item.filename_version === 1) {
          if ((item.recording_name !== null && (typeof item.recording_name !== 'string' || item.recording_name.length > 2000))
            || (item.recording_started_at !== null && (typeof item.recording_started_at !== 'string' || item.recording_started_at.length > 100))
            || !Number.isSafeInteger(item.filename_sequence) || item.filename_sequence < 1 || item.filename_sequence > 999999) continue;
          naming = { filename_version: 1, recording_name: item.recording_name, recording_started_at: item.recording_started_at, filename_sequence: item.filename_sequence };
          filename = createExportArchiveName({ name: naming.recording_name, started_at: naming.recording_started_at,
            format: item.format, recovery, sequence: naming.filename_sequence });
        } else continue;
        if (item.filename !== filename) continue;
        if (item.filename_version === undefined) {
          const sourceName = await savedRecordingName(this.dataDir, item.session_id);
          if (sourceName) {
            const allocated = allocateExportArchiveName({ name: sourceName.recording_name, started_at: sourceName.recording_started_at,
              format: item.format, recovery }, [...reservedNames, ...[...this.jobs.values()].map(job => job.filename)]);
            filename = allocated.filename;
            naming = { filename_version: 1, ...sourceName, filename_sequence: allocated.sequence };
          }
        }
        const job = { id: item.id, job_id: item.id, session_id: item.session_id, format: item.format, filename, recovery, ...naming,
          status: item.status, progress: Number.isFinite(item.progress) ? Math.max(0, Math.min(1, item.progress)) : 0,
          created_at: typeof item.created_at === 'string' ? item.created_at.slice(0, 100) : '',
          completed_at: typeof item.completed_at === 'string' ? item.completed_at.slice(0, 100) : null,
          error: typeof item.error === 'string' ? item.error.slice(0, 2000) : null, download_url: null };
        if (job.status === 'pending' || job.status === 'running') {
          Object.assign(job, { status: 'error', error: '导出被服务重启中断，请重新提交。', completed_at: timestamp() });
        } else if (job.status === 'complete') {
          const file = await realpath(path.join(this.outputDir, `${job.id}.zip`)).catch(() => null);
          const info = file && path.dirname(file) === this.outputDir ? await stat(file) : null;
          if (info?.isFile()) Object.assign(job, { bytes: info.size, progress: 1, download_url: `/api/export/download/${job.id}` });
          else Object.assign(job, { status: 'error', error: '导出文件不存在，请重新提交。', completed_at: timestamp() });
        }
        this.jobs.set(job.id, job);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Ignoring invalid export history:', error.message);
    }
    await this._persist();
    return this;
  }

  formats() { return exportFormats(); }
  listJobs() { return [...this.jobs.values()].reverse().map(clone); }
  getJob(id) {
    if (typeof id !== 'string' || !JOB_ID.test(id)) throw new SessionError('Invalid export job id');
    if (!this.jobs.has(id)) throw new SessionError('Export job not found', 404);
    return clone(this.jobs.get(id));
  }
  async download(id) {
    const job = this.getJob(id);
    if (job.status !== 'complete') throw new SessionError('Export is not complete', 409);
    const file = await realpath(path.join(this.outputDir, `${id}.zip`)).catch(() => null);
    if (!file || path.dirname(file) !== this.outputDir || !(await stat(file)).isFile())
      throw new SessionError('Export archive not found', 404);
    return { path: file, filename: job.filename };
  }

  async createJob({ session_id: sessionId, format, recovery = false } = {}) {
    if (this.closing) throw new SessionError('Export service is closing', 503);
    if (typeof recovery !== 'boolean') throw new SessionError('Recovery must be an explicit boolean');
    if (!this.formats().some(item => item.id === format && item.available))
      throw new SessionError('Export format is unavailable in the Node prototype');
    const { folder, manifest } = await loadSession(this.dataDir, sessionId, { allowIncomplete: recovery });
    if (recovery && manifest.status !== 'incomplete') throw new SessionError('异常导出仅用于已停止且标为 incomplete 的录制。', 409);
    await checkExportSpace({ folder, manifest, outputDir: this.outputDir, format, recovery });
    if (this.closing) throw new SessionError('Export service is closing', 503);
    if ([...this.jobs.values()].filter(job => ['pending', 'running'].includes(job.status)).length >= this.capacity)
      throw new SessionError('Export queue is full; wait for a current export to finish', 429);
    while (this.jobs.size >= 100) {
      const old = [...this.jobs.values()].find(job => ['complete', 'error'].includes(job.status));
      if (!old) break;
      this.jobs.delete(old.id);
    }
    const id = randomUUID().replaceAll('-', '');
    const recordingName = typeof manifest.name === 'string' ? manifest.name.slice(0, 2000) : null;
    const recordingStartedAt = typeof manifest.started_at === 'string' ? manifest.started_at.slice(0, 100) : null;
    const { filename, sequence } = allocateExportArchiveName({ name: recordingName, started_at: recordingStartedAt, format, recovery },
      [...this.jobs.values()].map(job => job.filename));
    const job = { id, job_id: id, session_id: sessionId, format, recovery, status: 'pending', progress: 0,
      filename, filename_version: 1, recording_name: recordingName, recording_started_at: recordingStartedAt, filename_sequence: sequence,
      error: null, download_url: null,
      created_at: timestamp(), completed_at: null };
    this.jobs.set(id, job);
    // Queue before awaiting persistence so close() also observes in-flight submissions.
    this.queue.push(id);
    try { await this._persist(); }
    catch (error) {
      this.queue = this.queue.filter(item => item !== id); this.jobs.delete(id); this._pump(); throw error;
    }
    this._pump();
    return this.getJob(id);
  }

  async inspectRecovery(sessionId) {
    if (this.closing) throw new SessionError('Export service is closing', 503);
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) throw new SessionError('Invalid session id');
    if (this.inspection) throw new SessionError('正在检查另一段异常录制，请等待检查完成。', 409);
    const worker = new Worker(new URL('./inspection-worker.mjs', import.meta.url), {
      execArgv: [], workerData: { dataDir: this.dataDir, sessionId },
    });
    const promise = new Promise((resolve, reject) => {
      let result;
      const timer = setTimeout(() => {
        result = { error: '文件与元信息检查超时，可能磁盘暂时无法访问，请保留原文件并稍后重试。', statusCode: 504 };
        void worker.terminate();
      }, 15000);
      worker.on('message', message => { result = message; });
      worker.once('error', error => { result = { error: error.message, statusCode: 500 }; });
      worker.once('exit', code => {
        clearTimeout(timer); this.inspection = null;
        if (result?.error) reject(new SessionError(result.error, result.statusCode));
        else if (code !== 0 || !result?.report) reject(new SessionError('异常录制检查进程未完成，请重试。', 500));
        else resolve(result.report);
      });
    });
    this.inspection = { worker, promise };
    return promise;
  }

  _persist() {
    const snapshot = JSON.stringify({ schema_version: 1, jobs: [...this.jobs.values()] }, null, 2) + '\n';
    this.persisted = this.persisted.catch(() => {}).then(async () => {
      const temporary = path.join(this.outputDir, '.jobs.tmp');
      await writeFile(temporary, snapshot);
      await rename(temporary, path.join(this.outputDir, 'jobs.json'));
    });
    return this.persisted;
  }
  _saveBackground() { this._persist().catch(error => console.error('Could not save export history:', error.message)); }

  _pump() {
    if (this.worker) return;
    const id = this.queue.shift();
    if (!id) { for (const resolve of this.closeWaiters.splice(0)) resolve(); return; }
    const job = this.jobs.get(id);
    job.status = 'running'; this._saveBackground();
    let result;
    try {
      this.worker = new Worker(new URL('./worker.mjs', import.meta.url), {
        execArgv: [],
        workerData: { dataDir: this.dataDir, sessionId: job.session_id, format: job.format, recovery: job.recovery, outputFile: path.join(this.outputDir, `${id}.zip`) },
      });
    } catch (error) {
      Object.assign(job, { status: 'error', error: error.message, completed_at: timestamp() }); this._saveBackground(); this._pump(); return;
    }
    this.worker.on('message', message => {
      if (Number.isFinite(message.progress)) job.progress = Math.max(0, Math.min(1, message.progress));
      if (message.complete) result = { complete: true };
      if (message.error) result = { error: String(message.error) };
    });
    this.worker.on('error', error => { result = { error: error.message }; });
    this.worker.on('exit', async code => {
      try {
        if (code !== 0 || !result?.complete) throw new Error(result?.error ?? `Export worker exited with code ${code}`);
        const info = await stat(path.join(this.outputDir, `${id}.zip`));
        Object.assign(job, { status: 'complete', progress: 1, bytes: info.size, download_url: `/api/export/download/${id}`, completed_at: timestamp() });
      } catch (error) { Object.assign(job, { status: 'error', error: error.message, completed_at: timestamp() }); }
      this.worker = null; this._saveBackground(); this._pump();
    });
  }

  async close() {
    this.closing = true;
    await this.inspection?.promise.catch(() => {});
    if (this.worker || this.queue.length) await new Promise(resolve => this.closeWaiters.push(resolve));
    await this.persisted;
  }
}
