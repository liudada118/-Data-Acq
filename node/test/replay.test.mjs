import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, truncate } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeFrame } from 'shroom-sdk/core';
import { ReplayReader } from '../src/replay/reader.mjs';
import { ReplayManager } from '../src/replay/manager.mjs';

const ORIGIN = 9007199254740993n;
function floats(values) { const result = Buffer.alloc(values.length * 4); values.forEach((v, i) => result.writeFloatLE(v, i * 4)); return result; }
function record(sequence, relativeNs, payload, count = 1) {
  const result = Buffer.alloc(32 + payload.length);
  result.writeBigUInt64LE(BigInt(sequence)); result.writeBigInt64LE(ORIGIN + BigInt(relativeNs), 8);
  result.writeBigInt64LE(ORIGIN + BigInt(relativeNs) + 1234n, 16);
  result.writeUInt32LE(count, 24); result.writeUInt32LE(payload.length, 28); payload.copy(result, 32);
  return result;
}
async function fixture(t, count = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'daq-replay-')), folder = path.join(root, 'session-replay');
  await mkdir(folder); t.after(() => rm(root, { recursive: true, force: true }));
  const definitions = [
    { id: 'imu', kind: 'imu', dtype: 'float32', shape: [2], sample_rate: 1000,
      payload: n => floats([n + .25, -n]), count: 1 },
    { id: 'pad', kind: 'pressure', dtype: 'uint8', shape: [1024], rows: 32, cols: 32, sample_rate: 0,
      sample_rate_known: false, irregular_timestamps: true, adapter: 'shroom-sdk', metadata: { product: 'hand-pad', sdk_version: '0.2.0' },
      payload: n => Buffer.from(Array.from({ length: 1024 }, (_, i) => (i + n) % 255)), count: 1 },
    { id: 'glove', kind: 'pressure', dtype: 'uint8', shape: [256], rows: 13, cols: 15, sample_rate: 0,
      sample_rate_known: false, irregular_timestamps: true, adapter: 'shroom-sdk', metadata: { product: 'glove', sdk_version: '0.2.0' },
      payload: n => Buffer.alloc(256, n), count: 1 },
    { id: 'audio', kind: 'audio', dtype: 'float32', shape: [1], sample_rate: 48000,
      payload: () => floats([1, -1, .5, -.5]), count: 4 },
    { id: 'camera', kind: 'camera', dtype: 'uint8', shape: [1, 2, 3], sample_rate: 15,
      payload: n => Buffer.from([n, 0, 0, 0, 255, 128]), count: 1 },
    { id: 'imu-raw', kind: 'imu', dtype: 'uint8', shape: [16], sample_rate: 0,
      sample_rate_known: false, irregular_timestamps: true, payload: n => Buffer.alloc(16, n), count: 1 },
  ];
  const streams = [];
  for (const def of count > 100 ? definitions.slice(0, 1) : definitions) {
    const blocks = Array.from({ length: count }, (_, i) => record(i + 1, count > 100 ? BigInt(i + 100) * 1000000n : [100000000n, 500000000n, 1000000000n][i], def.payload(i), def.count));
    const { payload, count: blockSamples, ...stream } = def;
    Object.assign(stream, { file: `${def.id}.bin`, records: count, samples: count * blockSamples,
      payload_bytes: blocks.reduce((sum, block) => sum + block.length - 32, 0) });
    await writeFile(path.join(folder, stream.file), Buffer.concat([Buffer.from('MDAQBIN1'), ...blocks])); streams.push(stream);
  }
  const manifest = { id: 'session-replay', name: 'Replay test', status: 'complete', finalized: true,
    duration_s: count > 100 ? count / 1000 + 1 : 2, session_start_device_time_ns: ORIGIN.toString(),
    started_at: '2026-11-04T00:00:00.000Z', device_ids: streams.map(s => s.id), streams };
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  return { dataDir: root, folder, manifest };
}

