import { packageEntry, hasPackageEntry, packagePath, packageFileMap } from './helpers/package-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { exportSession } from '../src/exports/exporter.mjs';
import { ExportManager } from '../src/exports/manager.mjs';
import { loadSession, readRecords } from '../src/exports/reader.mjs';
import { CaptureEngine } from '../src/capture/engine.mjs';

const TIME = 9007199254740993n;
function floats(values) { const data = Buffer.alloc(values.length * 4); values.forEach((value, index) => data.writeFloatLE(value, index * 4)); return data; }
function binaryRecord(sequence, count, payload) {
  const header = Buffer.alloc(32);
  header.writeBigUInt64LE(BigInt(sequence)); header.writeBigInt64LE(TIME + BigInt(sequence), 8);
  header.writeBigInt64LE(TIME + BigInt(sequence) + 1000n, 16); header.writeUInt32LE(count, 24); header.writeUInt32LE(payload.length, 28);
  return Buffer.concat([header, payload]);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-daq-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'sessions'), outputDir = path.join(root, 'exports'), folder = path.join(dataDir, 'session-test');
  await mkdir(folder, { recursive: true }); await mkdir(outputDir);
  const streams = [
    { id: 'imu', kind: 'imu', dtype: 'float32', shape: [2], sample_rate: 100, records: 2, samples: 2, payload_bytes: 16,
      channel_names: ['ax', 'ay'], payloads: [[1, floats([1.25, -2.5])], [1, floats([2.5, -5])]] },
    { id: 'audio', kind: 'audio', dtype: 'float32', shape: [1], sample_rate: 48000, records: 1, samples: 4, payload_bytes: 16,
      payloads: [[4, floats([-0.5, 0, 0.12345679, 1.5])]] },
    { id: 'camera', kind: 'camera', dtype: 'uint8', shape: [1, 2, 3], sample_rate: 15, records: 1, samples: 1, payload_bytes: 6,
      payloads: [[1, Buffer.from([255, 0, 0, 0, 255, 128])]] },
  ];
  for (const stream of streams) {
    stream.file = `${stream.id}.bin`;
    await writeFile(path.join(folder, stream.file), Buffer.concat([Buffer.from('MDAQBIN1'), ...stream.payloads.map(([count, payload], i) => binaryRecord(i + 1, count, payload))]));
    delete stream.payloads;
  }
  const manifest = { id: 'session-test', name: '中文测试', source: 'simulation', status: 'complete', finalized: true, streams,
    assets: [{ file: 'sdk-frames.jsonl', role: 'sdk-frame-metadata' }] };
  await writeFile(path.join(folder, 'sdk-frames.jsonl'), '{"sdk_sequence":123,"sdk_timestamp":"9007199254740993","packet":{"flags":3}}\n');
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  return { root, dataDir, outputDir, folder, manifest };
}

function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'ZIP end record');
  const count = buffer.readUInt16LE(end + 10), result = new Map();
  let cursor = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const compression = buffer.readUInt16LE(cursor + 10), compressed = buffer.readUInt32LE(cursor + 20), uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'), local = buffer.readUInt32LE(cursor + 42);
    const offset = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(offset, offset + compressed), bytes = compression === 0 ? raw : inflateRawSync(raw);
    assert.equal(bytes.length, uncompressed); result.set(name, bytes);
    cursor += 46 + nameLength + extra + comment;
  }
  return result;
}
function npy(buffer) {
  assert.equal(buffer.subarray(0, 6).toString('hex'), '934e554d5059');
  assert.equal(buffer[6], 1);
  const length = buffer.readUInt16LE(8);
  assert.equal((10 + length) % 64, 0);
  return { header: buffer.subarray(10, 10 + length).toString(), data: buffer.subarray(10 + length) };
}

