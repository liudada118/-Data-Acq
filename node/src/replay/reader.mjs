import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeFrame } from 'shroom-sdk/core';
import { glovePreviewFromLayout, legacyGloveLayout040 } from '../glove-layout.mjs';
import { loadSession, streamLayout, streamPath, MAX_PAYLOAD, SessionError } from '../exports/reader.mjs';
import { jpegPreview } from '../plugins/mjpeg.mjs';

const MAX_INDEX_POINTS = 4096;
const MAX_STREAMS = 32;
const MAX_VALUES = 8192;
const NS = 1000000000n;
const fail = message => { throw new SessionError(message); };
const numberNs = (value, field) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > 24) fail(`录制缺少有效 ${field}。`);
  return BigInt(value);
};
async function exactAt(handle, size, offset) {
  const data = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const result = await handle.read(data, read, size - read, offset + read);
    if (!result.bytesRead) fail('录制文件已截断。');
    read += result.bytesRead;
  }
  return data;
}
class HeaderWindow {
  constructor(handle, size, windowSize = 65536) { this.handle = handle; this.size = size; this.windowSize = windowSize; this.buffer = Buffer.alloc(0); this.offset = -1; }
  async read(offset) {
    if (offset < this.offset || offset + 32 > this.offset + this.buffer.length) {
      this.offset = offset;
      this.buffer = await exactAt(this.handle, Math.min(this.windowSize, this.size - offset), offset);
    }
    if (offset + 32 > this.size) fail('录制头已截断。');
    return this.buffer.subarray(offset - this.offset, offset - this.offset + 32);
  }
}
function header(data, layout, offset, fileSize) {
  const value = { offset, sequence: data.readBigUInt64LE(0), deviceNs: data.readBigInt64LE(8), hostNs: data.readBigInt64LE(16),
    sampleCount: data.readUInt32LE(24), bytes: data.readUInt32LE(28) };
  if (!value.sampleCount || value.bytes > MAX_PAYLOAD || (layout.variablePayload ? value.sampleCount !== 1 || value.bytes < 1 : value.bytes !== value.sampleCount * layout.elements * layout.size) ||
      (layout.irregular && value.sampleCount !== 1) || value.deviceNs < 0n || value.hostNs < 0n)
    fail('录制样本形状或时间戳无效。');
  value.next = offset + 32 + value.bytes;
  if (value.next > fileSize) fail('录制数据已截断。');
  return value;
}
async function buildIndex(folder, stream, { allowPartial = false, fastThreshold = 100000 } = {}) {
  const filename = await streamPath(folder, stream), info = await stat(filename), layout = streamLayout(stream);
  if (!Number.isSafeInteger(stream.records) || stream.records < 0) fail('回放需要已完成的记录计数。');
  const recordBytes = 32 + layout.elements * layout.size;
  let stride = Math.max(1, Math.ceil((allowPartial && !layout.variablePayload ? Math.max(stream.records, Math.floor((info.size - 8) / recordBytes)) : stream.records) / MAX_INDEX_POINTS));
  const handle = await open(filename, 'r');
  let points = []; let records = 0, samples = 0, payloadBytes = 0, previousSequence = -1n, previousTime = -1n, last, warning;
  try {
    if ((await exactAt(handle, 8, 0)).toString('ascii') !== 'MDAQBIN1') fail('录制文件格式无效。');
    // SDK records have a fixed payload width and one sample per record. Seek large
    // captures directly; do not scan tens of millions of headers before showing a frame.
    // This is explicitly on-demand validation, not a claim that the whole file is sound.
    if (allowPartial && layout.irregular && !layout.variablePayload && Math.floor((info.size - 8) / recordBytes) >= fastThreshold) {
      let count = Math.floor((info.size - 8) / recordBytes);
      const first = header(await exactAt(handle, 32, 8), layout, 8, info.size);
      const lastOffset = 8 + (count - 1) * recordBytes;
      const warnings = [];
      try {
        last = header(await exactAt(handle, 32, lastOffset), layout, lastOffset, info.size);
        if (last.deviceNs < first.deviceNs || (count > 1 && last.sequence <= first.sequence)) fail('录制序号或时间顺序无效。');
      } catch (error) {
        // A damaged tail must not prevent looking at an earlier valid timestamp.
        // The cursor search validates every header it touches, including neighbours.
        last = undefined; warnings.push(`末条记录异常：${error.message} 可尝试回放此前时刻。`);
      }
      if ((info.size - 8) % recordBytes) warnings.push('末尾存在未写完的记录；只定位完整记录。');
      if (stream.records !== count || stream.samples !== count || stream.payload_bytes !== count * (recordBytes - 32))
        warnings.push('文件记录数与清单不一致；按实际文件边界定位。');
      return { filename, size: info.size, mtimeMs: info.mtimeMs, layout, points: [first], first, last,
        count, recordBytes, direct: true, warning: warnings.join(' ') || undefined };
    }
    const window = new HeaderWindow(handle, info.size, layout.variablePayload ? 32 : 65536);
    let offset = 8;
    while (offset < info.size) {
      try {
        const entry = header(await window.read(offset), layout, offset, info.size);
        if (entry.sequence <= previousSequence || entry.deviceNs < previousTime) fail('录制序号或时间顺序无效。');
        if (!allowPartial && records >= stream.records) fail('记录计数与会话清单不一致。');
        if (allowPartial && layout.variablePayload && points.length >= MAX_INDEX_POINTS && records % stride === 0) {
          points = points.filter((_, pointIndex) => pointIndex % 2 === 0); stride *= 2;
        }
        if (records % stride === 0) points.push({ offset, deviceNs: entry.deviceNs });
        if (points.length > MAX_INDEX_POINTS + 1) fail('记录计数与会话清单不一致。');
        records++; samples += entry.sampleCount; payloadBytes += entry.bytes;
        previousSequence = entry.sequence; previousTime = entry.deviceNs; last = entry; offset = entry.next;
      } catch (error) {
        if (!allowPartial) throw error;
        warning = `${error.message} 仅回放此前 ${records} 条完整记录。`; break;
      }
    }
    for (const [key, actual] of [['records', records], ['samples', samples], ['payload_bytes', payloadBytes]]) {
      if (stream[key] !== undefined && stream[key] !== actual) {
        if (!allowPartial) fail(`录制 ${key} 与会话清单不一致。`);
        warning ??= `录制 ${key} 与会话清单不一致；仅回放已校验的 ${records} 条记录。`;
      }
    }
    return { filename, size: info.size, validSize: offset, mtimeMs: info.mtimeMs, layout, points, last, stride, warning };
  } finally { await handle.close(); }
}
async function directRecordAt(handle, index, target) {
  const seen = new Map();
  const read = async position => {
    if (seen.has(position)) return seen.get(position);
    const offset = 8 + position * index.recordBytes;
    const value = header(await exactAt(handle, 32, offset), index.layout, offset, index.size);
    for (const [otherPosition, other] of seen) {
      if (otherPosition < position && (other.deviceNs > value.deviceNs || other.sequence >= value.sequence) ||
          otherPosition > position && (other.deviceNs < value.deviceNs || other.sequence <= value.sequence))
        fail('定位到序号或时间顺序异常；此时刻无法可靠回放，请导出检查。');
    }
    seen.set(position, value); return value;
  };
  let low = 0, high = index.count - 1, candidatePosition = -1;
  await read(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), value = await read(middle);
    if (value.deviceNs <= target) { candidatePosition = middle; low = middle + 1; }
    else high = middle - 1;
  }
  if (candidatePosition < 0) return null;
  const candidate = await read(candidatePosition);
  if (candidatePosition > 0) await read(candidatePosition - 1);
  if (candidatePosition + 1 < index.count) await read(candidatePosition + 1);
  return { ...candidate, payload: await exactAt(handle, candidate.bytes, candidate.offset + 32) };
}
async function recordAt(index, target) {
  if (!index.points.length || target < index.points[0].deviceNs) return null;
  let low = 0, high = index.points.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (index.points[middle].deviceNs <= target) low = middle; else high = middle - 1; }
  const handle = await open(index.filename, 'r');
  try {
    const currentInfo = await handle.stat();
    if (currentInfo.size !== index.size || currentInfo.mtimeMs !== index.mtimeMs) fail('录制文件已更改，请重新加载回放。');
    if (index.direct) return await directRecordAt(handle, index, target);
    const window = new HeaderWindow(handle, index.size, index.layout.variablePayload ? 32 : 65536);
    let offset = index.points[low].offset, candidate;
    while (offset < (index.validSize ?? index.size)) {
      const entry = header(await window.read(offset), index.layout, offset, index.size);
      if (entry.deviceNs > target) break;
      candidate = entry; offset = entry.next;
    }
    if (!candidate) return null;
    return { ...candidate, payload: await exactAt(handle, candidate.bytes, candidate.offset + 32) };
  } finally { await handle.close(); }
}
function valuesAt(payload, stream, count, start = 0) {
  if (count > MAX_VALUES) fail('该数据流维度超过回放预览上限，请导出分析。');
  const result = Array.from({ length: count }, (_, i) => stream.dtype === 'float32' ? payload.readFloatLE((i + start) * 4)
    : stream.dtype === 'uint16' ? payload.readUInt16LE((i + start) * 2) : payload[i + start]);
  if (result.some(value => !Number.isFinite(value))) fail('录制包含非有限数值，无法显示该帧。');
  return result;
}

