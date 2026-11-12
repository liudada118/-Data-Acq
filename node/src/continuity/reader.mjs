import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { SAFE_ID, MAX_PAYLOAD, SessionError, streamLayout, streamPath, checkWave } from '../exports/reader.mjs';
import { sourceInfo } from '../exports/package-guide.mjs';

const LIMITS = Object.freeze({ manifestBytes: 8 * 1024 * 1024, streams: 64, media: 16, segments: 4096, timeline: 120, anomalies: 100, window: 4 * 1024 * 1024 });
const objectList = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
const string = value => typeof value === 'string' ? value : null;
const ns = value => typeof value === 'string' && /^\d{1,24}$/.test(value) ? BigInt(value) : null;
const finite = value => Number.isFinite(value) ? value : null;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const errorText = error => typeof error?.message === 'string' ? error.message : '无法检查文件';
const relative = (value, origin) => origin === null ? null : Number(value - origin) / 1e9;

export function validateThreshold(value = 100) {
  if (!Number.isFinite(value) || value < 0.001 || value > 60000) throw new SessionError('间隔阈值须为 0.001–60000 毫秒。', 400);
  return value;
}

async function readManifest(dataDir, sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) throw new SessionError('录制 ID 无效。', 400);
  const root = await realpath(dataDir), folder = await realpath(path.join(root, sessionId)).catch(() => null);
  if (!folder || path.dirname(folder) !== root) throw new SessionError('录制不存在。', 404);
  const filename = await realpath(path.join(folder, 'manifest.json')).catch(() => null);
  if (!filename || path.dirname(filename) !== folder) throw new SessionError('录制清单不存在。', 404);
  const info = await stat(filename);
  if (!info.isFile() || info.size > LIMITS.manifestBytes) throw new SessionError('录制清单大小无效。', 400);
  const handle = await open(filename, 'r'); let raw;
  try {
    const buffer = Buffer.alloc(info.size + 1); let count = 0;
    while (count < buffer.length) { const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count); if (!bytesRead) break; count += bytesRead; }
    if (count > info.size) throw new SessionError('录制清单正在变化，请停止保存后重试。', 409);
    raw = buffer.subarray(0, count);
  } finally { await handle.close(); }
  let manifest; try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw new SessionError('录制清单 JSON 无效。', 400); }
  if (!manifest || (manifest.id ?? manifest.session_id) !== sessionId) throw new SessionError('录制清单与目录 ID 不一致。', 400);
  if (manifest.finalized !== true || !['complete', 'completed', 'incomplete'].includes(manifest.status)) throw new SessionError('请先停止录制并完成保存，再检查时间连续性。', 409);
  if (!Array.isArray(manifest.streams) || manifest.streams.length > LIMITS.streams || !Array.isArray(manifest.media_streams ?? []) || (manifest.media_streams?.length ?? 0) > LIMITS.media)
    throw new SessionError('录制的数据流清单无效或超出检查上限。', 400);
  return { folder, manifest, manifest_hash: createHash('sha256').update(raw).digest('hex') };
}

/** Small manifest + file stat fingerprints only. No sample scan and no source writes. */
export async function inspectContinuitySource({ dataDir, sessionId }) {
  const source = await readManifest(dataDir, sessionId), descriptors = [...objectList(source.manifest.streams)];
  let mediaParts = 0;
  for (const media of objectList(source.manifest.media_streams)) {
    if (Array.isArray(media.segments) && media.segments.length > LIMITS.segments) throw new SessionError('音频分段数量超出检查上限。', 400);
    mediaParts += Array.isArray(media.segments) ? media.segments.length : 1;
    if (mediaParts > LIMITS.segments) throw new SessionError('媒体分段总数量超出检查上限。', 400);
    descriptors.push(...(objectList(media.segments).length ? objectList(media.segments) : [media]));
  }
  if (descriptors.length > LIMITS.segments + LIMITS.streams) throw new SessionError('录制附件数量超出检查上限。', 400);
  const files = new Map();
  for (const descriptor of descriptors) {
    const file = string(descriptor.file); if (files.has(file)) continue;
    try {
      const filename = await streamPath(source.folder, descriptor), info = await stat(filename, { bigint: true });
      if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('文件过大，无法安全索引');
      files.set(file, { file, filename, size: Number(info.size), fingerprint: [file, info.size, info.mtimeNs, info.ctimeNs, info.ino].map(String), error: null });
    } catch (error) { files.set(file, { file, size: 0, error: errorText(error), fingerprint: [file, errorText(error)] }); }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([source.manifest_hash, [...files.values()].map(file => file.fingerprint)])).digest('hex');
  const totalBytes = objectList(source.manifest.streams).reduce((sum, stream) => sum + (files.get(string(stream.file))?.size ?? 0), 0);
  return { ...source, files, fingerprint, total_bytes: totalBytes };
}

