import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, truncate } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectContinuitySource, scanContinuity, validateThreshold } from '../src/continuity/reader.mjs';
import { ContinuityManager } from '../src/continuity/manager.mjs';

const ORIGIN = 9007199254740993n;
function binary(sequence, milliseconds, { count = 1, payload = Buffer.from([7]), hostMs = milliseconds } = {}) {
  const head = Buffer.alloc(32); head.writeBigUInt64LE(BigInt(sequence)); head.writeBigInt64LE(ORIGIN + BigInt(Math.round(milliseconds * 1e6)), 8);
  head.writeBigInt64LE(ORIGIN + BigInt(Math.round(hostMs * 1e6)) + 1000n, 16); head.writeUInt32LE(count, 24); head.writeUInt32LE(payload.length, 28);
  return Buffer.concat([head, payload]);
}
async function fixture(t, definitions = [{ id: 'pressure', events: [[1, 0], [2, 10], [3, 20]] }], extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shroom-continuity-')), folder = path.join(root, 'session-continuity');
  await mkdir(folder); t.after(() => rm(root, { recursive: true, force: true }));
  const streams = [];
  for (const item of definitions) {
    const { events, ...fields } = item;
    const chunks = events.map(([sequence, time, options]) => binary(sequence, time, options));
    const stream = { kind: 'pressure', name: item.id, adapter: 'shroom-sdk', dtype: 'uint8', shape: [1], sample_rate: 0,
      sample_rate_known: false, irregular_timestamps: true, file: `${item.id}.bin`, records: events.length,
      samples: events.reduce((sum, event) => sum + (event[2]?.count ?? 1), 0), payload_bytes: chunks.reduce((sum, chunk) => sum + chunk.length - 32, 0), ...fields };
    await writeFile(path.join(folder, stream.file), Buffer.concat([Buffer.from('MDAQBIN1'), ...chunks])); streams.push(stream);
  }
  const manifest = { id: 'session-continuity', name: 'Tiny continuity fixture', status: 'complete', finalized: true,
    duration_s: 1, session_start_device_time_ns: ORIGIN.toString(), streams, ...extra };
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  return { dataDir: root, folder, manifest, sessionId: manifest.id };
}
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) <= expected * 0.0051, `${actual} near ${expected}`);
const recordedQuality = overrides => ({ observed_frames: 3, source_sequence_status: 'available', source_sequence_supported: true,
  source_indexed_frames: 3, source_unindexed_frames: 0, source_missing_frames: '2', source_gap_events: 1,
  source_duplicates: 0, source_reversals: 0, invalid_jpeg_frames: 1, jpeg_warning_frames: 1,
  scope: 'recorded-frames', jpeg_decode_verified: false, ...overrides });

test('capture-time source gaps and JPEG issues remain separate from contiguous application record IDs', async t => {
  const quality = recordedQuality(), env = await fixture(t, [{ id: 'camera', events: [[1, 0], [2, 10], [3, 20]], quality }]);
  const report = await scanContinuity(env), row = report.streams[0];
  assert.equal(row.sequence_missing_records, '0'); assert.equal(row.record_sequence_scope, 'application-records');
  assert.equal(row.recorded_quality_status, 'available'); assert.equal(row.recorded_quality.source_missing_frames, '2');
  assert.equal(row.recorded_quality.invalid_jpeg_frames, 1); assert.equal(row.recorded_quality.jpeg_warning_frames, 1);
  assert.equal(row.recorded_quality.scope, 'recorded-frames'); assert.equal(row.recorded_quality.rescanned, false);
  assert.equal(row.recorded_quality.validation, 'not-rescanned'); assert.equal(row.recorded_quality.jpeg_decode_verified, false);
  assert.equal(row.recorded_quality.scan_record_count_matches, true); assert.equal(row.completion, 'complete');
  assert.ok(row.warnings.some(warning => warning.includes('连续不表示设备没有丢帧')));
});

