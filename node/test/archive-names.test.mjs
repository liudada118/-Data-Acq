import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { allocateExportArchiveName, createExportArchiveName } from '../src/exports/package-names.mjs';
import { ExportManager } from '../src/exports/manager.mjs';

test('download filename uses recording name, recorded Shanghai start and uppercase format', () => {
  assert.equal(createExportArchiveName({ name: '多模态实验 11/05', started_at: '2026-11-05T08:14:00.201Z', format: 'csv' }),
    '多模态实验 11-05_2026-11-05_16-14-00_CSV.zip');
  assert.equal(createExportArchiveName({ name: '夜间采集', started_at: '2026-11-05T18:01:02Z', format: 'npz' }),
    '夜间采集_2026-11-06_02-01-02_NPZ.zip');
  assert.equal(createExportArchiveName({ name: '任务', started_at: '2026-11-05T16:14:00+08:00', format: 'json', recovery: true, sequence: 2 }),
    '任务_2026-11-05_16-14-00_JSON_数据不完整_2.zip');
});

test('unknown or invalid timestamp is never replaced by the export time or server local time', () => {
  for (const started_at of [null, undefined, '', '2026-11-05', '2026-11-05T08:00:00', '2026-02-30T08:00:00Z', '2026-11-05T24:01:00Z', { toString: null }]) {
    assert.equal(createExportArchiveName({ started_at, format: 'wav' }), '未命名录制_时间未知_WAV.zip');
  }
  assert.match(createExportArchiveName({ name: 'CON', started_at: '2024-02-29T01:02:03Z', format: 'csv' }),
    /^设备_CON_2024-02-29_09-02-03_CSV\.zip$/);
});

test('same visible name is disambiguated only when needed with a short sequence', () => {
  const options = { name: 'recording', started_at: '2026-11-05T08:14:00Z', format: 'csv' };
  const first = allocateExportArchiveName(options);
  assert.equal(first.sequence, 1); assert.doesNotMatch(first.filename, /_1\.zip$/);
  const second = allocateExportArchiveName(options, [first.filename.toUpperCase()]);
  assert.equal(second.sequence, 2); assert.match(second.filename, /_CSV_2\.zip$/);
  const third = allocateExportArchiveName(options, [first.filename, second.filename]);
  assert.equal(third.sequence, 3);
  assert.throws(() => createExportArchiveName({ sequence: 0 }), /Invalid export filename sequence/);
});

test('archive display names are Windows-safe and fit the full UTF16 filename budget', () => {
  const name = createExportArchiveName({ name: '🎤'.repeat(200) + '<>:/\\\u0085', started_at: '2026-11-05T08:14:00Z',
    format: 'csv', recovery: true, sequence: 999999 });
  assert.ok(name.length <= 255); assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/);
  assert.match(name, /_2026-11-05_16-14-00_CSV_数据不完整_999999\.zip$/);
});

test('history upgrades legacy display names from bounded source metadata while retaining job IDs', async t => {
  // JSON metadata only: no archive file, worker, export or payload conversion is created.
  const root = await mkdtemp(path.join(os.tmpdir(), 'shroom-export-name-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'sessions'), outputDir = path.join(root, 'exports');
  await mkdir(path.join(dataDir, 'session-one'), { recursive: true }); await mkdir(outputDir);
  await writeFile(path.join(dataDir, 'session-one', 'manifest.json'), JSON.stringify({ id: 'session-one', name: '多模态实验 11/05', started_at: '2026-11-05T08:14:00.201Z' }));
  const legacy = (letter, session = 'session-one') => ({ id: letter.repeat(32), job_id: letter.repeat(32), session_id: session,
    format: 'csv', status: 'error', filename: `${session}-csv-${letter.repeat(8)}.zip`, error: 'fixture', progress: 0 });
  const a = legacy('a'), b = legacy('b'), missing = legacy('c', 'session-missing');
  const modern = { ...legacy('d'), filename_version: 1, recording_name: '另一次录制', recording_started_at: null, filename_sequence: 1,
    filename: createExportArchiveName({ name: '另一次录制', format: 'csv' }) };
  const unsafe = { ...legacy('e'), filename: '../escape.zip' };
  const malformed = { ...legacy('f'), filename_version: 1, recording_name: { toString: null }, recording_started_at: null, filename_sequence: 1 };
  await writeFile(path.join(outputDir, 'jobs.json'), JSON.stringify({ schema_version: 1, jobs: [a, b, missing, modern, unsafe, malformed] }));
  const manager = await new ExportManager({ dataDir, outputDir }).init();
  assert.equal(manager.listJobs().length, 4);
  assert.equal(manager.getJob(a.id).filename, '多模态实验 11-05_2026-11-05_16-14-00_CSV.zip');
  assert.equal(manager.getJob(b.id).filename, '多模态实验 11-05_2026-11-05_16-14-00_CSV_2.zip');
  assert.equal(manager.getJob(a.id).session_id, a.session_id); assert.equal(manager.getJob(a.id).id, a.id);
  assert.equal(manager.getJob(missing.id).filename, missing.filename);
  assert.equal(manager.getJob(modern.id).filename, modern.filename);
  const saved = JSON.parse(await readFile(path.join(outputDir, 'jobs.json'), 'utf8'));
  assert.equal(saved.jobs[0].filename_version, 1); assert.equal(saved.jobs[0].recording_started_at, '2026-11-05T08:14:00.201Z');
  await manager.close();
  const reloaded = await new ExportManager({ dataDir, outputDir }).init();
  assert.deepEqual(reloaded.listJobs(), manager.listJobs()); await reloaded.close();
  assert.deepEqual(await readdir(outputDir), ['jobs.json']);
});

test('legacy migration reserves existing modern filenames and leaves mismatched metadata alone', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shroom-export-name-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'sessions'), outputDir = path.join(root, 'exports');
  await mkdir(path.join(dataDir, 'session-one'), { recursive: true }); await mkdir(path.join(dataDir, 'session-other')); await mkdir(outputDir);
  await writeFile(path.join(dataDir, 'session-one', 'manifest.json'), JSON.stringify({ session_id: 'session-one', name: 'task', started_at: null }));
  await writeFile(path.join(dataDir, 'session-other', 'manifest.json'), JSON.stringify({ session_id: 'wrong-session', name: 'unrelated' }));
  const legacy = { id: '1'.repeat(32), job_id: '1'.repeat(32), session_id: 'session-one', format: 'csv', status: 'pending', filename: 'session-one-csv-11111111.zip' };
  const modern = { id: '2'.repeat(32), job_id: '2'.repeat(32), session_id: 'session-one', format: 'csv', status: 'error', filename_version: 1,
    recording_name: 'task', recording_started_at: null, filename_sequence: 1, filename: 'task_时间未知_CSV.zip' };
  const mismatch = { id: '3'.repeat(32), job_id: '3'.repeat(32), session_id: 'session-other', format: 'csv', status: 'error', filename: 'session-other-csv-33333333.zip' };
  await writeFile(path.join(outputDir, 'jobs.json'), JSON.stringify({ schema_version: 1, jobs: [legacy, modern, mismatch] }));
  const manager = await new ExportManager({ dataDir, outputDir }).init();
  assert.equal(manager.getJob(legacy.id).filename, 'task_时间未知_CSV_2.zip');
  assert.equal(manager.getJob(legacy.id).status, 'error');
  assert.match(manager.getJob(legacy.id).error, /重启中断/);
  assert.equal(manager.getJob(mismatch.id).filename, mismatch.filename);
  assert.equal(manager.worker, null); assert.deepEqual(await readdir(outputDir), ['jobs.json']);
  await manager.close();
});