class HeaderWindow {
  constructor(handle, size, windowSize = LIMITS.window) { this.handle = handle; this.size = size; this.windowSize = windowSize; this.start = -1; this.buffer = Buffer.alloc(0); }
  async read(offset, bytes) {
    if (offset + bytes > this.size) throw new Error('记录头或负载在文件末尾被截断');
    if (offset < this.start || offset + bytes > this.start + this.buffer.length) {
      const buffer = Buffer.allocUnsafe(Math.min(this.windowSize, this.size - offset)); let count = 0;
      while (count < buffer.length) { const { bytesRead } = await this.handle.read(buffer, count, buffer.length - count, offset + count); if (!bytesRead) break; count += bytesRead; }
      this.buffer = buffer.subarray(0, count); this.start = offset;
    }
    if (offset + bytes > this.start + this.buffer.length) throw new Error('扫描期间文件变短或读取不完整');
    return this.buffer.subarray(offset - this.start, offset - this.start + bytes);
  }
}

class IntervalHistogram {
  constructor() { this.bins = new Float64Array(8192); this.count = 0; }
  add(milliseconds) {
    const index = milliseconds === 0 ? 0 : Math.min(8191, Math.max(1, Math.floor(Math.log(milliseconds / 0.000001) / Math.log(1.01)) + 1));
    this.bins[index]++; this.count++;
  }
  quantile(q) {
    if (!this.count) return null;
    const target = Math.ceil(this.count * q); let cumulative = 0;
    for (let i = 0; i < this.bins.length; i++) { cumulative += this.bins[i]; if (cumulative >= target) return i === 0 ? 0 : 0.000001 * Math.pow(1.01, i - 0.5); }
    return null;
  }
}

const emptyBucket = () => ({ records: 0, interval_count: 0, gaps: 0, max_gap_ms: 0, sequence_gap_events: 0, backward_timestamps: 0 });
class Timeline {
  constructor(duration) { this.width = duration > 0 ? Math.max(0.000001, duration / LIMITS.timeline) : 1; this.bins = Array.from({ length: LIMITS.timeline }, emptyBucket); this.beforeOrigin = 0; }
  add(time, values) {
    if (time < 0) this.beforeOrigin++;
    while (time > this.width * LIMITS.timeline) {
      const old = this.bins; this.width *= 2; this.bins = Array.from({ length: LIMITS.timeline }, emptyBucket);
      for (let i = 0; i < old.length; i++) for (const name of Object.keys(old[i])) {
        const target = this.bins[Math.floor(i / 2)];
        target[name] = name === 'max_gap_ms' ? Math.max(target[name], old[i][name]) : target[name] + old[i][name];
      }
    }
    const item = this.bins[Math.max(0, Math.min(LIMITS.timeline - 1, Math.floor(time / this.width)))];
    for (const [name, value] of Object.entries(values)) item[name] = name === 'max_gap_ms' ? Math.max(item[name], value) : item[name] + value;
  }
  result() { return this.bins.map((item, i) => ({ start_s: i * this.width, end_s: (i + 1) * this.width, ...item })); }
}

