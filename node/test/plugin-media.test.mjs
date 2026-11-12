import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PpmFrames, validateRtspUrl, buildRtspArgs, createManagedMedia, probeMedia } from '../src/plugins/media.mjs';
import { probePackage } from '../src/plugins/manager.mjs';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { createRtspFixture } from './helpers/rtsp-fixture.mjs';

const manifest = { streams: [{ id: 'rgb', kind: 'camera', dtype: 'uint8', shape: [16, 16, 3] }] };
const ppm = payload => Buffer.concat([Buffer.from('P6\n2 1\n255\n'), payload]);
async function until(check, timeout = 3000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started >= timeout) throw new Error('Media fixture condition timed out'); await delay(20); }
}

test('PPM parser preserves binary frame bytes across arbitrary header and payload boundaries', () => {
  const expected = [Buffer.from([10, 0, 32, 80, 54, 255]), Buffer.from([1, 2, 3, 4, 5, 6])];
  const bytes = Buffer.concat(expected.map(ppm));
  for (let split = 1; split < bytes.length; split++) {
    const actual = [], parser = new PpmFrames({ width: 2, height: 1, onFrame: frame => actual.push(frame) });
    parser.push(bytes.subarray(0, split)); parser.push(bytes.subarray(split));
    assert.deepEqual(actual, expected); assert.equal(parser.partial, false);
  }
  const actual = [], parser = new PpmFrames({ width: 2, height: 1, onFrame: frame => actual.push(frame) });
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  assert.deepEqual(actual, expected);
});

test('PPM parser rejects mismatched dimensions, oversized headers, unsafe sizes and downstream backpressure', () => {
  const create = onFrame => new PpmFrames({ width: 2, height: 1, onFrame });
  assert.throws(() => create(() => {}).push(Buffer.from('P6\n1 2\n255\n')), /实际输出.*不一致/);
  assert.throws(() => create(() => {}).push(Buffer.alloc(257, 65)), /帧头损坏/);
  assert.throws(() => new PpmFrames({ width: 0, height: 1, onFrame() {} }), /尺寸/);
  assert.throws(() => new PpmFrames({ width: -2, height: -2, onFrame() {} }), /尺寸/);
  assert.throws(() => new PpmFrames({ width: 1.5, height: 2, onFrame() {} }), /尺寸/);
  assert.throws(() => new PpmFrames({ width: 100000, height: 100000, onFrame() {} }), /尺寸/);
  assert.throws(() => create(() => false).push(ppm(Buffer.alloc(6))), /宿主拒绝/);
  const partial = create(() => {}); partial.push(ppm(Buffer.alloc(6)).subarray(0, -1)); assert.equal(partial.partial, true);
});

test('RTSP addresses are strict and remain one argument with no shell or secondary-protocol injection', () => {
  const url = 'rtsp://camera:password@127.0.0.1:554/live?track=1&test=2';
  assert.equal(validateRtspUrl(url), url);
  const args = buildRtspArgs({ url });
  assert.equal(args[args.indexOf('-i') + 1], url);
  assert.equal(args.filter(item => item === url).length, 1);
  assert.equal(args.at(-1), 'pipe:1');
  assert.equal(args.includes('-vf'), false); assert.equal(args.includes('-r'), false);
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1].includes('file'), false);
  for (const bad of ['file:///C:/secret', 'https://example.com/live', 'rtsp://', 'rtsp://cam/live\n-i file:secret',
    'rtsp://cam/live\0', 'rtsp://cam/live#fragment', '-i rtsp://cam/live', 'rtsp://cam/' + 'a'.repeat(2048)]) {
    assert.throws(() => validateRtspUrl(bad));
  }
  assert.throws(() => buildRtspArgs({ url, transport: 'tcp -i file:secret' }), /transport/);
  for (const timeoutMs of [NaN, Infinity, -100, 1.5, 99, 10001]) assert.throws(() => buildRtspArgs({ url, timeoutMs }), /超时/);
});

