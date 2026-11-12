import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { LivePreview } from "../src/LivePreview";
import type { CameraQuality, Device, Preview } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
let rejectDecode = false, bitmapClosed = 0, imagesDrawn = 0, rgbDrawn = 0;
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} },
  ImageData: class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} },
  createImageBitmap: async () => {
    if (rejectDecode) throw new Error("corrupt JPEG");
    return { width: 2, height: 2, close: () => { bitmapClosed++; } };
  },
});
dom.window.HTMLCanvasElement.prototype.getContext = (() => ({
  setTransform() {}, clearRect() {}, fillRect() {},
  drawImage() { imagesDrawn++; }, putImageData() { rgbDrawn++; },
})) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
const { createRoot } = await import("react-dom/client");
const device: Device = { id: "left-camera", name: "Orbbec 左目", kind: "camera", transport: "plugin", sample_rate: 30,
  unit: "MJPEG", channels: 3, mode: "plugin", connected: true, width: 2, height: 2, metadata: { pixel_format: "mjpeg" } };
const quality: CameraQuality = { observed_frames: 10, source_sequence_status: "available", source_sequence_supported: true,
  source_indexed_frames: 10, source_unindexed_frames: 0, source_missing_frames: "2", source_gap_events: 1,
  source_duplicates: 0, source_reversals: 0, invalid_jpeg_frames: 1, jpeg_warning_frames: 2 };

test("JPEG decode errors and source gaps are visible, later frames recover, and legacy RGB still draws", async () => {
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  const render = async (camera: NonNullable<Preview["camera"]>, source = device) => {
    await act(async () => root.render(<StrictMode><LivePreview device={source} enabled connected paused={false}
      snapshot={{ timestamp_s: 1, camera }} /></StrictMode>));
  };
  try {
    rejectDecode = true;
    await render({ width: 2, height: 2, sequence: 1, jpeg_base64: "AQID", quality });
    assert.match(node.textContent!, /当前帧无法解码预览/);
    assert.match(node.textContent!, /源序号缺口 2/);
    assert.match(node.textContent!, /JPEG 结构异常 1/);
    assert.match(node.textContent!, /预览解码异常 1/);
    rejectDecode = false;
    await render({ width: 2, height: 2, sequence: 2, jpeg_base64: "BAUG", quality });
    assert.doesNotMatch(node.textContent!, /当前帧无法解码预览/);
    assert.match(node.textContent!, /预览解码异常 1/, "failure history must remain visible after recovery");
    assert.ok(imagesDrawn > 0); assert.ok(bitmapClosed > 0);
    await render({ width: 2, height: 2, sequence: 3, preview_status: "invalid-jpeg", quality });
    assert.match(node.textContent!, /当前 JPEG 帧结构异常/);
    await render({ width: 2, height: 2, sequence: 4, preview_status: "unsupported-jpeg", quality });
    assert.match(node.textContent!, /不支持此 JPEG 格式预览/);
    await render({ width: 2, height: 2, sequence: 1, rgb_base64: Buffer.alloc(12, 127).toString("base64") },
      { ...device, id: "legacy-rgb", metadata: { pixel_format: "rgb8" } });
    assert.ok(rgbDrawn > 0);
    assert.doesNotMatch(node.textContent!, /当前 JPEG 帧结构异常|预览解码异常/);
    assert.match(node.textContent!, /RGB8/);
  } finally { await act(async () => root.unmount()); node.remove(); dom.window.close(); }
});