test('four formats preserve precision, timestamps, media pixels and native reader', async t => {
  const env = await fixture(t);
  for (const format of ['csv', 'wav', 'npz', 'json']) {
    const outputFile = path.join(env.outputDir, `${format}.zip`);
    await exportSession({ dataDir: env.dataDir, sessionId: 'session-test', format, outputFile });
    const files = unzip(await readFile(outputFile));
    assert.equal(JSON.parse(files.get('manifest.json')).name, '中文测试');
    assert.equal(JSON.parse(files.get('export_report.json')).format, format);
    assert.deepEqual(files.get('sdk-frames.jsonl'), await readFile(path.join(env.folder, 'sdk-frames.jsonl')));
    if (format === 'json') {
      assert.deepEqual(packageEntry(files, 'imu.bin'), await readFile(path.join(env.folder, 'imu.bin')));
      assert.match(files.get('session_reader.mjs').toString(), /async function\* readRecords/);
      continue;
    }
    const wav = packageEntry(files, 'audio/audio.wav');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.readUInt16LE(20), 3); assert.equal(wav.readUInt32LE(46), 4);
    assert.deepEqual(wav.subarray(58), floats([-0.5, 0, 0.12345679, 1.5]));
    const png = packageEntry(files, 'camera/frame_00000000.png');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 2); assert.equal(png.readUInt32BE(20), 1);
    const compressedLength = png.readUInt32BE(33);
    assert.deepEqual(inflateSync(png.subarray(41, 41 + compressedLength)), Buffer.from([0, 255, 0, 0, 0, 255, 128]));
    if (format === 'npz') {
      const arrays = unzip(packageEntry(files, 'imu.npz'));
      const values = npy(arrays.get('data.npy'));
      assert.match(values.header, /'shape': \(2, 2\)/); assert.match(values.header, /'<f4'/);
      assert.deepEqual(values.data, floats([1.25, -2.5, 2.5, -5]));
      const time = npy(arrays.get('record_device_time_ns.npy'));
      assert.equal(time.data.readBigInt64LE(0), TIME + 1n);
      assert.equal(time.data.readBigInt64LE(8), TIME + 2n);
      const metadata = JSON.parse(npy(arrays.get('metadata_json_utf8.npy')).data.toString());
      assert.equal(metadata.id, 'imu');
    } else {
      const csv = packageEntry(files, 'imu.csv').toString();
      assert.match(csv, /"ax","ay"/); assert.ok(csv.includes((TIME + 1n).toString())); assert.ok(csv.includes('"1.25","-2.5"'));
    }
  }
});

test('reader and exporter reject truncated streams, invalid paths, incomplete sessions and unavailable formats', async t => {
  const env = await fixture(t);
  await assert.rejects(loadSession(env.dataDir, '../outside'), /Invalid session id/);
  const file = path.join(env.folder, 'imu.bin'); await truncate(file, (await readFile(file)).length - 1);
  await assert.rejects(async () => { for await (const record of readRecords(env.folder, env.manifest.streams[0])) void record; }, /Truncated/);
  const outputFile = path.join(env.outputDir, 'bad.zip');
  await assert.rejects(exportSession({ dataDir: env.dataDir, sessionId: 'session-test', format: 'csv', outputFile }), /Truncated/);
  assert.deepEqual(await readdir(env.outputDir), []);
  await assert.rejects(exportSession({ dataDir: env.dataDir, sessionId: 'session-test', format: 'parquet', outputFile }), /unavailable/);
  env.manifest.finalized = false; await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  await assert.rejects(loadSession(env.dataDir, 'session-test'), /Only finalized/);
});

