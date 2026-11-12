/** Human-readable package inventory. Reads metadata only; never touches source payloads. */
export const GUIDE_FILES = Object.freeze({
  readme: 'README_数据说明.txt', csv: '传感器文件对照表.csv', index: 'sensor_index.json',
});

const list = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
const string = value => typeof value === 'string' ? value : null;
// Recovery may retain a rejected descriptor. Never invoke untrusted object coercion.
const text = value => value == null ? '' : ['string', 'number', 'boolean', 'bigint'].includes(typeof value)
  ? String(value).replace(/[\r\n\u0000-\u001f]/g, ' ') : '无效元信息';
const kind = stream => string(stream.kind) ?? string(stream.modality) ?? '';
const cell = value => {
  const result = text(value);
  return '"' + (/^[\s\u0000-\u001f]*[=+@-]/.test(result) ? "'" : '') + result.replaceAll('"', '""') + '"';
};
const csvRow = values => values.map(cell).join(',') + '\r\n';
const productNames = { body: '人体全身', glove: '触觉手套', insole: '鞋垫', 'hand-pad': '压力阵列', mock: 'SDK 模拟传感器' };
const fileNotes = {
  'manifest.json': '原始录制清单：设备、数据形状、原始文件名、时间与状态。转换后的文件名请以本对照表为准。',
  'schema.json': '本次导出可用数据流的结构与媒体元信息。',
  'export_report.json': '导出格式、每路样本与记录数、跳过文件和异常说明。',
  'recovery_report.json': '不完整录制的逐流检查结果、有效前缀与缺失文件。',
  'INCOMPLETE_RECORDING.md': '不完整数据包使用说明。',
  'experiment.json': '本次采集任务、对象与标签定义。',
  'annotations.json': '动作与事件标注，包含精确纳秒时间和关联数据流。',
  'annotations.csv': '动作与事件标注的表格形式。',
  'annotations.original.json': '未能读取的原始标注附件，仅供检查。',
  'session_reader.mjs': 'Node.js 原始二进制数据读取模块。',
  'READ_DATA.md': '原始二进制数据读取示例。',
  [GUIDE_FILES.readme]: '本数据包阅读说明与传感器文件速查。',
  [GUIDE_FILES.csv]: '可用 Excel / WPS 打开的传感器与文件对照表（UTF-8 BOM）。',
  [GUIDE_FILES.index]: '程序可读取的传感器、文件与音频分段索引。',
};

function paths(files) {
  return [...new Set((files ?? []).map(file => {
    if (typeof file !== 'string') throw new TypeError('Package guide files must be relative path strings');
    const normalized = file.replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
      || normalized.split('/').some(part => part === '..' || part === '.') || /[\u0000-\u001f]/.test(normalized))
      throw new TypeError('Invalid package guide relative path');
    return normalized;
  }))];
}

