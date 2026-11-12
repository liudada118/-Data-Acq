import { configuration, send, sendCameraPreview, setCameraPreviewStreams, onCameraPreviewSubscriptions, onCommand, onParentDisconnect } from './transport.mjs';
import { mkdir, open, readFile, writeFile, rename, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAdapters } from './adapters.mjs';
import { SdkManager } from './sdk-manager.mjs';
import { PluginManager } from '../plugins/manager.mjs';
import { createStreamQuality, observeStreamQuality, streamQualitySnapshot } from '../plugins/stream-quality.mjs';
import { validateExperiment, validateLabels } from '../annotations.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const origin = process.hrtime.bigint();
const root = path.resolve(configuration.dataDir);
const queueLimit = configuration.queueLimitBytes;
const queueCapacity = configuration.queueCapacity;
let active = null, last = null, stopping = false, closing = false;
let queue = [], queueBytes = 0, writing = false, drainPromise = Promise.resolve();
const adapters = createAdapters(origin);
const sdk = new SdkManager({ sdkPath: configuration.sdkPath, origin, onBatch: accept, onError: (error, instance) => {
  if (active && instance.stream_ids.some(id => active.selected.has(id))) active.error ??= `SDK (${instance.instance_id}): ${error.message}`;
} });
const plugins = new PluginManager({ root: configuration.pluginRoot ?? path.join(path.dirname(root), 'plugins'), origin, onBatch: accept, onCameraPreview: sendCameraPreview,
  onError: (error, instance) => { if (active && instance.stream_ids.some(id => active.selected.has(id))) active.error ??= `SDK plugin (${instance.instance_id}): ${error.message}`; } });
const devices = () => [...adapters.map(a => structuredClone(a.descriptor)), ...sdk.descriptors(), ...plugins.descriptors()];