class Anomalies {
  constructor() { this.first = []; this.longest = []; this.total = 0; }
  add(item) {
    this.total++; if (this.first.length < LIMITS.anomalies / 2) this.first.push(item);
    if (item.type !== 'gap') return;
    // Fixed 50-entry min-heap retains the longest gaps without growing with recording length.
    const heap = this.longest;
    if (heap.length < LIMITS.anomalies / 2) {
      heap.push(item); let i = heap.length - 1;
      while (i && heap[Math.floor((i - 1) / 2)].interval_ms > heap[i].interval_ms) { const parent = Math.floor((i - 1) / 2); [heap[parent], heap[i]] = [heap[i], heap[parent]]; i = parent; }
    } else if (item.interval_ms > heap[0].interval_ms) {
      heap[0] = item; let i = 0;
      for (;;) { let child = i * 2 + 1; if (child >= heap.length) break; if (child + 1 < heap.length && heap[child + 1].interval_ms < heap[child].interval_ms) child++; if (heap[i].interval_ms <= heap[child].interval_ms) break; [heap[i], heap[child]] = [heap[child], heap[i]]; i = child; }
    }
  }
  result() { return [...new Map([...this.first, ...this.longest].map(item => [`${item.record_index}:${item.type}`, item])).values()].sort((a, b) => a.record_index - b.record_index); }
}

function streamIdentity(stream, all, index) {
  const source = stream && typeof stream === 'object' ? stream : {}, info = sourceInfo(source, all);
  return { id: typeof source.id === 'string' && SAFE_ID.test(source.id) ? source.id : `invalid-${index}`,
    name: string(source.name) ?? string(source.id) ?? '无效数据流', sensor_label: info.sensor,
    encoding: string(source.encoding ?? source.metadata?.encoding ?? source.metadata?.pixel_format)?.toLowerCase() ?? null,
    kind: info.modality || 'unknown', port: info.port, instance_id: info.instance_id, side: info.side, file: string(source.file) };
}

/** Capture-time counters are manifest evidence, never reconstructed from app record IDs. */
function attachRecordedQuality(row, stream) {
  row.record_sequence_scope = 'application-records';
  row.recorded_quality = null; row.recorded_quality_status = 'unavailable';
  const value = stream?.quality ?? stream?.metadata?.quality;
  if (value === undefined || value === null) return;
  const count = item => Number.isSafeInteger(item) && item >= 0;
  const validObject = value && typeof value === 'object' && !Array.isArray(value);
  const known = validObject && value.source_sequence_supported === true;
  const unknown = validObject && value.source_sequence_supported === false;
  const fields = ['observed_frames', 'source_indexed_frames', 'source_unindexed_frames', 'invalid_jpeg_frames', 'jpeg_warning_frames'];
  const sourceCounts = ['source_gap_events', 'source_duplicates', 'source_reversals'];
  const valid = validObject && value.scope === 'recorded-frames' && value.jpeg_decode_verified === false
    && fields.every(key => count(value[key]))
    && value.source_indexed_frames + value.source_unindexed_frames === value.observed_frames
    && value.invalid_jpeg_frames + value.jpeg_warning_frames <= value.observed_frames
    && (known ? value.source_indexed_frames > 0 && sourceCounts.every(key => count(value[key]))
      && typeof value.source_missing_frames === 'string' && /^\d{1,128}$/.test(value.source_missing_frames)
      && value.source_sequence_status === (value.source_unindexed_frames || value.source_reversals ? 'partial' : 'available')
      : unknown && value.source_indexed_frames === 0 && value.source_sequence_status === 'unknown'
        && value.source_missing_frames === null && sourceCounts.every(key => value[key] === null));
  if (!valid) {
    row.recorded_quality_status = 'invalid';
    row.warnings.push('录制清单的源质量统计缺失字段、计数不一致或范围不明，未将其当作有效丢帧统计');
    return;
  }
  const quality = Object.fromEntries([...fields, ...sourceCounts, 'source_sequence_supported', 'source_sequence_status', 'source_missing_frames'].map(key => [key, value[key]]));
  Object.assign(quality, { scope: 'recorded-frames', jpeg_decode_verified: false, provenance: 'manifest-snapshot', rescanned: false,
    validation: 'not-rescanned', scan_record_count_matches: row.scan_complete ? value.observed_frames === row.records : null });
  row.recorded_quality = quality; row.recorded_quality_status = 'available';
  row.warnings.push('源序号与 JPEG 质量来自录制期间保存的统计，本次未重新扫描源序号或解码图像；应用记录序号连续不表示设备没有丢帧');
  if (quality.scan_record_count_matches === false) row.warnings.push('录制期质量统计的帧数与本次可读记录数不同，不能把两者视为同一检查范围');
}

