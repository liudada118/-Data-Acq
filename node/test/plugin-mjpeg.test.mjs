import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { validateManifest, validFramePayload, MAX_FRAME_BYTES } from '../src/plugins/contract.mjs';
import { inspectJpeg, jpegPreview, MAX_JPEG_PREVIEW_BYTES } from '../src/plugins/mjpeg.mjs';
import { createStreamQuality, observeStreamQuality, streamQualitySnapshot } from '../src/plugins/stream-quality.mjs';
import { PluginManager } from '../src/plugins/manager.mjs';

// Marker structure fixture only: tests intentionally do not claim entropy decoding.
function jpeg(width = 3, height = 2) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xda, 0, 12, 3, 1, 0, 2, 0, 3, 0, 0, 63, 0,
    42, 0xff, 0, 42, 0xff, 0xd0, 42, 0xff, 0xd9]);
}
const baseManifest = {
  api_version: 1, id: 'mjpeg-fixture', name: 'Test-only MJPEG SDK', version: '1.0.0', entry: 'adapter.mjs',
  streams: [{ id: 'camera', name: 'Fixture JPEG', kind: 'camera', dtype: 'uint8', encoding: 'mjpeg', shape: [2, 3, 3], sample_rate: 30 }],
};

test('MJPEG manifest uses decoded dimensions while payload validation retains fixed RGB contracts', () => {
  const [stream] = validateManifest(baseManifest).streams;
  assert.equal(stream.metadata.pixel_format, 'mjpeg'); assert.equal(stream.encoding, 'mjpeg');
  assert.equal(validFramePayload(stream, jpeg(), 1), true);
  assert.equal(validFramePayload(stream, Buffer.from([0]), 1), true, 'invalid JPEG bytes remain recordable');
  assert.equal(validFramePayload(stream, Buffer.alloc(0), 1), false);
  assert.equal(validFramePayload(stream, jpeg(), 2), false);
  assert.equal(validFramePayload(stream, Buffer.alloc(MAX_FRAME_BYTES + 1), 1), false);
  const [rgb] = validateManifest({ ...baseManifest, streams: [{ ...baseManifest.streams[0], encoding: undefined }] }).streams;
  assert.equal(rgb.encoding, 'rgb8'); assert.equal(validFramePayload(rgb, Buffer.alloc(18), 1), true);
  assert.equal(validFramePayload(rgb, jpeg(), 1), false);
  assert.throws(() => validateManifest({ ...baseManifest, streams: [{ ...baseManifest.streams[0], encoding: 'h264' }] }), /encoding/);
});

test('JPEG inspection preserves original bytes, permits tails and skips marker-like bytes inside metadata', () => {
  const image = jpeg(), withMetadata = Buffer.concat([image.subarray(0, 2), Buffer.from([255, 225, 0, 6, 255, 217, 1, 2]), image.subarray(2)]);
  const original = Buffer.from(withMetadata);
  assert.equal(inspectJpeg(withMetadata, { width: 3, height: 2 }).status, 'ok');
  assert.deepEqual(withMetadata, original);
  const withTail = Buffer.concat([image, Buffer.from([1, 2, 3, 4])]);
  const inspected = inspectJpeg(withTail, { width: 3, height: 2 });
  assert.equal(inspected.status, 'warning'); assert.equal(inspected.trailing_bytes, 4);
  assert.equal(inspected.preview_allowed, true); assert.equal(inspected.decoder_verified, false);
  const view = jpegPreview(withTail, { width: 3, height: 2 }, 5n, inspected);
  assert.deepEqual(Buffer.from(view.jpeg_base64, 'base64'), withTail, 'preview must not rewrite or trim original JPEG');
});

test('missing markers, dimension mismatch and excessive decoded images are explicit invalid previews', () => {
  for (const bytes of [Buffer.from([0, 1, 2]), jpeg().subarray(0, -2), jpeg(4000, 4000), jpeg(4, 2)]) {
    const status = inspectJpeg(bytes, { width: 3, height: 2 });
    assert.equal(status.status, 'invalid'); assert.equal(status.preview_allowed, false);
    const view = jpegPreview(bytes, { width: 3, height: 2 }, 0n, status);
    assert.equal(view.preview_status, 'invalid-jpeg'); assert.equal(view.jpeg_base64, undefined);
  }
  const tooLarge = Buffer.concat([jpeg(), Buffer.alloc(MAX_JPEG_PREVIEW_BYTES)]);
  const view = jpegPreview(tooLarge, { width: 3, height: 2 }, 0n);
  assert.equal(view.preview_status, 'jpeg-too-large'); assert.equal(view.jpeg_base64, undefined);
});

