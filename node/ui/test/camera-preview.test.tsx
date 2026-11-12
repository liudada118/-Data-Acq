import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { CameraPreview } from "../src/CameraPreview";
import type { CameraConnection } from "../src/camera-types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

test("pausing, interrupting and unmounting video playback never stop capture tracks", async () => {
  let playCalls = 0;
  let pauseCalls = 0;
  let stopCalls = 0;
  dom.window.HTMLMediaElement.prototype.play = async () => { playCalls += 1; };
  dom.window.HTMLMediaElement.prototype.pause = () => { pauseCalls += 1; };
  const track = { readyState: "live", stop() { stopCalls += 1; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const connection: CameraConnection = {
    instanceId: "c-phone", deviceId: "phone-device", label: "Phone camera", stream,
    width: 1280, height: 720, frameRate: 30, quality: "720p", connected: true, error: null,
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let unmounted = false;
  try {
    await act(async () => root.render(<StrictMode><CameraPreview connection={connection} paused={false} recording /></StrictMode>));
    const video = node.querySelector("video")!;
    assert.equal(video.srcObject, stream);
    assert.ok(playCalls > 0);
    const beforePause = pauseCalls;
    await act(async () => root.render(<StrictMode><CameraPreview connection={connection} paused recording /></StrictMode>));
    assert.ok(pauseCalls > beforePause);
    assert.equal(video.srcObject, stream);
    assert.equal(stopCalls, 0);

    const beforeResume = playCalls;
    await act(async () => root.render(<StrictMode><CameraPreview connection={connection} paused={false} recording recordingError="Another camera upload failed" /></StrictMode>));
    assert.ok(playCalls > beforeResume);
    assert.equal(video.srcObject, stream);
    assert.equal(stopCalls, 0);

    await act(async () => root.unmount());
    unmounted = true;
    assert.equal(video.srcObject, null);
    assert.equal(stopCalls, 0);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    node.remove();
    dom.window.close();
  }
});