test('metadata fallback preserves unknown source loss while old recordings never acquire invented zero counters', async t => {
  const unknown = recordedQuality({ source_sequence_status: 'unknown', source_sequence_supported: false, source_indexed_frames: 0,
    source_unindexed_frames: 3, source_missing_frames: null, source_gap_events: null, source_duplicates: null, source_reversals: null });
  const env = await fixture(t, [{ id: 'old', events: [[1, 0]] }, { id: 'unknown', events: [[1, 0], [2, 10], [3, 20]], metadata: { quality: unknown } }]);
  const [old, row] = (await scanContinuity(env)).streams;
  assert.equal(old.recorded_quality, null); assert.equal(old.recorded_quality_status, 'unavailable');
  assert.equal(row.recorded_quality.source_missing_frames, null); assert.equal(row.recorded_quality.source_sequence_status, 'unknown');
});

test('invalid scope is not presented as recorded-frame quality and valid mismatched snapshots stay explicitly unverified', async t => {
  const env = await fixture(t, [{ id: 'bad', events: [[1, 0]], quality: recordedQuality({ scope: 'live-session' }) },
    { id: 'mismatch', events: [[1, 0], [2, 10]], quality: recordedQuality({ source_sequence_status: 'partial', source_reversals: 1 }) }]);
  const [bad, row] = (await scanContinuity(env)).streams;
  assert.equal(bad.recorded_quality, null); assert.equal(bad.recorded_quality_status, 'invalid');
  assert.equal(row.recorded_quality.source_reversals, 1); assert.equal(row.recorded_quality.scan_record_count_matches, false);
  assert.ok(row.warnings.some(warning => warning.includes('检查范围')));
});

test('record interval statistics use exact origin, bounded quantiles and preserve empty timeline windows', async t => {
  const env = await fixture(t, [{ id: 'pressure', events: [[1, 10], [2, 20], [3, 30], [4, 800]] }]);
  const before = await readFile(path.join(env.folder, 'pressure.bin'));
  const report = await scanContinuity(env), row = report.streams[0];
  assert.equal(row.records, 4); assert.equal(row.interval_count, 3); assert.equal(row.gaps_over_threshold, 1);
  assert.equal(row.max_gap_ms, 770); assert.equal(row.max_gap_time_s, 0.8); assert.equal(row.first_time_s, 0.01);
  assert.equal(row.mean_hz, 3 / 0.79); closeTo(row.p50_interval_ms, 10); closeTo(row.p95_interval_ms, 770);
  assert.equal(row.time_basis, 'host_receive'); assert.equal(row.timeline.length, 120);
  assert.ok(row.timeline.slice(10, 80).every(bucket => bucket.records === 0));
  assert.equal(row.anomalies.find(item => item.type === 'gap').time_s, 0.8);
  assert.equal(row.completion, 'complete'); assert.equal(row.validated_bytes, before.length);
  assert.equal(report.source_changed, false); assert.equal(report.dropped_records, null); assert.equal(report.source_error, null);
  assert.deepEqual(await readFile(path.join(env.folder, 'pressure.bin')), before);
});

test('sequence and timestamp anomalies are counted independently without calling them device loss', async t => {
  const env = await fixture(t, [{ id: 'pressure', events: [[1, 0], [2, 10], [4, 210], [4, 210], [3, 190], [5, 220]] }],
    { dropped_records: 104, dropped_batches: 9, error: 'WAV limit', status: 'incomplete' });
  const report = await scanContinuity(env), row = report.streams[0];
  assert.equal(row.records, 6); assert.equal(row.interval_count, 5); assert.equal(row.nonnegative_interval_count, 4);
  assert.equal(row.duplicate_sequences, 1); assert.equal(row.backward_sequences, 1);
  assert.equal(row.duplicate_timestamps, 1); assert.equal(row.backward_timestamps, 1); assert.equal(row.backward_host_timestamps, 1);
  assert.equal(row.sequence_gap_events, 2); assert.equal(row.sequence_missing_records, '2'); assert.equal(row.mean_hz, null);
  closeTo(row.p50_interval_ms, 10); assert.equal(row.scan_complete, true);
  assert.equal(report.dropped_records, 104); assert.equal(report.dropped_batches, 9); assert.equal(report.source_error, 'WAV limit');
  assert.ok(report.warnings.some(text => text.includes('不能据此认定设备侧丢帧')));
});

