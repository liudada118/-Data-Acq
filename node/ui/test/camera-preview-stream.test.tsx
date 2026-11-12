import test from "node:test";
import assert from "node:assert/strict";
import { readCameraPreviewStream, subscribeCameraPreview } from "../src/camera-preview-stream";
import type { CameraPreviewFrame } from "../src/camera-preview-stream";

function packet(sequence = 1, header: Record<string, unknown> = {}, payload = new Uint8Array([255, 216, 255, 217])) {
  const encoded = new TextEncoder().encode(JSON.stringify({ sequence, width: 2, height: 2, timestamp_s: sequence,
    payload_bytes: payload.length, ...header }));
  const result = new Uint8Array(4 + encoded.length + payload.length);
  new DataView(result.buffer).setUint32(0, encoded.length, true);
  result.set(encoded, 4); result.set(payload, 4 + encoded.length);
  return result;
}
function response(chunks: Uint8Array[], type = "application/x-shroom-camera") {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }), { headers: { "Content-Type": type } });
}

test("camera packets survive arbitrary network boundaries and preserve JPEG bytes", async () => {
  const frames: CameraPreviewFrame[] = [];
  const bytes = Buffer.concat([packet(1), packet(2)]);
  await readCameraPreviewStream(response(Array.from(bytes, byte => new Uint8Array([byte]))), new AbortController().signal,
    frame => frames.push(frame));
  assert.deepEqual(frames.map(({ sequence, timestamp_s }) => ({ sequence, timestamp_s })), [
    { sequence: 1, timestamp_s: 1 }, { sequence: 2, timestamp_s: 2 },
  ]);
  assert.deepEqual([...frames[0].jpeg_bytes], [255, 216, 255, 217]);
  assert.notEqual(frames[0].jpeg_bytes.buffer, frames[1].jpeg_bytes.buffer);
});

test("camera packet reader rejects unbounded lengths, invalid dimensions, clocks and incomplete packets", async () => {
  const oversizedHeader = new Uint8Array(4);
  new DataView(oversizedHeader.buffer).setUint32(0, 4097, true);
  for (const bytes of [oversizedHeader, packet(1, { payload_bytes: 2 * 1024 * 1024 + 1 }),
    packet(1, { payload_bytes: 0 }), packet(1, { width: 100000000 }), packet(1, { height: 0 }),
    packet(-1), packet(1, { sequence: Number.MAX_SAFE_INTEGER + 1 }), packet(1, { timestamp_s: -1 }),
    packet(1).slice(0, 3), packet(1).slice(0, -1), new Uint8Array([2, 0, 0, 0, 123, 123])]) {
    await assert.rejects(readCameraPreviewStream(response([bytes]), new AbortController().signal, () => assert.fail("invalid frame emitted")));
  }
  await assert.rejects(readCameraPreviewStream(response([packet()], "application/json"), new AbortController().signal, () => {}));
});

test("aborting a stalled camera stream cancels its reader and emits no late frame", async () => {
  let cancelled = 0;
  const controller = new AbortController();
  const pending = readCameraPreviewStream(new Response(new ReadableStream({ cancel() { cancelled++; } }),
    { headers: { "Content-Type": "application/x-shroom-camera" } }), controller.signal, () => assert.fail("late frame"));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, 1);
});

test("preview retries stop after their budget and cleanup cancels a scheduled retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const failures: boolean[] = [];
  globalThis.fetch = async () => { calls++; throw new Error("offline"); };
  let stop = () => {};
  try {
    stop = subscribeCameraPreview("camera-left", () => {}, retrying => failures.push(retrying), [1, 1]);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, 3);
    assert.deepEqual(failures, [true, true, false]);
    stop();
    calls = 0;
    stop = subscribeCameraPreview("camera-left", () => {}, () => {}, [50]);
    await new Promise(resolve => setImmediate(resolve));
    stop();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(calls, 1);
  } finally { stop(); globalThis.fetch = originalFetch; }
});