test('worker job queue is bounded, completes independently, persists downloads and marks interrupted jobs', async t => {
  const env = await fixture(t);
  const manager = new ExportManager({ dataDir: env.dataDir, outputDir: env.outputDir, capacity: 1 });
  await manager.init();
  const results = await Promise.allSettled([manager.createJob({ session_id: 'session-test', format: 'npz' }), manager.createJob({ session_id: 'session-test', format: 'csv' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 429);
  const accepted = results.find(result => result.status === 'fulfilled').value;
  await manager.close();
  const complete = manager.getJob(accepted.id); assert.equal(complete.status, 'complete', complete.error);
  assert.equal(complete.progress, 1); assert.match(complete.download_url, /api\/export\/download/);
  const download = await manager.download(accepted.id); assert.ok(unzip(await readFile(download.path)).has('manifest.json'));
  await assert.rejects(manager.createJob({ session_id: 'session-test', format: 'csv' }), /closing/);
  const history = JSON.parse(await readFile(path.join(env.outputDir, 'jobs.json'), 'utf8'));
  const interrupted = { ...history.jobs[0], id: 'a'.repeat(32), job_id: 'a'.repeat(32), status: 'running', filename: 'session-test-npz-aaaaaaaa.zip', format: 'npz' };
  history.jobs.push(interrupted); await writeFile(path.join(env.outputDir, 'jobs.json'), JSON.stringify(history));
  const restored = new ExportManager({ dataDir: env.dataDir, outputDir: env.outputDir }); await restored.init();
  assert.equal(restored.getJob(complete.id).status, 'complete');
  assert.equal(restored.getJob(interrupted.id).status, 'error'); assert.match(restored.getJob(interrupted.id).error, /重启中断/);
  assert.equal((await restored.download(complete.id)).filename, complete.filename);
  await assert.rejects(restored.download('../bad'), /Invalid export job id/);
  await restored.close();
});

test('SDK byte streams preserve irregular timestamps without inventing sample rates; assets stay within session', async t => {
  const env = await fixture(t);
  const stream = { id: 'sdk-pressure', file: 'sdk-pressure.bin', kind: 'pressure', dtype: 'uint8', shape: [4],
    sample_rate: 0, sample_rate_known: false, irregular_timestamps: true, records: 1, samples: 1, payload_bytes: 4 };
  const raw = Buffer.from([0, 128, 254, 255]);
  await writeFile(path.join(env.folder, stream.file), Buffer.concat([Buffer.from('MDAQBIN1'), binaryRecord(1, 1, raw)]));
  env.manifest.streams = [stream];
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  for (const format of ['csv', 'npz']) {
    const outputFile = path.join(env.outputDir, `sdk-${format}.zip`);
    await exportSession({ dataDir: env.dataDir, sessionId: 'session-test', format, outputFile });
    const files = unzip(await readFile(outputFile));
    assert.ok(files.has('sdk-frames.jsonl'));
    if (format === 'csv') {
      const csv = packageEntry(files, 'sdk-pressure.csv').toString();
      assert.ok(csv.includes(`"${TIME + 1n}","${TIME + 1n}"`));
      assert.ok(csv.includes('"0","128","254","255"'));
    } else {
      const values = npy(unzip(packageEntry(files, 'sdk-pressure.npz')).get('data.npy'));
      assert.match(values.header, /'\|u1'/); assert.deepEqual(values.data, raw);
    }
  }
  env.manifest.assets[0].file = '../outside.jsonl';
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  await assert.rejects(loadSession(env.dataDir, 'session-test'), /Invalid stream filename/);
  env.manifest.assets[0].file = 'sdk-pressure.csv';
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  await assert.rejects(loadSession(env.dataDir, 'session-test'), /Duplicate or invalid session asset/);
});

test('actual four-device Node recording exports through the independent NPZ worker', async t => {
  const env = await fixture(t);
  const engine = new CaptureEngine({ dataDir: env.dataDir });
  const manager = new ExportManager({ dataDir: env.dataDir, outputDir: env.outputDir });
  t.after(async () => { await engine.close(); await manager.close(); });
  await engine.init(); await manager.init();
  await engine.start({ name: '四设备闭环', device_ids: engine.devices().map(device => device.id) });
  await new Promise(resolve => setTimeout(resolve, 350));
  const session = await engine.stop();
  assert.equal(session.status, 'complete'); assert.equal(session.finalized, true);
  assert.equal(session.streams.length, 4); assert.equal(session.dropped_records, 0);
  for (const stream of session.streams) assert.ok(stream.records > 0, `${stream.id} has records`);
  const job = await manager.createJob({ session_id: session.id, format: 'npz' });
  await manager.close();
  const complete = manager.getJob(job.id); assert.equal(complete.status, 'complete', complete.error);
  const files = unzip(await readFile((await manager.download(job.id)).path));
  const exportedManifest = JSON.parse(files.get('manifest.json'));
  assert.deepEqual(exportedManifest, session);
  for (const id of ['sim-pressure', 'sim-imu', 'sim-audio']) {
    const arrays = unzip(packageEntry(files, `${id}.npz`));
    const stream = session.streams.find(item => item.id === id);
    assert.equal(npy(arrays.get('data.npy')).data.length, stream.payload_bytes);
    assert.equal(npy(arrays.get('sequence.npy')).data.length / 8, stream.records);
  }
  assert.ok(hasPackageEntry(files, 'sim-camera/frames.csv'));
});

test('12-bit pressure preserves values above 255 through all exports and the standalone reader', async t => {
  const env = await fixture(t);
  const values = [0, 255, 256, 1023, 2048, 4095];
  const payload = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => payload.writeUInt16LE(value, i * 2));
  const stream = { id: 'insole', file: 'insole.bin', kind: 'pressure', dtype: 'uint16', shape: [values.length],
    sample_rate: 0, sample_rate_known: false, irregular_timestamps: true, records: 1, samples: 1, payload_bytes: payload.length,
    metadata: { product: 'insole', side: 'left', protocol: '12bit', full_scale: 4095 } };
  const rawFile = Buffer.concat([Buffer.from('MDAQBIN1'), binaryRecord(1, 1, payload)]);
  await writeFile(path.join(env.folder, stream.file), rawFile);
  env.manifest.streams = [stream];
  await writeFile(path.join(env.folder, 'manifest.json'), JSON.stringify(env.manifest));
  for (const format of ['csv', 'wav', 'npz', 'json']) {
    const outputFile = path.join(env.outputDir, `insole-${format}.zip`);
    await exportSession({ dataDir: env.dataDir, sessionId: env.manifest.id, format, outputFile });
    const files = unzip(await readFile(outputFile));
    assert.deepEqual(JSON.parse(files.get('manifest.json')).streams[0], stream);
    if (format === 'npz') {
      const data = npy(unzip(packageEntry(files, 'insole.npz')).get('data.npy'));
      assert.match(data.header, /'<u2'/); assert.match(data.header, /'shape': \(1, 6\)/);
      assert.deepEqual(data.data, payload);
    } else if (format === 'json') {
      assert.deepEqual(packageEntry(files, 'insole.bin'), rawFile);
      const exportedDir = path.join(env.root, 'standalone-reader');
      await mkdir(exportedDir);
      await writeFile(path.join(exportedDir, 'session_reader.mjs'), files.get('session_reader.mjs'));
      const exportedFilename = packagePath(files, stream.file), fileMap = packageFileMap(files);
      assert.notEqual(exportedFilename, stream.file);
      assert.match(exportedFilename, /左脚/);
      await writeFile(path.join(exportedDir, exportedFilename), packageEntry(files, stream.file));
      await assert.rejects(readFile(path.join(exportedDir, stream.file)), { code: 'ENOENT' });
      const { pathToFileURL } = await import('node:url');
      const standalone = await import(pathToFileURL(path.join(exportedDir, 'session_reader.mjs')).href);
      assert.equal(standalone.streamLayout(stream).size, 2);
      let seen = 0;
      for await (const record of standalone.readRecords(exportedDir, stream, { fileMap })) {
        assert.equal(record.deviceNs, TIME + 1n);
        assert.deepEqual(Array.from({ length: values.length }, (_, i) => record.payload.readUInt16LE(i * 2)), values);
        seen++;
      }
      assert.equal(seen, 1);
    } else assert.ok(packageEntry(files, 'insole.csv').toString().includes('"0","255","256","1023","2048","4095"'));
  }
});
