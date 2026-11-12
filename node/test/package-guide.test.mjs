import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPackageGuide, GUIDE_FILES } from '../src/exports/package-guide.mjs';

const pressure = (id, instance, side, port) => ({ id, name: '手套原始压力', kind: 'pressure', dtype: 'uint8', shape: [256],
  sample_rate: 0, sample_rate_known: false, file: `${id}.bin`, unit: 'ADC',
  metadata: { instance_id: instance, product: 'glove', side, port, raw_order: 'SDK raw ADC scan order' } });
const imu = (id, instance, side) => ({ id, name: '手套 IMU 原字节（未解析）', kind: 'imu', dtype: 'uint8', shape: [16],
  sample_rate: 0, sample_rate_known: false, file: `${id}.bin`, unit: 'raw-byte',
  metadata: { instance_id: instance, product: 'glove', side, parsed: false } });

test('maps left/right glove and raw IMU using recorded instance IDs and preserves original names', () => {
  const manifest = { id: 'recording', status: 'complete', streams: [
    pressure('left-pressure', 'instance-left', 'left', 'COM5'), imu('left-imu', 'instance-left', 'left'),
    pressure('right-pressure', 'instance-right', 'right', 'COM9'), imu('right-imu', 'instance-right', 'right'),
  ] };
  const before = structuredClone(manifest);
  const files = manifest.streams.map(stream => `${stream.id}.csv`);
  const result = buildPackageGuide({ manifest, format: 'csv', files });
  const left = result.index.entries.find(entry => entry.stream_id === 'left-imu');
  const right = result.index.entries.find(entry => entry.stream_id === 'right-imu');
  assert.equal(left.sensor, '左手 · 触觉手套'); assert.equal(left.port, 'COM5'); assert.equal(left.port_source, 'same-instance');
  assert.equal(right.sensor, '右手 · 触觉手套'); assert.equal(right.port, 'COM9');
  assert.equal(left.file, 'left-imu.csv'); assert.equal(left.sample_rate_hz, null);
  assert.equal(left.data_type, 'IMU 原始字节（未解析）');
  assert.deepEqual(left.shape, [16]); assert.match(result.readme, /未标定的 ADC/);
  assert.match(result.readme, /原始扫描通道顺序/); assert.deepEqual(manifest, before);
  assert.equal(result.csv.charCodeAt(0), 0xfeff);
});

test('never inherits COM from names or ambiguous instance metadata', () => {
  const streams = [pressure('a', 'shared', 'left', 'COM1'), pressure('b', 'shared', 'left', 'COM2'),
    imu('c', 'shared', 'left'), imu('d', 'other', 'left'), imu('e', null, 'left')];
  const result = buildPackageGuide({ manifest: { streams }, format: 'csv', files: streams.map(item => `${item.id}.csv`) });
  for (const id of ['c', 'd', 'e']) assert.equal(result.index.entries.find(item => item.stream_id === id).port, null);
});

test('uses true media filenames and marks camera rate and device identity without inventing synchronization', () => {
  const media = [
    { id: 'video', name: 'DroidCam Video', kind: 'camera', file: 'video.webm', sample_rate: 30, sample_rate_known: false, finalized: true },
    { id: 'mic', name: '麦克风 (DroidCam Audio)', kind: 'audio', file: 'mic.wav', sample_rate: 48000, sample_rate_known: true,
      encoding: 'pcm_s16le', channels: 1, bits_per_sample: 16, finalized: true },
  ];
  const { index, readme } = buildPackageGuide({ manifest: { media_streams: media }, format: 'csv', files: ['video.webm', 'mic.wav'] });
  assert.equal(index.entries[0].device_label, 'DroidCam Video'); assert.equal(index.entries[0].sample_rate_hz, null);
  assert.equal(index.entries[1].sample_rate_hz, 48000); assert.equal(index.entries[1].dtype, 'pcm_s16le');
  assert.match(readme, /开始时间未记录/); assert.match(readme, /不构成硬件同步/);
});