test('seek preserves exact timestamp origin and decodes recorded modalities without live fallback', async t => {
  const env = await fixture(t), reader = new ReplayReader({ dataDir: env.dataDir });
  const frame = await reader.frame(env.manifest.id, .75);
  assert.equal(frame.streams.imu.relative_time_s, .5);
  assert.deepEqual(frame.streams.imu.imu.values, [1.25, -1]);
  assert.equal(frame.streams.imu.device_time_ns, (ORIGIN + 500000000n).toString());
  const raw = Uint8Array.from(Array.from({ length: 1024 }, (_, i) => (i + 1) % 255));
  assert.deepEqual(frame.streams.pad.pressure.values, Array.from(decodeFrame(raw, { layout: 'mat32' }).values, v => Math.round(v * 255)));
  assert.equal(frame.streams.pad.representation, 'sdk-mapped-matrix');
  assert.equal(frame.streams.glove.pressure.rows, 16); assert.equal(frame.streams.glove.pressure.cols, 16);
  assert.equal(frame.streams.glove.representation, 'raw-scan-order'); assert.match(frame.streams.glove.note, /未恢复/);
  assert.deepEqual(frame.streams['imu-raw'].raw.values, Array(16).fill(1));
  assert.deepEqual(frame.streams.audio.audio.waveform, [1, -1, .5, -.5]);
  assert.equal(frame.streams.audio.audio.rms, Math.sqrt(.625));
  assert.deepEqual(Buffer.from(frame.streams.camera.camera.rgb_base64, 'base64'), Buffer.from([1, 0, 0, 0, 255, 128]));
  const before = await reader.frame(env.manifest.id, 0);
  assert.equal(before.streams.imu.available, false); assert.equal(before.streams.imu.imu, undefined);
  const gap = await reader.frame(env.manifest.id, 1.9);
  assert.equal(gap.streams.imu.relative_time_s, 1); assert.equal(gap.streams.imu.stale, true); assert.match(gap.streams.imu.note, /没有新数据/);
  assert.equal(reader.indexBuilds, 1);
});

test('incomplete replay isolates missing streams and retains the valid prefix of a truncated stream', async t => {
  const env = await fixture(t);
  env.manifest.status = 'incomplete'; env.manifest.error = 'Interrupted recording'; env.manifest.dropped_records = 2;
  await rm(path.join(env.folder, 'pad.bin'));
  const audioFile = path.join(env.folder, 'audio.bin');
  await truncate(audioFile, (await readFile(audioFile)).length - 3);
  const original = JSON.stringify(env.manifest);
  await writeFile(path.join(env.folder, 'manifest.json'), original);
  const reader = new ReplayReader({ dataDir: env.dataDir });
  const frame = await reader.frame(env.manifest.id, 1.5);
  assert.equal(frame.incomplete, true); assert.equal(frame.validation, 'full-index');
  assert.equal(frame.streams.pad.available, false); assert.ok(frame.stream_errors.pad);
  assert.equal(frame.streams.imu.available, true); assert.equal(frame.streams.imu.sequence, '3');
  assert.equal(frame.streams.audio.available, true); assert.equal(frame.streams.audio.sequence, '2');
  assert.match(frame.streams.audio.note, /截断/); assert.ok(frame.warnings.some(item => item.includes('Interrupted recording')));
  assert.equal(await readFile(path.join(env.folder, 'manifest.json'), 'utf8'), original);
});

test('an invalid media descriptor does not block readable raw streams in an incomplete capture', async t => {
  const env = await fixture(t);
  Object.assign(env.manifest, { status: 'incomplete', media_streams: [null] });
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const frame = await new ReplayReader({ dataDir: env.dataDir }).frame(env.manifest.id, .75);
  assert.equal(frame.streams.imu.available, true); assert.deepEqual(frame.media_streams, []);
  assert.ok(frame.warnings.some(warning => warning.includes('Invalid')));
});

