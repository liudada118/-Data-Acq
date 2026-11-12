import { packageEntry, hasPackageEntry } from './helpers/package-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { loadSession, readRecords } from '../src/exports/reader.mjs';
import { inspectRecoverySession } from '../src/exports/recovery.mjs';
import { exportSession } from '../src/exports/exporter.mjs';
import { ExportManager } from '../src/exports/manager.mjs';
import { ReplayReader } from '../src/replay/reader.mjs';
import { createApplication } from '../src/server.mjs';

function record(sequence, relativeSeconds, value) {
  const data = Buffer.alloc(36);
  data.writeBigUInt64LE(BigInt(sequence)); data.writeBigInt64LE(BigInt(1e9 + relativeSeconds * 1e9), 8);
  data.writeBigInt64LE(BigInt(2e9 + relativeSeconds * 1e9), 16);
  data.writeUInt32LE(1, 24); data.writeUInt32LE(4, 28); data.writeFloatLE(value, 32);
  return data;
}
async function fixture(t, empty = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'daq-recovery-'));
  const close = [];
  t.after(async () => { for (const action of close.reverse()) await action(); await rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'sessions'), outputDir = path.join(root, 'exports'), folder = path.join(dataDir, 'incomplete-test');
  await mkdir(folder, { recursive: true }); await mkdir(outputDir);
  const raw = Buffer.concat([Buffer.from('MDAQBIN1'), ...(empty ? [] : [record(1, 0, 1.25), record(3, 1, 2.5)])]);
  const stream = { id: 'imu', name: '惯性传感器', file: 'imu.bin', kind: 'imu', dtype: 'float32', shape: [1], sample_rate: 100,
    records: empty ? 0 : 2, samples: empty ? 0 : 2, payload_bytes: empty ? 0 : 8 };
  const manifest = { id: 'incomplete-test', name: '异常测试', source: 'hardware', status: 'incomplete', finalized: true,
    duration_s: 2, session_start_device_time_ns: '1000000000', started_at: '2026-11-05T01:00:00Z',
    dropped_records: 3, error: 'Device disconnected', streams: [stream], device_ids: ['imu'], assets: [] };
  await writeFile(path.join(folder, 'imu.bin'), raw);
  const save = () => writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  await save();
  return { root, dataDir, outputDir, folder, raw, manifest, save, onClose: action => close.push(action) };
}
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0);
  let cursor = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const compression = buffer.readUInt16LE(cursor + 10), size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42), name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const content = buffer.subarray(start, start + size);
    files.set(name, compression === 8 ? inflateRawSync(content) : content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('ordinary export remains strict; stopped incomplete replay and metadata inspection preserve sources', async t => {
  const env = await fixture(t), originalManifest = await readFile(path.join(env.folder, 'manifest.json'));
  await assert.rejects(loadSession(env.dataDir, env.manifest.id), /Only finalized/);
  assert.equal((await new ReplayReader({ dataDir: env.dataDir }).frame(env.manifest.id, 0)).incomplete, true);
  const outputFile = path.join(env.outputDir, 'recovery.zip');
  await assert.rejects(exportSession({ dataDir: env.dataDir, sessionId: env.manifest.id, format: 'json', outputFile }), /Only finalized/);
  const report = await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id });
  assert.equal(report.incomplete, true); assert.equal(report.has_data, true); assert.equal(report.dropped_records, 3);
  assert.equal(report.inspection_mode, 'metadata'); assert.equal(report.fully_scanned, false);
  assert.deepEqual(report.streams.map(stream => [stream.records, stream.samples, stream.start_s, stream.end_s, stream.observed_span_s]), [[2, 2, null, null, null]]);
  assert.equal(report.streams[0].record_sequence_gaps, null); assert.equal(report.streams[0].counts_verified, false);
  const scanned = await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id, scanRecords: true });
  assert.equal(scanned.streams[0].record_sequence_gaps, '1'); assert.equal(scanned.streams[0].end_s, 1);
  assert.match(report.warnings.join(' '), /信号质量合格/); assert.match(report.warnings.join(' '), /Device disconnected/);
  for (const format of ['json', 'csv', 'npz']) {
    const target = path.join(env.outputDir, `${format}.zip`);
    await exportSession({ dataDir: env.dataDir, sessionId: env.manifest.id, format, outputFile: target, recovery: true });
    const files = unzip(await readFile(target));
    assert.deepEqual(files.get('manifest.json'), originalManifest);
    assert.equal(JSON.parse(files.get('manifest.json')).status, 'incomplete');
    assert.equal(JSON.parse(files.get('recovery_report.json')).incomplete, true);
    assert.equal(JSON.parse(files.get('export_report.json')).recovery, true);
    assert.match(files.get('INCOMPLETE_RECORDING.md').toString(), /不完整/);
    if (format === 'json') assert.deepEqual(packageEntry(files, 'imu.bin'), env.raw);
  }
  assert.deepEqual(await readFile(path.join(env.folder, 'manifest.json')), originalManifest);
  assert.deepEqual(await readFile(path.join(env.folder, 'imu.bin')), env.raw);
});