// Save mappings with the recording, so replay remains stable across SDK updates.
// These arrays describe real sensor points; no interpolation or calibration is applied.
function savedPressureLayout(stream, values) {
  const layout = stream.metadata?.pressure_layout;
  if (layout === undefined) return null;
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) fail('录制压力映射无效。');
  const fullScale = stream.metadata?.full_scale;
  if (!Number.isFinite(fullScale) || fullScale <= 0 || fullScale > 65535 || values.some(v => v < 0 || v > fullScale))
    fail('录制压力量程或数值无效。');
  const indices = (source, count) => {
    if (!Array.isArray(source) || source.length !== count || source.some(i => !Number.isSafeInteger(i) || i < 0 || i >= values.length) || new Set(source).size !== count)
      fail('录制压力映射的源索引无效。');
    return source;
  };
  if (layout.type === 'glove') {
    if (stream.dtype !== 'uint8' || values.length !== 256 || fullScale !== 255 || stream.metadata?.product !== 'glove') fail('录制手套映射无效。');
    let glove;
    try { glove = glovePreviewFromLayout(layout, values, stream.metadata?.side); }
    catch (error) { fail(`录制手套映射无效：${error.message}`); }
    return { pressure: { rows: 16, cols: 16, values, full_scale: 255, glove },
      representation: 'sdk-glove-regions', note: '手套五指与手掌 · 137 点 · 按录制保存的映射显示，保留 256 通道原始 ADC' };
  }
  if (layout.type === 'matrix') {
    if (layout.layout !== 'mat32' || stream.dtype !== 'uint8' || values.length !== 1024 || fullScale !== 255)
      fail('录制矩阵映射无效。');
    const decoded = decodeFrame(Uint8Array.from(values), { layout: 'mat32' });
    return { pressure: { rows: decoded.rows, cols: decoded.cols, values: Array.from(decoded.values, v => Math.round(v * 255)), full_scale: 255 },
      representation: 'sdk-mapped-matrix', note: '手垫映射矩阵 · ADC 原始量纲' };
  }
  if (layout.type === 'regions') {
    if (stream.dtype !== 'uint8' || values.length !== 1024 || fullScale !== 255 || !Array.isArray(layout.regions) || layout.regions.length !== 10)
      fail('录制人体分区映射无效。');
    const ids = new Set(), mapped = new Set();
    const regions = layout.regions.map(region => {
      if (!region || typeof region.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(region.id) || ids.has(region.id) ||
          typeof region.name !== 'string' || !region.name.length || region.name.length > 80 ||
          !Number.isSafeInteger(region.rows) || region.rows < 1 || !Number.isSafeInteger(region.cols) || region.cols < 1 || region.rows * region.cols > 400)
        fail('录制人体分区形状无效。');
      ids.add(region.id);
      const source = indices(region.source_indices, region.rows * region.cols);
      for (const index of source) { if (mapped.has(index)) fail('录制人体分区源索引重复。'); mapped.add(index); }
      return { id: region.id, name: region.name, rows: region.rows, cols: region.cols, values: source.map(index => values[index]) };
    });
    if (mapped.size !== 400) fail('录制人体映射必须包含 400 个物理点。');
    return { pressure: { rows: 32, cols: 32, values, full_scale: fullScale, regions },
      representation: 'sdk-body-regions', note: '人体 10 个物理分区 · 400 点 · 保留 1024 通道原始 ADC' };
  }
  if (layout.type === 'points') {
    if (values.length !== 256 || !((stream.dtype === 'uint16' && fullScale === 4095) || (stream.dtype === 'uint8' && fullScale === 255)) ||
        !Array.isArray(layout.positions) || layout.positions.length !== 112) fail('录制鞋垫点位映射无效。');
    const source = indices(layout.source_indices, 112), cells = new Set();
    const points = layout.positions.map((position, i) => {
      if (!position || !Number.isSafeInteger(position.row) || position.row < 0 || position.row >= 14 ||
          !Number.isSafeInteger(position.col) || position.col < 0 || position.col >= 8 ||
          !Number.isFinite(position.x_mm) || Math.abs(position.x_mm) > 10000 || !Number.isFinite(position.y_mm) || Math.abs(position.y_mm) > 10000)
        fail('录制鞋垫点位坐标无效。');
      const cell = `${position.row}:${position.col}`;
      if (cells.has(cell)) fail('录制鞋垫点位坐标重复。');
      cells.add(cell);
      return { row: position.row, col: position.col, x_mm: position.x_mm, y_mm: position.y_mm, value: values[source[i]] };
    });
    return { pressure: { rows: 16, cols: 16, values, full_scale: fullScale, points },
      representation: 'sdk-insole-points', note: `鞋垫 112 个物理点 · ${fullScale === 4095 ? '12' : '8'} 位原始 ADC · 未插值或标定` };
  }
  fail('不支持的录制压力映射类型。');
}
function renderRecord(stream, index, record, origin, timeSeconds) {
  if (!record) return { available: false, note: '此时刻尚无已录制数据。' };
  const relative = Number(record.deviceNs - origin) / 1e9;
  const result = { available: true, timestamp_s: timeSeconds, relative_time_s: relative,
    sequence: record.sequence.toString(), device_time_ns: record.deviceNs.toString(),
    stale: timeSeconds - relative > Math.max(0.5, index.layout.rate > 0 ? 3 / index.layout.rate : 0.5), representation: 'recorded-sample', note: '' };
  const kind = stream.kind ?? stream.modality;
  const sampleIndex = index.layout.rate > 0 ? Math.min(record.sampleCount - 1, Math.max(0, Math.floor((timeSeconds - relative) * index.layout.rate))) : 0;
  if (kind === 'camera') {
    const shape = stream.shape;
    if (index.layout.variablePayload) {
      const camera = jpegPreview(record.payload, { width: shape[1], height: shape[0] }, record.sequence.toString());
      return { ...result, available: Boolean(camera.jpeg_base64), camera, representation: 'recorded-mjpeg',
        note: camera.jpeg_base64 ? '原始 MJPEG 帧；仅检查 JPEG 结构，像素解码由播放器完成。'
          : camera.preview_status === 'jpeg-too-large' ? '原始 JPEG 超过实时预览大小上限，数据仍完整保留。'
            : camera.preview_status === 'unsupported-jpeg' ? '此 JPEG 编码不支持浏览器预览，原始数据仍完整保留。'
            : '此条 JPEG 结构异常，原始数据已保留；不将损坏图像作为有效画面显示。' };
    }
    if (stream.dtype !== 'uint8' || shape.length !== 3 || shape[2] !== 3) fail('回放摄像头需要 RGB8 帧。');
    const sourceHeight = shape[0], sourceWidth = shape[1], scale = Math.min(1, 320 / sourceWidth, 240 / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
    const rgb = Buffer.alloc(width * height * 3);
    const start = sampleIndex * index.layout.elements;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = start + (Math.min(sourceHeight - 1, Math.floor(y / scale)) * sourceWidth + Math.min(sourceWidth - 1, Math.floor(x / scale))) * 3;
      record.payload.copy(rgb, (y * width + x) * 3, p, p + 3);
    }
    result.camera = { width, height, rgb_base64: rgb.toString('base64'), sequence: Number(record.sequence) };
    if (scale < 1) result.note = '回放预览已缩小，原始分辨率保留在文件中。';
  } else if (kind === 'audio') {
    const count = record.sampleCount * index.layout.elements, stride = Math.max(1, Math.ceil(count / 256));
    const waveform = []; let squared = 0;
    for (let i = 0; i < count; i++) {
      const value = stream.dtype === 'float32' ? record.payload.readFloatLE(i * 4)
        : stream.dtype === 'uint16' ? record.payload.readUInt16LE(i * 2) : record.payload[i];
      if (!Number.isFinite(value)) fail('音频包含非有限数值。');
      squared += value * value;
      if (i % stride === 0) waveform.push(value);
    }
    result.audio = { waveform, rms: Math.sqrt(squared / count) };
    result.note = '录制音频块波形；按原始时间戳定位。';
  } else {
    let values = valuesAt(record.payload, stream, index.layout.elements, sampleIndex * index.layout.elements);
    if (kind === 'pressure') {
      let rows = stream.rows ?? stream.shape[0], cols = stream.cols ?? stream.shape[1] ?? 1;
      let mapped = stream.adapter === 'shroom-sdk' ? savedPressureLayout(stream, values) : null;
      if (!mapped && stream.adapter === 'shroom-sdk' && stream.metadata?.product === 'glove'
        && stream.metadata?.sdk_version === '0.4.0' && ['left', 'right'].includes(stream.metadata?.side)
        && stream.dtype === 'uint8' && values.length === 256) {
        const glove = glovePreviewFromLayout(legacyGloveLayout040(stream.metadata.side), values, stream.metadata.side);
        mapped = { pressure: { rows: 16, cols: 16, values, full_scale: 255, glove }, representation: 'sdk-glove-regions',
          note: '旧录制按 SDK 0.4.0 固定点位映射重建 · 五指与手掌 137 点 · 保留 256 通道原始 ADC' };
      }
      if (mapped) {
        Object.assign(result, mapped);
      } else if (stream.adapter === 'shroom-sdk' && stream.metadata?.product === 'hand-pad' && stream.metadata?.sdk_version === '0.2.0' && values.length === 1024) {
        const decoded = decodeFrame(Uint8Array.from(values), { layout: 'mat32' });
        values = Array.from(decoded.values, value => Math.round(value * 255)); rows = decoded.rows; cols = decoded.cols;
        result.representation = 'sdk-mapped-matrix'; result.note = 'SDK 0.2.0 手垫映射矩阵 · ADC 原始量纲';
      } else if (stream.adapter === 'shroom-sdk' && stream.metadata?.product !== 'mock') {
        rows = Math.sqrt(values.length); if (!Number.isInteger(rows)) rows = 1;
        cols = values.length / rows;
        result.representation = 'raw-scan-order'; result.note = '原始扫描顺序，未恢复传感器空间映射。';
      }
      if (!mapped) {
        if (rows * cols !== values.length) { rows = 1; cols = values.length; result.note = '按原始通道顺序展示。'; result.representation = 'raw-scan-order'; }
        result.pressure = { rows, cols, values };
      }
    } else if (kind === 'imu' && stream.dtype === 'uint8') {
      result.raw = { values, encoding: 'unparsed-imu-bytes' }; result.note = 'IMU 原始字节，未进行六轴解码。';
    } else result.imu = { values };
  }
  if (result.stale) result.note = `${result.note} 游标附近没有新数据，显示最后有效采样。`.trim();
  return result;
}

