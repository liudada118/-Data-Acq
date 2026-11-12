import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import archiver from 'archiver';
import { channelNames, loadSession, readRecords, SessionError, streamLayout, streamPath } from './reader.mjs';
import { exportFormats } from './formats.mjs';
import { readAnnotationDocument } from '../annotations.mjs';
import { inspectRecoverySession, readRecoveryAnnotations } from './recovery.mjs';
import { checkExportSpace } from './space.mjs';
import { buildPackageGuide, GUIDE_FILES } from './package-guide.mjs';
import { createPackageFileMap, mapPackagePath } from './package-names.mjs';
import { inspectJpeg } from '../plugins/mjpeg.mjs';

const json = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n');
const csvCell = value => '"' + String(value).replaceAll('"', '""') + '"';
const row = values => values.map(csvCell).join(',') + '\r\n';
const kindOf = stream => stream.kind ?? stream.modality;
// Spreadsheet applications evaluate formula-like text even in quoted CSV cells.
const safeText = value => /^[\s\u0000-\u001f]*[=+@-]/.test(String(value)) ? `'${value}` : value;
function seconds(ns) {
  const value = BigInt(ns), whole = value / 1000000000n, fraction = (value % 1000000000n).toString().padStart(9, '0');
  return `${whole}.${fraction}`;
}
function annotationCsv(document) {
  let content = row(['id', 'label_id', 'label', 'kind', 'onset_s', 'duration_s', 'start_ns', 'end_ns', 'stream_ids', 'note', 'source', 'revision']);
  for (const item of document.annotations) content += row([item.id, item.label_id, safeText(item.label_name), item.kind,
    seconds(item.start_ns), item.end_ns === null ? '' : seconds(BigInt(item.end_ns) - BigInt(item.start_ns)), item.start_ns, item.end_ns ?? '',
    JSON.stringify(item.stream_ids), safeText(item.note), safeText(item.source), document.revision]);
  return content;
}
function assertFinishedAnnotations(document, manifest) {
  if (!document.annotations.length) return;
  const duration = typeof manifest.duration_ns === 'string' && /^\d+$/.test(manifest.duration_ns)
    ? BigInt(manifest.duration_ns) : Number.isFinite(manifest.duration_s ?? manifest.duration_seconds)
      ? BigInt(Math.round((manifest.duration_s ?? manifest.duration_seconds) * 1e9)) : null;
  if (duration === null || duration < 0n) throw new SessionError('会话缺少有效时长，无法校验标注。');
  for (const item of document.annotations) if (item.end_ns === null || BigInt(item.start_ns) > duration || BigInt(item.end_ns) > duration)
    throw new SessionError('存在未结束或超出录制范围的标注，请在回放中修复后再导出。', 409);
}

export async function zipDirectory(directory, output, sourceFiles = [], fileMap = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  await new Promise((resolve, reject) => {
    const sink = createWriteStream(output, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 1 } });
    let failure;
    function fail(error) {
      if (failure) return;
      failure = error; archive.abort(); sink.destroy();
    }
    // Close the destination before rejecting so Windows can remove partial files.
    sink.once('close', () => { if (failure) reject(failure); else resolve(); });
    sink.once('error', fail); archive.once('error', fail); archive.once('warning', fail);
    archive.pipe(sink);
    // Archive aliases keep recording files and conversion staging untouched.
    for (const entry of entries) {
      if (entry.isDirectory()) archive.directory(path.join(directory, entry.name), mapPackagePath(`${entry.name}/`, fileMap).replace(/\/$/, ''));
      else archive.file(path.join(directory, entry.name), { name: mapPackagePath(entry.name, fileMap) });
    }
    for (const source of sourceFiles) archive.file(source.path, { name: mapPackagePath(source.name, fileMap) });
    archive.finalize().catch(fail);
  });
}