test('source index diagnostics distinguish gaps, duplicates, reversals and unknown intervals exactly', () => {
  const state = createStreamQuality();
  assert.equal(streamQualitySnapshot(state).source_missing_frames, null);
  const events = [100n, 101n, 104n, 104n, 10n, 11n, null, 13n, 14n].map(value => observeStreamQuality(state, value));
  assert.deepEqual(events.map(event => event.source_sequence_status), ['first', 'continuous', 'gap', 'duplicate', 'reversal', 'first', 'unknown', 'first', 'continuous']);
  const result = streamQualitySnapshot(state);
  assert.equal(result.source_sequence_status, 'partial'); assert.equal(result.source_missing_frames, '2');
  assert.equal(result.source_duplicates, 1); assert.equal(result.source_reversals, 1); assert.equal(result.source_gap_events, 1);
  const exact = createStreamQuality(); observeStreamQuality(exact, '90071992547409930000');
  observeStreamQuality(exact, '90071992547409930004');
  assert.equal(streamQualitySnapshot(exact).source_missing_frames, '3');
  const unknown = createStreamQuality(); observeStreamQuality(unknown, null);
  assert.equal(streamQualitySnapshot(unknown).source_sequence_status, 'unknown');
  assert.equal(streamQualitySnapshot(unknown).source_duplicates, null);
  const reordered = createStreamQuality(); [100, 99, 101].forEach(value => observeStreamQuality(reordered, value));
  assert.equal(streamQualitySnapshot(reordered).source_missing_frames, '0', 'already received index 100 is not missing');
  assert.equal(streamQualitySnapshot(reordered).source_sequence_status, 'partial');
});

test('MJPEG host accepts variable payloads, snapshots reused buffers and preserves invalid frames with diagnostics', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mjpeg-runtime-test-')), directory = path.join(root, baseManifest.id);
  await mkdir(directory);
  const warning = Buffer.concat([jpeg(), Buffer.from([1, 2, 3])]), invalid = jpeg().subarray(0, -2);
  const payloads = [jpeg(), warning, invalid, Buffer.from([0, 1, 2])];
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify(baseManifest));
  await writeFile(path.join(directory, 'adapter.mjs'), `export function createAdapter({emit}) {
    let timer;
    return {start() {
      const payloads=${JSON.stringify(payloads.map(value => value.toString('base64')))}, indices=['100','103','103','10']; let index=0;
      timer=setInterval(()=>{ if(index>=payloads.length){clearInterval(timer);return;}
        const full=Buffer.alloc(Buffer.from(payloads[index],'base64').length+2,7);
        const payload=full.subarray(1,-1);payload.set(Buffer.from(payloads[index],'base64'));
        emit({stream_id:'camera',payload,sequence:indices[index],device_time_ns:123456n});
        payload.fill(255); index++;
      },225);
    },stop(){clearInterval(timer);} };
  }`);
  const received = [], errors = [];
  const manager = new PluginManager({ root, onBatch: frame => received.push(frame), onError: error => errors.push(error) });
  t.after(async () => { await manager.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'mjpeg-runtime-test-'))); await rm(root, { recursive: true, force: true }); });
  await manager.reload(); await manager.connect({ plugin_id: baseManifest.id, instance_id: 'fixture' });
  const deadline = Date.now() + 4000;
  while (received.length < payloads.length && Date.now() < deadline) await delay(20);
  assert.equal(received.length, payloads.length); assert.deepEqual(errors, []);
  for (let index = 0; index < payloads.length; index++) assert.deepEqual(received[index].payload, payloads[index], 'IPC snapshot must survive immediate buffer reuse');
  assert.deepEqual(received.map(frame => frame.metadata.jpeg_status.status), ['ok', 'warning', 'invalid', 'invalid']);
  const info = manager.catalog().instances[0], quality = info.stream_diagnostics[0];
  assert.equal(quality.source_missing_frames, '2'); assert.equal(quality.source_duplicates, 1); assert.equal(quality.source_reversals, 1);
  assert.equal(quality.invalid_jpeg_frames, 2); assert.equal(quality.jpeg_warning_frames, 1);
  assert.ok(info.runtime_metrics.rss_bytes > 0); assert.equal(info.runtime_metrics.pending_frames, 0);
  const preview = manager.previews['plugin-fixture-camera'].camera;
  assert.equal(preview.preview_status, 'invalid-jpeg'); assert.equal(preview.jpeg_base64, undefined);
  assert.equal(preview.quality.invalid_jpeg_frames, 2);
  const descriptor = manager.descriptors()[0]; descriptor.metadata.quality.invalid_jpeg_frames = 99;
  assert.equal(manager.descriptors()[0].metadata.quality.invalid_jpeg_frames, 2, 'returned quality is an independent snapshot');
  await manager.disconnect({ instance_id: 'fixture' });
});
