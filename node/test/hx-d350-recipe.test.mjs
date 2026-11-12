import test from 'node:test';
import assert from 'node:assert/strict';
import { HX_D350_MANIFEST, HX_D350_ADAPTER } from '../src/integration/recipes/hx-d350-rtsp.mjs';
import { validateManifest, validateConfig } from '../src/plugins/contract.mjs';

const { createAdapter } = await import(`data:text/javascript;base64,${Buffer.from(HX_D350_ADAPTER).toString('base64')}`);

test('HX-D350 recipe validates with two unassigned channels and no mandatory probe address', () => {
  const manifest = validateManifest(HX_D350_MANIFEST);
  assert.deepEqual(validateConfig(manifest, {}), {});
  assert.deepEqual(manifest.streams.map(stream => stream.id), ['channel-1254', 'channel-1256']);
  for (const stream of manifest.streams) {
    assert.deepEqual(stream.shape, [1200, 1600, 3]);
    assert.equal(stream.sample_rate_known, false);
    assert.match(stream.name, /左右待确认/);
  }
});

test('dependency probe never creates a source, requires no hardware and propagates failed dependency', async () => {
  let probed = 0;
  const adapter = createAdapter({ media: {
    async probe() { probed++; return { ok: true }; },
    createRtspSource() { assert.fail('probe must not create a hardware source'); },
  } });
  assert.equal((await adapter.probe()).hardware_verified, false);
  assert.equal(probed, 1);
  await adapter.stop();
  const failed = createAdapter({ media: { async probe() { return { ok: false }; }, createRtspSource() {} } });
  await assert.rejects(failed.probe(), /自检失败/);
});

test('RTSP starts both fixed ports, waits for actual source readiness and stops idempotently', async () => {
  const calls = [], ready = [], stopped = [];
  const adapter = createAdapter({ config: { camera_ip: 'ego-camera.local' }, media: {
    async probe() {},
    createRtspSource(options) {
      calls.push(options);
      return { start: () => new Promise(resolve => ready.push(resolve)), async stop() { stopped.push(options.stream_id); } };
    },
  } });
  let started = false;
  const start = adapter.start().then(() => { started = true; });
  assert.deepEqual(calls, [1254, 1256].map(port => ({ stream_id: `channel-${port}`, url: `rtsp://ego-camera.local:${port}`, transport: 'tcp' })));
  ready[0]();
  await Promise.resolve();
  assert.equal(started, false);
  ready[1]();
  await start;
  await adapter.stop();
  await adapter.stop();
  assert.deepEqual(stopped, ['channel-1254', 'channel-1256']);
});

test('a failed channel cleans up both sources; invalid host does not open either source', async () => {
  const stopped = [];
  const media = {
    async probe() {},
    createRtspSource({ stream_id }) {
      return { async start() { if (stream_id.endsWith('1256')) throw new Error('second channel unavailable'); }, async stop() { stopped.push(stream_id); } };
    },
  };
  const adapter = createAdapter({ config: { camera_ip: '192.168.1.100' }, media });
  await assert.rejects(adapter.start(), /second channel unavailable/);
  assert.deepEqual(stopped, ['channel-1254', 'channel-1256']);
  await adapter.stop();
  assert.equal(stopped.length, 2);
  for (const camera_ip of ['', 'rtsp://camera:1254', 'user:password@camera', 'camera/path', '300.1.1.1']) {
    const invalid = createAdapter({ config: { camera_ip }, media: { ...media, createRtspSource() { assert.fail('invalid address must not reach media bridge'); } } });
    await assert.rejects(invalid.start(), /IP|主机名/);
  }
});