test('bundled decoder probe verifies software only and probe-mode sources never open a camera', async t => {
  const fixture = await createRtspFixture(); t.after(() => fixture.close());
  const errors = [], children = [];
  const media = createManagedMedia({ manifest, probeOnly: true, emit: () => { throw new Error('probe must not emit'); }, error: error => errors.push(error), onChild: child => children.push(child) });
  t.after(() => media.close());
  const result = await probeMedia();
  assert.equal(result.ok, true); assert.equal(result.hardware_verified, false); assert.equal(result.source_timestamps, false);
  assert.match(result.decoder, /^ffmpeg version /);
  const source = media.api.createRtspSource({ stream_id: 'rgb', url: fixture.url });
  await assert.rejects(source.start(), /测试期间禁止/);
  assert.equal(fixture.connections, 0); assert.deepEqual(children, []); assert.deepEqual(errors, []);
  assert.throws(() => media.api.createRtspSource({ stream_id: 'rgb', url: fixture.url }), /唯一/);
  await media.close(); assert.throws(() => media.api.createRtspSource({ stream_id: 'rgb', url: fixture.url }), /已关闭/);
});

test('real bundled FFmpeg receives loopback RTSP H264, emits RGB frames, and exits on stop', { timeout: 20000 }, async t => {
  const fixture = await createRtspFixture(); t.after(() => fixture.close());
  const frames = [], errors = [], children = [];
  const media = createManagedMedia({ manifest, emit: frame => { frames.push(frame); return true; }, error: error => errors.push(error), onChild: child => children.push(child) });
  t.after(() => media.close());
  const source = media.api.createRtspSource({ stream_id: 'rgb', url: fixture.url });
  await source.start(); await until(() => frames.length >= 3);
  assert.equal(fixture.connections, 1); assert.ok(fixture.sent >= frames.length);
  for (const frame of frames) {
    assert.equal(frame.stream_id, 'rgb'); assert.equal(frame.sample_count, 1); assert.equal(frame.payload.length, 16 * 16 * 3);
    assert.ok(frame.payload[0] > 240 && frame.payload[1] < 10 && frame.payload[2] < 10, 'decoded red RGB pixels');
    assert.equal(frame.device_time_ns, undefined); assert.equal(frame.sequence, undefined);
  }
  await source.stop(); await media.close(); const count = frames.length; await delay(150);
  assert.equal(frames.length, count); assert.deepEqual(errors, []);
  assert.ok(children.some(child => child.started && child.pid > 0));
  assert.ok(children.some(child => !child.started && child.pid === children[0].pid));
  await until(() => fixture.openSockets === 0);
});

test('RTSP dimension mismatch fails connection and terminates decoder without emitting partial data', { timeout: 20000 }, async t => {
  const fixture = await createRtspFixture(); t.after(() => fixture.close());
  const errors = [], children = [];
  const media = createManagedMedia({ manifest: { streams: [{ ...manifest.streams[0], shape: [32, 32, 3] }] },
    emit: () => { throw new Error('wrong-size frame must never emit'); }, error: error => errors.push(error), onChild: child => children.push(child) });
  t.after(() => media.close());
  const source = media.api.createRtspSource({ stream_id: 'rgb', url: fixture.url });
  await assert.rejects(source.start(), /实际输出 16×16.*32×32/);
  await media.close(); assert.equal(errors.length, 1);
  assert.ok(children.some(child => child.started === false)); await until(() => fixture.openSockets === 0);
});

test('stopping while RTSP awaits its first frame rejects the pending start and releases the child', { timeout: 10000 }, async t => {
  const fixture = await createRtspFixture({ silent: true }); t.after(() => fixture.close());
  const errors = [], children = [];
  const media = createManagedMedia({ manifest, emit: () => { throw new Error('silent source'); }, error: error => errors.push(error), onChild: child => children.push(child) });
  t.after(() => media.close());
  const source = media.api.createRtspSource({ stream_id: 'rgb', url: fixture.url });
  const started = assert.rejects(source.start(), /已停止/);
  await until(() => fixture.connections === 1); await source.stop(); await started;
  assert.deepEqual(errors, []); assert.ok(children.some(child => child.started === false));
  await assert.rejects(source.start(), /已停止/);
});