async function scanBinary(source, stream, index, threshold, progress, checkCancelled) {
  const identity = streamIdentity(stream, objectList(source.manifest.streams), index), file = source.files.get(identity.file);
  const row = { ...identity, available: false, records: 0, samples: 0, interval_count: 0, nonnegative_interval_count: 0,
    mean_hz: null, p50_interval_ms: null, p95_interval_ms: null, p99_interval_ms: null, max_gap_ms: null, max_gap_time_s: null,
    gaps_over_threshold: 0, sequence_gap_events: 0, sequence_missing_records: '0', duplicate_sequences: 0, backward_sequences: 0,
    backward_timestamps: 0, duplicate_timestamps: 0, backward_host_timestamps: 0, source_bytes: file?.size ?? 0,
    validated_bytes: 0, payload_bytes: 0, first_time_s: null, last_time_s: null, first_time_ns: null, last_time_ns: null,
    completion: 'unavailable', scan_complete: false, error: null, warnings: [], timeline: [], anomalies: [], anomalies_total: 0, anomalies_truncated: 0,
    time_basis: stream?.adapter === 'shroom-sdk' ? 'host_receive' : 'record_device_timestamp', time_origin: 'recording_start', seekable: true,
    rate_kind: 'record_rate', validation: 'record-headers-and-file-boundaries' };
  let handle, previous, origin = ns(source.manifest.session_start_device_time_ns), first, missing = 0n, compressedImages = false;
  if (origin === null) { row.time_origin = 'first_record'; row.seekable = false; }
  const duration = sessionDuration(source.manifest), histogram = new IntervalHistogram(), timeline = new Timeline(duration), anomalies = new Anomalies();
  try {
    if (!stream || typeof stream.id !== 'string' || !SAFE_ID.test(stream.id)) throw new Error('数据流 ID 无效');
    if (!file || file.error) throw new Error(file?.error ?? '数据文件不存在');
    const layout = streamLayout(stream); handle = await open(file.filename, 'r'); const window = new HeaderWindow(handle, file.size, layout.variablePayload ? 32 : LIMITS.window);
    compressedImages = layout.variablePayload;
    if ((await window.read(0, 8)).toString('ascii') !== 'MDAQBIN1') throw new Error('数据文件标识无效');
    let offset = 8; row.validated_bytes = 8;
    while (offset < file.size) {
      if ((row.records & 8191) === 0) { checkCancelled?.(); progress(offset, stream.id); }
      const header = await window.read(offset, 32), sequence = header.readBigUInt64LE(0), time = header.readBigInt64LE(8), host = header.readBigInt64LE(16), count = header.readUInt32LE(24), bytes = header.readUInt32LE(28);
      if (!count || bytes > MAX_PAYLOAD || (layout.variablePayload ? count !== 1 || bytes < 1 : bytes !== count * layout.elements * layout.size) || (layout.irregular && count !== 1)) throw new Error('记录负载大小与数据形状不一致');
      if (time < 0n || host < 0n) throw new Error('记录时间戳为负值');
      if (offset + 32 + bytes > file.size) throw new Error('记录负载在文件末尾被截断');
      if (origin === null) { row.time_origin = 'first_record'; row.seekable = false; }
      const timeS = relative(time, origin), streamTimeS = Number(time - (first ?? time)) / 1e9;
      const bucket = { records: 1, interval_count: 0, gaps: 0, max_gap_ms: 0, sequence_gap_events: 0, backward_timestamps: 0 };
      const anomaly = (type, interval = null, extra = {}) => anomalies.add({ type, record_index: row.records, sequence: sequence.toString(), time_s: timeS, stream_time_s: streamTimeS, interval_ms: interval, ...extra });
      if (previous) {
        row.interval_count++; bucket.interval_count = 1;
        const delta = time - previous.time, milliseconds = Number(delta) / 1e6;
        if (delta < 0n) { row.backward_timestamps++; bucket.backward_timestamps = 1; anomaly('backward_timestamp', milliseconds); }
        else {
          histogram.add(milliseconds); row.nonnegative_interval_count++;
          if (delta === 0n) { row.duplicate_timestamps++; anomaly('duplicate_timestamp', 0); }
          if (row.max_gap_ms === null || milliseconds > row.max_gap_ms) { row.max_gap_ms = milliseconds; row.max_gap_time_s = timeS; }
          bucket.max_gap_ms = milliseconds;
          if (milliseconds > threshold) { row.gaps_over_threshold++; bucket.gaps = 1; anomaly('gap', milliseconds, { from_s: relative(previous.time, origin) }); }
        }
        if (sequence === previous.sequence) { row.duplicate_sequences++; anomaly('duplicate_sequence'); }
        else if (sequence < previous.sequence) { row.backward_sequences++; anomaly('backward_sequence'); }
        else if (sequence > previous.sequence + 1n) { const gap = sequence - previous.sequence - 1n; missing += gap; row.sequence_gap_events++; bucket.sequence_gap_events = 1; anomaly('sequence_gap', null, { missing_records: gap.toString() }); }
        if (host < previous.host) { row.backward_host_timestamps++; anomaly('backward_host_timestamp'); }
      }
      first ??= time; row.records++; row.samples += count; row.payload_bytes += bytes; offset += 32 + bytes;
      row.validated_bytes = offset; row.first_time_s ??= timeS; row.last_time_s = timeS;
      row.first_time_ns ??= time.toString(); row.last_time_ns = time.toString(); previous = { time, sequence, host };
      timeline.add(timeS ?? streamTimeS, bucket);
    }
    row.scan_complete = true;
    for (const field of ['records', 'samples', 'payload_bytes']) if (stream[field] !== undefined && stream[field] !== row[field]) row.warnings.push(`文件 ${field}=${row[field]} 与录制清单 ${typeof stream[field] === 'number' ? stream[field] : '无效值'} 不一致`);
    if (row.warnings.length) row.error = '文件记录计数与清单不一致；统计使用实际可读记录';
  } catch (error) { if (error?.name === 'AbortError') throw error; row.error = errorText(error); }
  finally { await handle?.close(); }
  row.sequence_missing_records = missing.toString(); row.available = row.records > 0;
  row.completion = row.error ? row.available ? 'partial' : 'unavailable' : 'complete';
  if (first !== undefined && previous.time > first && !row.backward_timestamps) row.mean_hz = row.interval_count / (Number(previous.time - first) / 1e9);
  row.p50_interval_ms = histogram.quantile(0.5); row.p95_interval_ms = histogram.quantile(0.95); row.p99_interval_ms = histogram.quantile(0.99);
  row.timeline = timeline.result(); row.anomalies = anomalies.result(); row.anomalies_total = anomalies.total; row.anomalies_truncated = anomalies.total - row.anomalies.length;
  if (timeline.beforeOrigin) row.warnings.push(`${timeline.beforeOrigin} 条记录早于时间原点，时间图首桶包含这些记录`);
  if (row.time_origin === 'first_record') row.warnings.push('清单缺少录制时间原点；时间图相对于本流首条记录，异常录制时间留空，不用于回放定位或对齐其他设备');
  if (row.backward_timestamps) row.warnings.push('存在时间回退，平均记录率未计算；分位数仅统计非负相邻间隔');
  if (compressedImages) row.warnings.push('MJPEG 连续性按记录头与字节边界检查，未验证 JPEG 像素能否解码；原始压缩帧全部保留');
  if (row.time_basis === 'host_receive') row.warnings.push('SDK 此时间字段为主机接收时间，非硬件采样时钟');
  else row.warnings.push('时间来自记录的 device_time_ns 字段，未确认其代表硬件采样时钟');
  attachRecordedQuality(row, stream);
  progress(row.validated_bytes, identity.id);
  return row;
}

