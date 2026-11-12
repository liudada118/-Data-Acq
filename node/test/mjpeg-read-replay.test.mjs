import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRecords, inspectBinaryStream, streamLayout } from '../src/exports/reader.mjs';
import { ReplayReader } from '../src/replay/reader.mjs';
import { scanContinuity } from '../src/continuity/reader.mjs';
import { checkExportSpace } from '../src/exports/space.mjs';

// Real 8 x 6 JPEG encoded by System.Drawing, unrelated to hardware acquisition.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDQooor648M/9k=', 'base64');
const ORIGIN = 9007199254740993n;
const payloads = [JPEG, Buffer.concat([JPEG, Buffer.alloc(17)]), JPEG.subarray(0, -2)];

async function fixture(t, { incomplete = false, count = 3, manifestCount = count, framePayloads = payloads } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mjpeg-reader-')), sessionId = 'session-mjpeg', folder = path.join(dataDir, sessionId);
  await mkdir(folder); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const blocks = Array.from({ length: count }, (_, index) => {
    const payload = framePayloads[index % framePayloads.length], header = Buffer.alloc(32);
    header.writeBigUInt64LE(BigInt(index + 1)); header.writeBigInt64LE(ORIGIN + BigInt(index) * 100000000n, 8);
    header.writeBigInt64LE(ORIGIN + BigInt(index) * 100000000n + 1234n, 16);
    header.writeUInt32LE(1, 24); header.writeUInt32LE(payload.length, 28);
    return Buffer.concat([header, payload]);
  });
  const stream = { id: 'left-camera', name: 'Left camera', kind: 'camera', dtype: 'uint8', shape: [6, 8, 3], encoding: 'mjpeg',
    sample_rate: 0, sample_rate_known: false, irregular_timestamps: true, metadata: { encoding: 'mjpeg', pixel_format: 'mjpeg' },
    file: 'left-camera.bin', records: manifestCount, samples: manifestCount, payload_bytes: blocks.reduce((sum, block) => sum + block.length - 32, 0) };
  await writeFile(path.join(folder, stream.file), Buffer.concat([Buffer.from('MDAQBIN1'), ...blocks]));
  const manifest = { id: sessionId, status: incomplete ? 'incomplete' : 'complete', finalized: true, duration_s: count / 10 + 1,
    session_start_device_time_ns: ORIGIN.toString(), streams: [stream] };
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  return { dataDir, folder, sessionId, stream, manifest };
}
async function records(folder, stream, reader = readRecords) { const rows = []; for await (const row of reader(folder, stream)) rows.push(row); return rows; }

test('standalone raw reader retains variable JPEG lengths, exact timestamps and malformed original bytes', async t => {
  const env = await fixture(t), rows = await records(env.folder, env.stream);
  assert.deepEqual(rows.map(row => row.payload), payloads);
  assert.deepEqual(rows.map(row => row.sequence), [1n, 2n, 3n]);
  assert.equal(rows[1].deviceNs, ORIGIN + 100000000n);
  assert.equal((await inspectBinaryStream(env.folder, env.stream)).error, null);
  const standalone = path.join(env.dataDir, 'session_reader.mjs');
  await writeFile(standalone, await readFile(new URL('../src/exports/reader.mjs', import.meta.url)));
  const independent = await import(pathToFileURL(standalone).href);
  assert.deepEqual((await records(env.folder, env.stream, independent.readRecords)).map(row => row.payload), payloads);
});

test('replay preserves JPEG bytes and blocks malformed preview without stopping other timestamps', async t => {
  const env = await fixture(t), reader = new ReplayReader({ dataDir: env.dataDir, fastThreshold: 1 });
  const first = (await reader.frame(env.sessionId, 0)).streams[env.stream.id];
  assert.equal(first.available, true); assert.equal(first.camera.width, 8); assert.equal(first.camera.height, 6);
  assert.deepEqual(Buffer.from(first.camera.jpeg_base64, 'base64'), JPEG); assert.equal(first.camera.rgb_base64, undefined);
  assert.equal(first.camera.jpeg_status.decoder_verified, false);
  const padded = (await reader.frame(env.sessionId, .1)).streams[env.stream.id];
  assert.equal(padded.camera.jpeg_status.status, 'warning'); assert.deepEqual(Buffer.from(padded.camera.jpeg_base64, 'base64'), payloads[1]);
  const broken = (await reader.frame(env.sessionId, .2)).streams[env.stream.id];
  assert.equal(broken.available, false); assert.equal(broken.sequence, '3'); assert.equal(broken.camera.jpeg_base64, undefined);
  assert.equal(broken.camera.preview_status, 'invalid-jpeg');
  assert.equal((await reader.frame(env.sessionId, 0)).streams[env.stream.id].available, true);
});

