import path from 'node:path';
import { open, rename, realpath } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const SAFE_INSTANCE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const CAMERA_CHUNK_LIMIT = 16 * 1024 * 1024;
export const WAV_MAX_DATA_BYTES = Math.floor((0xffffffff - 44) / 2) * 2;
export const AUDIO_SEGMENT_MAX_BYTES = 1024 * 1024 * 1024;
export const AUDIO_SEGMENT_MAX_DURATION_MS = 60 * 60 * 1000;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const mimeBase = value => typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
const publicStream = entry => structuredClone(entry.info);
const audio = info => info.kind === 'audio' && info.mode === 'browser-microphone';

/** Keep a canonical PCM16 WAV header, including on incomplete recoverable recordings. */
function wavHeader(info) {
  const dataBytes = info.payload_bytes ?? 0, header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(info.channels, 22); header.writeUInt32LE(info.sample_rate, 24);
  header.writeUInt32LE(info.sample_rate * info.channels * 2, 28);
  header.writeUInt16LE(info.channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  return header;
}
async function writeHeader(entry) {
  const segment = entry.info.segments?.at(-1);
  const header = wavHeader({ ...entry.info, ...(segment ? { payload_bytes: segment.payload_bytes } : {}) });
  let offset = 0;
  while (offset < header.length) {
    const { bytesWritten } = await entry.handle.write(header, offset, header.length - offset, offset);
    if (!bytesWritten) throw new Error('WAV header write returned zero bytes');
    offset += bytesWritten;
  }
}
function updateAudioCounters(info) {
  if (info.segments) {
    info.bytes = info.segments.reduce((sum, segment) => sum + segment.bytes, 0);
    info.payload_bytes = info.segments.reduce((sum, segment) => sum + segment.payload_bytes, 0);
    if (info.segments.length) info.file = info.segments[0].file;
  } else info.payload_bytes = Math.max(0, info.bytes - 44);
  info.sample_count = info.payload_bytes / (info.channels * 2);
  info.duration_ms = info.sample_count / info.sample_rate * 1000;
}

/** Browser owns capture/encoding. This service owns leases, bounded writes and durable media. */
export class CameraManager {
  constructor({ dataDir, leaseTimeoutMs = 20000, onUpdate = async () => {}, isEngineAlive = () => true,
    audioSegmentMaxBytes = AUDIO_SEGMENT_MAX_BYTES, audioSegmentMaxDurationMs = AUDIO_SEGMENT_MAX_DURATION_MS }) {
    if (!Number.isSafeInteger(audioSegmentMaxBytes) || audioSegmentMaxBytes < 2 || audioSegmentMaxBytes > WAV_MAX_DATA_BYTES ||
        audioSegmentMaxBytes % 2 || !Number.isFinite(audioSegmentMaxDurationMs) || audioSegmentMaxDurationMs <= 0)
      throw failure('Invalid audio segment limits');
    this.dataDir = path.resolve(dataDir); this.leaseTimeoutMs = leaseTimeoutMs;
    this.audioSegmentMaxBytes = audioSegmentMaxBytes; this.audioSegmentMaxDurationMs = audioSegmentMaxDurationMs;
    this.onUpdate = onUpdate; this.isEngineAlive = isEngineAlive;
    this.leases = new Map(); this.active = null; this.closed = false;
    this.timer = setInterval(() => this.sweep(), Math.min(1000, leaseTimeoutMs));
    this.timer.unref();
  }
  register(input) {
    if (this.closed) throw failure('Camera service is closing', 503);
    if (!input || typeof input.instance_id !== 'string' || !SAFE_INSTANCE.test(input.instance_id)) throw failure('Invalid camera instance_id');
    const { instance_id: id, width, height, frame_rate: frameRate } = input;
    const isAudio = input.kind === 'audio';
    if (input.kind !== undefined && !['camera', 'audio'].includes(input.kind)) throw failure('Unsupported browser media kind');
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200) throw failure('Invalid media label');
    if (isAudio ? !Number.isInteger(input.sample_rate) || input.sample_rate < 8000 || input.sample_rate > 384000 ||
        input.channels !== 1 || (input.encoding !== undefined && input.encoding !== 'pcm_s16le') :
        !Number.isInteger(width) || width < 0 || width > 16384 ||
        !Number.isInteger(height) || height < 0 || height > 16384 ||
        !Number.isFinite(frameRate) || frameRate < 0 || frameRate > 1000) throw failure('Invalid browser media settings');
    this.sweep();
    if (this.leases.get(id)?.device.connected || this.active?.entries.has(id)) throw failure('Camera instance already in use', 409);
    if ([...this.leases.values()].filter(lease => lease.device.connected).length >= 8) throw failure('At most eight browser media sources may be connected', 409);
    // Keep offline entries bounded; callers retain the descriptor on their own cards.
    if (this.leases.size >= 32) for (const [key, lease] of this.leases) {
      if (!lease.device.connected && !this.active?.entries.has(key)) this.leases.delete(key);
      if (this.leases.size < 32) break;
    }
    const device = isAudio ? { id: `microphone-${id}`, name: input.label.trim(), kind: 'audio', transport: 'Browser Web Audio',
      mode: 'browser-microphone', connected: true, simulated: false, sample_rate: input.sample_rate, sample_rate_known: true,
      unit: 'PCM', channels: 1, bits_per_sample: 16, encoding: 'pcm_s16le', preview_supported: false,
      metadata: { instance_id: id, count_unit: 'chunks', sample_rate: input.sample_rate, channels: 1, bits_per_sample: 16,
        encoding: 'pcm_s16le', synchronization: 'AudioContext sample clock; not hardware synchronized' } }
      : { id: `camera-${id}`, name: input.label.trim(), kind: 'camera', transport: 'Browser MediaStream',
      mode: 'browser-camera', connected: true, simulated: false, width, height, sample_rate: frameRate,
      sample_rate_known: false, unit: 'encoded video', channels: 1, preview_supported: false,
      metadata: { instance_id: id, count_unit: 'chunks', nominal_frame_rate: frameRate || null,
        width_known: width > 0, height_known: height > 0, frame_rate_known: frameRate > 0,
        synchronization: 'browser timestamps; not hardware synchronized' } };
    const token = randomBytes(32).toString('hex');
    this.leases.set(id, { device, token, seen: Date.now() });
    return { device: structuredClone(device), token, lease_timeout_ms: this.leaseTimeoutMs, chunk_limit_bytes: CAMERA_CHUNK_LIMIT };
  }
  devices() { this.sweep(); return [...this.leases.values()].map(lease => structuredClone(lease.device)); }
  stopRequiresOwner() {
    this.sweep();
    return [...(this.active?.entries ?? [])].some(([id, entry]) =>
      !entry.info.finalized && !entry.info.error && this.leases.get(id)?.device.connected === true);
  }
  authorize(id, token, renew = true) {
    if (typeof id !== 'string' || !SAFE_INSTANCE.test(id)) throw failure('Invalid camera instance_id');
    const lease = this.leases.get(id);
    if (!lease || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(lease.token))) throw failure('Invalid camera lease token', 403);
    this.sweep();
    if (!lease.device.connected) throw failure('Camera lease is offline; reconnect the camera', 409);
    if (renew) lease.seen = Date.now();
    return lease;
  }
  heartbeat(id, token) { return { device: structuredClone(this.authorize(id, token).device) }; }
  disconnect(id, token) {
    const lease = this.authorize(id, token);
    lease.device.connected = false;
    this.fail(id, 'Camera disconnected before video finalization');
    return { device: structuredClone(lease.device) };
  }
  sweep() {
    const now = Date.now();
    for (const [id, lease] of this.leases) if (lease.device.connected && now - lease.seen > this.leaseTimeoutMs) {
      lease.device.connected = false; this.fail(id, 'Camera heartbeat expired');
    }
    if (this.active && !this.isEngineAlive()) for (const id of this.active.entries.keys()) this.fail(id, 'Capture process is unavailable');
  }
  sources(request) {
    if (!Array.isArray(request.device_ids)) throw failure('Select at least one device');
    const cameraIds = request.device_ids.filter(id => typeof id === 'string' && /^(camera|microphone)-/.test(id));
    const sources = request.camera_sources ?? [];
    if (!Array.isArray(sources) || sources.length > 8) throw failure('Invalid camera_sources');
    const seen = new Set();
    const result = sources.map(source => {
      if (!source || typeof source !== 'object' || seen.has(source.instance_id)) throw failure('Invalid or duplicate camera source');
      const lease = this.authorize(source.instance_id, source.token);
      seen.add(source.instance_id);
      if (!cameraIds.includes(lease.device.id)) throw failure('Camera source is not selected');
      const base = mimeBase(source.mime_type);
      const isAudio = audio(lease.device);
      if (!(isAudio ? ['audio/wav'] : ['video/webm', 'video/mp4']).includes(base) || source.mime_type.length > 200 || /[\r\n]/.test(source.mime_type)) throw failure('Unsupported browser media MIME type', 415);
      const extension = isAudio ? 'wav' : base === 'video/webm' ? 'webm' : 'mp4';
      return { ...structuredClone(lease.device), mime_type: source.mime_type, format: extension,
        file: `${lease.device.id}.${extension}.part`, finalized: false, chunks: 0, bytes: 0, error: null,
        ...(isAudio ? { payload_bytes: 0, sample_count: 0, client_duration_ms: null, segments: [] } : {}),
        started_at: null, stopped_at: null, duration_ms: null, first_received_at: null, last_received_at: null };
    });
    if (new Set(cameraIds).size !== result.length) throw failure('Every selected camera requires an authorized camera_sources entry');
    return result;
  }
  async prepare(session, sources) {
    if (!sources.length) return;
    if (this.active) throw failure('A camera recording is already active', 409);
    const directory = await realpath(path.join(this.dataDir, session.id));
    if (path.dirname(directory) !== await realpath(this.dataDir)) throw failure('Invalid camera session path');
    const active = { id: session.id, directory, entries: new Map(), closing: false };
    this.active = active;
    try {
      for (const source of sources) {
        const id = source.metadata.instance_id;
        const lease = this.leases.get(id);
        if (!lease?.device.connected) throw failure('Camera disconnected during recording start', 409);
        const entry = { info: structuredClone(source), handle: null, pending: null, finalizing: null };
        active.entries.set(id, entry);
        if (audio(entry.info)) await this.openAudioSegment(entry);
        else entry.handle = await open(path.join(directory, source.file), 'wx');
      }
      await this.publish();
    } catch (error) {
      for (const entry of active.entries.values()) entry.info.error ??= `Video preparation failed: ${error.message}`;
      throw error;
    }
  }
  /** Segment boundaries use exact sample counts, never elapsed browser time. */
  audioSegmentLimit(info) {
    const alignment = info.channels * 2;
    return Math.max(alignment, Math.floor(Math.min(this.audioSegmentMaxBytes, WAV_MAX_DATA_BYTES,
      Math.floor(this.audioSegmentMaxDurationMs * info.sample_rate / 1000) * alignment) / alignment) * alignment);
  }
  async openAudioSegment(entry) {
    const index = entry.info.segments.length;
    const file = `${entry.info.id}${index ? `-${String(index + 1).padStart(6, '0')}` : ''}.wav.part`;
    const handle = await open(path.join(this.active.directory, file), 'wx');
    entry.handle = handle;
    const segment = { index, file, start_sample: entry.info.sample_count, sample_count: 0,
      payload_bytes: 0, bytes: 0, duration_ms: 0, finalized: false, error: null };
    entry.info.segments.push(segment);
    await writeHeader(entry);
    segment.bytes = 44; updateAudioCounters(entry.info);
  }
  async sealAudioSegment(entry) {
    const segment = entry.info.segments.at(-1);
    if (segment.finalized) return;
    await writeHeader(entry); await entry.handle.sync(); await entry.handle.close(); entry.handle = null;
    const file = segment.file.replace(/\.part$/, '');
    await rename(path.join(this.active.directory, segment.file), path.join(this.active.directory, file));
    Object.assign(segment, { file, finalized: true });
    updateAudioCounters(entry.info);
  }
  recording(id, sessionId) {
    if (!this.active || this.active.id !== sessionId) throw failure('Camera recording session does not match', 409);
    const entry = this.active.entries.get(id);
    if (!entry) throw failure('Camera is not selected in this recording', 409);
    return entry;
  }
  update() {
    if (!this.active) return { media_streams: [] };
    return { session_id: this.active.id, media_streams: [...this.active.entries.values()].map(publicStream) };
  }
  async publish() { if (this.active) await this.onUpdate(this.update()); }
  fail(id, message) {
    const entry = this.active?.entries.get(id);
    if (!entry || entry.info.finalized || entry.info.error) return;
    entry.info.error = String(message).slice(0, 1000);
    const segment = entry.info.segments?.at(-1);
    if (segment && !segment.finalized) segment.error ??= entry.info.error;
    void this.publish().catch(() => {});
  }
  error(id, token, input) {
    this.authorize(id, token);
    const entry = this.recording(id, input.session_id);
    if (entry.info.finalized) throw failure('Video is already finalized', 409);
    this.fail(id, typeof input.error === 'string' ? input.error.slice(0, 1000) : 'Browser camera recording failed');
    return { media_stream: publicStream(entry) };
  }
  async append(id, token, sessionId, indexText, request) {
    this.authorize(id, token);
    const entry = this.recording(id, sessionId);
    if (this.active.closing || entry.info.finalized || entry.finalizing || entry.info.error) throw failure('Video no longer accepts chunks', 409);
    if (!/^(0|[1-9][0-9]*)$/.test(indexText ?? '') || !Number.isSafeInteger(Number(indexText))) throw failure('Invalid chunk index');
    if (entry.pending || Number(indexText) !== entry.info.chunks) throw failure('Chunk is concurrent, duplicate, or out of order', 409);
    if (mimeBase(request.headers['content-type']) !== mimeBase(entry.info.mime_type) &&
        !(audio(entry.info) && mimeBase(request.headers['content-type']) === 'application/octet-stream')) throw failure('Chunk MIME type differs from recording', 415);
    const length = Number(request.headers['content-length']);
    if (Number.isFinite(length) && length > CAMERA_CHUNK_LIMIT) {
      this.fail(id, 'Video chunk exceeds 16 MiB'); throw failure('Video chunk exceeds 16 MiB', 413);
    }
    const isAudio = audio(entry.info), alignment = isAudio ? entry.info.channels * 2 : 1;
    if (isAudio && Number.isFinite(length) && (length % alignment || length > this.audioSegmentLimit(entry.info))) {
      const message = length % alignment ? 'PCM chunk is not aligned to complete samples' : 'PCM chunk exceeds the WAV segment limit';
      this.fail(id, message); throw failure(message, length % alignment ? 400 : 413);
    }
    let resolvePending;
    entry.pending = new Promise(resolve => { resolvePending = resolve; });
    const committed = entry.info.bytes, committedChunks = entry.info.chunks;
    const deadline = setTimeout(() => request.destroy(new Error('Video upload timed out')), 15000);
    let bytes = 0, audioRollback;
    const audioChunks = [];
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        if (entry.info.error) throw failure(entry.info.error, 409);
        bytes += chunk.length;
        if (bytes > CAMERA_CHUNK_LIMIT) throw failure('Video chunk exceeds 16 MiB', 413);
        // A PCM upload is bounded to 16 MiB and buffered until fully received.
        // Only then may it rotate files; an aborted/odd-size upload cannot seal
        // the old segment or split an acknowledged chunk across two files.
        if (isAudio) {
          if (bytes > this.audioSegmentLimit(entry.info)) throw failure('PCM chunk exceeds the WAV segment limit', 413);
          audioChunks.push(chunk); continue;
        }
        let offset = 0;
        while (offset < chunk.length) {
          const result = await entry.handle.write(chunk, offset, chunk.length - offset, committed + bytes - chunk.length + offset);
          if (!result.bytesWritten) throw new Error('Video write returned zero bytes');
          offset += result.bytesWritten;
        }
      }
      if (!bytes) throw failure('Video chunk is empty');
      if (bytes % alignment) throw failure('PCM chunk is not aligned to complete samples');
      if (entry.info.error) throw failure(entry.info.error, 409);
      if (isAudio) {
        let segment = entry.info.segments.at(-1);
        if (segment.payload_bytes && segment.payload_bytes + bytes > this.audioSegmentLimit(entry.info)) {
          await this.sealAudioSegment(entry);
          if (entry.info.error) throw failure(entry.info.error, 409);
          await this.openAudioSegment(entry);
          segment = entry.info.segments.at(-1);
        }
        audioRollback = { segment, bytes: segment.bytes, payload_bytes: segment.payload_bytes,
          sample_count: segment.sample_count, duration_ms: segment.duration_ms };
        let position = segment.bytes;
        for (const chunk of audioChunks) {
          let offset = 0;
          while (offset < chunk.length) {
            const result = await entry.handle.write(chunk, offset, chunk.length - offset, position + offset);
            if (!result.bytesWritten) throw new Error('PCM write returned zero bytes');
            offset += result.bytesWritten;
          }
          position += chunk.length;
        }
        if (entry.info.error) throw failure(entry.info.error, 409);
        segment.bytes += bytes; segment.payload_bytes += bytes;
        segment.sample_count = segment.payload_bytes / alignment;
        segment.duration_ms = segment.sample_count / entry.info.sample_rate * 1000;
        await writeHeader(entry); updateAudioCounters(entry.info);
      } else entry.info.bytes += bytes;
      entry.info.chunks++;
      entry.info.first_received_at ??= new Date().toISOString();
      entry.info.last_received_at = new Date().toISOString();
      await this.publish();
      return { next_index: entry.info.chunks, bytes_written: entry.info.bytes,
        ...(isAudio ? { payload_bytes: entry.info.payload_bytes, sample_count: entry.info.sample_count } : {}) };
    } catch (error) {
      request.resume();
      // A failed HTTP chunk is rolled back, preserving all previously acknowledged chunks.
      if (isAudio) {
        if (audioRollback && entry.handle) {
          await entry.handle.truncate(audioRollback.bytes).catch(() => {});
          const { segment, ...counters } = audioRollback; Object.assign(segment, counters);
          await writeHeader(entry).catch(() => {});
        }
        updateAudioCounters(entry.info);
      } else {
        await entry.handle.truncate(committed).catch(() => {});
        entry.info.bytes = committed;
      }
      entry.info.chunks = committedChunks;
      this.fail(id, `Video upload failed: ${error.message}`);
      throw error;
    } finally { clearTimeout(deadline); entry.pending = null; resolvePending(); }
  }
  async finalize(id, token, input) {
    this.authorize(id, token);
    const entry = this.recording(id, input.session_id);
    if (this.active.closing || entry.info.finalized || entry.finalizing) throw failure('Video is finalizing or already finalized', 409);
    if (!Number.isSafeInteger(input.next_index) || input.next_index < 0 ||
        typeof input.started_at !== 'string' || !Number.isFinite(Date.parse(input.started_at)) ||
        typeof input.stopped_at !== 'string' || !Number.isFinite(Date.parse(input.stopped_at)) ||
        Date.parse(input.stopped_at) < Date.parse(input.started_at) ||
        !Number.isFinite(input.duration_ms) || input.duration_ms < 0) throw failure('Invalid video finalization metadata');
    entry.finalizing = (async () => {
      if (entry.pending) await entry.pending;
      if (entry.info.error) throw failure(entry.info.error, 409);
      if (!entry.info.chunks || input.next_index !== entry.info.chunks) throw failure('Video has missing chunks or no data', 409);
      if (audio(entry.info)) {
        if (!Number.isSafeInteger(input.bytes) || input.bytes !== entry.info.payload_bytes) throw failure('PCM byte count does not match acknowledged samples', 409);
        await this.sealAudioSegment(entry);
      } else {
        await entry.handle.sync(); await entry.handle.close(); entry.handle = null;
        const file = entry.info.file.replace(/\.part$/, '');
        await rename(path.join(this.active.directory, entry.info.file), path.join(this.active.directory, file));
        entry.info.file = file;
      }
      if (entry.info.error) throw failure(entry.info.error, 409);
      Object.assign(entry.info, { finalized: true, started_at: input.started_at, stopped_at: input.stopped_at,
        ...(audio(entry.info) ? { client_duration_ms: input.duration_ms } : { duration_ms: input.duration_ms }) });
      await this.publish();
      return { media_stream: publicStream(entry) };
    })();
    try { return await entry.finalizing; }
    catch (error) { this.fail(id, `Video finalization failed: ${error.message}`); throw error; }
    finally { entry.finalizing = null; }
  }
  async finish() {
    const active = this.active;
    if (!active) return undefined;
    if (active.finishing) return active.finishing;
    active.closing = true;
    active.finishing = (async () => {
      for (const [id, entry] of active.entries) {
        await entry.pending;
        await entry.finalizing?.catch(() => {});
        if (!entry.info.finalized) this.fail(id, 'Video was not finalized before session stop');
        if (entry.handle) {
          if (audio(entry.info)) {
            try {
              await writeHeader(entry);
              const segment = entry.info.segments?.at(-1);
              if (segment) segment.bytes = segment.payload_bytes + 44;
              updateAudioCounters(entry.info);
            } catch (error) { this.fail(id, `WAV header repair failed: ${error.message}`); }
          }
          try { await entry.handle.sync(); } catch (error) { this.fail(id, `Video flush failed: ${error.message}`); }
          try { await entry.handle.close(); } catch (error) { this.fail(id, `Video close failed: ${error.message}`); }
          entry.handle = null;
        }
      }
      const result = this.update();
      this.active = null;
      return result;
    })();
    return active.finishing;
  }
  async close() { this.closed = true; clearInterval(this.timer); return this.finish(); }
}