test('unfinished media can be retained only as an explicitly unverified original attachment', async t => {
  const env = await fixture(t), partial = Buffer.from('partial-media');
  env.manifest.media_streams = [{ id: 'camera-a', name: '故障相机', kind: 'camera', mode: 'browser-camera',
    file: 'camera-a.webm.part', mime_type: 'video/webm', finalized: false, chunks: 1, bytes: partial.length,
    error: 'Last chunk missing', duration_ms: null }];
  env.manifest.assets = [{ file: 'camera-a.webm.part', role: 'browser-camera-video', stream_id: 'camera-a' }];
  await writeFile(path.join(env.folder, 'camera-a.webm.part'), partial); await env.save();
  const report = await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id });
  assert.equal(report.media_streams[0].attachment_only, true); assert.equal(report.media_streams[0].playback_verified, false);
  assert.match(report.warnings.join(' '), /不保证能够播放/);
  const outputFile = path.join(env.outputDir, 'partial.zip');
  await exportSession({ dataDir: env.dataDir, sessionId: env.manifest.id, format: 'json', outputFile, recovery: true });
  const files = unzip(await readFile(outputFile)); assert.deepEqual(packageEntry(files, 'camera-a.webm.part'), partial);
  assert.equal(JSON.parse(files.get('manifest.json')).media_streams[0].finalized, false);
  env.manifest.media_streams[0].bytes++; await env.save();
  const damaged = await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id });
  assert.equal(damaged.has_data, true); assert.equal(damaged.media_streams[0].available, false);
  assert.match(damaged.media_streams[0].error, /byte count/);
});

test('opt-in never permits active, unfinalized, unknown status, malformed flags or empty recordings', async t => {
  const env = await fixture(t, true), options = { dataDir: env.dataDir, sessionId: env.manifest.id, format: 'json', outputFile: path.join(env.outputDir, 'bad.zip'), recovery: true };
  const report = await inspectRecoverySession(options); assert.equal(report.has_data, false);
  assert.match(report.warnings.join(' '), /无可导出/);
  await assert.rejects(exportSession(options), /没有可验证/);
  for (const [status, finalized] of [['recording', true], ['incomplete', false], ['unknown', true]]) {
    Object.assign(env.manifest, { status, finalized }); await env.save();
    await assert.rejects(loadSession(env.dataDir, env.manifest.id, { allowIncomplete: true }), /Only finalized/);
  }
  Object.assign(env.manifest, { status: 'complete', finalized: true }); await env.save();
  await assert.rejects(inspectRecoverySession(options), /仅用于/);
  await assert.rejects(exportSession({ ...options, recovery: 'true' }), /explicit boolean/);
  assert.deepEqual(await readdir(env.outputDir), []);
});

test('recovery converts only the verified prefix and isolates invalid metadata and paths', async t => {
  const env = await fixture(t), options = { dataDir: env.dataDir, sessionId: env.manifest.id, format: 'json', outputFile: path.join(env.outputDir, 'bad.zip'), recovery: true };
  const file = path.join(env.folder, 'imu.bin');
  await truncate(file, env.raw.length - 1);
  assert.match((await inspectRecoverySession(options)).streams[0].error, /byte count/);
  for (const format of ['json', 'csv', 'npz']) {
    const outputFile = path.join(env.outputDir, `prefix-${format}.zip`);
    await exportSession({ ...options, format, outputFile });
    const files = unzip(await readFile(outputFile)), report = JSON.parse(files.get('recovery_report.json'));
    assert.equal(report.streams[0].records, 1); assert.equal(report.streams[0].valid_bytes, 44); assert.match(report.streams[0].error, /Truncated/);
    assert.equal(report.fully_scanned, true); assert.equal(report.streams[0].counts_verified, true);
    if (format === 'csv') { assert.match(packageEntry(files, 'imu.csv').toString(), /1.25/); assert.doesNotMatch(packageEntry(files, 'imu.csv').toString(), /2.5/); }
    if (format === 'json') assert.deepEqual(packageEntry(files, 'imu.bin'), env.raw.subarray(0, -1));
    if (format === 'npz') {
      const npy = unzip(packageEntry(files, 'imu.npz')).get('data.npy'), headerLength = npy.readUInt16LE(8);
      assert.match(npy.subarray(10, 10 + headerLength).toString(), /'shape': \(1, 1\)/);
      assert.equal(npy.subarray(10 + headerLength).length, 4); assert.equal(npy.readFloatLE(10 + headerLength), 1.25);
    }
  }
  assert.deepEqual(await readFile(file), env.raw.subarray(0, -1));
  await writeFile(file, env.raw);
  env.manifest.streams[0].samples++; await env.save();
  assert.match((await inspectRecoverySession(options)).streams[0].error, /samples.*match/);
  env.manifest.streams[0].samples--;
  env.manifest.streams[0].shape = [0]; await env.save();
  assert.equal((await inspectRecoverySession(options)).streams[0].available, false);
  env.manifest.streams[0].shape = [1]; env.manifest.streams[0].file = '../imu.bin'; await env.save();
  assert.match((await inspectRecoverySession(options)).streams[0].error, /Invalid stream filename/);
  await assert.rejects(exportSession(options), /没有可验证/);
});