test('each WAV segment keeps original sample coordinates and unavailable middle segment', () => {
  const stream = { id: 'mic', name: 'phone', kind: 'audio', file: 'first.wav', sample_rate: 48000,
    segments: [
      { index: 0, file: 'first.wav', start_sample: 0, sample_count: 48000, duration_ms: 1000, finalized: true },
      { index: 1, file: 'missing.wav', start_sample: 48000, sample_count: 48000, duration_ms: 1000, finalized: false },
      { index: 2, file: 'third.wav', start_sample: 96000, sample_count: 24000, duration_ms: 500, finalized: true },
    ] };
  const { index, csv, readme } = buildPackageGuide({ manifest: { status: 'incomplete', media_streams: [stream] },
    format: 'wav', files: ['first.wav', 'third.wav'], report: { skipped_assets: [{ file: 'missing.wav', reason: 'Header invalid' }] } });
  assert.deepEqual(index.entries.map(item => item.segment.start_sample), [0, 96000]);
  assert.equal(index.unavailable_streams[0].source_file, 'missing.wav');
  assert.equal(index.unavailable_streams[0].segment.index, 1); assert.equal(index.unavailable_streams[0].reason, 'Header invalid');
  assert.match(csv, /未包含/); assert.match(readme, /缺段保留空隙/);
});

test('supports actual CSV, WAV, NPZ and raw layouts including compact camera directories', () => {
  const manifest = { streams: [pressure('p', 'one', 'left', 'COM1'),
    { id: 'audio', kind: 'audio', file: 'audio.bin', dtype: 'float32', shape: [1], sample_rate: 48000 },
    { id: 'camera', kind: 'camera', file: 'camera.bin', dtype: 'uint8', shape: [720, 1280, 3], sample_rate: 30 }] };
  for (const format of ['csv', 'wav', 'npz', 'json']) {
    const files = format === 'json' ? ['p.bin', 'audio.bin', 'camera.bin']
      : [`p.${format === 'npz' ? 'npz' : 'csv'}`, 'audio/audio.wav', 'audio/blocks.csv',
        ...(format === 'npz' ? ['audio.npz'] : []), 'camera/frames.csv', 'camera/frame_00000000.png', 'camera/frame_00000001.png'];
    const result = buildPackageGuide({ manifest, format, files });
    assert.equal(result.index.unavailable_streams.length, 0);
    if (format === 'json') assert.deepEqual(result.index.entries.map(item => item.file), files);
    else {
      const camera = result.index.entries.find(item => item.stream_id === 'camera');
      assert.equal(camera.file, 'camera/'); assert.equal(camera.file_count, 3);
      assert.match(camera.notes.join(' '), /frames.csv/);
      assert.equal(result.index.entries.find(item => item.file === 'audio/blocks.csv').stream_id, 'audio');
      assert.equal(result.index.entries.length, format === 'npz' ? 5 : 4);
    }
  }
  const directory = buildPackageGuide({ manifest, format: 'csv', files: ['camera/'] }).index.entries[0];
  assert.equal(directory.file_count, null);
});

test('shared metadata is clearly shared, not misassigned to one sensor', () => {
  const manifest = { streams: [pressure('left', 'l', 'left', 'COM5'), pressure('right', 'r', 'right', 'COM9')],
    assets: [{ file: 'sdk-frames.jsonl', role: 'sdk-frame-metadata' }] };
  const { index } = buildPackageGuide({ manifest, format: 'csv', files: ['sdk-frames.jsonl', 'manifest.json', ...Object.values(GUIDE_FILES)] });
  const shared = index.entries[0]; assert.equal(shared.sensor, '全部 SDK 传感器（共享）');
  assert.deepEqual(shared.related_stream_ids, ['left', 'right']); assert.equal(shared.stream_id, null);
  assert.equal(index.unavailable_streams.length, 2);
  assert.match(index.entries.find(item => item.file === 'manifest.json').notes[0], /转换后的文件名/);
});