export class ReplayReader {
  constructor({ dataDir, cacheSessions = 2, fastThreshold = 100000 } = {}) {
    this.dataDir = path.resolve(dataDir); this.cacheSessions = cacheSessions; this.fastThreshold = fastThreshold; this.cache = new Map(); this.indexBuilds = 0;
  }
  async frame(sessionId, timeSeconds) {
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) fail('回放时间必须是非负秒数。');
    const { folder, manifest, sourceManifest, issues = [], mediaValidation = {} } = await loadSession(this.dataDir, sessionId, { allowIncomplete: true });
    const incomplete = sourceManifest.status === 'incomplete';
    const duration = manifest.duration_s ?? manifest.duration_seconds;
    if (!Number.isFinite(duration) || duration < 0 || timeSeconds > duration + 0.000001) fail('回放时间超出录制范围。');
    if (sourceManifest.streams.length > MAX_STREAMS) fail('单次回放数据流过多，请分组导出分析。');
    let origin = 0n, originError;
    try { if (manifest.streams.length) origin = numberNs(manifest.session_start_device_time_ns, '会话时间起点'); }
    catch (error) { if (!incomplete) throw error; originError = error.message; }
    const signatureParts = [], pathErrors = {};
    for (const stream of manifest.streams) {
      try {
        const filename = await streamPath(folder, stream), info = await stat(filename);
        signatureParts.push([filename, info.size, info.mtimeMs, stream]);
      } catch (error) { if (!incomplete) throw error; pathErrors[stream.id] = error.message; }
    }
    const signature = JSON.stringify([incomplete, manifest.session_start_device_time_ns, signatureParts, pathErrors]);
    let cached = this.cache.get(sessionId);
    if (!cached || cached.signature !== signature) {
      const indexes = new Map(), errors = { ...pathErrors };
      for (const stream of manifest.streams) {
        if (errors[stream.id]) continue;
        try { indexes.set(stream.id, await buildIndex(folder, stream, { allowPartial: incomplete, fastThreshold: this.fastThreshold })); }
        catch (error) { if (!incomplete) throw error; errors[stream.id] = error.message; }
      }
      cached = { signature, indexes, errors }; this.indexBuilds++;
    }
    this.cache.delete(sessionId); this.cache.set(sessionId, cached);
    while (this.cache.size > this.cacheSessions) this.cache.delete(this.cache.keys().next().value);
    const target = origin + BigInt(Math.round(timeSeconds * Number(NS))), streams = {}, streamErrors = { ...cached.errors };
    const warnings = issues.map(issue => `${issue.id ?? issue.file ?? '附件'}：${issue.error}`);
    if (incomplete && sourceManifest.error) warnings.unshift(sourceManifest.error);
    if (incomplete && sourceManifest.dropped_records) warnings.push(`录制报告丢弃 ${sourceManifest.dropped_records} 条记录。`);
    for (const stream of sourceManifest.streams) {
      if (!stream?.id) continue;
      try {
        const index = cached.indexes.get(stream.id);
        if (originError) fail(originError);
        if (!index) fail(streamErrors[stream.id] ?? issues.find(issue => issue.id === stream.id)?.error ?? '数据流不可读取。');
        streams[stream.id] = renderRecord(stream, index, await recordAt(index, target), origin, timeSeconds);
        if (index.warning) {
          warnings.push(`${stream.name ?? stream.id}：${index.warning}`);
          streams[stream.id].note = `${streams[stream.id].note} ${index.warning}`.trim();
        }
      } catch (error) {
        if (!incomplete) throw error;
        streamErrors[stream.id] = error.message;
        streams[stream.id] = { available: false, error: error.message, note: '此路此时刻不可读取，其他可用数据仍可回放。' };
      }
    }
    const fileUrl = file => `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(file)}`;
    const media = (sourceManifest.media_streams ?? []).filter(source => source && typeof source.id === 'string').map(source => {
      const valid = manifest.media_streams?.find(item => item.id === source.id), validation = mediaValidation[source.id];
      if (!valid || validation?.playable === false) {
        const error = issues.find(issue => issue.id === source.id)?.error ?? validation?.error ?? source.error ?? '媒体不可播放；可导出原始附件检查。';
        streamErrors[source.id] = error;
        return { ...source, available: false, error, url: null, segments: [], offset_s: null, duration_s: null, alignment: 'unknown', note: error };
      }
      const stream = valid;
      const offset = (Date.parse(stream.started_at) - Date.parse(manifest.started_at)) / 1000;
      const known = Number.isFinite(offset);
      const segments = stream.segments ? (validation?.segments ?? stream.segments).map(segment => ({ ...segment,
        url: segment.available === false ? null : fileUrl(segment.file),
        offset_s: known && Number.isSafeInteger(segment.start_sample) && segment.start_sample >= 0 ? Math.max(0, offset) + segment.start_sample / stream.sample_rate : null,
        duration_s: Number.isSafeInteger(segment.sample_count) && segment.sample_count >= 0 ? segment.sample_count / stream.sample_rate : null })) : undefined;
      return { ...stream, available: true, url: segments?.find(segment => segment.url)?.url ?? fileUrl(stream.file), ...(segments ? { segments } : {}),
        offset_s: known ? Math.max(0, offset) : null, duration_s: Number.isFinite(stream.duration_ms) ? stream.duration_ms / 1000 : null,
        alignment: known ? 'approximate-wall-clock' : 'unknown', note: [known ? '浏览器时间估计对齐，非硬件同步。' : '缺少媒体开始时间，请使用独立媒体控制查看。',
          stream.error ? `已保存内容可播放；原录制异常：${stream.error}` : ''].filter(Boolean).join(' ') };
    });
    const validation = [...cached.indexes.values()].some(index => index.direct) ? 'on-demand-records' : 'full-index';
    if (validation === 'on-demand-records') warnings.push('长录制按游标校验记录；尚未全量检查文件，导出时会逐条校验。');
    return { session_id: sessionId, time_s: timeSeconds, duration_s: duration, streams, media_streams: media,
      incomplete, warnings: [...new Set(warnings)], stream_errors: streamErrors, validation };
  }
}