export function sourceInfo(stream, streams) {
  const metadata = stream.metadata ?? {}, product = string(metadata.product) ?? string(stream.product);
  const encoding = stream.encoding ?? metadata.encoding ?? metadata.pixel_format;
  const side = string(metadata.side) ?? string(stream.side);
  const sideLabel = side === 'left' ? (product === 'insole' ? '左脚' : product === 'glove' ? '左手' : '左侧')
    : side === 'right' ? (product === 'insole' ? '右脚' : product === 'glove' ? '右手' : '右侧') : text(side);
  const instanceId = string(metadata.instance_id);
  const sourcePorts = instanceId
    ? [...new Set(streams.filter(item => item.metadata?.instance_id === instanceId)
      .map(item => string(item.metadata?.port) ?? string(item.port)).filter(Boolean))] : [];
  const directPort = string(metadata.port) ?? string(stream.port);
  const port = directPort || (sourcePorts.length === 1 ? sourcePorts[0] : null);
  const sensor = (Object.hasOwn(productNames, product) ? productNames[product] : null)
    ?? (kind(stream) === 'camera' ? '摄像头' : kind(stream) === 'audio' ? '麦克风' : string(stream.name) ?? string(stream.id) ?? '未识别传感器');
  const rawImu = kind(stream) === 'imu' && (metadata.parsed === false || metadata.encoding === 'unparsed-imu-bytes' || stream.unit === 'raw-byte');
  const dataType = kind(stream) === 'pressure' ? (stream.unit === 'ADC' ? '原始压力 ADC' : '压力数据')
    : kind(stream) === 'imu' ? (rawImu ? 'IMU 原始字节（未解析）' : 'IMU 数据')
      : kind(stream) === 'camera' ? '视频 / 图像' : kind(stream) === 'audio' ? '音频' : text(kind(stream));
  const rate = stream.sample_rate ?? stream.sample_rate_hz ?? metadata.sample_rate;
  const knownRate = Number.isFinite(rate) && rate > 0 && stream.sample_rate_known !== false;
  const notes = [];
  if (stream.unit === 'ADC') notes.push('未标定的 ADC 原值，不是牛顿或帕斯卡');
  if (metadata.raw_order) notes.push('数据按原始扫描通道顺序保存；物理位置映射见 manifest.json 对应流的 metadata.pressure_layout');
  if (rawImu) notes.push('每个数值表示一个原始字节，未解码为加速度、角速度或姿态');
  if (!knownRate && kind(stream) !== 'camera') notes.push('采样率未知；按原记录时间戳分析，不按固定频率补点');
  if (kind(stream) === 'camera') notes.push('保留原视频/图像；帧率信息为设备报告值，不表示逐帧硬件同步');
  if (typeof encoding === 'string' && encoding.toLowerCase() === 'mjpeg')
    notes.push('MJPEG 每条记录保存一帧原始 JPEG 字节，长度可变；shape 是解码后尺寸。JPG 不重编码，frames.csv 标明结构检查结果；坏帧也保留，结构通过不表示像素解码已验证');
  if (!directPort && port) notes.push('串口来自相同 instance_id 的关联数据流');
  return {
    stream_id: string(stream.id), instance_id: instanceId, product,
    sensor: [sideLabel, sensor].filter(Boolean).join(' · '), side, side_label: sideLabel || null,
    port: port ?? null, port_source: directPort ? 'stream' : port ? 'same-instance' : null,
    device_label: string(stream.device_label) ?? string(stream.name), modality: kind(stream), data_type: dataType,
    dtype: string(stream.dtype) ?? string(stream.encoding),
    shape: Array.isArray(stream.shape) && stream.shape.every(value => Number.isSafeInteger(value) && value > 0) ? [...stream.shape] : null,
    unit: string(stream.unit), sample_rate_hz: knownRate ? rate : null,
    channels: Number.isSafeInteger(stream.channels) ? stream.channels : null,
    bits_per_sample: Number.isSafeInteger(stream.bits_per_sample) ? stream.bits_per_sample : null,
    notes,
  };
}

function matchBinaryFiles(stream, format, files) {
  if (typeof stream.id !== 'string' || !stream.id) return [];
  if (format === 'json') return files.filter(file => file === stream.file);
  const direct = files.filter(file => file === `${stream.id}.csv` || file === `${stream.id}.npz`);
  const nested = files.filter(file => file.startsWith(`${stream.id}/`));
  if (kind(stream) !== 'camera') return [...direct, ...nested];
  // A frame folder may contain millions of PNGs/JPGs; describe the directory once.
  return nested.length ? [...direct, `${stream.id}/`] : direct;
}