test('incomplete MJPEG cannot use fixed-stride indexing and keeps bounded indices when counts are stale', async t => {
  const env = await fixture(t, { incomplete: true, count: 4100, manifestCount: 0 });
  const reader = new ReplayReader({ dataDir: env.dataDir, fastThreshold: 1 }), frame = await reader.frame(env.sessionId, 409.8);
  const index = reader.cache.get(env.sessionId).indexes.get(env.stream.id);
  assert.equal(index.direct, undefined); assert.ok(index.points.length <= 4096);
  assert.equal(frame.streams[env.stream.id].sequence, '4099'); assert.equal(frame.streams[env.stream.id].available, true);
  assert.equal(frame.validation, 'full-index'); assert.ok(frame.warnings.length);
});

test('continuity checks variable-record timestamps without claiming JPEG pixels were validated', async t => {
  const env = await fixture(t), report = await scanContinuity({ dataDir: env.dataDir, sessionId: env.sessionId, threshold_ms: 150 });
  const stream = report.streams[0]; assert.equal(stream.records, 3); assert.equal(stream.samples, 3);
  assert.equal(stream.scan_complete, true); assert.equal(stream.completion, 'complete'); assert.equal(stream.max_gap_ms, 100);
  assert.equal(stream.sequence_missing_records, '0'); assert.ok(stream.warnings.some(warning => warning.includes('JPEG')));
});

test('compressed payload contract rejects zero bytes, multiple samples and non-camera descriptors', async t => {
  const env = await fixture(t), filename = path.join(env.folder, env.stream.file), original = await readFile(filename);
  const multiple = Buffer.from(original); multiple.writeUInt32LE(2, 8 + 24); await writeFile(filename, multiple);
  await assert.rejects(records(env.folder, env.stream), /payload/);
  const empty = Buffer.from(original); empty.writeUInt32LE(0, 8 + 28); await writeFile(filename, empty);
  await assert.rejects(records(env.folder, env.stream), /payload/);
  assert.throws(() => streamLayout({ ...env.stream, kind: 'pressure' }), /MJPEG/);
});

test('MJPEG space-only estimate uses finalized record count instead of a one-byte hypothetical frame', async t => {
  const env = await fixture(t, { framePayloads: [Buffer.alloc(300000, 1)] });
  const result = await checkExportSpace({ folder: env.folder, manifest: env.manifest, outputDir: env.dataDir, format: 'csv',
    spaceInfo: async () => ({ bavail: 1024 ** 3, bsize: 1 }) });
  assert.equal(result.variable_record_counts[0].records, 3);
  assert.equal(result.variable_record_counts[0].basis, 'finalized-manifest-and-file-size');
  assert.ok(result.required_bytes < 16 * 1024 * 1024 + 900000 * 5);
});

test('incomplete MJPEG space-only estimate scans headers when counts are stale', async t => {
  const env = await fixture(t, { incomplete: true, manifestCount: 1, framePayloads: [Buffer.alloc(300000, 1)] });
  const args = { folder: env.folder, manifest: env.manifest, outputDir: env.dataDir, format: 'csv', spaceInfo: async () => ({ bavail: 1024 ** 3, bsize: 1 }) };
  await assert.rejects(checkExportSpace(args), /清单/);
  const result = await checkExportSpace({ ...args, recovery: true });
  assert.equal(result.variable_record_counts[0].records, 3);
  assert.equal(result.variable_record_counts[0].basis, 'recovery-header-prefix-scan');
  let yielded = 0;
  await assert.rejects(async () => { for await (const ignored of readRecords(env.folder, env.stream)) { void ignored; yielded++; } }, /records exceed/);
  assert.equal(yielded, 1, 'record cap must reject before writing a second frame');
});