test('truncated or missing stream preserves readable prefix and leaves healthy streams inspectable', async t => {
  const env = await fixture(t, [
    { id: 'truncated', events: [[1, 0], [2, 20], [3, 40]] }, { id: 'healthy', events: [[1, 0], [2, 30]] }, { id: 'missing', events: [[1, 0]] },
  ]);
  const target = path.join(env.folder, 'truncated.bin'); await truncate(target, (await readFile(target)).length - 1);
  await rm(path.join(env.folder, 'missing.bin'));
  const report = await scanContinuity(env), [truncated, healthy, missing] = report.streams;
  assert.equal(truncated.records, 2); assert.equal(truncated.validated_bytes, 74); assert.equal(truncated.completion, 'partial'); assert.match(truncated.error, /截断/);
  assert.equal(healthy.records, 2); assert.equal(healthy.completion, 'complete'); assert.equal(missing.available, false);
  assert.equal(report.fully_scanned, false);
});

test('invalid middle record stops at validated prefix and never resynchronizes guessing later frames', async t => {
  const env = await fixture(t, [{ id: 'pressure', events: [[1, 0], [2, 20, { payload: Buffer.from([1, 2]) }], [3, 40]] }]);
  const row = (await scanContinuity(env)).streams[0];
  assert.equal(row.records, 1); assert.equal(row.validated_bytes, 41); assert.match(row.error, /形状/);
});

test('unknown recording origin never creates misleading replay times', async t => {
  const env = await fixture(t, [{ id: 'pressure', events: [[1, 500], [2, 900]] }], { session_start_device_time_ns: null });
  const row = (await scanContinuity(env)).streams[0];
  assert.equal(row.time_origin, 'first_record'); assert.equal(row.seekable, false); assert.equal(row.first_time_s, null);
  assert.equal(row.max_gap_time_s, null); assert.equal(row.anomalies[0].time_s, null); assert.equal(row.anomalies[0].stream_time_s, 0.4);
  assert.equal(row.max_gap_ms, 400);
});

test('anomaly details and histogram memory stay bounded while retaining late longest gaps', async t => {
  let time = 0;
  const events = Array.from({ length: 501 }, (_, i) => { time += i + 1; return [i + 1, time]; });
  const env = await fixture(t, [{ id: 'pressure', events }], { duration_s: 200 });
  const row = (await scanContinuity({ ...env, threshold_ms: 0.001 })).streams[0];
  assert.equal(row.anomalies_total, 500); assert.equal(row.anomalies.length, 100); assert.equal(row.anomalies_truncated, 400);
  assert.equal(row.timeline.length, 120); assert.ok(row.anomalies.some(item => item.record_index === 500));
  assert.equal(row.max_gap_ms, 501);
});

function wave(sampleCount, rate = 48000) {
  const data = Buffer.alloc(44 + sampleCount * 2); data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(sampleCount * 2, 40); return data;
}
test('audio metadata exposes sample gaps and malformed segments while video frame loss remains unknown', async t => {
  const env = await fixture(t, []), segment = (index, file, start) => ({ index, file, start_sample: start, sample_count: 4,
    payload_bytes: 8, bytes: 52, duration_ms: 4 / 48000 * 1000, finalized: true });
  const microphone = { id: 'microphone', kind: 'audio', name: 'Phone microphone', format: 'wav', encoding: 'pcm_s16le', sample_rate: 48000,
    channels: 1, bits_per_sample: 16, file: 'a.wav', segments: [segment(0, 'a.wav', 0), segment(1, 'b.wav', 8), null, segment(3, 'missing.wav', 16)] };
  await writeFile(path.join(env.folder, 'a.wav'), wave(4)); await writeFile(path.join(env.folder, 'b.wav'), wave(4));
  await writeFile(path.join(env.folder, 'video.webm'), Buffer.from('test metadata fixture, not decoded video'));
  env.manifest.media_streams = [microphone, { id: 'video', kind: 'camera', name: 'Phone camera', file: 'video.webm', finalized: true }];
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const report = await scanContinuity(env), audio = report.media_streams[0], video = report.media_streams[1];
  assert.equal(audio.segment_gap_samples, '4'); assert.equal(audio.missing_segments, 2); assert.equal(audio.segments.length, 4);
  assert.equal(audio.segments[2].available, false); assert.equal(audio.segments[3].gap_before_samples, null);
  assert.equal(audio.validation, 'metadata-and-wav-header'); assert.equal(video.validation, 'metadata-only');
  assert.equal(video.frame_loss, 'unknown'); assert.equal(audio.synchronization, 'unknown');
});