function sessionDuration(manifest) {
  const value = finite(manifest.duration_s ?? manifest.duration_seconds);
  if (value !== null && value >= 0) return value;
  const duration = ns(manifest.duration_ns); return duration === null ? null : Number(duration) / 1e9;
}

async function inspectMedia(source, stream, index) {
  const identity = streamIdentity(stream, objectList(source.manifest.media_streams), index), audio = stream?.kind === 'audio';
  const row = { ...identity, available: false, validation: audio ? 'metadata-and-wav-header' : 'metadata-only',
    time_basis: audio ? 'audio_sample_clock' : 'encoded_video', frame_loss: 'unknown', synchronization: 'unknown',
    declared_duration_s: finite(stream?.duration_ms) === null ? null : stream.duration_ms / 1000,
    sample_rate: finite(stream?.sample_rate), error: null, segments: [], segment_gap_samples: '0', segment_overlap_samples: '0', missing_segments: 0,
    duplicate_segment_files: 0, duplicate_segment_indices: 0, segment_order_errors: 0, segment_index_gaps: '0', metadata_totals: {}, totals_mismatch: false,
    notes: audio ? ['仅检查分段声明、WAV 文件头和字节数；不测量声音质量或跨设备同步'] : ['未解码视频，帧间隔、视频丢帧与音画同步未知'] };
  if (!stream || typeof stream.id !== 'string' || !SAFE_ID.test(stream.id)) { row.error = '媒体 ID 无效'; return row; }
  if (!audio) {
    const file = source.files.get(identity.file); row.available = Boolean(file && !file.error && file.size > 0);
    row.error = file?.error ?? (!row.available ? '媒体文件为空或缺失' : null);
    if (file && Number.isSafeInteger(stream.bytes) && file.size !== stream.bytes) row.error = '媒体字节数与清单不一致';
    if (stream.finalized !== true || stream.error) row.notes.push('源媒体未正常收尾或记录了错误，不保证可播放');
    return row;
  }
  const declared = stream.segments !== undefined;
  if (declared && !Array.isArray(stream.segments)) { row.error = '音频分段清单无效'; row.missing_segments = 1; return row; }
  const parts = declared ? stream.segments : [{ ...stream, index: 0, start_sample: 0 }];
  let expected = 0n, gaps = 0n, overlaps = 0n, previousIndex = null, indexGaps = 0n;
  const seenFiles = new Set(), seenIndices = new Set(), sums = { sample_count: 0n, payload_bytes: 0n, bytes: 0n };
  const errors = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') {
      row.segments.push({ index: null, file: null, start_sample: null, sample_count: null, duration_s: null, available: false,
        gap_before_samples: null, overlap_before_samples: null, error: '音频分段记录无效' }); row.missing_segments++; expected = null;
      for (const field of Object.keys(sums)) sums[field] = null;
      continue;
    }
    const start = nonnegative(part.start_sample), count = nonnegative(part.sample_count);
    const delta = start === null || expected === null ? null : BigInt(start) - expected, gap = delta !== null && delta > 0n ? delta : 0n, overlap = delta !== null && delta < 0n ? -delta : 0n;
    gaps += gap; overlaps += overlap;
    const item = { index: nonnegative(part.index), file: string(part.file), start_sample: start, sample_count: count,
      duration_s: finite(part.duration_ms) === null ? null : part.duration_ms / 1000, available: false,
      gap_before_samples: delta === null ? null : gap.toString(), overlap_before_samples: delta === null ? null : overlap.toString(), error: null };
    const duplicateFile = item.file !== null && seenFiles.has(item.file.toLowerCase()), duplicateIndex = item.index !== null && seenIndices.has(item.index);
    if (duplicateFile) row.duplicate_segment_files++; if (duplicateIndex) row.duplicate_segment_indices++;
    if (item.index !== null && previousIndex !== null) {
      if (item.index < previousIndex) row.segment_order_errors++;
      if (item.index > previousIndex + 1) indexGaps += BigInt(item.index) - BigInt(previousIndex) - 1n;
    }
    if (item.file !== null) seenFiles.add(item.file.toLowerCase()); if (item.index !== null) seenIndices.add(item.index);
    previousIndex = item.index;
    for (const field of Object.keys(sums)) {
      if (sums[field] === null || nonnegative(part[field]) === null) sums[field] = null;
      else sums[field] += BigInt(part[field]);
    }
    try {
      if (start === null || count === null || item.index === null) throw new Error('音频分段序号或样本偏移无效');
      if (duplicateFile || duplicateIndex) throw new Error('音频分段文件或索引重复，未重复计为可用分段');
      await checkWave(source.folder, stream, part); item.available = count > 0;
    }
    catch (error) { item.error = errorText(error); }
    expected = start !== null && count !== null ? BigInt(start) + BigInt(count) : null;
    if (!item.available) row.missing_segments++;
    row.segments.push(item);
  }
  row.available = row.segments.some(item => item.available); row.segment_gap_samples = gaps.toString(); row.segment_overlap_samples = overlaps.toString(); row.segment_index_gaps = indexGaps.toString();
  for (const field of Object.keys(sums)) {
    const declaredCount = nonnegative(stream[field]), sum = sums[field];
    const matches = declaredCount === null || sum === null ? null : BigInt(declaredCount) === sum;
    row.metadata_totals[field] = { declared: declaredCount === null ? null : String(declaredCount), segment_sum: sum?.toString() ?? null, matches };
    if (matches === false) { row.totals_mismatch = true; errors.push(`音频 ${field} 总量与分段之和不一致，可能存在未列出的段或元信息错误`); }
  }
  if (declared && string(stream.file) && parts[0]?.file !== stream.file) errors.push('音频首段文件与流清单不一致');
  if (sums.sample_count !== null && Number.isFinite(stream.sample_rate) && stream.sample_rate > 0 && Number.isFinite(stream.duration_ms)
    && Math.abs(Number(sums.sample_count) / stream.sample_rate * 1000 - stream.duration_ms) > 0.000001) { row.totals_mismatch = true; errors.push('音频声明时长与分段样本总数不一致'); }
  if (!parts.length) errors.push('音频分段清单为空或无效');
  else if (row.missing_segments) { errors.push(`${row.missing_segments} 个音频分段不可验证或为空`); row.notes.push('存在缺失或无效分段；样本缺口/重叠计数仅基于可读的相邻声明，不代表缺失数据总量'); }
  if (row.segment_order_errors || indexGaps) errors.push('音频分段索引存在回退或缺口，按原声明检查，未重新排序补段');
  row.error = errors.length ? errors.join('；') : null;
  if (gaps || overlaps) row.notes.push('分段样本坐标存在缺口或重叠；未拼接或修正原始数据');
  if (stream.started_at == null) row.notes.push('媒体开始时间未记录，不能据此推断与其他设备的偏移');
  return row;
}

