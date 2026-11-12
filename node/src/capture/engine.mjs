import { fork } from 'node:child_process';
import path from 'node:path';
import { descriptors } from './adapters.mjs';

const idle = () => ({ state: 'idle', engine_alive: false, session_id: null, elapsed_s: 0, bytes_written: 0, queue_depth: 0, queue_capacity: 4096, queue_bytes: 0, queue_limit_bytes: 64 * 1024 * 1024, dropped_records: 0, record_counts: {}, selected_ids: [], error: null, source: 'simulation' });

/** Stable façade: the HTTP service can later delegate these methods to a native process. */
export class CaptureEngine {
  constructor({ dataDir, sdkPath, pluginRoot, queueLimitBytes = 64 * 1024 * 1024, queueCapacity = 4096 }) {
    this.dataDir = path.resolve(dataDir);
    this.options = { dataDir: this.dataDir, sdkPath, pluginRoot: path.resolve(pluginRoot ?? path.join(path.dirname(this.dataDir), 'plugins')), queueLimitBytes, queueCapacity };
    this.cachedDevices = structuredClone(descriptors);
    this.cachedSdk = null;
    this.cachedStatus = idle();
    this.cachedPreview = { timestamp_s: 0 };
    this.pending = new Map();
    this.counter = 0;
    this.closed = false;
    this.cameraPreviewListeners = new Map();
    this.cameraPreviewSyncPending = false;
    this.cameraPreviewRevision = 0;
  }
  async init() {
    if (this.ready) return this.ready;
    // Native SDK bindings run on the main thread of their own process. A native abort
    // must never take down the HTTP process that serves the React application.
    this.child = fork(new URL('./worker.mjs', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'advanced', windowsHide: true, execArgv: [],
    });
    this.worker = this.child; // Compatibility for existing lifecycle callers/tests.
    this.worker.terminate = () => this.terminateChild();
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
    this.ready = new Promise((resolve, reject) => {
      const fail = error => {
        if (this.failure) return;
        error.statusCode ??= 503;
        this.failure = error;
        this.cameraPreviewListeners.clear();
        clearTimeout(startupTimeout);
        reject(error);
        for (const task of this.pending.values()) task.reject(error);
        this.pending.clear();
        if (!this.closed) {
          this.cachedStatus = { ...this.cachedStatus, state: 'error', engine_alive: false, error: error.message };
          this.cachedDevices = this.cachedDevices.map(device => ({ ...device, connected: false }));
          this.cachedPreview = { timestamp_s: this.cachedPreview.timestamp_s, streams: {} };
          this.cachedSdk = { ...this.cachedSdk, connected: false, connecting: false, has_device: false, error: error.message,
            instances: (this.cachedSdk?.instances ?? []).map(instance => ({ ...instance, connected: false, connecting: false, has_device: false, error: error.message })) };
        }
      };
      const startupTimeout = setTimeout(() => { fail(new Error('Capture process startup timed out')); void this.terminateChild(); }, 15000);
      this.fail = fail;
      this.child.on('error', error => {
        fail(error);
        if (!this.child.pid) this.resolveExited(null);
      });
      this.child.on('exit', (code, signal) => {
        if (!this.closed) fail(new Error(`Capture process exited (${signal ?? code}); HTTP service remains available`));
        this.resolveExited(code);
      });
      this.child.on('disconnect', () => {
        if (!this.closed) fail(new Error('Capture process exited or disconnected; HTTP service remains available'));
      });
      this.child.on('message', message => {
        if (this.failure) return;
        if (message.snapshot) {
          this.cachedStatus = message.snapshot.status;
          this.cachedPreview = message.snapshot.preview;
          this.cachedDevices = message.snapshot.devices;
          this.cachedSdk = message.snapshot.sdk;
          const disconnected = this.cachedDevices.filter(device => !device.connected).map(device => device.id);
          let changed = false;
          for (const streamId of disconnected) changed = this.cameraPreviewListeners.delete(streamId) || changed;
          if (changed) this.syncCameraPreviewSubscriptions();
        }
        if (message.camera_preview) {
          const frame = message.camera_preview;
          try {
            if (typeof frame.stream_id === 'string' && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 &&
                Number.isSafeInteger(frame.width) && frame.width > 0 && Number.isSafeInteger(frame.height) && frame.height > 0 &&
                Number.isFinite(frame.timestamp_s) && frame.payload instanceof Uint8Array && frame.payload.byteLength > 0 && frame.payload.byteLength <= 2 * 1024 * 1024) {
              const listeners = this.cameraPreviewListeners.get(frame.stream_id);
              for (const subscription of [...(listeners ?? [])]) {
                if (!listeners.has(subscription)) continue;
                try { subscription.listener(frame); } catch { /* Preview failures do not affect recording. */ }
              }
            }
          } finally {
            if (this.child.connected && typeof frame.stream_id === 'string') this.child.send({ camera_preview_ack: frame.stream_id }, error => { if (error) fail(error); });
          }
        }
        if (message.ready) { clearTimeout(startupTimeout); resolve(this); }
        if (message.id) {
          const task = this.pending.get(message.id);
          if (!task) return;
          this.pending.delete(message.id);
          if (message.error) task.reject(Object.assign(new Error(message.error.message), { statusCode: message.error.statusCode ?? 500 }));
          else task.resolve(message.result);
        }
      });
      this.child.send({ initialize: this.options }, error => { if (error) fail(error); });
    });
    return this.ready;
  }
  devices() { return structuredClone(this.cachedDevices); }
  status() { return structuredClone(this.cachedStatus); }
  preview() { return { ...structuredClone(this.cachedPreview), status: this.status() }; }
  subscribeCameraPreview(streamId, listener, fps = 30) {
    if (this.closed || this.closing) throw new Error('Capture engine is closed');
    if (this.failure) throw this.failure;
    if (typeof streamId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,139}$/.test(streamId) || typeof listener !== 'function' || !Number.isFinite(fps) || fps <= 0) throw new TypeError('Invalid camera preview subscription');
    const subscription = { listener, fps: Math.max(1, Math.min(30, fps)) };
    let listeners = this.cameraPreviewListeners.get(streamId);
    if (!listeners) { listeners = new Set(); this.cameraPreviewListeners.set(streamId, listeners); }
    listeners.add(subscription);
    this.syncCameraPreviewSubscriptions();
    return () => {
      if (!listeners.delete(subscription)) return;
      if (!listeners.size && this.cameraPreviewListeners.get(streamId) === listeners) this.cameraPreviewListeners.delete(streamId);
      this.syncCameraPreviewSubscriptions();
    };
  }
  syncCameraPreviewSubscriptions() {
    this.cameraPreviewRevision++;
    if (this.cameraPreviewSyncPending || this.closed || this.closing || this.failure) return;
    this.cameraPreviewSyncPending = true;
    let sentRevision = -1;
    void this.init().then(() => {
      if (this.closed || this.closing || this.failure || !this.child.connected) return;
      const subscriptions = [...this.cameraPreviewListeners].map(([stream_id, listeners]) => ({ stream_id, fps: Math.max(...[...listeners].map(subscription => subscription.fps)) }));
      sentRevision = this.cameraPreviewRevision;
      this.child.send({ camera_preview_subscriptions: subscriptions }, error => { if (error) this.fail(error); });
    }).catch(() => {}).finally(() => {
      this.cameraPreviewSyncPending = false;
      if (sentRevision !== this.cameraPreviewRevision && !this.closed && !this.closing && !this.failure) this.syncCameraPreviewSubscriptions();
    });
  }
  async request(action, payload) {
    await this.init();
    if (this.closed) throw new Error('Capture engine is closed');
    if (this.failure) throw this.failure;
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.child.connected) {
        this.fail(new Error('Capture process exited or disconnected; HTTP service remains available'));
        return;
      }
      this.child.send({ id, action, payload }, error => { if (error) this.fail(error); });
    });
  }
  start(payload) { return this.request('start', payload); }
  stop(media) { return this.request('stop', media); }
  mediaUpdate(media) { return this.request('mediaUpdate', media); }
  annotationClock(id) { return this.request('annotationClock', id); }
  listSessions() { return this.request('list'); }
  getSession(id) { return this.request('get', id); }
  async sdkInfo() {
    await this.init();
    if (this.closed) throw new Error('Capture engine is closed');
    return structuredClone(this.cachedSdk);
  }
  sdkPorts() { return this.request('sdkPorts'); }
  sdkConnect(options) { return this.request('sdkConnect', options); }
  sdkDisconnect(options) { return this.request('sdkDisconnect', options); }
  pluginCatalog() { return this.request('pluginCatalog'); }
  pluginConnect(options) { return this.request('pluginConnect', options); }
  pluginDisconnect(options) { return this.request('pluginDisconnect', options); }
  pluginReload() { return this.request('pluginReload'); }
  async close() {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.cameraPreviewListeners.clear();
    if (!this.child) { this.closed = true; return; }
    if (this.child.connected && !this.failure) this.child.send({ camera_preview_subscriptions: [] }, () => {});
    this.closing = (async () => {
      let timeout;
      try {
        if (!this.failure) await Promise.race([
          this.request('close'),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Capture process shutdown timed out; unfinished recording will be recovered on restart')), 15000); }),
        ]);
      } finally {
        clearTimeout(timeout);
        this.closed = true;
        await this.terminateChild();
        for (const task of this.pending.values()) task.reject(new Error('Capture engine is closed'));
        this.pending.clear();
      }
    })();
    return this.closing;
  }
  async terminateChild() {
    if (!this.child) return;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    return this.exited;
  }
}