async function csvStream(folder, stream, target, readOptions) {
  const handle = await open(target, 'wx');
  const { elements, rate, size } = streamLayout(stream);
  try {
    await handle.writeFile(row(['sequence', 'sample_index_in_record', 'sample_device_time_ns', 'record_device_time_ns', 'record_host_time_ns', ...channelNames(stream)]));
    let pending = '';
    for await (const record of readRecords(folder, stream, readOptions)) {
      for (let i = 0; i < record.sampleCount; i++) {
        const values = Array.from({ length: elements }, (_, j) => stream.dtype === 'float32'
          ? record.payload.readFloatLE((i * elements + j) * size) : stream.dtype === 'uint16'
            ? record.payload.readUInt16LE((i * elements + j) * size) : record.payload[i * elements + j]);
        const sampleTime = i === 0 ? record.deviceNs : record.deviceNs + BigInt(Math.round(i * 1e9 / rate));
        pending += row([record.sequence, i, sampleTime, record.deviceNs, record.hostNs, ...values]);
        if (pending.length >= 128 * 1024) { await handle.writeFile(pending); pending = ''; }
      }
    }
    if (pending) await handle.writeFile(pending);
  } finally { await handle.close(); }
}

async function audioStream(folder, stream, directory, readOptions) {
  const { elements: channels, rate } = streamLayout(stream);
  if (stream.dtype !== 'float32' || !Number.isInteger(rate) || rate <= 0 || rate > 384000 || channels > 32)
    throw new SessionError('WAV requires float32 audio, integer rate up to 384kHz and at most 32 channels');
  await mkdir(directory, { recursive: true });
  const wave = await open(path.join(directory, 'audio.wav'), 'wx');
  let index;
  try {
    index = await open(path.join(directory, 'blocks.csv'), 'wx');
    const header = Buffer.alloc(58);
    header.write('RIFF', 0); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(18, 16);
    header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * channels * 4, 28); header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
    header.write('fact', 38); header.writeUInt32LE(4, 42); header.write('data', 50);
    await wave.writeFile(header);
    await index.writeFile(row(['sequence', 'record_device_time_ns', 'record_host_time_ns', 'sample_count', 'sample_offset']));
    let samples = 0, bytes = 0;
    for await (const record of readRecords(folder, stream, readOptions)) {
      bytes += record.payload.length;
      if (bytes > 0xffffffff - 58) throw new SessionError('WAV exceeds RIFF 4GiB limit; use NPZ or raw JSON package');
      await wave.writeFile(record.payload);
      await index.writeFile(row([record.sequence, record.deviceNs, record.hostNs, record.sampleCount, samples]));
      samples += record.sampleCount;
    }
    header.writeUInt32LE(50 + bytes, 4); header.writeUInt32LE(samples, 46); header.writeUInt32LE(bytes, 54);
    await wave.write(header, 0, header.length, 0);
  } finally { await wave.close(); if (index) await index.close(); }
}

const crcTable = Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let j = 0; j < 8; j++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function pngChunk(type, payload) {
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length, 0); result.write(type, 4, 4, 'ascii'); payload.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, 8 + payload.length)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.length);
  return result;
}
function encodePng(rgb, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) rgb.copy(scanlines, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 1 })), pngChunk('IEND', Buffer.alloc(0))]);
}
async function cameraStream(folder, stream, directory, readOptions) {
  const { shape, elements, variablePayload } = streamLayout(stream);
  if (stream.dtype !== 'uint8' || shape.length !== 3 || shape[2] !== 3) throw new SessionError('PNG export requires RGB8 camera frames');
  await mkdir(directory, { recursive: true });
  const index = await open(path.join(directory, 'frames.csv'), 'wx');
  try {
    const columns = ['filename', 'sequence', 'sample_index_in_record', 'record_device_time_ns', 'record_host_time_ns'];
    if (variablePayload) columns.push('encoding', 'original_payload_bytes', 'jpeg_structure_status', 'jpeg_structure_issues', 'pixel_decode_verified');
    await index.writeFile(row(columns));
    let frameIndex = 0;
    for await (const record of readRecords(folder, stream, readOptions)) for (let i = 0; i < record.sampleCount; i++) {
      const filename = `frame_${String(frameIndex++).padStart(8, '0')}.${variablePayload ? 'jpg' : 'png'}`;
      const values = [filename, record.sequence, i, record.deviceNs, record.hostNs];
      if (variablePayload) {
        const jpeg = inspectJpeg(record.payload, { width: shape[1], height: shape[0] });
        // Preserve every recorded payload verbatim, including malformed JPEGs for diagnosis.
        await writeFile(path.join(directory, filename), record.payload);
        values.push('mjpeg', record.payload.length, jpeg.status, jpeg.issues.join('; '), false);
        const quality = readOptions.report.jpeg_structure ??= { checked: 0, invalid: 0, warning: 0, pixel_decode_verified: false };
        quality.checked++; if (jpeg.status !== 'ok') quality[jpeg.status]++;
      } else await writeFile(path.join(directory, filename), encodePng(record.payload.subarray(i * elements, (i + 1) * elements), shape[1], shape[0]));
      await index.writeFile(row(values));
    }
  } finally { await index.close(); }
}