/** Explicit full header scan, intended for the background worker only. */
export async function scanContinuity({ dataDir, sessionId, threshold_ms = 100, onProgress = () => {}, checkCancelled }) {
  const threshold = validateThreshold(threshold_ms), source = await inspectContinuitySource({ dataDir, sessionId });
  const started = Date.now(), streams = [], media = [], seenIds = new Set(), seenFiles = new Set(); let completedWeight = 0, scannedBytes = 0, lastProgress = 0;
  const totalWeight = source.total_bytes || 1;
  const update = (offset, id, force = false) => { if (force || Date.now() - lastProgress >= 200) { lastProgress = Date.now(); onProgress({ progress: Math.min(0.95, (completedWeight + offset) / totalWeight * 0.95), scanned_bytes: scannedBytes + offset, total_bytes: source.total_bytes, current_stream_id: id }); } };
  update(0, null, true);
  for (let i = 0; i < source.manifest.streams.length; i++) {
    checkCancelled?.(); const stream = source.manifest.streams[i]; let row;
    if (stream && (seenIds.has(stream.id) || seenFiles.has(stream.file))) {
      row = await scanBinary({ ...source, files: new Map() }, stream, i, threshold, () => {}, checkCancelled); row.id = `duplicate-${i}`; row.error = '重复的数据流 ID 或文件，未重复计数';
    } else row = await scanBinary(source, stream, i, threshold, update, checkCancelled);
    if (stream) { seenIds.add(stream.id); seenFiles.add(stream.file); }
    streams.push(row); scannedBytes += row.validated_bytes; completedWeight += row.source_bytes; update(0, null, true);
  }
  const mediaSources = source.manifest.media_streams ?? [];
  for (let i = 0; i < mediaSources.length; i++) {
    checkCancelled?.(); media.push(await inspectMedia(source, mediaSources[i], i));
    onProgress({ progress: 0.95 + (i + 1) / Math.max(1, mediaSources.length) * 0.04, scanned_bytes: scannedBytes, total_bytes: source.total_bytes, current_stream_id: mediaSources[i]?.id ?? null });
  }
  const after = await inspectContinuitySource({ dataDir, sessionId }).catch(() => null), sourceChanged = after?.fingerprint !== source.fingerprint;
  const warnings = ['间隔阈值由用户设置，仅用于定位时间异常，不是合格标准。',
    '统计对象是相邻记录；含多样本的数据块按块计算记录率，不等于样本采样率。',
    '序号缺口是相邻应用记录序号的差值；不能据此认定设备侧丢帧，首条之前的缺失未知。',
    '扫描校验记录头、负载长度和文件边界，不解码全部信号，不认证信号质量或多设备同步。',
    '时间图最多 120 桶；异常明细保留最先 50 条与最长 50 个间隔的并集。',
    '报告缓存在内存，服务重启后需重新生成。缓存按清单哈希及源文件大小、修改时间和元信息变化判断，不计算全部数据内容哈希。'];
  if (source.manifest.status === 'incomplete') warnings.push('原录制标记为数据不完整；此检查不会修改源文件或录制状态。');
  if (sourceChanged) warnings.push('检查期间源文件发生变化，结果可能来自变化前的前缀；请保存完成后重新检查。');
  if (streams.some(stream => !stream.scan_complete)) warnings.push('至少一路无法完整扫描；已保留可读前缀，其他数据流独立统计。');
  return { schema_version: 1, session_id: sessionId, session_name: string(source.manifest.name), source_status: source.manifest.status,
    source_error: string(source.manifest.error), dropped_records: nonnegative(source.manifest.dropped_records), dropped_batches: nonnegative(source.manifest.dropped_batches),
    source_fingerprint: source.fingerprint, source_changed: sourceChanged, threshold_ms: threshold, checked_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started, duration_s: sessionDuration(source.manifest), fully_scanned: streams.every(stream => stream.scan_complete),
    quantile_method: '固定 8192 桶对数直方图：零间隔单独计数；正间隔从 1 ns 起，桶宽比 1.01，分位数取所在桶几何中点，约 ±0.5% 相对估计误差；负间隔不计入分位数。',
    quantile_relative_error_bound: 0.005, limits: LIMITS, warnings, streams, media_streams: media };
}
