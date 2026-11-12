import { fork, spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { inspectPackage, validateConfig, ID_PATTERN, INSTANCE_PATTERN, validFramePayload, isMjpegStream } from './contract.mjs';
import { PLUGIN_FORCE_STOP_TIMEOUT_MS } from './lifecycle.mjs';
import { inspectJpeg, MAX_JPEG_PREVIEW_BYTES } from './mjpeg.mjs';
import { createStreamQuality, observeStreamQuality, streamQualitySnapshot } from './stream-quality.mjs';

const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const MAX_STDERR_TAIL_BYTES = 8192;
function exitProblem(child, label, code, signal, statusCode = 400) {
  // Classify a few known runtime failures; never return raw vendor logs, which
  // can contain SDK configuration, file paths or credentials in camera URLs.
  const text = child.pluginExitDiagnostic?.() ?? '';
  let detail = '';
  if (/FATAL ERROR:[^\r\n]*(?:external.*(?:buffer|memory)|(?:buffer|memory).*sandbox)/i.test(text))
    detail = 'Electron 拒绝了原生模块的外部内存缓冲区';
  else if (/FATAL ERROR:[^\r\n]*(?:napi_|N-API)/i.test(text))
    detail = '原生模块发生 N-API 致命错误';
  else if (/FATAL ERROR:[^\r\n]*(?:heap out of memory|allocation failed|out of memory)/i.test(text))
    detail = 'SDK 进程内存分配失败';
  // Exit 134 alone is not evidence of a specific SDK, pointer or format fault.
  return problem(`${label} (${signal ?? code})${detail ? `：${detail}` : ''}`, statusCode);
}
function forceStop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && process.env.SystemRoot) {
    // Kill only this application's still-live owned child tree, including a
    // decoder if an uncooperative vendor module prevented normal cleanup.
    const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.once('error', () => child.kill('SIGKILL'));
    killer.once('exit', () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  } else child.kill('SIGKILL');
}
function launch() {
  // SDKs receive only runtime essentials, never the application's model/license secrets.
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'ELECTRON_RUN_AS_NODE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = fork(new URL('./host.mjs', import.meta.url), [], { env, serialization: 'advanced', execArgv: [], windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderrTail = Buffer.alloc(0);
  child.stderr.on('data', chunk => {
    const end = chunk.subarray(-MAX_STDERR_TAIL_BYTES);
    const keep = Math.min(stderrTail.length, MAX_STDERR_TAIL_BYTES - end.length);
    // Copy even a large chunk's tail so its full backing allocation is released.
    stderrTail = Buffer.concat([stderrTail.subarray(stderrTail.length - keep), end], keep + end.length);
  });
  child.pluginExitDiagnostic = () => stderrTail.toString('utf8');
  child.on('message', message => { if (message?.shutdown_error) child.pluginShutdownError = String(message.shutdown_error); });
  return child;
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { error: child.pluginShutdownError ?? null };
  await new Promise(resolve => {
    const deadline = setTimeout(() => { child.pluginShutdownError ??= 'SDK stop timed out; plugin host was terminated'; forceStop(child); }, PLUGIN_FORCE_STOP_TIMEOUT_MS);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    if (child.connected) child.send({ stop: true }, () => {}); else forceStop(child);
  });
  return { error: child.pluginShutdownError ?? null };
}

/** Explicit code-executing test. Never opens a live acquisition via start(). */
export async function probePackage(directory, { config = {}, timeoutMs = 15000 } = {}) {
  const details = await inspectPackage(directory);
  const validated = validateConfig(details.manifest, config);
  const child = launch();
  try {
    return await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { forceStop(child); reject(problem('SDK test timed out', 408)); }, timeoutMs);
      const settle = (error, result) => { clearTimeout(deadline); error ? reject(error) : resolve(result); };
      child.on('message', message => {
        if (message.error) settle(problem(message.error));
        else if (message.ready) settle(null, { ...message.probe, plugin_id: details.manifest.id, version: details.manifest.version });
      });
      child.once('error', error => settle(error));
      // close follows exit and drained stdio, including the final fatal message.
      child.once('close', (code, signal) => settle(exitProblem(child, 'SDK test process exited', code, signal)));
      child.send({ initialize: { directory: details.directory, config: validated, probe: true } }, error => { if (error) settle(error); });
    });
  } finally { const stopped = await stopChild(child); if (stopped.error) throw problem(stopped.error); }
}