test('bad annotations become explicit original attachments; valid unfinished intervals stay unchanged', async t => {
  const env = await fixture(t), options = { dataDir: env.dataDir, sessionId: env.manifest.id, format: 'json', outputFile: path.join(env.outputDir, 'annotations.zip'), recovery: true };
  const annotationPath = path.join(env.folder, 'annotations.json');
  await writeFile(annotationPath, '{broken');
  const broken = await inspectRecoverySession(options);
  assert.equal(broken.has_data, true); assert.equal(broken.annotations.available, false); assert.match(broken.annotations.error, /标注文件无法解析/);
  await exportSession(options);
  const brokenFiles = unzip(await readFile(options.outputFile));
  assert.equal(brokenFiles.get('annotations.original.json').toString(), '{broken');
  assert.equal(brokenFiles.has('annotations.json'), false); assert.equal(brokenFiles.has('annotations.csv'), false);
  assert.equal(await readFile(annotationPath, 'utf8'), '{broken');
  const document = { schema_version: 1, session_id: env.manifest.id, revision: 2, experiment: {},
    labels: [{ id: 'grasp', name: '抓握', kind: 'interval', color: '#25866b', shortcut: '' }], history: [],
    annotations: [{ id: 'event-a', label_id: 'grasp', label_name: '抓握', kind: 'interval', color: '#25866b',
      start_ns: '1000000000', end_ns: null, stream_ids: [], note: '未结束', source: 'live' }] };
  const source = JSON.stringify(document); await writeFile(annotationPath, source);
  const report = await inspectRecoverySession(options);
  assert.equal(report.annotations.open_intervals, 1); assert.match(report.warnings.join(' '), /未结束区间/);
  await exportSession(options);
  const files = unzip(await readFile(options.outputFile));
  assert.deepEqual(JSON.parse(files.get('annotations.json')), document);
  assert.equal(JSON.parse(files.get('recovery_report.json')).annotations.revision, 2);
  assert.match(files.get('annotations.csv').toString(), /"1\.000000000","","1000000000",""/);
  assert.equal(await readFile(annotationPath, 'utf8'), source);
});

test('partial PCM remains subject to exact WAV header, sample and byte checks', async t => {
  const env = await fixture(t), bytes = Buffer.alloc(46);
  bytes.write('RIFF'); bytes.writeUInt32LE(38, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(2, 40); bytes.writeInt16LE(1234, 44);
  const stream = { id: 'microphone-a', name: '故障麦克风', kind: 'audio', mode: 'browser-microphone', file: 'microphone-a.wav.part',
    mime_type: 'audio/wav', format: 'wav', encoding: 'pcm_s16le', channels: 1, bits_per_sample: 16, sample_rate: 48000,
    finalized: false, error: 'Capture interrupted', chunks: 1, bytes: 46, payload_bytes: 2, sample_count: 1, duration_ms: 1 / 48000 * 1000 };
  env.manifest.media_streams = [stream]; env.manifest.assets = [{ file: stream.file, stream_id: stream.id, role: 'browser-microphone-audio' }];
  await writeFile(path.join(env.folder, stream.file), bytes); await env.save();
  assert.equal((await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id })).media_streams[0].samples, 1);
  bytes.writeUInt32LE(0, 40); await writeFile(path.join(env.folder, stream.file), bytes);
  const damaged = await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id });
  assert.equal(damaged.has_data, true); assert.equal(damaged.media_streams[0].samples, 0);
  assert.match(damaged.media_streams[0].segments[0].validation_error, /WAV header/);
});

