import { packageEntry } from './helpers/package-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { exportSession } from '../src/exports/exporter.mjs';
import { loadSession } from '../src/exports/reader.mjs';

function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0);
  const entries = new Map(); let cursor = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const compressed = buffer.readUInt32LE(cursor + 20), nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString(), local = buffer.readUInt32LE(cursor + 42);
    const offset = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28), bytes = buffer.subarray(offset, offset + compressed);
    entries.set(name, buffer.readUInt16LE(cursor + 10) === 0 ? bytes : inflateRawSync(bytes));
    cursor += 46 + nameLength + extra + comment;
  }
  return entries;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'daq-label-export-')), dataDir = path.join(root, 'sessions'), folder = path.join(dataDir, 'session-labels');
  await mkdir(folder, { recursive: true }); t.after(() => rm(root, { recursive: true, force: true }));
  const raw = Buffer.alloc(44); raw.write('MDAQBIN1'); raw.writeBigUInt64LE(1n, 8); raw.writeBigInt64LE(1n, 16); raw.writeBigInt64LE(1n, 24);
  raw.writeUInt32LE(1, 32); raw.writeUInt32LE(4, 36); raw.writeFloatLE(1.25, 40);
  const manifest = { id: 'session-labels', name: 'Annotation fixture', status: 'complete', finalized: true, duration_s: 2,
    duration_ns: '2000000000', device_ids: ['imu'], streams: [{ id: 'imu', kind: 'imu', dtype: 'float32', shape: [1], sample_rate: 100,
      file: 'imu.bin', records: 1, samples: 1, payload_bytes: 4 }] };
  await writeFile(path.join(folder, 'imu.bin'), raw); await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  const document = { schema_version: 1, session_id: manifest.id, revision: 7,
    experiment: { project: '实验项目', task: '抓握', subject: 'P001', scene: '室内', trial: '3', notes: '中文备注', tags: ['左手'] },
    labels: [{ id: 'grasp', name: '=formula', color: '#228866', kind: 'interval', shortcut: 'g' }],
    annotations: [{ id: 'ann-test', label_id: 'grasp', label_name: '=formula', color: '#228866', kind: 'interval', start_ns: '123456789', end_ns: '1234567890',
      stream_ids: ['imu'], note: '+unsafe', source: 'review', created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z' }],
    history: [{ revision: 7, action: 'upsert' }] };
  await writeFile(path.join(folder, 'annotations.json'), JSON.stringify(document));
  return { root, dataDir, folder, manifest, document, raw };
}

test('all export formats include one annotation revision, exact timing, experiment metadata and safe CSV text', async t => {
  const env = await fixture(t);
  for (const format of ['csv', 'npz', 'wav', 'json']) {
    const outputFile = path.join(env.root, `${format}.zip`);
    await writeFile(path.join(env.folder, 'annotations.json'), JSON.stringify(env.document));
    let changed = false;
    await exportSession({ dataDir: env.dataDir, sessionId: env.manifest.id, format, outputFile }, progress => {
      if (progress > 0 && !changed) { changed = true; writeFileSync(path.join(env.folder, 'annotations.json'), JSON.stringify({ ...env.document, revision: 8 })); }
    });
    const files = unzip(await readFile(outputFile)), exported = JSON.parse(files.get('annotations.json'));
    assert.deepEqual(exported, env.document);
    assert.equal(JSON.parse(files.get('experiment.json')).annotation_revision, 7);
    assert.equal(JSON.parse(files.get('experiment.json')).experiment.subject, 'P001');
    assert.equal(JSON.parse(files.get('export_report.json')).annotation_revision, 7);
    const csv = files.get('annotations.csv').toString();
    assert.ok(csv.includes('"0.123456789","1.111111101","123456789","1234567890"'));
    assert.ok(csv.includes('"\'=formula"')); assert.ok(csv.includes('"\'+unsafe"'));
    assert.equal(exported.annotations[0].label_name, '=formula');
    if (format === 'json') assert.deepEqual(packageEntry(files, 'imu.bin'), env.raw);
  }
  assert.deepEqual(await readFile(path.join(env.folder, 'imu.bin')), env.raw);
});

test('legacy sessions export empty labels; unfinished or out-of-range annotations and reserved collisions are rejected', async t => {
  const env = await fixture(t), outputFile = path.join(env.root, 'result.zip');
  env.document.annotations[0].end_ns = null;
  await writeFile(path.join(env.folder, 'annotations.json'), JSON.stringify(env.document));
  await assert.rejects(exportSession({ dataDir: env.dataDir, sessionId: env.manifest.id, format: 'json', outputFile }), /修复/);
  env.document.annotations[0].end_ns = '2000000001';
  await writeFile(path.join(env.folder, 'annotations.json'), JSON.stringify(env.document));
  await assert.rejects(exportSession({ dataDir: env.dataDir, sessionId: env.manifest.id, format: 'json', outputFile }), /范围/);
  await rm(path.join(env.folder, 'annotations.json'));
  await exportSession({ dataDir: env.dataDir, sessionId: env.manifest.id, format: 'json', outputFile });
  const files = unzip(await readFile(outputFile));
  assert.deepEqual(JSON.parse(files.get('annotations.json')).annotations, []);
  assert.equal(JSON.parse(files.get('annotations.json')).revision, 0);
  env.manifest.streams[0].id = 'annotations';
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  await assert.rejects(loadSession(env.dataDir, env.manifest.id), /conflicts/);
});
