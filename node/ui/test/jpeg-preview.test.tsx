import assert from "node:assert/strict";
import test from "node:test";
import { decodeJpegPreview, LatestJpegDecoder } from "../src/jpeg-preview";

const frame = (sequence: number) => ({ sequence, width: 2, height: 2, jpeg_base64: `frame-${sequence}` });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness() {
  const jobs: { sequence: number; resolve: (image: { close(): void }) => void; reject: (error: Error) => void }[] = [];
  const received: number[] = [], failures: number[] = [], closed: number[] = [];
  let inFlight = 0, maximumInFlight = 0;
  const decoder = new LatestJpegDecoder<{ close(): void }>(value => {
    inFlight++;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    return new Promise((resolve, reject) => jobs.push({ sequence: value.sequence,
      resolve: image => { inFlight--; resolve(image); }, reject: error => { inFlight--; reject(error); } }));
  }, (_image, value) => received.push(value.sequence), (_error, value) => failures.push(value.sequence));
  const finish = (index: number) => jobs[index].resolve({ close: () => closed.push(jobs[index].sequence) });
  return { decoder, jobs, received, failures, closed, finish, maximumInFlight: () => maximumInFlight };
}

test("slow JPEG decoder keeps at most one active decode and the latest queued frame", async () => {
  const h = harness();
  h.decoder.offer(frame(1)); h.decoder.offer(frame(2)); h.decoder.offer(frame(3));
  assert.deepEqual(h.jobs.map(job => job.sequence), [1]);
  h.finish(0); await flush();
  assert.deepEqual(h.jobs.map(job => job.sequence), [1, 3]);
  h.finish(1); await flush();
  assert.equal(h.maximumInFlight(), 1);
  assert.deepEqual(h.received, [1, 3]);
  assert.deepEqual(h.closed, [1, 3]);
  h.decoder.offer(frame(3)); await flush();
  assert.equal(h.jobs.length, 2, "canvas resize must not decode the same frame again");
});

test("reset during replay seek rejects the old result without parallel decode or leaked bitmap", async () => {
  const h = harness();
  h.decoder.offer(frame(1)); h.decoder.offer(frame(2)); h.decoder.reset(); h.decoder.offer(frame(10));
  h.finish(0); await flush();
  assert.deepEqual(h.received, []);
  assert.deepEqual(h.closed, [1]);
  assert.deepEqual(h.jobs.map(job => job.sequence), [1, 10]);
  h.finish(1); await flush();
  assert.deepEqual(h.received, [10]);
  assert.equal(h.maximumInFlight(), 1);
});

test("bad JPEG reports failure then continues with the next frame", async () => {
  const h = harness();
  h.decoder.offer(frame(1)); h.decoder.offer(frame(2));
  h.jobs[0].reject(new Error("invalid JPEG entropy")); await flush();
  assert.deepEqual(h.failures, [1]);
  h.finish(1); await flush();
  assert.deepEqual(h.received, [2]);
  assert.deepEqual(h.closed, [2]);
});

test("unmount releases an in-flight bitmap and suppresses all later callbacks", async () => {
  const h = harness();
  h.decoder.offer(frame(1)); h.decoder.offer(frame(2)); h.decoder.dispose();
  h.finish(0); await flush();
  h.decoder.offer(frame(3));
  assert.deepEqual(h.received, []);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.closed, [1]);
  assert.equal(h.jobs.length, 1);
});

test("binary JPEG decoding bypasses base64 and checks payload and decoded dimensions", async () => {
  const originalDecode = globalThis.createImageBitmap, originalAtob = globalThis.atob;
  let closed = 0, calls = 0;
  const bytes = new Uint8Array([255, 216, 255, 217]);
  globalThis.atob = () => assert.fail("binary preview must not decode base64");
  globalThis.createImageBitmap = (async (blob: Blob) => {
    calls++;
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
    return { width: 2, height: 2, close() { closed++; } };
  }) as typeof createImageBitmap;
  try {
    const bitmap = await decodeJpegPreview({ sequence: 1, width: 2, height: 2, jpeg_bytes: bytes });
    bitmap.close();
    await assert.rejects(decodeJpegPreview({ sequence: 2, width: 3, height: 2, jpeg_bytes: bytes }), /实际尺寸/);
    assert.equal(closed, 2);
    for (const jpeg_bytes of [new Uint8Array(), new Uint8Array(2 * 1024 * 1024 + 1)])
      await assert.rejects(decodeJpegPreview({ sequence: 3, width: 2, height: 2, jpeg_bytes }), /尺寸超出/);
    await assert.rejects(decodeJpegPreview({ sequence: 4, width: 100000, height: 100000, jpeg_bytes: bytes }), /尺寸超出/);
    assert.equal(calls, 2, "invalid inputs must be rejected before allocating a decoded bitmap");
  } finally { globalThis.createImageBitmap = originalDecode; globalThis.atob = originalAtob; }
});