test("live camera subscription follows visibility, pause, stream selection and replay lifecycle", async () => {
  const { JSDOM } = await import("jsdom");
  const { act, StrictMode, createElement } = await import("react");
  const { LivePreview } = await import("../src/LivePreview");
  const { startPreviewPolling } = await import("../src/preview");
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
  let drawn = 0, closed = 0;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
    createImageBitmap: async () => ({ width: 2, height: 2, close() { closed++; } }),
  });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({
    setTransform() {}, clearRect() {}, fillRect() {}, drawImage() { drawn++; },
  })) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  const { createRoot } = await import("react-dom/client");
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  const originalFetch = globalThis.fetch;
  const requests: { url: string; signal: AbortSignal; controller: ReadableStreamDefaultController<Uint8Array>; cancelled: boolean }[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/preview") return Response.json({ timestamp_s: 1, streams: {
      "camera-left": { camera: { sequence: 1, width: 2, height: 2, binary_preview: true,
        quality: { observed_frames: 5, source_sequence_status: "unknown", invalid_jpeg_frames: 0 } } },
    } });
    const request = { url: String(input), signal: init!.signal as AbortSignal,
      controller: null as unknown as ReadableStreamDefaultController<Uint8Array>, cancelled: false };
    requests.push(request);
    return new Response(new ReadableStream({ start(controller) { request.controller = controller; },
      cancel() { request.cancelled = true; } }), { headers: { "Content-Type": "application/x-shroom-camera" } });
  };
  const device = { id: "camera-left", name: "Left", kind: "camera" as const, transport: "SDK plugin", mode: "sdk-plugin",
    connected: true, sample_rate: 30, unit: "MJPEG", channels: 3, width: 2, height: 2, metadata: { pixel_format: "mjpeg" } };
  const render = async (props: Record<string, unknown> = {}) => {
    await act(async () => root.render(createElement(StrictMode, null, createElement(LivePreview,
      { device, enabled: true, connected: true, paused: false, ...props }))));
  };
  const latest = () => requests.at(-1)!;
  let stopPolling = () => {};
  try {
    await render();
    assert.match(latest().url, /\/api\/preview\/cameras\/camera-left\?fps=30$/);
    await act(async () => { latest().controller.enqueue(packet(10)); await new Promise(resolve => setImmediate(resolve)); });
    assert.match(node.textContent!, /T \+ 10\.00 s/);
    assert.match(node.textContent!, /帧 #10/);
    assert.ok(drawn > 0); assert.ok(closed > 0);
    await act(async () => {
      stopPolling = startPreviewPolling(100000, () => {});
      await new Promise(resolve => setImmediate(resolve));
    });
    stopPolling();
    assert.match(node.textContent!, /T \+ 10\.00 s/, "low-rate metadata must not rewind the live clock");
    assert.match(node.textContent!, /帧 #10/);
    assert.match(node.textContent!, /源序号未提供/);
    const first = latest();
    await render({ paused: true });
    assert.equal(first.signal.aborted, true); assert.equal(first.cancelled, true);
    const count = requests.length;
    await render({ visible: false });
    assert.equal(requests.length, count);
    await render();
    assert.ok(requests.length > count);
    const resumed = latest();
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    assert.equal(resumed.signal.aborted, true);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    const previous = latest();
    await render({ device: { ...device, id: "camera right" } });
    assert.equal(previous.signal.aborted, true);
    assert.match(latest().url, /camera%20right\?fps=30$/);
    const beforeReplay = latest();
    await render({ snapshot: { timestamp_s: 20, camera: { width: 2, height: 2, sequence: 20, jpeg_base64: "AQID" } } });
    assert.equal(beforeReplay.signal.aborted, true);
    assert.match(node.textContent!, /T \+ 20\.00 s/);
    await render();
    const last = latest();
    await act(async () => root.unmount());
    assert.equal(last.signal.aborted, true); assert.equal(last.cancelled, true);
  } finally {
    stopPolling(); globalThis.fetch = originalFetch;
    await act(async () => root.unmount()); node.remove(); dom.window.close();
  }
});
