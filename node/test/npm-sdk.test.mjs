import { packageEntry } from './helpers/package-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Shroom } from 'shroom-sdk/node';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { ExportManager } from '../src/exports/manager.mjs';
import { readRecords } from '../src/exports/reader.mjs';

async function eventually(check, label) {
  const deadline = Date.now() + 4000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'ZIP end record exists');
  const entries = buffer.readUInt16LE(end + 10), result = new Map();
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < entries; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const compression = buffer.readUInt16LE(offset + 10);
    const packedSize = buffer.readUInt32LE(offset + 20), unpackedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = buffer.readUInt32LE(offset + 42);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(start, start + packedSize);
    assert.ok([0, 8].includes(compression));
    const data = compression === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(data.length, unpackedSize);
    result.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function npy(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '934e554d50590100');
  const length = buffer.readUInt16LE(8);
  return { header: buffer.subarray(10, 10 + length).toString(), payload: buffer.subarray(10 + length) };
}

test('installed npm Shroom SDK mock flows through preview, recording, sidecar and NPZ without a port or license', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'synapse-npm-sdk-'));
  const dataDir = path.join(root, 'sessions'), outputDir = path.join(root, 'exports');
  // No sdkPath: this must load the installed shroom-sdk/node package rather than a fixture checkout.
  const engine = new CaptureEngine({ dataDir });
  const exporter = new ExportManager({ dataDir, outputDir });
  t.after(async () => {
    await engine.close();
    await exporter.close();
    await rm(root, { recursive: true, force: true });
  });

  const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Shroom.version, packageManifest.dependencies['shroom-sdk'], 'installed SDK matches the project-pinned version');
  assert.equal(typeof Shroom.mock, 'function');
  await engine.init();
  await exporter.init();
  const info = await engine.sdkInfo();
  assert.equal(info.loaded, true, info.error);
  assert.equal(info.version, Shroom.version);
  assert.equal(info.source, 'npm');
  assert.equal(info.connected, false);

  const connected = await engine.sdkConnect({ mode: 'mock' });
  assert.equal(connected.connected, true);
  assert.equal(connected.mode, 'sdk-mock');
  await eventually(async () => (await engine.sdkInfo()).frames >= 3, 'npm SDK mock frames');
  const device = engine.devices().find(item => item.id === 'sdk-pressure');
  assert.ok(device?.connected);
  assert.equal(device.simulated, true);
  assert.equal(device.dtype, 'uint8');
  assert.deepEqual(device.shape, [1024]);
  assert.equal(device.unit, 'ADC');
  assert.equal(device.sample_rate, 20);

  const preview = engine.preview().streams['sdk-pressure'].pressure;
  assert.equal(preview.rows, 32); assert.equal(preview.cols, 32);
  assert.equal(preview.values.length, 1024);
  assert.ok(preview.values.every(value => Number.isFinite(value) && value >= 0 && value <= 255.001));
  assert.ok(Math.max(...preview.values) > 100, 'normalized SDK preview is converted back to ADC display units');

  const before = Date.now();
  await engine.start({ name: 'npm SDK 模拟闭环', device_ids: ['sdk-pressure'] });
  await assert.rejects(engine.sdkDisconnect(), error => error.statusCode === 409);
  await eventually(() => engine.status().record_counts['sdk-pressure'] >= 4, 'recorded SDK frames');
  const session = await engine.stop();
  const after = Date.now();
  assert.equal(session.status, 'complete', session.error);
  assert.equal(session.finalized, true);
  assert.equal(session.simulated, true);
  assert.equal(session.source, 'shroom-sdk');
  assert.equal(session.dropped_records, 0);
  assert.equal(session.streams.length, 1);
  assert.ok(session.assets.some(asset => asset.file === 'sdk-frames.jsonl'));
  const stream = session.streams[0];
  const folder = path.join(dataDir, session.id);
  const records = [];
  for await (const record of readRecords(folder, stream)) records.push(record);
  assert.equal(records.length, stream.records);
  assert.ok(records.length >= 4);
  for (const record of records) {
    assert.equal(record.sampleCount, 1);
    assert.equal(record.payload.length, 1024);
    assert.ok(new Set(record.payload).size > 20, 'actual SDK mock produces a nonconstant ADC matrix');
  }

  const sidecar = await readFile(path.join(folder, 'sdk-frames.jsonl'));
  const metadata = sidecar.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(metadata.length, records.length);
  metadata.forEach((item, index) => {
    assert.equal(item.stream_id, 'sdk-pressure');
    assert.equal(item.sequence, records[index].sequence.toString());
    assert.equal(item.host_time_ns, records[index].hostNs.toString());
    assert.ok(Number.isInteger(item.sdk_timestamp_ms) && item.sdk_timestamp_ms >= before && item.sdk_timestamp_ms <= after);
    // Generic SDK mock frames contain timestamps, but do not manufacture protocol sequence/type fields.
    assert.equal(item.sdk_sequence, null);
    assert.equal(item.packet_type, null);
  });

  const job = await exporter.createJob({ session_id: session.id, format: 'npz' });
  await exporter.close();
  const finished = exporter.getJob(job.id);
  assert.equal(finished.status, 'complete', finished.error);
  const bundle = unzip(await readFile((await exporter.download(job.id)).path));
  assert.deepEqual(bundle.get('sdk-frames.jsonl'), sidecar);
  assert.deepEqual(JSON.parse(bundle.get('manifest.json')), session);
  const arrays = unzip(packageEntry(bundle, 'sdk-pressure.npz'));
  const data = npy(arrays.get('data.npy'));
  assert.match(data.header, /'\|u1'/);
  assert.ok(data.header.includes(`(${stream.samples}, 1024)`));
  assert.deepEqual(data.payload, Buffer.concat(records.map(record => record.payload)));
  const timestamps = npy(arrays.get('record_host_time_ns.npy')).payload;
  records.forEach((record, index) => assert.equal(timestamps.readBigInt64LE(index * 8), record.hostNs));

  const disconnected = await engine.sdkDisconnect();
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.has_device, false);
  assert.equal(engine.devices().some(item => item.id === 'sdk-pressure'), false);
  assert.equal(engine.preview().streams['sdk-pressure'], undefined);
});