function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
async function atomicJson(filename, value) {
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, filename);
}
async function sessionFolder(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw problem('Invalid session id');
  const directory = path.join(root, id);
  try {
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw problem('Invalid session path');
  } catch (error) { if (error.code === 'ENOENT') throw problem('Session not found', 404); throw error; }
  return directory;
}
async function readManifest(id) {
  const directory = await sessionFolder(id);
  const filename = path.join(directory, 'manifest.json');
  const info = await lstat(filename).catch(() => { throw problem('Session not found', 404); });
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw problem('Invalid session manifest');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  if (manifest.id !== id || typeof manifest.started_at !== 'string') throw problem('Invalid session identity');
  return manifest;
}
async function listSessions() {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    try { result.push(await readManifest(entry.name)); } catch { /* Ignore unrelated or corrupt directories. */ }
  }
  return result.sort((a, b) => b.started_at.localeCompare(a.started_at));
}
function updateManifest(recording, finalized = false) {
  const manifest = structuredClone(recording.manifest);
  const elapsed = process.hrtime.bigint() - recording.started;
  manifest.duration_ns = elapsed.toString();
  manifest.duration_s = manifest.duration_seconds = Number(elapsed) / 1e9;
  manifest.record_count = 0;
  manifest.bytes_written = 0;
  manifest.record_counts = {};
  manifest.media_chunk_counts = {};
  manifest.dropped_records = manifest.dropped_batches = recording.dropped;
  manifest.error = recording.error;
  manifest.finalized = finalized;
  for (const stream of manifest.streams) {
    const stats = recording.stats.get(stream.id);
    Object.assign(stream, stats);
    if (recording.quality.has(stream.id)) {
      stream.quality = { ...streamQualitySnapshot(recording.quality.get(stream.id)), scope: 'recorded-frames', jpeg_decode_verified: false };
      stream.metadata = { ...stream.metadata, quality: stream.quality };
    }
    manifest.record_counts[stream.id] = stats.records;
    manifest.record_count += stats.records;
    manifest.bytes_written += stats.payload_bytes + stats.records * 32 + 8;
  }
  manifest.raw_record_count = manifest.record_count;
  for (const stream of manifest.media_streams ?? []) {
    manifest.media_chunk_counts[stream.id] = stream.chunks;
    manifest.record_counts[stream.id] = stream.chunks;
    manifest.record_count += stream.chunks;
    manifest.bytes_written += stream.bytes;
  }
  manifest.assets = [...(manifest.assets ?? []).filter(asset => !['browser-camera-video', 'browser-microphone-audio'].includes(asset.role)),
    ...(manifest.media_streams ?? []).flatMap(stream => (stream.kind === 'audio' && Array.isArray(stream.segments) ? stream.segments : [stream])
      .map(segment => ({ file: segment.file, role: stream.kind === 'audio' ? 'browser-microphone-audio' : 'browser-camera-video',
        stream_id: stream.id, mime_type: stream.mime_type, bytes: segment.bytes,
        ...(segment.index !== undefined ? { segment_index: segment.index } : {}) })))];
  return manifest;
}
function status() {
  const manifest = active ? updateManifest(active) : null;
  return {
    engine_alive: true,
    state: stopping ? 'stopping' : active ? active.error ? 'error' : 'recording' : 'idle',
    session_id: manifest?.id ?? null, elapsed_s: manifest?.duration_s ?? 0,
    bytes_written: manifest?.bytes_written ?? 0, queue_depth: queue.length + (writing ? 1 : 0),
    queue_capacity: queueCapacity, queue_bytes: queueBytes, queue_limit_bytes: queueLimit,
    dropped_records: active?.dropped ?? 0, record_counts: manifest?.record_counts ?? {},
    media_chunk_counts: manifest?.media_chunk_counts ?? {},
    selected_ids: manifest?.device_ids ?? [], error: active?.error ?? null, source: manifest?.source ?? (sdk.connected ? 'shroom-sdk' : 'simulation'),
    scheduler_overruns: adapters.reduce((n, a) => n + (a.overruns ?? 0), 0),
  };
}
function snapshot() {
  const preview = { timestamp_s: Number(process.hrtime.bigint() - origin) / 1e9, streams: {} };
  for (const adapter of adapters) {
    preview[adapter.descriptor.kind] = adapter.preview();
    preview.streams[adapter.descriptor.id] = { [adapter.descriptor.kind]: adapter.preview() };
  }
  Object.assign(preview.streams, sdk.previews);
  Object.assign(preview.streams, plugins.previews);
  return { status: status(), preview, devices: devices(), sdk: sdk.info() };
}
function announce() { send({ snapshot: snapshot() }, true); }
async function writeAll(handle, data) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
    if (!bytesWritten) throw new Error('Recording write returned zero bytes');
    offset += bytesWritten;
  }
}
async function drain() {
  if (writing) return drainPromise;
  writing = true;
  drainPromise = (async () => {
    while (queue.length) {
      const { recording, batch, bytes } = queue.shift();
      try {
        const header = Buffer.allocUnsafe(32);
        header.writeBigUInt64LE(batch.sequence, 0);
        header.writeBigInt64LE(batch.deviceTimeNs, 8);
        header.writeBigInt64LE(batch.hostTimeNs, 16);
        header.writeUInt32LE(batch.sampleCount, 24);
        header.writeUInt32LE(batch.payload.length, 28);
        await writeAll(recording.files.get(batch.streamId), Buffer.concat([header, batch.payload]));
        const metadataFile = batch.streamId.startsWith('plugin-') ? recording.pluginMetadataFile : recording.metadataFile;
        if (batch.metadata && metadataFile) await writeAll(metadataFile, Buffer.from(JSON.stringify(batch.metadata) + '\n'));
        const stats = recording.stats.get(batch.streamId);
        stats.records++;
        stats.samples += batch.sampleCount;
        stats.payload_bytes += batch.payload.length;
        stats.first_device_time_ns ??= batch.deviceTimeNs.toString();
        stats.last_device_time_ns = batch.deviceTimeNs.toString();
        if (recording.quality.has(batch.streamId)) observeStreamQuality(recording.quality.get(batch.streamId), batch.metadata?.source_sequence, batch.metadata?.jpeg_status);
      } catch (error) { recording.error ??= `Recording write failed: ${error.message}`; recording.dropped++; }
      finally { queueBytes -= bytes; }
    }
    writing = false;
  })();
  return drainPromise;
}
function accept(batch) {
  const recording = active;
  if (!recording || stopping || !recording.selected.has(batch.streamId) || batch.deviceTimeNs < recording.deviceStart) return;
  if (recording.error) { recording.dropped++; return; }
  const bytes = batch.payload.length + 32;
  if (queueBytes + bytes > queueLimit || queue.length + (writing ? 1 : 0) >= queueCapacity) {
    recording.error = 'Recording queue overflow; data loss detected'; recording.dropped++; return;
  }
  queue.push({ recording, batch, bytes });
  queueBytes += bytes;
  void drain();
}
async function start(request) {
  if (active) throw problem('A recording is already active', 409);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw problem('Expected request object');
  if (!Array.isArray(request.device_ids)) throw problem('Select at least one device');
  if (typeof request.name !== 'undefined' && (typeof request.name !== 'string' || request.name.length > 200)) throw problem('Invalid session name');
  const experiment = validateExperiment(request.experiment);
  const labels = validateLabels(request.labels);
  const mediaSources = request.media_sources ?? [];
  if (!Array.isArray(mediaSources) || mediaSources.length > 8 || mediaSources.some(source =>
    !source || !/^(camera|microphone)-[a-z0-9][a-z0-9_-]{0,47}$/.test(source.id ?? '') ||
    !(source.mode === 'browser-microphone' ? source.kind === 'audio' && source.id.startsWith('microphone-') && source.format === 'wav'
      && source.encoding === 'pcm_s16le' && source.channels === 1 && Number.isInteger(source.sample_rate) && source.sample_rate >= 8000 && source.sample_rate <= 384000
      : source.mode === 'browser-camera' && source.kind === 'camera' && source.id.startsWith('camera-') && ['webm', 'mp4'].includes(source.format)) ||
    source.file !== `${source.id}.${source.format}.part`)) throw problem('Invalid browser media sources');
  if (new Set(mediaSources.map(source => source.id)).size !== mediaSources.length) throw problem('Duplicate browser media source');
  const available = [...devices(), ...mediaSources];
  const known = new Set(available.filter(d => d.connected).map(d => d.id));
  for (const id of request.device_ids) if (typeof id !== 'string' || !known.has(id)) throw problem('Unknown device');
  const ids = [...new Set([...request.device_ids, ...mediaSources.map(source => source.id)])];
  if (!ids.length) throw problem('Select at least one device');
  const sourceName = id => id.startsWith('camera-') ? 'browser-camera' : id.startsWith('microphone-') ? 'browser-microphone' : id.startsWith('plugin-') ? 'sdk-plugin' : id.startsWith('sdk-') ? 'shroom-sdk' : 'simulation';
  const id = `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, id);
  const started = process.hrtime.bigint();
  const recording = { files: new Map(), stats: new Map(), quality: new Map(), selected: new Set(ids), started, deviceStart: started - origin, directory, dropped: 0, error: null };
  recording.manifest = {
    schema_version: 1, format: 'multimodal-capture-session', session_id: id, id,
    name: request.name || '多模态采集', profile: request.profile ?? {}, experiment, labels,
    status: 'recording', finalized: false, source: new Set(ids.map(sourceName)).size > 1 ? 'mixed' : sourceName(ids[0]), simulated: !available.some(d => ids.includes(d.id) && !d.simulated), mode: 'node-capture', engine: 'node',
    started_at: new Date().toISOString(), ended_at: null, duration_s: 0, duration_seconds: 0,
    device_ids: ids, streams: [], media_streams: structuredClone(mediaSources),
    session_start_device_time_ns: recording.deviceStart.toString(), session_start_host_time_ns: started.toString(),
    clock: { device_time: 'nanoseconds since Node capture process start', host_time: 'process.hrtime.bigint nanoseconds', synchronization: 'shared simulated clock; not hardware synchronized', json_nanoseconds: 'decimal strings preserve int64 precision' },
    binary: { magic: 'MDAQBIN1', record_header: '<QqqII', record_header_bytes: 32, fields: ['sequence', 'device_time_ns', 'host_time_ns', 'sample_count', 'payload_bytes'] },
  };
  await mkdir(directory);
  try {
    for (const descriptor of available) if (recording.selected.has(descriptor.id) && !['browser-camera', 'browser-microphone'].includes(descriptor.mode)) {
      const d = structuredClone(descriptor);
      const handle = await open(path.join(directory, `${d.id}.bin`), 'wx');
      recording.files.set(d.id, handle);
      await writeAll(handle, Buffer.from('MDAQBIN1'));
      recording.stats.set(d.id, { records: 0, samples: 0, payload_bytes: 0, first_device_time_ns: null, last_device_time_ns: null });
      if (d.adapter === 'sdk-plugin') recording.quality.set(d.id, createStreamQuality());
      recording.manifest.streams.push({ ...d, file: `${d.id}.bin`, format: 'mdaqbin-v1', byte_order: 'little' });
    }
    if (ids.some(id => id.startsWith('sdk-'))) {
      recording.metadataFile = await open(path.join(directory, 'sdk-frames.jsonl'), 'wx');
      recording.manifest.assets = [{ file: 'sdk-frames.jsonl', role: 'sdk-frame-metadata', description: 'SDK timestamp milliseconds, source sequence and packet type alongside exact host timestamp and recording sequence' }];
      recording.manifest.clock.synchronization = 'SDK device_time_ns is host receive elapsed time; original SDK timestamps retained in sdk-frames.jsonl; no hardware synchronization';
    }
    if (ids.some(id => id.startsWith('plugin-'))) {
      recording.pluginMetadataFile = await open(path.join(directory, 'plugin-frames.jsonl'), 'wx');
      recording.manifest.assets ??= [];
      recording.manifest.assets.push({ file: 'plugin-frames.jsonl', role: 'plugin-frame-metadata', description: 'Source SDK timestamps and sequence are retained separately from the host receipt clock; no hardware synchronization' });
      recording.manifest.clock.synchronization = 'device_time_ns is capture host receive elapsed time; optional source SDK timestamps retained in metadata assets; no hardware synchronization';
    }
    if (mediaSources.length) recording.manifest.clock.media_time = 'Browser media timeline and HTTP receive wall-clock timestamps; PCM audio duration is sample_count/sample_rate; chunk counts are not frame counts; no hardware synchronization';
    await atomicJson(path.join(directory, 'manifest.json'), updateManifest(recording));
    active = recording;
    return updateManifest(recording);
  } catch (error) {
    await Promise.allSettled([...recording.files.values()].map(h => h.close()));
    await recording.metadataFile?.close().catch(() => {});
    await recording.pluginMetadataFile?.close().catch(() => {});
    recording.error = error.message;
    recording.manifest.status = 'incomplete';
    // Preserve diagnostics even when a file could not be created.
    await atomicJson(path.join(directory, 'manifest.json'), { ...recording.manifest, finalized: true, error: error.message }).catch(() => {});
    throw error;
  }
}
function validateAudioSegments(stream, incoming) {
  // Older callers may still report one WAV without a segment list.
  if (incoming.segments === undefined) return incoming.bytes === 0 || incoming.bytes === incoming.payload_bytes + 44;
  if (!Array.isArray(incoming.segments)) return false;
  let bytes = 0, samples = 0, payloadBytes = 0;
  for (const [index, segment] of incoming.segments.entries()) {
    const filename = `${stream.id}${index ? `-${String(index + 1).padStart(6, '0')}` : ''}.wav`;
    if (!segment || segment.index !== index || segment.start_sample !== samples ||
        typeof segment.finalized !== 'boolean' || segment.file !== `${filename}${segment.finalized ? '' : '.part'}` ||
        !Number.isSafeInteger(segment.payload_bytes) || segment.payload_bytes < 0 || segment.payload_bytes > 0xffffffff - 44 ||
        !Number.isSafeInteger(segment.sample_count) || segment.sample_count < 0 ||
        segment.payload_bytes !== segment.sample_count * stream.channels * 2 ||
        (segment.bytes !== segment.payload_bytes + 44 && !(segment.bytes === 0 && segment.payload_bytes === 0 && !segment.finalized)) ||
        segment.duration_ms !== segment.sample_count / stream.sample_rate * 1000 ||
        (segment.error != null && typeof segment.error !== 'string') ||
        (index < incoming.segments.length - 1 && !segment.finalized)) return false;
    bytes += segment.bytes; samples += segment.sample_count; payloadBytes += segment.payload_bytes;
  }
  return bytes === incoming.bytes && samples === incoming.sample_count && payloadBytes === incoming.payload_bytes &&
    (!incoming.segments.length || incoming.file === incoming.segments[0].file) &&
    (!incoming.finalized || incoming.segments.length > 0 && incoming.segments.every(segment => segment.finalized));
}
function mediaUpdate(payload) {
  if (!active || payload?.session_id !== active.manifest.id) throw problem('Media session is no longer active', 409);
  if (!Array.isArray(payload.media_streams)) throw problem('Invalid media update');
  for (const incoming of payload.media_streams) {
    const stream = active.manifest.media_streams.find(item => item.id === incoming.id);
    if (!stream || ![`${stream.id}.${stream.format}.part`, `${stream.id}.${stream.format}`].includes(incoming.file) ||
        !Number.isSafeInteger(incoming.chunks) || incoming.chunks < 0 || !Number.isSafeInteger(incoming.bytes) || incoming.bytes < 0) throw problem('Invalid media stream update');
    if (stream.kind === 'audio' && (!Number.isSafeInteger(incoming.payload_bytes) || incoming.payload_bytes < 0 ||
        !Number.isSafeInteger(incoming.sample_count) || incoming.sample_count < 0 || incoming.payload_bytes !== incoming.sample_count * stream.channels * 2 ||
        !validateAudioSegments(stream, incoming))) throw problem('Invalid PCM media counters');
    for (const key of ['file', 'chunks', 'bytes', 'finalized', 'error', 'started_at', 'stopped_at', 'duration_ms', 'first_received_at', 'last_received_at',
      ...(stream.kind === 'audio' ? ['payload_bytes', 'sample_count', 'client_duration_ms'] : [])]) stream[key] = incoming[key];
    if (stream.kind === 'audio') {
      if (incoming.segments !== undefined) stream.segments = structuredClone(incoming.segments);
      else delete stream.segments;
    }
    if (stream.error) active.error ??= `Media (${stream.id}): ${stream.error}`;
  }
  return { session_id: active.manifest.id };
}
async function stop(media) {
  if (!active) return last ?? { status: 'idle' };
  if (media) mediaUpdate(media);
  const recording = active;
  stopping = true;
  announce();
  await drain();
  for (const [id, handle] of recording.files) {
    try { await handle.sync(); } catch (error) { recording.error ??= `Flush failed (${id}): ${error.message}`; }
    try { await handle.close(); } catch (error) { recording.error ??= `Close failed (${id}): ${error.message}`; }
  }
  if (recording.metadataFile) {
    try { await recording.metadataFile.sync(); await recording.metadataFile.close(); } catch (error) { recording.error ??= `Metadata flush failed: ${error.message}`; }
  }
  if (recording.pluginMetadataFile) {
    try { await recording.pluginMetadataFile.sync(); await recording.pluginMetadataFile.close(); } catch (error) { recording.error ??= `Plugin metadata flush failed: ${error.message}`; }
  }
  for (const [id, stats] of recording.stats) if ((id.startsWith('sdk-') || id.startsWith('plugin-')) && stats.records === 0) recording.error ??= `SDK stream ${id} produced no frames during recording`;
  for (const stream of recording.manifest.media_streams ?? []) if (!stream.finalized || !stream.chunks || !stream.bytes || stream.error)
    recording.error ??= `Camera (${stream.id}): ${stream.error || 'Video was not finalized or produced no data'}`;
  const manifest = updateManifest(recording, true);
  manifest.status = recording.error || recording.dropped ? 'incomplete' : 'complete';
  manifest.ended_at = new Date().toISOString();
  try {
    await atomicJson(path.join(recording.directory, 'manifest.json'), manifest);
    last = structuredClone(manifest);
    active = null;
    return last;
  } catch (error) {
    recording.error = `Failed to finalize manifest: ${error.message}`;
    throw error;
  } finally { stopping = false; }
}

await mkdir(root, { recursive: true });
await sdk.init();
await plugins.reload();
for (const manifest of await listSessions()) if (!manifest.finalized || manifest.status === 'recording') {
  manifest.status = 'incomplete';
  manifest.finalized = true;
  manifest.error = 'Capture process ended before recording was finalized; raw files preserved';
  manifest.ended_at = new Date().toISOString();
  await atomicJson(path.join(root, manifest.id, 'manifest.json'), manifest);
}
for (const adapter of adapters) await adapter.start(accept, error => {
  if (active && active.selected.has(adapter.descriptor.id)) active.error ??= `Adapter ${adapter.descriptor.id}: ${error.message}`;
});
const snapshots = setInterval(announce, 100);
send({ ready: true, snapshot: snapshot() });
let lifecycle = Promise.resolve();
async function shutdown() {
  closing = true;
  try {
    for (const adapter of adapters) {
      try { await adapter.stop(); }
      catch (error) { if (active) active.error ??= `Adapter shutdown failed: ${error.message}`; }
    }
    try { await sdk.close(); }
    catch (error) {
      if (active && (!error.stream_ids || error.stream_ids.some(id => active.selected.has(id)))) active.error ??= `SDK shutdown failed: ${error.message}`;
    }
    try { await plugins.close(); }
    catch (error) { if (active) active.error ??= `SDK plugin shutdown failed: ${error.message}`; }
    return await stop();
  } finally { clearInterval(snapshots); }
}
onParentDisconnect(() => {
  const deadline = setTimeout(() => process.exit(1), 12000);
  lifecycle = lifecycle.then(shutdown).catch(() => {}).finally(() => { clearTimeout(deadline); process.exit(0); });
});
// Preview demand is independent of lifecycle operations such as a slow SDK connect.
onCameraPreviewSubscriptions(subscriptions => {
  if (closing) return;
  try {
    plugins.setCameraPreviewSubscriptions(subscriptions);
    setCameraPreviewStreams(subscriptions.map(subscription => subscription.stream_id));
  } catch { /* Ignore malformed control messages without interrupting recording. */ }
});
onCommand(message => {
  lifecycle = lifecycle.then(async () => {
    try {
      let result;
      if (closing) throw problem('Capture engine is closing', 503);
      switch (message.action) {
        case 'start': result = await start(message.payload); break;
        case 'stop': result = await stop(message.payload); break;
        case 'mediaUpdate': result = mediaUpdate(message.payload); break;
        case 'annotationClock':
          if (!active || stopping || active.manifest.id !== message.payload) throw problem('录制已停止，无法实时打点。', 409);
          result = { session_id: active.manifest.id, time_ns: (process.hrtime.bigint() - active.started).toString(), manifest: updateManifest(active) };
          break;
        case 'list': result = await listSessions(); break;
        case 'get': result = active?.manifest.id === message.payload ? updateManifest(active) : await readManifest(message.payload); break;
        case 'sdkInfo': result = sdk.info(); break;
        case 'pluginCatalog': result = plugins.catalog(); break;
        case 'pluginReload':
          if (active) throw problem('Stop recording before changing installed SDK plugins', 409);
          result = await plugins.reload(); break;
        case 'pluginConnect':
          if (active) throw problem('Stop recording before connecting SDK plugins', 409);
          result = await plugins.connect(message.payload); break;
        case 'pluginDisconnect':
          if (active) throw problem('Stop recording before disconnecting SDK plugins', 409);
          result = await plugins.disconnect(message.payload); break;
        case 'sdkPorts': result = await sdk.ports(); break;
        case 'sdkConnect':
          if (active) throw problem('Stop recording before changing SDK connection', 409);
          result = await sdk.connect(message.payload); break;
        case 'sdkDisconnect':
          if (active) throw problem('Stop recording before disconnecting SDK', 409);
          result = await sdk.disconnect(message.payload); break;
        case 'close':
          result = await shutdown();
          break;
        default: throw problem('Unknown capture action');
      }
      send({ id: message.id, result, snapshot: snapshot() });
    } catch (error) {
      send({ id: message.id, error: { message: error.message, statusCode: error.statusCode ?? 500 }, snapshot: snapshot() });
    }
  });
});