function npyHeader(descr, shape) {
  const dimensions = shape.length === 1 ? `${shape[0]},` : shape.join(', ');
  const dictionary = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${dimensions}), }`;
  const padding = Math.max(256, Math.ceil((10 + dictionary.length + 1) / 64) * 64) - 10 - dictionary.length - 1;
  const text = Buffer.from(dictionary + ' '.repeat(padding) + '\n', 'ascii');
  const prefix = Buffer.from([0x93, 78, 85, 77, 80, 89, 1, 0, 0, 0]);
  prefix.writeUInt16LE(text.length, 8);
  return Buffer.concat([prefix, text]);
}
async function npzStream(folder, stream, directory, target, readOptions = {}) {
  if (!readOptions.allowPartial && (!Number.isSafeInteger(stream.samples) || stream.samples < 0 || !Number.isSafeInteger(stream.records) || stream.records < 0))
    throw new SessionError('NPZ export requires finalized sample and record counts');
  await mkdir(directory);
  const files = new Map();
  try {
    for (const [name, dtype, shape] of [
      ['data', { float32: '<f4', uint16: '<u2', uint8: '|u1' }[stream.dtype], [0, ...stream.shape]],
      ['sequence', '<u8', [0]], ['record_device_time_ns', '<i8', [0]],
      ['record_host_time_ns', '<i8', [0]], ['sample_count', '<u8', [0]], ['sample_offset', '<u8', [0]],
    ]) {
      const handle = await open(path.join(directory, `${name}.npy`), 'wx'); files.set(name, { handle, dtype, pending: [], bytes: 0 });
      await handle.writeFile(npyHeader(dtype, shape));
    }
    const append = (name, buffer) => { const file = files.get(name); file.pending.push(buffer); file.bytes += buffer.length; };
    const flush = async file => { if (file.bytes) { await file.handle.writeFile(Buffer.concat(file.pending, file.bytes)); file.pending = []; file.bytes = 0; } };
    let sampleOffset = 0n, count = 0;
    for await (const record of readRecords(folder, stream, readOptions)) {
      append('data', record.payload);
      const fields = [['sequence', record.sequence], ['record_device_time_ns', record.deviceNs], ['record_host_time_ns', record.hostNs],
        ['sample_count', BigInt(record.sampleCount)], ['sample_offset', sampleOffset]];
      for (const [name, value] of fields) {
        const buffer = Buffer.alloc(8);
        if (name.includes('time_ns')) buffer.writeBigInt64LE(value); else buffer.writeBigUInt64LE(value);
        append(name, buffer);
      }
      sampleOffset += BigInt(record.sampleCount);
      count++;
      for (const file of files.values()) if (file.bytes >= 128 * 1024) await flush(file);
    }
    for (const [name, file] of files) {
      await flush(file);
      const header = npyHeader(file.dtype, name === 'data' ? [Number(sampleOffset), ...stream.shape] : [count]);
      await file.handle.write(header, 0, header.length, 0);
    }
  } finally { await Promise.all([...files.values()].map(file => file.handle.close())); }
  const metadata = Buffer.from(JSON.stringify({ ...stream, ...(readOptions.allowPartial ? { records: readOptions.report.records, samples: readOptions.report.samples, payload_bytes: readOptions.report.payload_bytes, recovered_prefix: true } : {}) }), 'utf8');
  await writeFile(path.join(directory, 'metadata_json_utf8.npy'), Buffer.concat([npyHeader('|u1', [metadata.length]), metadata]));
  await zipDirectory(directory, target);
  await rm(directory, { recursive: true });
}

export async function exportSession({ dataDir, sessionId, format, outputFile, recovery = false, spaceInfo }, progress = () => {}) {
  if (!exportFormats().some(item => item.id === format && item.available)) throw new SessionError('Export format is unavailable in the Node prototype');
  if (typeof recovery !== 'boolean') throw new SessionError('Recovery must be an explicit boolean');
  const loaded = await loadSession(dataDir, sessionId, { allowIncomplete: recovery });
  const { folder, manifest, sourceManifest, mediaValidation } = loaded;
  // Exactly one atomic document read: all annotation outputs describe this revision,
  // even when the user edits labels while the raw data is being converted.
  const annotationResult = recovery ? await readRecoveryAnnotations(dataDir, sourceManifest, folder)
    : { document: await readAnnotationDocument(dataDir, manifest), error: null, rawFile: null };
  const annotations = annotationResult.document;
  const recoveryReport = recovery ? await inspectRecoverySession({ dataDir, sessionId, loaded }, annotationResult) : null;
  if (recoveryReport && !recoveryReport.has_data) throw new SessionError('异常录制没有可验证的样本或媒体块，无法生成数据包。', 409);
  if (!recovery) assertFinishedAnnotations(annotations, manifest);
  await mkdir(path.dirname(outputFile), { recursive: true });
  const space = await checkExportSpace({ folder, manifest, outputDir: path.dirname(outputFile), format, recovery, ...(spaceInfo ? { spaceInfo } : {}) });
  const directory = await mkdtemp(path.join(path.dirname(outputFile), '.export-'));
  const partial = `${outputFile}.partial`;
  const report = {
    schema_version: 1, session_id: sessionId, format, source: manifest.source ?? 'unknown',
    recovery, incomplete: recovery, source_status: manifest.status,
    ...(recoveryReport ? { recovery_report: 'recovery_report.json', warnings: recoveryReport.warnings } : {}),
    timestamp_policy: 'Original record timestamps retained exactly. CSV offsets within multi-sample blocks use nominal sample rate. Unknown-rate irregular streams retain one sample per original timestamp. No resampling or cross-device synchronization.',
    audio_encoding: 'Raw float32 audio streams become IEEE float32 WAV. Browser microphone assets preserve captured PCM16LE samples in original WAV containers; duration is derived from sample count and AudioContext sample rate.', camera_encoding: 'RGB8 streams become PNG. MJPEG streams preserve each original compressed payload as JPG with frames.csv timestamps and JPEG structure status; malformed payloads are retained, never decoded, repaired or presented as verified pixels. Browser video assets preserve original MediaRecorder WebM/MP4 bytes without transcoding or invented frame timestamps.',
    array_layout: 'sample-first, C row-major, little-endian',
    npz_metadata: 'metadata_json_utf8 is a uint8 array; decode with .tobytes().decode("utf-8")', streams: [],
    annotation_revision: annotations?.revision ?? null, annotation_count: annotations?.annotations.length ?? 0,
    annotation_error: annotationResult.error, space_estimate: space, source_assets_streamed: true,
    annotation_time_basis: 'start_ns/end_ns are exact decimal nanoseconds relative to the recording start. CSV onset_s/duration_s use the same origin; no resampling.',
    annotation_snapshot_at: new Date().toISOString(),
    annotation_csv_text: 'Formula-like label/note text is prefixed with an apostrophe for spreadsheet safety; annotations.json preserves the exact text.',
  };
  const sourceFiles = [], exportedStreams = [];
  try {
    await copyFile(path.join(folder, 'manifest.json'), path.join(directory, 'manifest.json'));
    if (recoveryReport) {
      await writeFile(path.join(directory, 'INCOMPLETE_RECORDING.md'), '# 不完整录制数据包 / INCOMPLETE RECORDING\n\n此包来自已停止但不完整的录制，不得当作完整或质量合格的数据集。\n原始 manifest 与源数据不作修复或改写。格式转换只包含每路第一个错误之前验证通过的完整记录；不补零、不跨坏记录猜测。\n原始数据包可能包含坏尾/未收尾媒体，仅供诊断，不保证能够播放。WAV 分段保留原 start_sample，缺失段不拼平。\n坏标注以 annotations.original.json 附件保留，不生成虚构标注。\n\n各路有效样本数、有效字节前缀、缺失段与跳过文件见 recovery_report.json 和 export_report.json。\n', 'utf8');
    }
    if (annotations) {
      await json(path.join(directory, 'annotations.json'), annotations);
      await json(path.join(directory, 'experiment.json'), { schema_version: 1, session_id: sessionId,
        annotation_revision: annotations.revision, experiment: annotations.experiment, labels: annotations.labels });
      await writeFile(path.join(directory, 'annotations.csv'), '\ufeff' + annotationCsv(annotations), 'utf8');
    } else if (annotationResult.rawFile) sourceFiles.push({ path: annotationResult.rawFile, name: 'annotations.original.json' });
    for (let index = 0; index < manifest.streams.length; index++) {
      const stream = manifest.streams[index], kind = kindOf(stream);
      const verified = {}, readOptions = { allowPartial: recovery, report: verified };
      try { if (format === 'json') {
        for await (const ignored of readRecords(folder, stream, readOptions)) { void ignored; }
        sourceFiles.push({ path: await streamPath(folder, stream), name: stream.file });
      } else if (kind === 'camera') await cameraStream(folder, stream, path.join(directory, stream.id), readOptions);
      else {
        if (kind === 'audio') await audioStream(folder, stream, path.join(directory, stream.id), readOptions);
        if (format === 'npz') await npzStream(folder, stream, path.join(directory, `.npy-${stream.id}`), path.join(directory, `${stream.id}.npz`), readOptions);
        else if (kind !== 'audio') await csvStream(folder, stream, path.join(directory, `${stream.id}.csv`), readOptions);
      } } catch (error) {
        if (!recovery || !(error instanceof SessionError)) throw error;
        Object.assign(verified, { records: 0, samples: 0, payload_bytes: 0, valid_bytes: 0, error: error.message });
        await rm(path.join(directory, `.npy-${stream.id}`), { recursive: true, force: true });
      }
      if (recovery) {
        const item = recoveryReport.streams.find(item => item.id === stream.id);
        Object.assign(item, verified, { validation: 'prefix', counts_verified: true, available: verified.records > 0, has_data: verified.records > 0 });
        if (verified.error) recoveryReport.warnings.push(`${stream.name ?? stream.id}：${verified.error}；仅使用已验证前缀 ${verified.records} 条记录。`);
        if (!verified.records && format !== 'json') for (const target of [stream.id, `${stream.id}.csv`, `${stream.id}.npz`])
          await rm(path.join(directory, target), { recursive: true, force: true });
      }
      if (verified.records) exportedStreams.push(recovery ? { ...stream, records: verified.records, samples: verified.samples, payload_bytes: verified.payload_bytes, recovered_prefix: true } : stream);
      report.streams.push({ id: stream.id, kind, samples: verified.samples, records: verified.records, payload_bytes: verified.payload_bytes,
        valid_bytes: verified.valid_bytes, error: verified.error, skipped: !verified.records, raw_original: format === 'json', shape: stream.shape,
        ...(verified.jpeg_structure ? { jpeg_structure: verified.jpeg_structure } : {}) });
      progress((index + 1) / (manifest.streams.length + 1));
    }
    const includedAssets = [], skippedAssets = [];
    for (const asset of manifest.assets ?? []) {
      const media = mediaValidation[asset.stream_id];
      const mediaAsset = ['browser-microphone-audio', 'browser-camera-video'].includes(asset.role);
      const usable = media?.segments.length ? media.segments.some(segment => segment.file === asset.file && segment.available && segment.sample_count > 0) : media?.playable;
      if (recovery && format !== 'json' && mediaAsset && !usable) { skippedAssets.push({ ...asset, reason: 'Media file or segment failed validation / was not finalized' }); continue; }
      sourceFiles.push({ path: await streamPath(folder, asset), name: asset.file }); includedAssets.push(asset);
    }
    report.assets = includedAssets; report.skipped_assets = skippedAssets;
    report.media_streams = manifest.media_streams ?? [];
    if (format === 'json') {
      await copyFile(new URL('./reader.mjs', import.meta.url), path.join(directory, 'session_reader.mjs'));
      await writeFile(path.join(directory, 'READ_DATA.md'), '# Read raw data with Node.js 22+\n\n```js\nimport { readRecords } from "./session_reader.mjs";\nimport { readFile } from "node:fs/promises";\nconst manifest = JSON.parse(await readFile("./manifest.json", "utf8"));\nconst report = JSON.parse(await readFile("./export_report.json", "utf8"));\nfor (const stream of manifest.streams) {\n  for await (const record of readRecords(process.cwd(), stream, { fileMap: report.file_mapping, allowPartial: report.recovery === true })) {\n    // sequence, deviceNs, hostNs are BigInt; payload contains original bytes.\n    console.log(stream.id, record.sequence.toString(), record.payload.length);\n  }\n}\n```\n\nUse stream.dtype and stream.shape to interpret uncompressed numeric samples (little-endian). For camera encoding=mjpeg, each record contains one original JPEG image with variable byte length; shape describes decoded RGB dimensions, never the compressed byte count. Preserve malformed JPEG records for diagnosis; a readable binary record does not guarantee successful image decoding. The original binary format is mdaqbin-v1, not JSON sample arrays. Exported filenames use sensor names; report.file_mapping maps the unchanged manifest filenames to the package files. Original stream IDs remain available for annotations.\n');
    }
    if (recoveryReport) {
      Object.assign(recoveryReport, { inspection_mode: 'records', fully_scanned: true,
        has_data: recoveryReport.streams.some(item => item.has_data) || recoveryReport.media_streams.some(item => item.has_data),
        validation: 'Each available binary source was scanned through its first invalid record using buffered I/O. Only verified records were converted. WAV segments were independently header/size checked; offsets and gaps preserved. No reconstruction.' });
      if (!recoveryReport.has_data) throw new SessionError('异常录制没有可验证的样本或媒体块，无法生成数据包。', 409);
      recoveryReport.warnings = [...new Set(recoveryReport.warnings)]; report.warnings = recoveryReport.warnings;
      await json(path.join(directory, 'recovery_report.json'), recoveryReport);
    }
    report.package_guide = { ...GUIDE_FILES };
    // Describe the files actually included, not every file named by the source manifest.
    // Keep frame directories grouped so a long video does not expand the guide per frame.
    const entries = await readdir(directory, { withFileTypes: true });
    const audioDirectories = new Set(exportedStreams.filter(stream => kindOf(stream) === 'audio').map(stream => stream.id));
    const generatedFiles = (await Promise.all(entries.map(async entry => {
      if (entry.isDirectory() && audioDirectories.has(entry.name)) {
        const children = await readdir(path.join(directory, entry.name));
        return children.map(child => `${entry.name}/${child}`);
      }
      return [entry.name + (entry.isDirectory() ? '/' : '')];
    }))).flat();
    const packageFiles = [
      ...generatedFiles,
      ...sourceFiles.map(source => source.name), ...Object.values(GUIDE_FILES), 'schema.json', 'export_report.json',
    ];
    const fileMap = createPackageFileMap({ manifest: sourceManifest, format, files: packageFiles });
    const exportFilesFor = stream => fileMap.filter(item => item.stream_id === stream.id).map(item => item.file);
    const withExportPaths = stream => ({ ...stream, export_files: exportFilesFor(stream),
      export_file: fileMap.find(item => item.original_file === stream.file)?.file ?? null,
      ...(Array.isArray(stream.segments) ? { segments: stream.segments.map(segment => ({ ...segment,
        export_file: fileMap.find(item => item.original_file === segment.file)?.file ?? null })) } : {}),
    });
    report.file_mapping = fileMap;
    report.filename_policy = 'Sensor names, side and modality identify exported files. Original manifest and stream IDs are preserved; use file_mapping / export_files to resolve package paths.';
    report.streams = report.streams.map(stream => ({ ...stream, export_files: exportFilesFor(stream) }));
    report.assets = includedAssets.map(asset => ({ ...asset, export_file: fileMap.find(item => item.original_file === asset.file)?.file ?? null }));
    report.media_streams = (manifest.media_streams ?? []).map(withExportPaths);
    await json(path.join(directory, 'schema.json'), { binary: manifest.binary, clock: manifest.clock,
      streams: exportedStreams.map(withExportPaths), media_streams: report.media_streams, file_mapping: fileMap });
    await json(path.join(directory, 'export_report.json'), report);
    const guide = buildPackageGuide({ manifest: sourceManifest, format, report, fileMap,
      files: packageFiles.map(file => mapPackagePath(file, fileMap)),
    });
    await writeFile(path.join(directory, GUIDE_FILES.readme), guide.readme, 'utf8');
    await writeFile(path.join(directory, GUIDE_FILES.csv), guide.csv, 'utf8');
    await json(path.join(directory, GUIDE_FILES.index), guide.index);
    await zipDirectory(directory, partial, sourceFiles, fileMap);
    await rename(partial, outputFile);
    progress(1);
    return report;
  } catch (error) {
    if (error.code === 'ENOSPC') throw new SessionError('导出磁盘空间已耗尽，任务已停止，临时文件会清理；原始录制未改变。请释放空间后重试。', 507);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(partial, { force: true });
  }
}