test('fixed SDK records seek on demand and fail only the affected stream when the cursor hits corrupt metadata', async t => {
  const env = await fixture(t);
  env.manifest.status = 'incomplete';
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const reader = new ReplayReader({ dataDir: env.dataDir, fastThreshold: 2 });
  const frame = await reader.frame(env.manifest.id, .75);
  assert.equal(frame.validation, 'on-demand-records');
  assert.equal(frame.streams.pad.sequence, '2'); assert.equal(frame.streams['imu-raw'].sequence, '2');
  const index = reader.cache.get(env.manifest.id).indexes.get('pad');
  assert.equal(index.direct, true); assert.equal(index.points.length, 1);
  const padFile = path.join(env.folder, 'pad.bin'), corrupted = await readFile(padFile);
  corrupted.writeUInt32LE(0, 8 + 1056 + 24);
  await writeFile(padFile, corrupted);
  const bad = await reader.frame(env.manifest.id, .75);
  assert.equal(bad.streams.pad.available, false); assert.match(bad.stream_errors.pad, /形状/);
  assert.equal(bad.streams['imu-raw'].available, true);
});

test('a corrupt last SDK header does not prevent seeking earlier records in a long capture', async t => {
  const env = await fixture(t), raw = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 255));
  const blocks = Array.from({ length: 32 }, (_, i) => record(i + 1, BigInt(i) * 100000000n, raw));
  blocks.at(-1).writeUInt32LE(0, 24);
  const pad = env.manifest.streams.find(s => s.id === 'pad');
  Object.assign(pad, { records: 32, samples: 32, payload_bytes: 32 * 1024 });
  Object.assign(env.manifest, { status: 'incomplete', duration_s: 4 });
  await writeFile(path.join(env.folder, pad.file), Buffer.concat([Buffer.from('MDAQBIN1'), ...blocks]));
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const reader = new ReplayReader({ dataDir: env.dataDir, fastThreshold: 2 });
  const early = await reader.frame(env.manifest.id, .25);
  assert.equal(early.streams.pad.available, true); assert.equal(early.streams.pad.sequence, '3');
  assert.ok(early.warnings.some(warning => warning.includes('末条记录异常')));
  const tail = await reader.frame(env.manifest.id, 3.5);
  assert.equal(tail.streams.pad.available, false); assert.equal(tail.streams.imu.available, true);
  blocks.at(-1).writeUInt32LE(1, 24); blocks.at(-1).writeBigUInt64LE(2n, 0);
  await writeFile(path.join(env.folder, pad.file), Buffer.concat([Buffer.from('MDAQBIN1'), ...blocks]));
  const earlyWithBadTailOrder = await reader.frame(env.manifest.id, .25);
  assert.equal(earlyWithBadTailOrder.streams.pad.available, true);
  assert.equal(earlyWithBadTailOrder.streams.pad.sequence, '3');
  assert.equal((await reader.frame(env.manifest.id, 3.5)).streams.pad.available, false);
});