test('isolated SDK host probes, previews, records decoded RTSP bytes with host clocks, and releases the camera on disconnect', { timeout: 25000 }, async t => {
  const fixture = await createRtspFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'capture-media-host-test-'));
  const pluginRoot = path.join(directory, 'plugins'), packageDir = path.join(pluginRoot, 'fixture-rtsp');
  let engine;
  t.after(async () => {
    try { await engine?.close(); }
    finally {
      await fixture.close();
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('capture-media-host-test-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'plugin.json'), JSON.stringify({
    api_version: 1, id: 'fixture-rtsp', name: 'Test-only RTSP bridge camera', version: '1.0.0', entry: 'adapter.mjs',
    streams: [{ ...manifest.streams[0], name: 'RGB fixture', sample_rate: 10 }],
    config_fields: [{ key: 'url', label: 'RTSP URL', type: 'string', required: true }],
  }));
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter({config,media}) {
    const source = media.createRtspSource({ stream_id: 'rgb', url: config.url });
    return { probe: () => media.probe(), start: () => source.start(), stop: () => source.stop() };
  }`);
  const probe = await probePackage(packageDir, { config: { url: fixture.url } });
  assert.equal(probe.passed, true); assert.equal(probe.hardware_verified, false);
  assert.equal(probe.details.ok, true); assert.equal(probe.details.source_timestamps, false);
  assert.equal(fixture.connections, 0, 'isolated dependency probe must not open RTSP');

  engine = new CaptureEngine({ dataDir: path.join(directory, 'sessions'), pluginRoot, sdkPath: false });
  await engine.init();
  assert.equal((await engine.pluginCatalog()).plugins[0].id, 'fixture-rtsp');
  const connected = await engine.pluginConnect({ plugin_id: 'fixture-rtsp', instance_id: 'rtsp-host', config: { url: fixture.url } });
  assert.equal(connected.connected, true); assert.equal(connected.data_received, true); assert.equal(connected.hardware_verified, false);
  const streamId = 'plugin-rtsp-host-rgb';
  assert.deepEqual(connected.stream_ids, [streamId]);
  await until(() => engine.preview().streams?.[streamId]?.camera);
  const preview = engine.preview().streams[streamId].camera;
  assert.equal(preview.width, 16); assert.equal(preview.height, 16);
  assert.ok(Buffer.from(preview.rgb_base64, 'base64')[0] > 240);

  const session = await engine.start({ name: 'Test-only RTSP recording', device_ids: [streamId] });
  await delay(150);
  const recorded = await engine.stop();
  assert.equal(recorded.status, 'complete'); assert.equal(recorded.source, 'sdk-plugin'); assert.equal(recorded.simulated, false);
  assert.equal(recorded.streams.length, 1);
  const stream = recorded.streams[0]; assert.ok(stream.records >= 1); assert.equal(stream.metadata.timestamp_source, 'host-receive');
  const data = await readFile(path.join(directory, 'sessions', session.id, stream.file));
  assert.equal(data.subarray(0, 8).toString(), 'MDAQBIN1');
  const recordSize = 32 + 16 * 16 * 3;
  assert.equal(data.length, 8 + stream.records * recordSize);
  let previousSequence = -1n, previousHost = 0n;
  for (let offset = 8; offset < data.length; offset += recordSize) {
    const sequence = data.readBigUInt64LE(offset), elapsed = data.readBigInt64LE(offset + 8), host = data.readBigInt64LE(offset + 16);
    assert.ok(sequence > previousSequence); assert.ok(host > previousHost); assert.ok(elapsed > 0n && host > elapsed);
    assert.equal(data.readUInt32LE(offset + 24), 1); assert.equal(data.readUInt32LE(offset + 28), 16 * 16 * 3);
    assert.ok(data[offset + 32] > 240 && data[offset + 33] < 10 && data[offset + 34] < 10);
    previousSequence = sequence; previousHost = host;
  }
  const metadata = (await readFile(path.join(directory, 'sessions', session.id, 'plugin-frames.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(metadata.length, stream.records);
  for (const record of metadata) {
    assert.equal(record.stream_id, streamId); assert.equal(record.timestamp_source, 'host-receive');
    assert.equal(record.source_device_time_ns, null); assert.equal(record.source_sequence, null); assert.equal(record.hardware_synchronized, false);
  }
  await engine.pluginDisconnect({ instance_id: 'rtsp-host' });
  await until(() => fixture.openSockets === 0);
  assert.equal((await engine.pluginCatalog()).instances[0].connected, false);
  assert.equal(fixture.connections, 1);
});
