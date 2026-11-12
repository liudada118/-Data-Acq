import { open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
export const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
export const MAX_PAYLOAD = 64 * 1024 * 1024;
export class SessionError extends Error { constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; } }
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const filenameValid = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,149}$/.test(value);
const packageBasenameValid = value => typeof value === 'string' && value.length > 0 && value.length <= 255
  && !/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u.test(value) && !/[. ]$/u.test(value)
  && value !== '.' && value !== '..'
  && !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(value);
const packagePathKey = value => value.replace(/\/$/, '').normalize('NFC').toLowerCase();
function packageRelativePathValid(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')) return false;
  const parts = (value.endsWith('/') ? value.slice(0, -1) : value).split('/');
  return parts.every(packageBasenameValid);
}
function mappedPackageFile(stream, fileMap) {
  if (fileMap === undefined) return stream.file;
  if (!Array.isArray(fileMap)) throw new SessionError('Invalid package file mapping');
  const sources = new Map(), targets = new Set();
  for (const entry of fileMap) {
    if (!entry || typeof entry !== 'object' || !packageRelativePathValid(entry.original_file) || !packageRelativePathValid(entry.file)
      || (entry.stream_id != null && (typeof entry.stream_id !== 'string' || !entry.stream_id)))
      throw new SessionError('Invalid package file mapping');
    const sourceKey = packagePathKey(entry.original_file), targetKey = packagePathKey(entry.file);
    if (sources.has(sourceKey) || targets.has(targetKey)) throw new SessionError('Ambiguous package file mapping');
    sources.set(sourceKey, entry); targets.add(targetKey);
  }
  const selected = sources.get(packagePathKey(stream.file));
  if (!selected) {
    if (targets.has(packagePathKey(stream.file))) throw new SessionError('Ambiguous package file mapping');
    return stream.file;
  }
  if (selected.original_file !== stream.file || !packageBasenameValid(selected.file)
    || (selected.stream_id != null && selected.stream_id !== (stream.id ?? stream.stream_id)))
    throw new SessionError('Package file mapping does not match this stream');
  return selected.file;
}
async function readHeader(handle, buffer) {
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (!result.bytesRead) break;
    bytesRead += result.bytesRead;
  }
  return bytesRead;
}
export function streamLayout(stream) {
  const size = { float32: 4, uint16: 2, uint8: 1 }[stream.dtype], shape = stream.shape, rate = stream.sample_rate ?? stream.sample_rate_hz;
  // MJPEG records contain one original compressed image, not shape.length RGB bytes.
  // Keep this detection self-contained: this file is shipped in raw export packages.
  const encoding = stream.encoding ?? stream.metadata?.encoding ?? stream.metadata?.pixel_format;
  const variablePayload = typeof encoding === 'string' && encoding.toLowerCase() === 'mjpeg';
  const irregular = stream.sample_rate_known === false && stream.irregular_timestamps === true && rate === 0;
  if (!size || !Array.isArray(shape) || !shape.length || shape.length > 8 || shape.some(n => !Number.isSafeInteger(n) || n < 1) || (!irregular && (!Number.isFinite(rate) || rate <= 0))) throw new SessionError('Invalid stream dtype, shape, or sampling rate');
  const elements = shape.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(elements) || elements * size > MAX_PAYLOAD) throw new SessionError('Stream shape is too large');
  if (variablePayload && ((stream.kind ?? stream.modality) !== 'camera' || stream.dtype !== 'uint8' || shape.length !== 3 || shape[2] !== 3)) throw new SessionError('MJPEG requires a camera stream with decoded RGB dimensions');
  return { size, shape, rate, elements, irregular, variablePayload };
}
export async function streamPath(folder, stream, { fileMap } = {}) {
  if (!filenameValid(stream.file)) throw new SessionError('Invalid stream filename');
  // Only an explicit export report map may introduce a Unicode package filename.
  // The original manifest and normal source-session filename validation stay intact.
  const filename = mappedPackageFile(stream, fileMap);
  const root = await realpath(folder), result = await realpath(path.join(root, filename)).catch(() => null);
  if (!result || path.dirname(result) !== root || !(await stat(result)).isFile()) throw new SessionError('Stream file missing or outside session directory');
  return result;
}
/** Constant-size checks only, without reading the sample payload. */
export async function inspectBinaryStream(folder, stream) {
  const layout = streamLayout(stream), filename = await streamPath(folder, stream), info = await stat(filename), handle = await open(filename, 'r');
  try {
    const header = Buffer.alloc(40), bytesRead = await readHeader(handle, header);
    if (bytesRead < 8 || header.toString('ascii', 0, 8) !== 'MDAQBIN1') throw new SessionError('Invalid binary magic');
    let warning = null, hasData = false;
    if (info.size > 8) {
      if (bytesRead < 40) warning = 'Truncated record header or payload';
      else { try { validateRecordHeader(header.subarray(8), layout, -1n, -1n); hasData = info.size >= 40 + header.readUInt32LE(36); } catch (error) { warning = error.message; } }
      if (!warning && !hasData) warning = 'Truncated record header or payload';
    }
    if (!['records', 'samples', 'payload_bytes'].every(key => nonnegative(stream[key]))) warning ??= 'Finalized stream counts are missing or invalid';
    else if (8 + stream.records * 32 + stream.payload_bytes !== info.size) warning ??= 'Stream byte count does not match finalized manifest';
    else if (layout.variablePayload ? stream.samples !== stream.records : stream.samples * layout.elements * layout.size !== stream.payload_bytes) warning ??= 'Stream samples do not match finalized manifest';
    return { available: true, bytes: info.size, has_data: hasData, error: warning, verified: false, counts_verified: false };
  } finally { await handle.close(); }
}
function audioMetadata(stream) {
  if (stream.format !== 'wav' || stream.encoding !== 'pcm_s16le' || stream.channels !== 1 || stream.bits_per_sample !== 16 || !Number.isInteger(stream.sample_rate) || stream.sample_rate < 8000 || stream.sample_rate > 384000) throw new SessionError('Invalid PCM WAV metadata');
}
export async function checkWave(folder, stream, segment) {
  audioMetadata(stream);
  if (!nonnegative(segment.sample_count) || !nonnegative(segment.payload_bytes) || segment.payload_bytes % 2 || segment.sample_count !== segment.payload_bytes / 2 || segment.bytes !== segment.payload_bytes + 44 || segment.bytes > 0xffffffff || segment.duration_ms !== segment.sample_count / stream.sample_rate * 1000) throw new SessionError('Invalid PCM WAV segment metadata');
  const filename = await streamPath(folder, segment), info = await stat(filename);
  if (info.size !== segment.bytes) throw new SessionError('Media byte count does not match finalized manifest');
  const handle = await open(filename, 'r');
  try {
    const h = Buffer.alloc(44), bytesRead = await readHeader(handle, h);
    if (bytesRead !== 44 || h.toString('ascii', 0, 4) !== 'RIFF' || h.readUInt32LE(4) !== segment.bytes - 8 || h.toString('ascii', 8, 12) !== 'WAVE' || h.toString('ascii', 12, 16) !== 'fmt ' || h.readUInt32LE(16) !== 16 || h.readUInt16LE(20) !== 1 || h.readUInt16LE(22) !== 1 || h.readUInt32LE(24) !== stream.sample_rate || h.readUInt32LE(28) !== stream.sample_rate * 2 || h.readUInt16LE(32) !== 2 || h.readUInt16LE(34) !== 16 || h.toString('ascii', 36, 40) !== 'data' || h.readUInt32LE(40) !== segment.payload_bytes) throw new SessionError('WAV header does not match finalized PCM metadata');
    return filename;
  } finally { await handle.close(); }
}
/** Each WAV is checked independently. A later good segment retains its original sample offset. */
export async function inspectMediaStream(folder, stream, { allowIncomplete = false, assets = [] } = {}) {
  const isAudio = stream?.kind === 'audio' && stream?.mode === 'browser-microphone';
  const mime = typeof stream?.mime_type === 'string' ? stream.mime_type.split(';')[0].trim().toLowerCase() : '';
  if (!stream || !SAFE_ID.test(stream.id ?? '') || typeof stream.finalized !== 'boolean' || (stream.error != null && typeof stream.error !== 'string') || !nonnegative(stream.chunks) || !nonnegative(stream.bytes) || !(isAudio ? ['audio/wav'] : ['video/webm', 'video/mp4']).includes(mime) || (!allowIncomplete && (!stream.finalized || stream.error || !stream.chunks || !stream.bytes))) throw new SessionError('Invalid or unfinished browser media');
  if (!isAudio) {
    if (!assets.some(asset => asset.file === stream.file && asset.role === 'browser-camera-video' && asset.stream_id === stream.id)) throw new SessionError('Invalid browser media asset');
    const file = await streamPath(folder, stream), actual = (await stat(file)).size;
    if (actual !== stream.bytes) throw new SessionError('Media byte count does not match finalized manifest');
    return { stream, segments: [], available: true, playable: stream.finalized && !stream.error && stream.bytes > 0, playback_verified: false, attachment_only: !stream.finalized || Boolean(stream.error) || !stream.chunks || !stream.bytes };
  }
  audioMetadata(stream);
  if (!allowIncomplete && (!nonnegative(stream.sample_count) || stream.sample_count < 1)) throw new SessionError('Invalid PCM WAV metadata');
  const segmented = stream.segments !== undefined;
  if (segmented && (!Array.isArray(stream.segments) || !stream.segments.length || stream.segments.length > 4096)) throw new SessionError('Invalid audio segments');
  const original = segmented ? stream.segments : [{ ...stream, index: 0, start_sample: 0 }];
  let expectedSample = 0, totalBytes = 0, totalPayload = 0, totalSamples = 0;
  const names = new Set(), segments = [], good = [];
  for (let index = 0; index < original.length; index++) {
    const segment = original[index]; let error = null;
    try {
      if (!segment || segment.index !== index || !nonnegative(segment.start_sample) || segment.start_sample !== expectedSample || !filenameValid(segment.file) || names.has(segment.file.toLowerCase()) || typeof segment.finalized !== 'boolean' || (segment.error != null && typeof segment.error !== 'string') || (!allowIncomplete && (!segment.finalized || segment.error))) throw new SessionError('Invalid or discontinuous audio segment');
      if (!assets.some(asset => asset.file === segment.file && asset.role === 'browser-microphone-audio' && asset.stream_id === stream.id)) throw new SessionError('Invalid browser media asset');
      await checkWave(folder, stream, segment); if (segment.sample_count > 0) good.push(segment);
    } catch (cause) { if (!allowIncomplete) throw cause; error = cause.message; }
    // Keep the original coordinates across unavailable files; never close gaps by concatenation.
    expectedSample = segment && nonnegative(expectedSample) && nonnegative(segment.sample_count) ? expectedSample + segment.sample_count : NaN;
    if (typeof segment?.file === 'string') names.add(segment.file.toLowerCase());
    totalBytes += Number(segment?.bytes); totalPayload += Number(segment?.payload_bytes); totalSamples += Number(segment?.sample_count);
    segments.push({ ...segment, available: !error, error: error ?? segment?.error ?? null, validation_error: error, attachment_only: Boolean(error), playback_verified: false });
  }
  const metadataError = stream.file !== original[0]?.file || stream.bytes !== totalBytes || stream.payload_bytes !== totalPayload || stream.sample_count !== totalSamples || stream.duration_ms !== totalSamples / stream.sample_rate * 1000 ? 'Audio segment totals do not match finalized manifest' : null;
  if (metadataError && !allowIncomplete) throw new SessionError(metadataError);
  return { stream: { ...stream, ...(segmented ? { segments: good } : {}) }, segments, available: good.length > 0, playable: good.some(item => item.sample_count > 0), attachment_only: !good.length, playback_verified: false, error: metadataError, verified_samples: good.reduce((sum, item) => sum + item.sample_count, 0), verified_payload_bytes: good.reduce((sum, item) => sum + item.payload_bytes, 0) };
}
export async function loadSession(dataDir, sessionId, { allowIncomplete = false } = {}) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) throw new SessionError('Invalid session id');
  const root = await realpath(dataDir), folder = await realpath(path.join(root, sessionId)).catch(() => null);
  if (!folder || path.dirname(folder) !== root) throw new SessionError('Session not found', 404);
  const manifestPath = await realpath(path.join(folder, 'manifest.json')).catch(() => null);
  if (!manifestPath || path.dirname(manifestPath) !== folder) throw new SessionError('Session manifest not found', 404);
  const info = await stat(manifestPath);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new SessionError('Invalid session manifest size');
  let sourceManifest;
  try { sourceManifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new SessionError('Invalid session manifest JSON'); }
  const recovering = allowIncomplete === true && sourceManifest.status === 'incomplete';
  if (sourceManifest.finalized !== true || (!['complete', 'completed'].includes(sourceManifest.status) && !recovering)) throw new SessionError('Only finalized, complete recordings can be exported');
  if (recovering && sourceManifest.id !== sessionId) throw new SessionError('Recovery manifest id does not match session directory');
  if (!Array.isArray(sourceManifest.streams) || (!sourceManifest.streams.length && !sourceManifest.media_streams?.length)) throw new SessionError('Session has no streams');
  const manifest = structuredClone(sourceManifest), issues = [], mediaValidation = {}, binaryValidation = {}, seen = new Set();
  // Keep this list self-contained: reader.mjs is also shipped as the standalone raw reader.
  const reserved = new Set(['manifest.json', 'schema.json', 'export_report.json', 'session_reader.mjs', 'read_data.md', 'annotations.json', 'annotations.csv', 'annotations.original.json', 'experiment.json', 'recovery_report.json', 'incomplete_recording.md', 'readme_数据说明.txt', '传感器文件对照表.csv', 'sensor_index.json']), files = new Set(reserved);
  const issue = (entry, scope, cause) => { if (!recovering) throw cause; issues.push({ id: entry?.id ?? entry?.stream_id ?? null, file: entry?.file ?? null, scope, error: cause.message }); };
  manifest.streams = [];
  for (const stream of sourceManifest.streams) {
    try {
      if (!stream || !SAFE_ID.test(stream.id ?? '') || seen.has(stream.id)) throw new SessionError('Invalid or duplicate stream id');
      seen.add(stream.id); streamLayout(stream);
      if (!filenameValid(stream.file)) throw new SessionError('Invalid stream filename');
      if (files.has(stream.file.toLowerCase())) throw new SessionError('Duplicate or reserved stream filename');
      files.add(stream.file.toLowerCase());
      for (const name of [stream.id, `${stream.id}.csv`, `${stream.id}.npz`]) { if (reserved.has(name.toLowerCase())) throw new SessionError('Stream id conflicts with an export metadata filename'); files.add(name.toLowerCase()); }
      await streamPath(folder, stream);
      if (recovering) binaryValidation[stream.id] = await inspectBinaryStream(folder, stream);
      manifest.streams.push(stream);
    } catch (cause) { issue(stream, 'binary', cause); }
  }
  if (sourceManifest.assets !== undefined && (!Array.isArray(sourceManifest.assets) || sourceManifest.assets.length > 32768)) throw new SessionError('Invalid session assets');
  manifest.assets = [];
  for (const asset of sourceManifest.assets ?? []) {
    try {
      if (!asset || !filenameValid(asset.file)) throw new SessionError('Invalid stream filename');
      if (files.has(asset.file.toLowerCase())) throw new SessionError('Duplicate or invalid session asset');
      files.add(asset.file.toLowerCase()); await streamPath(folder, asset); manifest.assets.push(asset);
    } catch (cause) { issue(asset, 'asset', cause); }
  }
  if (sourceManifest.media_streams !== undefined && (!Array.isArray(sourceManifest.media_streams) || sourceManifest.media_streams.length > 8)) throw new SessionError('Invalid media streams');
  manifest.media_streams = [];
  for (const stream of sourceManifest.media_streams ?? []) {
    try {
      if (!stream || !SAFE_ID.test(stream.id ?? '') || seen.has(stream.id)) throw new SessionError('Invalid or duplicate stream id');
      seen.add(stream.id);
      const result = await inspectMediaStream(folder, stream, { allowIncomplete: recovering, assets: manifest.assets }); mediaValidation[stream.id] = result;
      if (result.error) issues.push({ id: stream.id, file: stream.file, scope: 'media', error: result.error });
      for (const segment of result.segments) if (segment.validation_error) issues.push({ id: stream.id, file: segment.file, scope: 'segment', error: segment.validation_error });
      if (result.available) manifest.media_streams.push(result.stream);
    } catch (cause) { issue(stream, 'media', cause); }
  }
  return { folder, manifest: recovering ? manifest : sourceManifest, sourceManifest, issues, mediaValidation, binaryValidation };
}
function validateRecordHeader(header, layout, previousSequence, previousDevice) {
  const sequence = header.readBigUInt64LE(0), deviceNs = header.readBigInt64LE(8), hostNs = header.readBigInt64LE(16), sampleCount = header.readUInt32LE(24), byteCount = header.readUInt32LE(28);
  if (!sampleCount || byteCount > MAX_PAYLOAD || (layout.variablePayload ? sampleCount !== 1 || byteCount < 1 : byteCount !== sampleCount * layout.elements * layout.size)) throw new SessionError('Record payload does not match its declared shape');
  if (layout.irregular && sampleCount !== 1) throw new SessionError('Unknown-rate streams must have one sample per timestamped record');
  if (sequence <= previousSequence || deviceNs < 0n || deviceNs < previousDevice || hostNs < 0n) throw new SessionError('Invalid record sequence or timestamps');
  return { sequence, deviceNs, hostNs, sampleCount, byteCount };
}
/** Buffer small records in 4 MiB blocks, avoiding per-record fs.read calls. */
class BufferedReader {
  constructor(handle, limit = Infinity, report = {}) { this.handle = handle; this.limit = limit; this.position = 0; this.buffer = Buffer.alloc(0); this.offset = 0; this.report = report; this.report.io_reads = 0; }
  take(size) { if (this.buffer.length - this.offset < size) return undefined; const value = this.buffer.subarray(this.offset, this.offset + size); this.offset += size; return value; }
  async read(size, allowEof = false) {
    const value = this.take(size); if (value) return value;
    const remainder = this.buffer.subarray(this.offset), next = Buffer.allocUnsafe(Math.min(Math.max(4 * 1024 * 1024, size), remainder.length + Math.max(0, this.limit - this.position)));
    remainder.copy(next); let length = remainder.length;
    while (length < size && this.position < this.limit) { this.report.io_reads++; const { bytesRead } = await this.handle.read(next, length, Math.min(next.length - length, this.limit - this.position), this.position); if (!bytesRead) break; this.position += bytesRead; length += bytesRead; }
    this.buffer = next.subarray(0, length); this.offset = 0;
    if (length < size) { if (!length && allowEof) return null; throw new SessionError('Truncated record header or payload'); }
    return this.take(size);
  }
}
export async function* readRecords(folder, stream, { allowPartial = false, report = {}, maxBytes = Infinity, fileMap } = {}) {
  let handle; Object.assign(report, { records: 0, samples: 0, payload_bytes: 0, valid_bytes: 0, error: null, first_device_time_ns: null, last_device_time_ns: null, record_sequence_gaps: '0', verified: true });
  let previousSequence = -1n, previousDevice = -1n, gaps = 0n;
  try {
    const layout = streamLayout(stream); handle = await open(await streamPath(folder, stream, { fileMap }), 'r'); const reader = new BufferedReader(handle, maxBytes, report);
    if ((await reader.read(8)).toString('ascii') !== 'MDAQBIN1') throw new SessionError('Invalid binary magic'); report.valid_bytes = 8;
    for (;;) {
      const header = reader.take(32) ?? await reader.read(32, true); if (!header) break;
      if (!allowPartial && nonnegative(stream.records) && report.records >= stream.records) throw new SessionError('Stream records exceed finalized manifest');
      const fields = validateRecordHeader(header, layout, previousSequence, previousDevice), payload = reader.take(fields.byteCount) ?? await reader.read(fields.byteCount);
      if (previousSequence >= 0n) gaps += fields.sequence - previousSequence - 1n;
      previousSequence = fields.sequence; previousDevice = fields.deviceNs;
      report.records++; report.samples += fields.sampleCount; report.payload_bytes += payload.length; report.valid_bytes += 32 + payload.length; report.first_device_time_ns ??= fields.deviceNs.toString(); report.last_device_time_ns = fields.deviceNs.toString(); report.record_sequence_gaps = gaps.toString();
      yield { sequence: fields.sequence, deviceNs: fields.deviceNs, hostNs: fields.hostNs, sampleCount: fields.sampleCount, payload };
    }
    for (const key of ['records', 'samples', 'payload_bytes']) if (stream[key] !== undefined && stream[key] !== report[key]) throw new SessionError(`Stream ${key} does not match finalized manifest`);
  } catch (error) { report.error = error.message; if (!allowPartial) throw error; } finally { await handle?.close(); }
}
export function channelNames(stream) {
  const { elements, shape } = streamLayout(stream), names = stream.channel_names ?? stream.channels;
  if (Array.isArray(names) && names.length === elements && names.every(n => typeof n === 'string')) return names;
  return Array.from({ length: elements }, (_, i) => shape.length === 2 ? `r${Math.floor(i / shape[1]).toString().padStart(2, '0')}_c${(i % shape[1]).toString().padStart(2, '0')}` : `channel_${i.toString().padStart(3, '0')}`);
}