/** files lists actual package entries; camera directories may be supplied as "stream-id/". */
export function buildPackageGuide({ manifest = {}, format, files = [], report = {}, fileMap = [] } = {}) {
  const mappings = list(fileMap).filter(item => typeof item.original_file === 'string' && typeof item.file === 'string')
    .map(item => ({ original_file: paths([item.original_file])[0], file: paths([item.file])[0], stream_id: string(item.stream_id) }));
  function translate(file, reverse = false) {
    const from = reverse ? 'file' : 'original_file', to = reverse ? 'original_file' : 'file';
    const exact = mappings.find(item => item[from] === file);
    if (exact) return exact[to];
    const parent = mappings.filter(item => item[from].endsWith('/') && file.startsWith(item[from]))
      .sort((a, b) => b[from].length - a[from].length)[0];
    return parent ? parent[to] + file.slice(parent[from].length) : file;
  }
  const actual = paths(files).map(file => translate(file, true)), entries = [], unavailable = [], consumed = new Set();
  const streams = list(manifest.streams), media = list(manifest.media_streams), all = [...streams, ...media];
  const incomplete = manifest.status === 'incomplete' || report.incomplete === true || report.recovery === true;
  const results = list(report.streams);
  function add(entry) {
    consumed.add(entry.file);
    entries.push({ ...entry, original_file: entry.file, file: translate(entry.file) });
  }
  for (const stream of streams) {
    const info = sourceInfo(stream, all), result = results.find(item => item.id === stream.id);
    const matched = matchBinaryFiles(stream, format, actual);
    const issue = result?.error ? text(result.error) : (result?.skipped ? '本次导出未包含有效记录' : null);
    if (!matched.length) {
      unavailable.push({ ...info, source_file: string(stream.file), reason: issue || '本包未包含此数据流文件' });
      continue;
    }
    for (const file of matched) {
      const directory = file.endsWith('/');
      const members = directory ? actual.filter(item => item.startsWith(file) && !item.endsWith('/')) : [];
      for (const member of members) consumed.add(member);
      const notes = [...info.notes];
      if (file.endsWith('/blocks.csv')) notes.push('音频块时间戳、样本数与样本偏移索引');
      if (file.endsWith('/audio.wav')) notes.push('由原始 float32 音频生成的 IEEE float32 WAV');
      if (directory && kind(stream) === 'camera') notes.push('目录内 PNG 为逐帧图像；frames.csv 为帧文件与原始时间戳索引');
      if (directory && kind(stream) === 'audio') notes.push('音频目录：audio.wav 为音频，blocks.csv 为音频块时间戳和样本偏移索引；具体文件以目录内容为准');
      if (issue) notes.push(`此流异常：${issue}`);
      if (incomplete && format !== 'json') notes.push('仅转换首个坏记录之前的有效前缀，未补零');
      if (incomplete && format === 'json') notes.push('原始文件可能保留坏尾；以 recovery_report.json 为准');
      add({ ...info, file, role: directory ? (kind(stream) === 'camera' ? 'frame-directory' : kind(stream) === 'audio' ? 'audio-directory' : 'sensor-directory') : 'sensor-data', included: true,
        status: issue ? '已包含，存在异常' : incomplete ? '已包含，原录制不完整' : '已包含',
        ...(directory ? { file_count: members.length || null } : {}), notes });
    }
  }
  for (const stream of media) {
    const info = sourceInfo(stream, all), segments = list(stream.segments);
    const parts = segments.length ? segments : [{ file: stream.file }];
    for (const part of parts) {
      const segment = segments.length ? {
        index: Number.isSafeInteger(part.index) ? part.index : null,
        start_sample: Number.isSafeInteger(part.start_sample) ? part.start_sample : null,
        sample_count: Number.isSafeInteger(part.sample_count) ? part.sample_count : null,
        duration_ms: Number.isFinite(part.duration_ms) ? part.duration_ms : null,
      } : null;
      if (!actual.includes(part.file)) {
        const skipped = list(report.skipped_assets).find(item => item.file === part.file);
        unavailable.push({ ...info, source_file: string(part.file), segment,
          reason: text(skipped?.reason || part.error || stream.error || '本包未包含此媒体文件') });
        continue;
      }
      const notes = [...info.notes];
      if (segment) notes.push(`音频分段索引 ${segment.index}（从 0 开始），原始起始样本 ${segment.start_sample}；按 start_sample 排序，缺段保留空隙`);
      if (stream.started_at == null) notes.push('开始时间未记录，请独立播放，不猜测与其他传感器的时间偏移');
      if (part.error || stream.error) notes.push(`源录制异常：${text(part.error || stream.error)}`);
      if (part.finalized === false || stream.finalized === false) notes.push('源录制未正常收尾；文件是否可用以检查报告为准');
      add({ ...info, file: part.file, role: 'media', included: true, segment,
        status: incomplete ? '已包含，原录制不完整' : '已包含', notes });
    }
  }
  const assets = list(manifest.assets);
  for (const file of actual) {
    if (consumed.has(file)) continue;
    const asset = assets.find(item => item.file === file);
    const shared = asset?.role === 'sdk-frame-metadata';
    const knownFile = Object.hasOwn(fileNotes, file);
    add({ file, role: shared ? 'shared-sdk-metadata' : knownFile ? 'package-metadata' : 'attachment', included: true,
      sensor: shared ? '全部 SDK 传感器（共享）' : null, stream_id: string(asset?.stream_id),
      ...(shared ? { related_stream_ids: streams.filter(item => item.adapter === 'shroom-sdk' || item.metadata?.product).map(item => string(item.id)).filter(Boolean) } : {}),
      status: '已包含', notes: [shared ? 'SDK 逐帧元信息，共享附件；按 instance_id 区分设备，结合 sequence 与 host_time_ns 对照记录。'
        : (knownFile ? fileNotes[file] : string(asset?.description)) ?? '附加文件；未提供明确的传感器映射。'] });
  }
  const index = { schema_version: 1, session_id: string(manifest.session_id) ?? string(manifest.id),
    session_name: string(manifest.name), export_format: string(format), incomplete,
    source_manifest: 'manifest.json', file_mapping: mappings,
    mapping_policy: 'Metadata only. file is the exported path; original_file is the pre-rename package path, which may differ from the raw source filename after format conversion. stream_id links the unchanged source manifest. An inherited serial port requires one unique port among streams with the exact same instance_id. File presence is not a payload integrity check.',
    entries, unavailable_streams: unavailable };
  let csv = '\ufeff' + csvRow(['文件 / 目录', '原导出文件名 / 目录', '传感器', '左右侧', '串口', '设备名称', '数据类型', '数据流 ID', '实例 ID', 'dtype / 编码', '每个样本形状', '单位', '采样率 Hz（已知）', '分段索引（从0开始）', '分段起始样本', '分段样本数', '状态', '说明']);
  const rows = [...entries, ...unavailable.map(item => ({ ...item, file: '', original_file: item.source_file, status: '未包含', notes: [...item.notes, item.reason] }))];
  for (const entry of rows) csv += csvRow([entry.file, entry.original_file, entry.sensor, entry.side_label, entry.port, entry.device_label,
    entry.data_type, entry.stream_id, entry.instance_id, entry.dtype, entry.shape?.join(' × '), entry.unit, entry.sample_rate_hz,
    entry.segment?.index, entry.segment?.start_sample, entry.segment?.sample_count, entry.status, entry.notes.join('；')]);
  const lines = [
    '数据包说明与传感器文件对照', '==========================',
    `录制名称：${text(index.session_name) || '未命名'}`, `录制 ID：${text(index.session_id) || '未记录'}`,
    `导出格式：${text(format) || '未记录'}`, `源录制状态：${incomplete ? '数据不完整，请结合异常报告使用' : text(manifest.status) || '未记录'}`,
    '', '先看哪个文件', `- ${GUIDE_FILES.csv}：用 Excel / WPS 查看完整对照表。`,
    `- ${GUIDE_FILES.index}：供程序读取的文件、传感器与音频分段索引。`,
    mappings.some(item => item.file !== item.original_file)
      ? '- 数据文件按传感器命名；原导出文件名和数据流 ID 保存在对照表与 sensor_index.json 中。manifest.json 保持原样，读取包内文件时请使用此映射；格式转换后的原导出文件名可能与 manifest 中的原始二进制文件名不同。'
      : '- 文件名与原始数据流对应；下列说明给出具体设备名称。',
    '', '传感器数据速查',
  ];
  const sensorRoles = ['sensor-data', 'media', 'frame-directory', 'audio-directory', 'sensor-directory'];
  for (const entry of entries.filter(item => sensorRoles.includes(item.role))) {
    lines.push(`${text(entry.file)} → ${text(entry.sensor)} / ${text(entry.data_type)}${entry.port ? ` / ${text(entry.port)}` : ''}${entry.device_label ? ` / ${text(entry.device_label)}` : ''}`);
    if (entry.notes.length) lines.push(`  ${entry.notes.map(text).join('；')}`);
  }
  const other = entries.filter(item => !sensorRoles.includes(item.role));
  if (other.length) { lines.push('', '其他文件'); for (const entry of other) lines.push(`${text(entry.file)}：${entry.notes.map(text).join('；')}`); }
  if (unavailable.length) { lines.push('', '本包未包含的数据（不要当作零值或完整数据）'); for (const entry of unavailable) lines.push(`${text(entry.sensor)} / ${text(entry.data_type)} / ${text(entry.source_file)}：${text(entry.reason)}`); }
  lines.push('', '数据含义与时间',
    '- 压力的 ADC 数值是原始读数；物理点映射查看对应 metadata.pressure_layout，不等同于标定压力。',
    '- 标为“IMU 原始字节（未解析）”的数据未转换成加速度、角速度或姿态。',
    '- CSV 保留 sequence、sample_index_in_record 和原始纳秒时间字段；整型纳秒宜按文本或 BigInt 读取，避免表格软件丢精度。',
    '- NPZ 的 data 为样本优先数组，sequence 与时间、sample_count、sample_offset 为记录索引；完整结构见 schema.json。',
    '- JSON 原始数据包中的 .bin 是二进制记录，不是 JSON 样本数组；读取方法见 READ_DATA.md（若包内提供）。',
    '- SDK 接收时间、摄像头浏览器时间和音频样本时钟不构成硬件同步；不要仅按行号对齐不同设备。',
    '- 麦克风分段用原始 start_sample 定位；各段为独立 WAV，不要直接拼接文件字节。',
    '- 本说明依据录制元信息和包内文件清单生成，不重新校验数据内容；数据质量以 export_report.json / recovery_report.json 为准。', '');
  return { readme: '\ufeff' + lines.join('\r\n'), csv, index };
}
