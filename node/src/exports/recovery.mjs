import { loadSession, readRecords, SessionError, streamLayout, streamPath } from './reader.mjs';
import { readAnnotationDocument } from '../annotations.mjs';

const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const relative = (value, origin) => value === null || origin === null ? null : Number(BigInt(value) - origin) / 1e9;

/** Broken annotations are isolated, never silently repaired into a valid document. */
export async function readRecoveryAnnotations(dataDir, manifest, folder) {
  try { return { document: await readAnnotationDocument(dataDir, manifest), error: null, rawFile: null }; }
  catch (error) {
    const rawFile = await streamPath(folder, { file: 'annotations.json' }).catch(() => null);
    return { document: null, error: error.message, rawFile };
  }
}

/** Defaults to bounded metadata/head inspection; full prefix scanning is explicit and for exports only. */
export async function inspectRecoverySession({ dataDir, sessionId, scanRecords = false, loaded }, annotationSnapshot) {
  const session = loaded ?? await loadSession(dataDir, sessionId, { allowIncomplete: true });
  const { folder, sourceManifest: manifest, issues, binaryValidation, mediaValidation } = session;
  if (manifest.status !== 'incomplete') throw new SessionError('异常检查仅用于已停止且标为 incomplete 的录制。', 409);
  const annotationResult = annotationSnapshot === undefined ? await readRecoveryAnnotations(dataDir, manifest, folder)
    : annotationSnapshot?.document !== undefined || annotationSnapshot?.error ? annotationSnapshot : { document: annotationSnapshot, error: null };
  const annotations = annotationResult.document;
  const origin = typeof manifest.session_start_device_time_ns === 'string' && /^\d+$/.test(manifest.session_start_device_time_ns) ? BigInt(manifest.session_start_device_time_ns) : null;
  const warnings = ['此会话不完整；文件结构与计数自洽不代表信号质量合格，也不保证多设备同步或没有设备侧丢帧。',
    '不会恢复未写入、截断或无法验证的数据，不改变原始文件和会话状态。',
    scanRecords ? '只保留每路首个错误之前已逐条验证的完整记录，不跳过损坏位置猜测后续帧。' : '本次为文件路径、大小、文件头与清单检查；未逐条扫描记录，清单计数和时间范围尚未验证。导出时会验证有效记录前缀。'];
  if (manifest.error) warnings.push(`会话错误：${String(manifest.error).slice(0, 2000)}`);
  const dropped = nonnegative(manifest.dropped_records ?? manifest.dropped_batches);
  if (dropped) warnings.push(`采集服务记录丢弃 ${dropped} 个数据块；实际设备侧缺失可能更多。`);
  if (dropped === null) warnings.push('未记录可验证的采集服务丢弃计数。');
  if (annotationResult.error) warnings.push(`标注不可解析，原文件仅保留为附件：${annotationResult.error}`);
  for (const item of issues) warnings.push(`${item.id ?? item.file ?? item.scope}：${item.error}`);
  const duration = typeof manifest.duration_ns === 'string' && /^\d+$/.test(manifest.duration_ns) ? BigInt(manifest.duration_ns)
    : Number.isFinite(manifest.duration_s ?? manifest.duration_seconds) && (manifest.duration_s ?? manifest.duration_seconds) >= 0 ? BigInt(Math.round((manifest.duration_s ?? manifest.duration_seconds) * 1e9)) : null;
  const openAnnotations = annotations?.annotations.filter(item => item.end_ns === null).length ?? 0;
  const outsideAnnotations = duration === null ? null : annotations?.annotations.filter(item => BigInt(item.start_ns) > duration || item.end_ns !== null && BigInt(item.end_ns) > duration).length ?? 0;
  if (openAnnotations || outsideAnnotations || duration === null && annotations?.annotations.length) warnings.push(`标注未经修复，按原样保留：${openAnnotations} 个未结束区间，${outsideAnnotations === null ? '无法核验' : outsideAnnotations} 个越界标注。未结束区间的 CSV 结束时间与时长留空。`);
  const streams = [];
  for (const stream of manifest.streams) {
    const validation = binaryValidation[stream?.id], problem = issues.find(item => item.scope === 'binary' && item.id === stream?.id);
    const item = { id: stream?.id ?? 'invalid', name: stream?.name ?? stream?.id ?? '无效数据源', kind: stream?.kind ?? stream?.modality ?? 'unknown',
      available: Boolean(validation), validation: scanRecords ? 'prefix' : 'metadata', verified: false, counts_verified: false,
      records: validation ? nonnegative(stream.records) : 0, samples: validation ? nonnegative(stream.samples) : 0, payload_bytes: validation ? nonnegative(stream.payload_bytes) : 0,
      declared_records: nonnegative(stream?.records), declared_samples: nonnegative(stream?.samples), declared_payload_bytes: nonnegative(stream?.payload_bytes),
      file_bytes: validation?.bytes ?? null, valid_bytes: null, has_data: validation?.has_data ?? false,
      first_device_time_ns: null, last_device_time_ns: null, start_s: null, end_s: null, observed_span_s: null,
      nominal_sample_duration_s: null, record_sequence_gaps: null, error: problem?.error ?? validation?.error ?? stream?.error ?? null };
    if (scanRecords && validation) {
      const report = {}; for await (const record of readRecords(folder, stream, { allowPartial: true, report })) void record;
      Object.assign(item, report, { counts_verified: true, available: report.records > 0, has_data: report.records > 0 });
      item.start_s = relative(report.first_device_time_ns, origin); item.end_s = relative(report.last_device_time_ns, origin);
      item.observed_span_s = report.first_device_time_ns === null ? 0 : Number(BigInt(report.last_device_time_ns) - BigInt(report.first_device_time_ns)) / 1e9;
      const layout = streamLayout(stream); item.nominal_sample_duration_s = layout.irregular ? null : report.samples / layout.rate;
    }
    if (item.error) warnings.push(`${item.name}：${item.error}`);
    if (item.record_sequence_gaps && BigInt(item.record_sequence_gaps) > 0n) warnings.push(`${item.name}：记录序号存在 ${item.record_sequence_gaps} 个缺口；此计数不等同于硬件丢帧数。`);
    streams.push(item);
  }
  const mediaStreams = (manifest.media_streams ?? []).map(stream => {
    const checked = mediaValidation[stream?.id], error = issues.find(item => item.id === stream?.id && item.scope === 'media')?.error ?? checked?.error ?? stream?.error ?? null;
    return { id: stream?.id ?? 'invalid', name: stream?.name ?? stream?.id ?? '无效媒体', kind: stream?.kind, file: stream?.file,
      chunks: stream?.chunks, bytes: stream?.bytes, samples: stream?.kind === 'audio' ? checked?.verified_samples ?? 0 : null,
      duration_s: Number.isFinite(stream?.duration_ms) ? stream.duration_ms / 1000 : null, finalized: stream?.finalized, error,
      available: checked?.available ?? false, has_data: stream?.kind === 'audio' ? (checked?.verified_samples ?? 0) > 0 : Boolean(checked?.playable),
      segments: checked?.segments ?? [], attachment_only: checked?.attachment_only ?? true, playback_verified: false };
  });
  for (const media of mediaStreams) if (media.attachment_only) warnings.push(`${media.name}：媒体未完整收尾或无法验证，仅原样保留附件，不保证能够播放。${media.error ? ` ${media.error}` : ''}`);
  const hasData = streams.some(stream => stream.has_data) || mediaStreams.some(stream => stream.has_data);
  if (!hasData) warnings.push('所有数据流均无可导出的样本或媒体块。');
  return { schema_version: 2, session_id: sessionId, source_status: manifest.status, source_finalized: manifest.finalized,
    recovery: true, incomplete: true, checked_at: new Date().toISOString(), has_data: hasData,
    inspection_mode: scanRecords ? 'records' : 'metadata', fully_scanned: scanRecords, dropped_records: dropped,
    error: manifest.error ?? null, warnings: [...new Set(warnings)], issues, streams, media_streams: mediaStreams,
    annotations: { revision: annotations?.revision ?? null, count: annotations?.annotations.length ?? 0, open_intervals: openAnnotations, out_of_range: outsideAnnotations, available: Boolean(annotations), error: annotationResult.error },
    validation: scanRecords ? 'Binary records validated only through each first invalid record. Independently valid WAV segments retain original offsets. No reconstruction or signal-quality certification.' : 'Bounded metadata, path, size and header inspection only; binary record counts, sequence gaps and timestamps are not scanned or verified.' };
}