test('recovery states use actual entries and exported prefix report without claiming absent files exist', () => {
  const manifest = { status: 'incomplete', streams: [pressure('one', 'a', 'left', 'COM1'), pressure('two', 'b', 'right', 'COM2')] };
  const { index, readme } = buildPackageGuide({ manifest, format: 'csv', files: ['one.csv'], report: {
    streams: [{ id: 'one', records: 3, error: 'Truncated tail' }, { id: 'two', skipped: true, error: 'Missing file' }],
  } });
  assert.equal(index.entries.length, 1); assert.equal(index.entries[0].status, '已包含，存在异常');
  assert.equal(index.unavailable_streams[0].reason, 'Missing file');
  assert.match(readme, /仅转换首个坏记录之前的有效前缀/); assert.match(readme, /本包未包含的数据/);
});

test('CSV formula text is escaped and JSON device metadata remains exact', () => {
  const name = '=HYPERLINK("bad", "phone")';
  const manifest = { media_streams: [{ id: 'mic', name, kind: 'audio', file: '@mic.wav', sample_rate: 48000 }] };
  const { index, csv } = buildPackageGuide({ manifest, format: 'wav', files: ['@mic.wav'] });
  assert.equal(index.entries[0].device_label, name);
  assert.match(csv, /"'@mic.wav"/); assert.match(csv, /"'=HYPERLINK/);
  assert.throws(() => buildPackageGuide({ files: ['../secret.txt'] }), /Invalid package/);
  assert.throws(() => buildPackageGuide({ files: ['C:\\secret.txt'] }), /Invalid package/);
});

test('prototype-like names stay ordinary unknown metadata keys', () => {
  const manifest = { streams: ['constructor', '__proto__', 'toString'].map((product, index) => ({
    id: `sensor-${index}`, name: `自定义设备 ${index}`, kind: 'pressure', metadata: { product },
  })) };
  const { index } = buildPackageGuide({ manifest, format: 'csv', files: ['sensor-0.csv', 'sensor-1.csv', 'sensor-2.csv', 'constructor', '__proto__', 'toString'] });
  for (let i = 0; i < 3; i++) assert.equal(index.entries[i].sensor, `自定义设备 ${i}`);
  for (const entry of index.entries.slice(3)) {
    assert.equal(entry.role, 'attachment'); assert.match(entry.notes[0], /附加文件/);
  }
});

test('malformed rejected recovery descriptors do not abort the valid inventory', () => {
  const bad = JSON.parse('{"toString":null}');
  const manifest = { status: 'incomplete', streams: [
    { id: bad, name: bad, file: bad, kind: bad, metadata: { product: bad, side: bad, instance_id: bad, port: bad }, dtype: bad, shape: [bad] },
    { id: 'bad-fields', name: bad, kind: 'pressure', unit: bad, metadata: { product: bad, side: bad, port: bad } },
    pressure('good', 'good-instance', 'left', 'COM5'),
  ], media_streams: [{ id: 'mic', name: bad, kind: 'audio', error: bad, segments: [{ file: 'mic.wav', index: bad, start_sample: bad, sample_count: bad }] }] };
  const result = buildPackageGuide({ manifest, format: 'csv', files: ['good.csv', 'bad-fields.csv', 'mic.wav', 'other.json'],
    report: { streams: [{ id: 'bad-fields', error: bad }] } });
  assert.equal(result.index.entries.find(item => item.file === 'good.csv').port, 'COM5');
  assert.equal(result.index.entries.find(item => item.file === 'bad-fields.csv').sensor, 'bad-fields');
  assert.equal(result.index.entries.find(item => item.file === 'mic.wav').segment.start_sample, null);
  assert.equal(result.index.unavailable_streams[0].stream_id, null);
  assert.match(result.readme, /无效元信息/);
});

test('audio directory summaries use an audio role and explain its media/index files', () => {
  const { index, readme } = buildPackageGuide({ manifest: { streams: [{ id: 'audio', kind: 'audio' }] }, format: 'wav', files: ['audio/'] });
  assert.equal(index.entries[0].role, 'audio-directory');
  assert.match(index.entries[0].notes.join(' '), /audio.wav/);
  assert.match(index.entries[0].notes.join(' '), /blocks.csv/);
  assert.match(readme, /audio\/ → 麦克风/);
});