export class PluginManager {
  constructor({ root, origin = process.hrtime.bigint(), onBatch = () => {}, onError = () => {}, onCameraPreview = () => {} }) {
    this.root = path.resolve(root); this.origin = origin; this.onBatch = onBatch; this.onError = onError; this.onCameraPreview = onCameraPreview;
    this.packages = new Map(); this.instances = new Map(); this.warnings = []; this.closed = false;
    this.cameraPreviewSubscriptions = new Map();
  }
  setCameraPreviewSubscriptions(subscriptions) {
    if (!Array.isArray(subscriptions)) throw problem('Invalid camera preview subscriptions');
    const next = new Map();
    for (const subscription of subscriptions) {
      if (!subscription || typeof subscription.stream_id !== 'string' || subscription.stream_id.length > 140 || !Number.isFinite(subscription.fps) || subscription.fps <= 0) throw problem('Invalid camera preview subscription');
      next.set(subscription.stream_id, Math.max(next.get(subscription.stream_id) ?? 0, Math.max(1, Math.min(30, subscription.fps))));
    }
    this.cameraPreviewSubscriptions = next;
    for (const instance of this.instances.values()) for (const id of instance.lastCameraPreview.keys()) if (!next.has(id)) instance.lastCameraPreview.delete(id);
  }
  async reload() {
    await mkdir(this.root, { recursive: true });
    const inUse = new Set([...this.instances.values()].filter(instance => instance.connected || instance.connecting).map(instance => instance.manifest.id));
    const previous = this.packages;
    this.packages = new Map([...previous.entries()].filter(([id]) => inUse.has(id))); this.warnings = [];
    for (const directory of await readdir(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !ID_PATTERN.test(directory.name)) continue;
      // Connected instances keep their exact loaded contract until explicitly disconnected.
      if (inUse.has(directory.name)) continue;
      try {
        const details = await inspectPackage(path.join(this.root, directory.name));
        if (details.manifest.id !== directory.name) throw problem('Plugin directory and manifest id differ');
        this.packages.set(directory.name, details);
      } catch (error) { this.warnings.push({ id: directory.name, error: error.message }); }
    }
    return this.catalog();
  }
  catalog() { return { plugins: [...this.packages.values()].map(item => structuredClone(item.manifest)), instances: [...this.instances.values()].map(instance => this.public(instance)), warnings: [...this.warnings] }; }
  public(instance) { return { instance_id: instance.id, plugin_id: instance.manifest.id, name: instance.manifest.name, version: instance.manifest.version,
    connected: instance.connected, connecting: instance.connecting, error: instance.error, stream_ids: instance.descriptors.map(d => d.id), received_records: instance.received, data_received: instance.received > 0, hardware_verified: false,
    runtime_metrics: instance.runtimeMetrics ? { ...instance.runtimeMetrics } : null,
    stream_diagnostics: instance.descriptors.map(d => ({ stream_id: d.id, source_stream_id: d.metadata.plugin_stream_id, ...streamQualitySnapshot(instance.quality.get(d.metadata.plugin_stream_id)) })) }; }
  descriptors() { return [...this.instances.values()].flatMap(instance => instance.descriptors.map(d => ({ ...structuredClone(d),
    metadata: { ...structuredClone(d.metadata), quality: streamQualitySnapshot(instance.quality.get(d.metadata.plugin_stream_id)) },
    connected: instance.connected, status: instance.error ? 'error' : instance.connected ? 'ready' : 'disconnected' }))); }
  get previews() { return Object.assign({}, ...[...this.instances.values()].filter(item => item.connected).map(item => item.previews)); }
  async connect({ plugin_id, instance_id, config = {} } = {}) {
    if (this.closed) throw problem('Plugin manager is closed', 503);
    if (!ID_PATTERN.test(plugin_id ?? '') || !INSTANCE_PATTERN.test(instance_id ?? '')) throw problem('Invalid plugin or instance identity');
    if (this.instances.get(instance_id)?.connected || this.instances.get(instance_id)?.connecting) throw problem('SDK sensor is already connected', 409);
    if ([...this.instances.values()].filter(item => item.connected || item.connecting).length >= 16) throw problem('At most 16 SDK plugin instances can connect');
    // Recheck disk after installation so one newly installed device need not interrupt others.
    const details = await inspectPackage(path.join(this.root, plugin_id));
    if (details.manifest.id !== plugin_id) throw problem('Plugin identity mismatch');
    this.packages.set(plugin_id, details);
    const validated = validateConfig(details.manifest, config);
    const instance = { id: instance_id, manifest: details.manifest, connected: false, connecting: true, closing: false, error: null,
      previews: {}, received: 0, counters: new Map(), lastPreview: new Map(), lastCameraPreview: new Map(), quality: new Map(details.manifest.streams.map(stream => [stream.id, createStreamQuality()])), descriptors: details.manifest.streams.map(stream => ({ ...stream,
        id: `plugin-${instance_id}-${stream.id}`, device_id: `plugin-${instance_id}-${stream.id}`, name: stream.name, modality: stream.kind,
        transport: 'SDK plugin', mode: 'sdk-plugin', adapter: 'sdk-plugin', simulated: false, connected: false,
        clock_id: 'plugin-host-receive-monotonic', metadata: { ...stream.metadata, plugin_id, plugin_version: details.manifest.version,
          instance_id, plugin_stream_id: stream.id, timestamp_source: 'host-receive', source_timestamps_file: 'plugin-frames.jsonl' } })) };
    this.instances.set(instance_id, instance);
    const child = instance.child = launch();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (instance.closing || instance.error) return;
        instance.connected = false; instance.connecting = false; instance.error = error.message; instance.previews = {};
        clearTimeout(deadline); this.onError(error, this.public(instance));
        if (!settled) { settled = true; reject(error); }
        void stopChild(child);
      };
      const deadline = setTimeout(() => fail(problem('SDK connection timed out', 408)), 15000);
      child.on('message', message => {
        if (message.runtime_metrics) {
          const fields = ['rss_bytes', 'heap_used_bytes', 'external_bytes', 'pending_frames', 'pending_bytes'];
          if (fields.every(key => Number.isSafeInteger(message.runtime_metrics[key]) && message.runtime_metrics[key] >= 0)) {
            instance.runtimeMetrics = { ...Object.fromEntries(fields.map(key => [key, message.runtime_metrics[key]])), sampled_at: new Date().toISOString() };
          }
        }
        if (message.error) { fail(problem(message.error)); return; }
        if (message.frame) {
          try { if (!instance.error && !instance.closing) this.accept(instance, message.frame); }
          catch (error) { fail(error); }
          finally { if (child.connected) child.send({ ack: message.frame.id }, () => {}); }
        }
        if (message.ready && !instance.error && !instance.closing) {
          clearTimeout(deadline); instance.connecting = false; instance.connected = true;
          if (!settled) { settled = true; resolve(this.public(instance)); }
        }
      });
      child.once('error', fail);
      child.once('close', (code, signal) => { if (!instance.closing) fail(exitProblem(child, 'SDK process exited', code, signal, 503)); });
      child.send({ initialize: { directory: details.directory, config: validated } }, error => { if (error) fail(error); });
    });
  }
  accept(instance, frame) {
    const source = instance.manifest.streams.find(stream => stream.id === frame.stream_id);
    if (!source || !validFramePayload(source, frame.payload, frame.sample_count)) throw problem('Invalid SDK host frame');
    if (!Buffer.isBuffer(frame.payload)) frame.payload = Buffer.from(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
    const exactSourceInteger = value => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'number' && !Number.isSafeInteger(value) || !['number', 'bigint', 'string'].includes(typeof value)) throw problem('Invalid SDK source timestamp or sequence');
      const string = String(value);
      if (string.length > 24 || !/^-?\d+$/.test(string)) throw problem('Invalid SDK source timestamp or sequence');
      return BigInt(string).toString();
    };
    const sourceSequence = exactSourceInteger(frame.source_sequence), sourceTime = exactSourceInteger(frame.device_time_ns);
    const descriptor = instance.descriptors.find(item => item.metadata.plugin_stream_id === frame.stream_id);
    const now = process.hrtime.bigint(), sequence = instance.counters.get(source.id) ?? 0n;
    const jpegStatus = isMjpegStream(source) ? inspectJpeg(frame.payload, source) : undefined;
    const quality = instance.quality.get(source.id);
    const sourceEvent = observeStreamQuality(quality, sourceSequence, jpegStatus);
    instance.counters.set(source.id, sequence + 1n); instance.received++;
    this.onBatch({ streamId: descriptor.id, sequence, deviceTimeNs: now - this.origin, hostTimeNs: now,
      sampleCount: frame.sample_count, payload: frame.payload,
      metadata: { stream_id: descriptor.id, sequence: sequence.toString(), host_time_ns: now.toString(),
        source_device_time_ns: sourceTime, source_sequence: sourceSequence, ...sourceEvent,
        ...(jpegStatus ? { jpeg_status: jpegStatus } : {}),
        timestamp_source: 'host-receive', hardware_synchronized: false } });
    const fps = this.cameraPreviewSubscriptions.get(descriptor.id);
    const previewInterval = fps ? BigInt(Math.round(1e9 / fps)) : 0n;
    const previewDeadline = instance.lastCameraPreview.get(descriptor.id);
    const previewTolerance = previewInterval / 10n < 2000000n ? previewInterval / 10n : 2000000n;
    if (fps && jpegStatus?.preview_allowed && Number.isSafeInteger(Number(sequence)) && sequence >= 0n && frame.payload.byteLength <= MAX_JPEG_PREVIEW_BYTES &&
        (previewDeadline === undefined || now + previewTolerance >= previewDeadline)) {
      // Advance the scheduled deadline rather than restarting an interval at
      // every arrival: 33ms source jitter must not halve a 30fps preview.
      instance.lastCameraPreview.set(descriptor.id, previewDeadline === undefined || now - previewDeadline > previewInterval
        ? now + previewInterval : previewDeadline + previewInterval);
      // The accepted IPC payload is already owned by this process. Keep the
      // original recording bytes and transfer only demanded preview frames.
      try { this.onCameraPreview({ stream_id: descriptor.id, sequence: Number(sequence), width: source.width, height: source.height,
        timestamp_s: Number(now - this.origin) / 1e9, payload: frame.payload }); }
      catch { /* A preview consumer must never interrupt acquisition or recording. */ }
    }
    // Preview is throttled and bounded independently from full-fidelity recording.
    if (Number(now - (instance.lastPreview.get(source.id) ?? 0n)) < 200e6) return;
    instance.lastPreview.set(source.id, now);
    instance.previews[descriptor.id] = { [source.kind]: { ...preview(source, frame.payload, sequence, jpegStatus), quality: streamQualitySnapshot(quality) } };
  }
  async disconnect({ instance_id } = {}) {
    if (!INSTANCE_PATTERN.test(instance_id ?? '')) throw problem('Invalid instance identity');
    const instance = this.instances.get(instance_id);
    if (!instance) return { instance_id, connected: false };
    instance.closing = true;
    const stopped = await stopChild(instance.child);
    instance.connected = false; instance.connecting = false; instance.previews = {};
    for (const descriptor of instance.descriptors) this.cameraPreviewSubscriptions.delete(descriptor.id);
    instance.lastCameraPreview.clear();
    if (stopped.error) { instance.error ??= stopped.error; throw problem(stopped.error); }
    return this.public(instance);
  }
  async close() {
    this.closed = true;
    this.cameraPreviewSubscriptions.clear();
    const results = await Promise.allSettled([...this.instances.keys()].map(instance_id => this.disconnect({ instance_id })));
    const failure = results.find(item => item.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

function preview(stream, payload, sequence, jpegStatus) {
  if (stream.kind === 'camera') {
    if (isMjpegStream(stream)) return { width: stream.width, height: stream.height, sequence: Number(sequence), binary_preview: true,
      preview_status: !jpegStatus.preview_allowed ? jpegStatus.status === 'invalid' ? 'invalid-jpeg' : 'unsupported-jpeg'
        : payload.byteLength > MAX_JPEG_PREVIEW_BYTES ? 'jpeg-too-large' : undefined };
    const scale = Math.min(1, 160 / stream.width, 120 / stream.height), width = Math.max(1, Math.round(stream.width * scale)), height = Math.max(1, Math.round(stream.height * scale));
    const rgb = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const from = (Math.min(stream.height - 1, Math.floor(y / scale)) * stream.width + Math.min(stream.width - 1, Math.floor(x / scale))) * 3;
      payload.copy(rgb, (y * width + x) * 3, from, from + 3);
    }
    return { width, height, rgb_base64: rgb.toString('base64'), sequence: Number(sequence) };
  }
  const size = { uint8: 1, uint16: 2, float32: 4 }[stream.dtype];
  const count = Math.min(payload.length / size, stream.kind === 'pressure' ? 65536 : 256);
  const get = i => stream.dtype === 'uint8' ? payload[i] : stream.dtype === 'uint16' ? payload.readUInt16LE(i * 2) : payload.readFloatLE(i * 4);
  const values = Array.from({ length: count }, (_, i) => { const value = get(i); return Number.isFinite(value) ? value : 0; });
  if (stream.kind === 'pressure') return { rows: stream.shape[0], cols: stream.shape[1], values };
  if (stream.kind === 'audio') return { waveform: values, rms: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length)) };
  return { values };
}
