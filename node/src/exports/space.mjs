import { open, stat, statfs } from 'node:fs/promises';
import { MAX_PAYLOAD, SessionError, streamLayout, streamPath } from './reader.mjs';

async function variableRecordCount(filename, stream, bytes, recovery) {
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const declaredConsistent = ['records', 'samples', 'payload_bytes'].every(key => validCount(stream[key]))
    && stream.records === stream.samples && 8 + stream.records * 32 + stream.payload_bytes === bytes;
  // readRecords enforces this record cap before yielding additional data, so the
  // finalized manifest is a safe staging bound without reading every image.
  if (!recovery) {
    if (!declaredConsistent) throw new SessionError('MJPEG 录制清单的记录数、样本数或文件字节数不一致，无法可靠估算导出空间。');
    return { records: stream.records, basis: 'finalized-manifest-and-file-size' };
  }
  // An incomplete manifest can under-count. Scan only 32-byte headers through
  // the first bad record, matching recovery's valid-prefix policy; skip JPEGs.
  const handle = await open(filename, 'r');
  try {
    const header = Buffer.alloc(32);
    const readAt = async (length, position) => {
      let count = 0;
      while (count < length) { const result = await handle.read(header, count, length - count, position + count); if (!result.bytesRead) break; count += result.bytesRead; }
      return count === length;
    };
    if (!await readAt(8, 0) || header.toString('ascii', 0, 8) !== 'MDAQBIN1') throw new SessionError('Invalid binary magic');
    let offset = 8, records = 0, previousSequence = -1n, previousTime = -1n;
    while (offset + 32 <= bytes && await readAt(32, offset)) {
      const sequence = header.readBigUInt64LE(0), time = header.readBigInt64LE(8), host = header.readBigInt64LE(16);
      const samples = header.readUInt32LE(24), payload = header.readUInt32LE(28);
      if (samples !== 1 || !payload || payload > MAX_PAYLOAD || offset + 32 + payload > bytes
        || sequence <= previousSequence || time < 0n || time < previousTime || host < 0n) break;
      records++; previousSequence = sequence; previousTime = time; offset += 32 + payload;
    }
    return { records, basis: 'recovery-header-prefix-scan' };
  } finally { await handle.close(); }
}

/** Conservative uncompressed peak bound; original assets are streamed directly into ZIP. */
export async function checkExportSpace({ folder, manifest, outputDir, format, recovery = false, spaceInfo = statfs }) {
  let assets = 0, generated = 0, originals = 0;
  const variableRecordCounts = [];
  for (const asset of manifest.assets ?? []) assets += (await stat(await streamPath(folder, asset))).size;
  for (const stream of manifest.streams) {
    const filename = await streamPath(folder, stream), bytes = (await stat(filename)).size; originals += bytes;
    if (format === 'json') continue;
    const layout = streamLayout(stream);
    // Size supplies a safe upper bound even when incomplete manifest counts are wrong.
    const samples = Math.floor(Math.max(0, bytes - 8) / (layout.elements * layout.size));
    let records = Math.floor(Math.max(0, bytes - 8) / (32 + layout.elements * layout.size));
    if (layout.variablePayload) {
      const counted = await variableRecordCount(filename, stream, bytes, recovery);
      records = counted.records; variableRecordCounts.push({ stream_id: stream.id, ...counted });
    }
    if ((stream.kind ?? stream.modality) === 'camera') generated += bytes * 2 + records * 2048;
    else if (format === 'npz') generated += bytes + records * 48 + 4096;
    else if ((stream.kind ?? stream.modality) === 'audio') generated += bytes + records * 160;
    else generated += samples * (layout.elements * 32 + 160);
  }
  // Conversion staging plus its archive coexist; NPZ has one additional temporary set.
  const required = Math.ceil((format === 'json' ? originals + assets : assets + generated * (format === 'npz' ? 3 : 2)) * 1.02) + 16 * 1024 * 1024;
  const info = await spaceInfo(outputDir), available = Number(info.bavail) * Number(info.bsize);
  if (!Number.isSafeInteger(required) || !Number.isFinite(available) || available < required)
    throw new SessionError(`导出磁盘空间不足：可用 ${(available / 1024 ** 3).toFixed(2)} GiB，按未压缩保守估算至少需 ${(required / 1024 ** 3).toFixed(2)} GiB。请选择有足够空间的导出目录或释放空间后重试；原录制未改变。`, 507);
  return { available_bytes: available, required_bytes: required, estimation: 'conservative-uncompressed-peak', recovery,
    ...(variableRecordCounts.length ? { variable_record_counts: variableRecordCounts } : {}) };
}