test('audio declarations expose omitted tails, repeated segment files and repeated indices', async t => {
  const env = await fixture(t, []), part = { index: 0, file: 'a.wav', start_sample: 0, sample_count: 4, payload_bytes: 8, bytes: 52,
    duration_ms: 4 / 48000 * 1000, finalized: true };
  await writeFile(path.join(env.folder, 'a.wav'), wave(4));
  const base = { id: 'mic', kind: 'audio', format: 'wav', encoding: 'pcm_s16le', sample_rate: 48000, channels: 1, bits_per_sample: 16,
    file: 'a.wav', sample_count: 8, payload_bytes: 16, bytes: 104, duration_ms: 8 / 48000 * 1000 };
  env.manifest.media_streams = [{ ...base, segments: [part] }]; await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const omitted = (await scanContinuity(env)).media_streams[0];
  assert.equal(omitted.available, true); assert.equal(omitted.totals_mismatch, true); assert.match(omitted.error, /总量与分段之和不一致/);
  assert.equal(omitted.metadata_totals.sample_count.segment_sum, '4'); assert.equal(omitted.metadata_totals.sample_count.declared, '8');
  env.manifest.media_streams = [{ ...base, segments: [part, { ...part, start_sample: 4 }] }];
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const repeated = (await scanContinuity(env)).media_streams[0];
  assert.equal(repeated.duplicate_segment_files, 1); assert.equal(repeated.duplicate_segment_indices, 1); assert.equal(repeated.missing_segments, 1);
  assert.match(repeated.segments[1].error, /重复/);
});

async function finished(manager, sessionId) {
  for (let i = 0; i < 200; i++) { const job = manager.get(sessionId); if (job?.status !== 'running') return job; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Tiny continuity worker timed out');
}
test('manager caches by fingerprint and threshold, protects snapshots and invalidates changed sources', async t => {
  const env = await fixture(t), manager = new ContinuityManager({ dataDir: env.dataDir }); t.after(() => manager.close());
  const started = await manager.start(env.sessionId); const completed = await finished(manager, env.sessionId);
  assert.equal(completed.status, 'complete'); assert.equal(completed.progress, 1);
  const cached = await manager.start(env.sessionId); assert.equal(cached.id, started.id); assert.equal(cached.cache_hit, true);
  cached.report.streams[0].records = 999; assert.equal(manager.get(env.sessionId).report.streams[0].records, 3);
  const threshold = await manager.start(env.sessionId, { threshold_ms: 1 }); assert.notEqual(threshold.id, started.id); await finished(manager, env.sessionId);
  env.manifest.name = 'Updated source metadata'; await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const fingerprint = (await inspectContinuitySource(env)).fingerprint;
  const changed = await manager.start(env.sessionId, { threshold_ms: 1 }); assert.notEqual(changed.id, threshold.id); assert.equal(changed.source_fingerprint, fingerprint);
  assert.equal((await finished(manager, env.sessionId)).status, 'complete');
});

test('worker cancellation and preparation cancellation cannot overwrite a later job', async t => {
  const env = await fixture(t), manager = new ContinuityManager({ dataDir: env.dataDir }); t.after(() => manager.close());
  const cancelledStart = assert.rejects(manager.start(env.sessionId), /取消/); await manager.cancelActive(); await cancelledStart;
  assert.equal(manager.activeSessionId, null); assert.equal(manager.get(env.sessionId), null);
  const first = await manager.start(env.sessionId); const cancelled = await manager.cancelActive();
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.id, first.id); assert.equal(manager.activeSessionId, null);
  const second = await manager.start(env.sessionId); assert.notEqual(first.id, second.id);
  const complete = await finished(manager, env.sessionId); assert.equal(complete.status, 'complete'); assert.equal(complete.id, second.id);
});

test('input threshold and active recording cannot trigger a scan', async t => {
  for (const value of [0, -1, Infinity, NaN, '100', 60000.1]) assert.throws(() => validateThreshold(value), /阈值/);
  assert.equal(validateThreshold(), 100); assert.equal(validateThreshold(0.001), 0.001); assert.equal(validateThreshold(60000), 60000);
  const env = await fixture(t, [], { finalized: false, status: 'recording' });
  await assert.rejects(scanContinuity(env), /先停止录制/); await assert.rejects(inspectContinuitySource({ ...env, sessionId: '../outside' }), /ID/);
});