test('recovery job naming and history preserve opt-in across service restart; inspections are bounded', async t => {
  const env = await fixture(t), manager = new ExportManager(env); await manager.init();
  t.after(() => manager.close());
  await assert.rejects(manager.createJob({ session_id: env.manifest.id, format: 'json' }), /Only finalized/);
  const inspection = manager.inspectRecovery(env.manifest.id);
  await assert.rejects(manager.inspectRecovery(env.manifest.id), /正在检查/);
  assert.equal((await inspection).has_data, true);
  const job = await manager.createJob({ session_id: env.manifest.id, format: 'json', recovery: true });
  await manager.close();
  const complete = manager.getJob(job.id); assert.equal(complete.status, 'complete', complete.error);
  assert.equal(complete.recovery, true); assert.match(complete.filename, /-incomplete-/);
  const restored = new ExportManager(env); await restored.init(); t.after(() => restored.close());
  assert.equal(restored.getJob(job.id).recovery, true);
  assert.match((await restored.download(job.id)).filename, /-incomplete-/);
});

test('HTTP recovery requires explicit opt-in and no active recording, while ordinary export stays strict', async t => {
  const env = await fixture(t), app = await createApplication({ ...env, port: 0, sdkPath: false });
  env.onClose(() => app.close());
  const post = (route, value) => fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const route = `/api/sessions/${env.manifest.id}/recovery`;
  assert.equal((await post(route, {})).status, 400);
  assert.equal((await post('/api/export/jobs', { session_id: env.manifest.id, format: 'json' })).status, 400);
  const checked = await post(route, { allow_incomplete: true }); assert.equal(checked.status, 200);
  assert.equal((await checked.json()).incomplete, true);
  assert.equal((await post('/api/sessions/start', { name: 'Active', device_ids: ['sim-imu'] })).status, 201);
  assert.equal((await post(route, { allow_incomplete: true })).status, 409);
  assert.equal((await post('/api/export/jobs', { session_id: env.manifest.id, format: 'json', recovery: true })).status, 409);
  await post('/api/sessions/stop', {});
  const accepted = await post('/api/export/jobs', { session_id: env.manifest.id, format: 'json', recovery: true });
  assert.equal(accepted.status, 202); const job = await accepted.json();
  assert.equal(job.recovery, true); assert.match(job.filename, /-incomplete-/);
});

function pcmWave(values, sampleRate = 48000) {
  const bytes = Buffer.alloc(44 + values.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(values.length * 2, 40);
  values.forEach((value, index) => bytes.writeInt16LE(value, 44 + index * 2)); return bytes;
}
test('one missing binary and one damaged WAV segment do not block other streams or later valid segments', async t => {
  const env = await fixture(t), original = await readFile(path.join(env.folder, 'imu.bin'));
  env.manifest.streams.push({ ...env.manifest.streams[0], id: 'missing', file: 'missing.bin' });
  const segments = [];
  for (let index = 0; index < 3; index++) {
    const data = pcmWave([index + 1, index + 2]), file = `mic-${index}.wav`;
    await writeFile(path.join(env.folder, file), data);
    segments.push({ index, file, start_sample: index * 2, sample_count: 2, payload_bytes: 4, bytes: 48,
      duration_ms: 2 / 48000 * 1000, finalized: true, error: null });
  }
  const audio = { id: 'microphone-a', name: '麦克风', kind: 'audio', mode: 'browser-microphone', file: segments[0].file,
    mime_type: 'audio/wav', format: 'wav', encoding: 'pcm_s16le', channels: 1, bits_per_sample: 16, sample_rate: 48000,
    chunks: 3, finalized: true, bytes: 144, sample_count: 6, payload_bytes: 12, duration_ms: 6 / 48000 * 1000, segments };
  env.manifest.media_streams = [audio]; env.manifest.assets = segments.map(segment => ({ file: segment.file, role: 'browser-microphone-audio', stream_id: audio.id }));
  await env.save();
  let loaded = await loadSession(env.dataDir, env.manifest.id, { allowIncomplete: true });
  assert.equal(loaded.manifest.media_streams[0].segments.length, 3);
  const damaged = await readFile(path.join(env.folder, 'mic-1.wav')); damaged.writeUInt32LE(0, 40); await writeFile(path.join(env.folder, 'mic-1.wav'), damaged);
  loaded = await loadSession(env.dataDir, env.manifest.id, { allowIncomplete: true });
  assert.deepEqual(loaded.manifest.streams.map(stream => stream.id), ['imu']);
  assert.deepEqual(loaded.manifest.media_streams[0].segments.map(segment => [segment.index, segment.start_sample]), [[0, 0], [2, 4]]);
  assert.equal(loaded.sourceManifest.media_streams[0].segments.length, 3);
  const checked = await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id });
  assert.equal(checked.media_streams[0].samples, 4); assert.equal(checked.streams[1].available, false);
  for (const format of ['json', 'csv', 'npz']) {
    const outputFile = path.join(env.outputDir, `${format}-segments.zip`);
    await exportSession({ ...env, sessionId: env.manifest.id, format, outputFile, recovery: true });
    const files = unzip(await readFile(outputFile));
    assert.deepEqual(packageEntry(files, 'mic-0.wav'), pcmWave([1, 2])); assert.deepEqual(packageEntry(files, 'mic-2.wav'), pcmWave([3, 4]));
    assert.equal(hasPackageEntry(files, 'mic-1.wav'), format === 'json'); assert.equal(hasPackageEntry(files, 'missing.bin'), false);
    assert.equal(JSON.parse(files.get('export_report.json')).source_assets_streamed, true);
    assert.equal(JSON.parse(files.get('recovery_report.json')).media_streams[0].segments[2].start_sample, 4);
  }
  assert.deepEqual(await readFile(path.join(env.folder, 'imu.bin')), original);
  assert.deepEqual(await readFile(path.join(env.folder, 'mic-1.wav')), damaged);
  env.manifest.status = 'complete'; env.manifest.streams.pop(); await env.save();
  await assert.rejects(loadSession(env.dataDir, env.manifest.id, { allowIncomplete: true }), /WAV header/);
});

