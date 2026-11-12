import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readRecords, streamPath } from '../src/exports/reader.mjs';

const alias = '左手_触觉手套_压力_COM5.bin';
const stream = Object.freeze({ id: 'glove-left', file: 'glove-left.bin', kind: 'pressure',
  dtype: 'uint8', shape: [4], sample_rate: 100, records: 1, samples: 1, payload_bytes: 4 });
const mapping = file => [{ original_file: stream.file, file, stream_id: stream.id }];
const collect = async (folder, options) => {
  const rows = [];
  for await (const record of readRecords(folder, stream, options)) rows.push(record);
  return rows;
};
async function fixture(t) {
  const temp = await realpath(os.tmpdir()), root = await mkdtemp(path.join(temp, 'daq-reader-map-'));
  const folder = path.join(root, 'package'); await mkdir(folder);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), temp);
    await rm(root, { recursive: true, force: true });
  });
  const payload = Buffer.from([0, 17, 128, 255]), header = Buffer.alloc(32);
  header.writeBigUInt64LE(7n); header.writeBigInt64LE(9007199254740993n, 8);
  header.writeBigInt64LE(9007199254741993n, 16); header.writeUInt32LE(1, 24); header.writeUInt32LE(4, 28);
  const binary = Buffer.concat([Buffer.from('MDAQBIN1'), header, payload]);
  const manifest = JSON.stringify({ id: 'source-session', streams: [stream] });
  await writeFile(path.join(folder, alias), binary); await writeFile(path.join(folder, 'manifest.json'), manifest);
  return { root, folder, binary, payload, manifest };
}

test('explicit file map reads Unicode alias with original dtype, bytes and precise timestamps', async t => {
  const env = await fixture(t), before = structuredClone(stream);
  const rows = await collect(env.folder, { fileMap: mapping(alias) });
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].payload, env.payload);
  assert.equal(rows[0].sequence, 7n); assert.equal(rows[0].deviceNs, 9007199254740993n);
  assert.equal(rows[0].hostNs, 9007199254741993n); assert.deepEqual(stream, before);
  assert.equal(await readFile(path.join(env.folder, 'manifest.json'), 'utf8'), env.manifest);
});

test('default session path stays ASCII and does not automatically guess aliases', async t => {
  const env = await fixture(t);
  await assert.rejects(collect(env.folder), /Stream file missing/);
  await assert.rejects(streamPath(env.folder, { ...stream, file: alias }), /Invalid stream filename/);
  await writeFile(path.join(env.folder, stream.file), env.binary);
  assert.deepEqual((await collect(env.folder))[0].payload, env.payload);
  assert.deepEqual((await collect(env.folder, { fileMap: [] }))[0].payload, env.payload);
});

test('legitimate unrelated directory mappings do not block a top-level raw stream', async t => {
  const env = await fixture(t);
  const fileMap = [...mapping(alias),
    { original_file: 'camera/', file: '摄像头/', stream_id: 'camera' },
    { original_file: 'camera/frames.csv', file: '摄像头/frames.csv', stream_id: 'camera' },
    { original_file: 'audio/audio.wav', file: '麦克风/audio.wav', stream_id: 'audio' }];
  assert.deepEqual((await collect(env.folder, { fileMap }))[0].payload, env.payload);
});

test('unsafe aliases, invalid source mappings and non-basename selected targets fail closed', async t => {
  const env = await fixture(t);
  const unsafe = ['../outside.bin', '..\\outside.bin', '/absolute.bin', 'C:\\outside.bin', 'C:outside.bin',
    '\\\\server\\share\\data.bin', '.', '..', '', 'name.bin ', 'name.bin.', 'name\0.bin', 'name\u007f.bin',
    'NUL.bin', 'con', 'COM1.bin', 'LPT9.wav', 'COM¹.bin', 'AUX.txt', 'CONOUT$.bin', 'bad:name.bin', 'bad?.bin',
    'folder/data.bin', 'folder/', 'a'.repeat(256)];
  for (const file of unsafe) await assert.rejects(streamPath(env.folder, stream, { fileMap: mapping(file) }),
    /Invalid package file mapping|does not match this stream/, JSON.stringify(file));
  await assert.rejects(streamPath(env.folder, stream, { fileMap: null }), /Invalid package/);
  await assert.rejects(streamPath(env.folder, stream, { fileMap: [{ original_file: '../bad', file: alias }] }), /Invalid package/);
});

test('duplicate, case-conflicting, canonical and wrong-stream mappings are rejected', async t => {
  const env = await fixture(t), first = mapping(alias)[0];
  for (const second of [
    { ...first }, { ...first, file: 'other.bin' },
    { ...first, original_file: 'GLOVE-LEFT.bin', file: 'other.bin' },
    { original_file: 'other.bin', file: alias, stream_id: 'other' },
  ]) await assert.rejects(streamPath(env.folder, stream, { fileMap: [first, second] }), /Ambiguous package/);
  await assert.rejects(streamPath(env.folder, stream, { fileMap: [
    ...mapping(alias), { original_file: 'a.bin', file: 'A.bin' }, { original_file: 'b.bin', file: 'a.BIN' },
  ] }), /Ambiguous package/);
  await assert.rejects(streamPath(env.folder, stream, { fileMap: [
    ...mapping(alias), { original_file: 'a.bin', file: 'é.bin' }, { original_file: 'b.bin', file: 'e\u0301.bin' },
  ] }), /Ambiguous package/);
  await assert.rejects(streamPath(env.folder, stream, { fileMap: [{ ...first, original_file: 'GLOVE-LEFT.bin' }] }), /does not match/);
  await assert.rejects(streamPath(env.folder, stream, { fileMap: [{ ...first, stream_id: 'other' }] }), /does not match/);
  await assert.rejects(streamPath(env.folder, stream, { fileMap: [{ original_file: 'other.bin', file: stream.file }] }), /Ambiguous package/);
});

test('mapped symlink outside the package is rejected after realpath resolution', async t => {
  const env = await fixture(t), outside = path.join(env.root, 'outside.bin'), link = '外部链接.bin';
  await writeFile(outside, env.binary);
  try { await symlink(outside, path.join(env.folder, link), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit file symlinks'); return; } throw error; }
  await assert.rejects(streamPath(env.folder, stream, { fileMap: mapping(link) }), /outside session directory/);
});

test('Windows directory junction cannot escape the package through a mapped basename', { skip: process.platform !== 'win32' }, async t => {
  const env = await fixture(t), outside = path.join(env.root, 'outside-directory'), link = '目录链接.bin';
  await mkdir(outside); await writeFile(path.join(outside, 'data.bin'), env.binary);
  await symlink(outside, path.join(env.folder, link), 'junction');
  assert.equal(await realpath(path.join(env.folder, link)), await realpath(outside));
  await assert.rejects(streamPath(env.folder, stream, { fileMap: mapping(link) }), /outside session directory/);
});