function wave(samples, rate = 8000) {
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

test('audio segments retain global offsets and missing middle segments do not close timeline gaps', async t => {
  const env = await fixture(t), samples = 8000;
  const segments = Array.from({ length: 3 }, (_, index) => ({ index, file: `mic-${index}.wav`, start_sample: index * samples,
    sample_count: samples, payload_bytes: samples * 2, bytes: samples * 2 + 44, duration_ms: 1000, finalized: true }));
  const media = { id: 'microphone-test', kind: 'audio', mode: 'browser-microphone', name: 'Phone mic', format: 'wav',
    encoding: 'pcm_s16le', channels: 1, bits_per_sample: 16, sample_rate: 8000, mime_type: 'audio/wav',
    file: segments[0].file, bytes: segments.reduce((n, s) => n + s.bytes, 0), payload_bytes: samples * 6,
    sample_count: samples * 3, duration_ms: 3000, chunks: 3, finalized: true, segments,
    started_at: '2026-11-04T00:00:00.250Z' };
  Object.assign(env.manifest, { status: 'incomplete', duration_s: 4, streams: [], media_streams: [media],
    assets: segments.map(segment => ({ file: segment.file, stream_id: media.id, role: 'browser-microphone-audio' })) });
  await writeFile(path.join(env.folder, segments[0].file), wave(samples));
  await writeFile(path.join(env.folder, segments[2].file), wave(samples));
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const frame = await new ReplayReader({ dataDir: env.dataDir }).frame(env.manifest.id, 1.5);
  const result = frame.media_streams[0];
  assert.equal(result.available, true); assert.deepEqual(result.segments.filter(s => s.url).map(s => s.offset_s), [.25, 2.25]);
  assert.deepEqual(result.segments.map(s => s.index), [0, 1, 2]);
  assert.equal(result.segments[1].url, null); assert.ok(result.segments[1].error);
  assert.ok(frame.warnings.some(item => item.includes('mic-1.wav') || item.includes('missing')));
});

test('a valid legacy WAV part remains playable with unknown alignment and its original error', async t => {
  const env = await fixture(t), samples = 8000, file = 'microphone-old.wav.part';
  const media = { id: 'microphone-old', kind: 'audio', mode: 'browser-microphone', format: 'wav', file,
    encoding: 'pcm_s16le', channels: 1, bits_per_sample: 16, sample_rate: 8000, mime_type: 'audio/wav',
    sample_count: samples, payload_bytes: samples * 2, bytes: samples * 2 + 44, duration_ms: 1000,
    finalized: false, chunks: 1, error: 'WAV exceeds the RIFF 4 GiB limit', started_at: null };
  Object.assign(env.manifest, { status: 'incomplete', streams: [], media_streams: [media],
    assets: [{ file, stream_id: media.id, role: 'browser-microphone-audio' }] });
  await writeFile(path.join(env.folder, file), wave(samples));
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const frame = await new ReplayReader({ dataDir: env.dataDir }).frame(env.manifest.id, .5);
  assert.equal(frame.media_streams[0].available, true); assert.equal(frame.media_streams[0].offset_s, null);
  assert.match(frame.media_streams[0].url, /\.wav\.part$/); assert.match(frame.media_streams[0].note, /4 GiB/);
});

test('sparse index is bounded and reused across seeks; modified or truncated data is rejected', async t => {
  const env = await fixture(t, 12000), reader = new ReplayReader({ dataDir: env.dataDir });
  const frame = await reader.frame(env.manifest.id, 10.123);
  assert.equal(frame.streams.imu.sequence, '10024');
  assert.deepEqual(frame.streams.imu.imu.values, [10023.25, -10023]);
  const index = reader.cache.get(env.manifest.id).indexes.get('imu');
  assert.ok(index.points.length <= 4096); assert.equal(index.stride, 3);
  await reader.frame(env.manifest.id, 5.55); assert.equal(reader.indexBuilds, 1);
  const filename = path.join(env.folder, 'imu.bin'); await truncate(filename, (await readFile(filename)).length - 1);
  await assert.rejects(reader.frame(env.manifest.id, 1), /截断/);
});

test('worker bounds concurrent requests and rejects invalid paths, unfinished sessions, and out-of-range times', async t => {
  const env = await fixture(t, 12000), manager = new ReplayManager({ dataDir: env.dataDir, capacity: 1 });
  t.after(() => manager.close()); await manager.init();
  const requests = await Promise.allSettled([manager.frame(env.manifest.id, 1), manager.frame(env.manifest.id, 2)]);
  assert.equal(requests[0].status, 'fulfilled'); assert.equal(requests[1].status, 'rejected'); assert.equal(requests[1].reason.statusCode, 429);
  await assert.rejects(manager.frame('../escape', 0), /无效/);
  await assert.rejects(manager.frame(env.manifest.id, -1), /非负/);
  await assert.rejects(manager.frame(env.manifest.id, 14), /范围/);
  env.manifest.finalized = false; await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  await assert.rejects(manager.frame(env.manifest.id, 0), /Only finalized/);
  await manager.close(); await assert.rejects(manager.frame(env.manifest.id, 0), /关闭/);
});

test('browser video metadata uses explicit approximate offset and supports video-only recordings', async t => {
  const env = await fixture(t);
  const media = { id: 'camera-system', kind: 'camera', name: 'Camera', file: 'camera-system.webm', mime_type: 'video/webm',
    finalized: true, chunks: 1, bytes: 4, started_at: '2026-11-04T00:00:00.250Z', duration_ms: 1500 };
  env.manifest.streams = []; env.manifest.device_ids = [media.id]; env.manifest.media_streams = [media];
  env.manifest.assets = [{ file: media.file, stream_id: media.id, role: 'browser-camera-video' }];
  await writeFile(path.join(env.folder, media.file), Buffer.from([1, 2, 3, 4]));
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  const reader = new ReplayReader({ dataDir: env.dataDir }), frame = await reader.frame(env.manifest.id, 1);
  assert.deepEqual(frame.streams, {}); assert.equal(frame.media_streams[0].offset_s, .25);
  assert.equal(frame.media_streams[0].duration_s, 1.5); assert.equal(frame.media_streams[0].alignment, 'approximate-wall-clock');
  assert.equal(frame.media_streams[0].url, '/api/files/session-replay/camera-system.webm');
});

test('eval module entry does not leak input-type flags into replay or export file workers', async t => {
  const env = await fixture(t);
  const replayUrl = new URL('../src/replay/manager.mjs', import.meta.url).href;
  const exportUrl = new URL('../src/exports/manager.mjs', import.meta.url).href;
  const script = `
    import { ReplayManager } from ${JSON.stringify(replayUrl)};
    import { ExportManager } from ${JSON.stringify(exportUrl)};
    const replay = new ReplayManager({dataDir:process.argv[1]});
    const exporter = new ExportManager({dataDir:process.argv[1],outputDir:process.argv[2]});
    try {
      await replay.init(); await exporter.init();
      const frame = await replay.frame('session-replay', .75);
      const job = await exporter.createJob({session_id:'session-replay',format:'json'});
      await exporter.close();
      const final = exporter.getJob(job.id);
      if (!frame.streams.imu.available || final.status !== 'complete') throw new Error(final.error || 'No replay frame');
      console.log(JSON.stringify({replay:true,export:final.status}));
    } finally { await replay.close(); await exporter.close(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', script, env.dataDir, path.join(env.dataDir, 'eval-exports')],
    { windowsHide: true, timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout.trim()), { replay: true, export: 'complete' });
});

async function mappedFixture(t) {
  const env = await fixture(t);
  // Deliberately explicit fixture mappings: replay must use the saved source indices,
  // not a hard-coded SDK version or a guessed reshape of the ADC scan order.
  const bodyRaw = Array.from({ length: 1024 }, (_, i) => i % 251);
  const insoleRaw = Array.from({ length: 256 }, (_, i) => (i * 17) % 4096);
  insoleRaw[255] = 4095;
  const regions = Array.from({ length: 10 }, (_, r) => ({ id: `region-${r}`, name: `区域 ${r}`, rows: 5, cols: 8,
    source_indices: Array.from({ length: 40 }, (_, i) => 1023 - (r * 40 + i) * 2) }));
  const pointLayout = { type: 'points', source_indices: Array.from({ length: 112 }, (_, i) => 255 - i),
    positions: Array.from({ length: 112 }, (_, i) => ({ row: Math.floor(i / 8), col: i % 8, x_mm: i % 8 * 4.2 - 12, y_mm: 0 - Math.floor(i / 8) * 14.1 })) };
  const definitions = [
    { id: 'body', dtype: 'uint8', shape: [1024], rows: 32, cols: 32, payload: Buffer.from(bodyRaw),
      metadata: { product: 'body', sdk_version: '0.3.0', full_scale: 255, pressure_layout: { type: 'regions', regions } } },
    { id: 'insole12', dtype: 'uint16', shape: [256], rows: 16, cols: 16,
      payload: (() => { const bytes = Buffer.alloc(512); insoleRaw.forEach((v, i) => bytes.writeUInt16LE(v, i * 2)); return bytes; })(),
      metadata: { product: 'insole', sdk_version: '0.3.0', side: 'left', protocol: '12bit', full_scale: 4095, pressure_layout: pointLayout } },
    { id: 'insole8', dtype: 'uint8', shape: [256], rows: 16, cols: 16, payload: Buffer.from(insoleRaw.map(v => v % 256)),
      metadata: { product: 'insole', sdk_version: '0.3.0', side: 'right', protocol: '8bit', full_scale: 255, pressure_layout: pointLayout } },
  ];
  for (const { payload, ...definition } of definitions) {
    const stream = { ...definition, kind: 'pressure', sample_rate: 0, sample_rate_known: false, irregular_timestamps: true,
      adapter: 'shroom-sdk', file: `${definition.id}.bin`, records: 1, samples: 1, payload_bytes: payload.length };
    await writeFile(path.join(env.folder, stream.file), Buffer.concat([Buffer.from('MDAQBIN1'), record(1, 500000000n, payload)]));
    env.manifest.streams.push(stream);
  }
  const pad = env.manifest.streams.find(s => s.id === 'pad');
  pad.metadata = { ...pad.metadata, sdk_version: '0.3.0', full_scale: 255, pressure_layout: { type: 'matrix', layout: 'mat32' } };
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  return { ...env, bodyRaw, insoleRaw, regions, pointLayout };
}

test('body regions and 8/12-bit insole points replay from saved mapping and full precision ADC', async t => {
  const env = await mappedFixture(t), reader = new ReplayReader({ dataDir: env.dataDir });
  const frame = await reader.frame(env.manifest.id, .75);
  const body = frame.streams.body.pressure;
  assert.deepEqual(body.values, env.bodyRaw); assert.equal(body.full_scale, 255);
  assert.equal(body.regions.length, 10); assert.equal(body.regions.reduce((n, r) => n + r.values.length, 0), 400);
  for (let i = 0; i < 10; i++) assert.deepEqual(body.regions[i].values, env.regions[i].source_indices.map(index => env.bodyRaw[index]));
  for (const [id, scale] of [['insole12', 4095], ['insole8', 255]]) {
    const pressure = frame.streams[id].pressure;
    const values = id === 'insole12' ? env.insoleRaw : env.insoleRaw.map(v => v % 256);
    assert.deepEqual(pressure.values, values); assert.equal(pressure.full_scale, scale); assert.equal(pressure.points.length, 112);
    assert.deepEqual(pressure.points, env.pointLayout.positions.map((position, i) => ({ ...position, value: values[env.pointLayout.source_indices[i]] })));
    assert.equal(frame.streams[id].representation, 'sdk-insole-points');
  }
  assert.equal(frame.streams.insole12.pressure.points[0].value, 4095);
  assert.equal(frame.streams.pad.representation, 'sdk-mapped-matrix');
  assert.match(frame.streams.body.note, /400/);
});

test('saved pressure mapping rejects invalid indices, dimensions, coordinates and ADC ranges', async t => {
  const env = await mappedFixture(t), original = structuredClone(env.manifest), reader = new ReplayReader({ dataDir: env.dataDir });
  const cases = [
    manifest => { manifest.streams.find(s => s.id === 'body').metadata.pressure_layout.regions[0].source_indices[0] = 1024; },
    manifest => { manifest.streams.find(s => s.id === 'body').metadata.pressure_layout.regions[0].rows = 999999; },
    manifest => { const r = manifest.streams.find(s => s.id === 'body').metadata.pressure_layout.regions; r[1].source_indices[0] = r[0].source_indices[0]; },
    manifest => { manifest.streams.find(s => s.id === 'insole12').metadata.pressure_layout.positions[0].x_mm = null; },
    manifest => { const p = manifest.streams.find(s => s.id === 'insole12').metadata.pressure_layout.positions; p[1] = { ...p[0] }; },
    manifest => { manifest.streams.find(s => s.id === 'insole12').metadata.full_scale = 255; },
    manifest => { manifest.streams.find(s => s.id === 'pad').metadata.pressure_layout.layout = 'unrecognized'; },
  ];
  for (const mutate of cases) {
    const manifest = structuredClone(original); mutate(manifest);
    await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(reader.frame(manifest.id, .75), /映射|形状|坐标|量程|索引/);
  }
});