test('record reader stops at the first corrupt record instead of resynchronizing into later data', async t => {
  const env = await fixture(t), invalid = record(2, 0.5, 99); invalid.writeUInt32LE(100, 28);
  const data = Buffer.concat([Buffer.from('MDAQBIN1'), record(1, 0, 1.25), invalid, record(3, 1, 2.5)]);
  await writeFile(path.join(env.folder, 'imu.bin'), data);
  const report = {}, seen = [];
  for await (const item of readRecords(env.folder, env.manifest.streams[0], { allowPartial: true, report })) seen.push(item.payload.readFloatLE());
  assert.deepEqual(seen, [1.25]); assert.equal(report.valid_bytes, 44); assert.match(report.error, /payload/);
  assert.deepEqual(await readFile(path.join(env.folder, 'imu.bin')), data);
});

test('metadata inspection never scans internal records; buffered export scanning uses a handful of reads', async t => {
  const env = await fixture(t), count = 120000, raw = Buffer.alloc(8 + count * 36); raw.write('MDAQBIN1');
  for (let index = 0; index < count; index++) record(index + 1, index, index).copy(raw, 8 + index * 36);
  Object.assign(env.manifest.streams[0], { records: count, samples: count, payload_bytes: count * 4 });
  await writeFile(path.join(env.folder, 'imu.bin'), raw); await env.save();
  const report = {}; let seen = 0;
  for await (const item of readRecords(env.folder, env.manifest.streams[0], { report })) { assert.equal(item.sequence, BigInt(++seen)); }
  assert.equal(seen, count); assert.ok(report.io_reads <= 4, `buffered reads: ${report.io_reads}`);
  raw.writeUInt32LE(0, 8 + 60000 * 36 + 24); await writeFile(path.join(env.folder, 'imu.bin'), raw);
  const quick = await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id });
  assert.equal(quick.fully_scanned, false); assert.equal(quick.streams[0].counts_verified, false); assert.equal(quick.streams[0].records, count);
  const scanned = await inspectRecoverySession({ dataDir: env.dataDir, sessionId: env.manifest.id, scanRecords: true });
  assert.equal(scanned.streams[0].records, 60000); assert.match(scanned.streams[0].error, /payload/);
});

test('space preflight refuses before scanning or staging an archive and preserves source files', async t => {
  const env = await fixture(t), original = await readFile(path.join(env.folder, 'imu.bin'));
  await assert.rejects(exportSession({ ...env, sessionId: env.manifest.id, format: 'json', recovery: true,
    outputFile: path.join(env.outputDir, 'no-space.zip'), spaceInfo: async () => ({ bavail: 1, bsize: 1 }) }), error => error.statusCode === 507 && /空间不足/.test(error.message));
  assert.deepEqual(await readdir(env.outputDir), []); assert.deepEqual(await readFile(path.join(env.folder, 'imu.bin')), original);
});
