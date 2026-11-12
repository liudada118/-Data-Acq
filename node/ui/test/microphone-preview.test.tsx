import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, Profiler, StrictMode } from "react";
import { MicrophonePreview } from "../src/MicrophonePreview";
import type { MicrophoneConnection } from "../src/microphone-types";

test("microphone drawing is throttled and pausing, hiding or unmounting never changes the audio graph", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0, reads = 0, graphChanges = 0;
  dom.window.requestAnimationFrame = callback => { callbacks.set(++nextId, callback); return nextId; };
  dom.window.cancelAnimationFrame = id => { callbacks.delete(id); };
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => ({
    setTransform() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  }) });
  const track = { stop() { graphChanges++; } };
  const connection: MicrophoneConnection = {
    instanceId: "m-preview", deviceId: "microphone", label: "Microphone", sampleRate: 48000, channels: 1, connected: true, error: null,
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    analyser: { fftSize: 16, connect() { graphChanges++; }, disconnect() { graphChanges++; },
      getFloatTimeDomainData(array: Float32Array) { reads++; array.fill(0.25); } } as unknown as AnalyserNode,
  };
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  let unmounted = false;
  const tick = (time: number) => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(time)); };
  try {
    await act(async () => root.render(<StrictMode><MicrophonePreview connection={connection} paused={false} recording /></StrictMode>));
    assert.equal(callbacks.size, 1);
    tick(100); assert.equal(reads, 1);
    tick(110); assert.equal(reads, 1);
    tick(200); assert.equal(reads, 2);
    await act(async () => root.render(<StrictMode><MicrophonePreview connection={connection} paused recording /></StrictMode>));
    assert.equal(callbacks.size, 0); assert.equal(graphChanges, 0);
    await act(async () => root.render(<StrictMode><MicrophonePreview connection={connection} paused={false} visible={false} recording /></StrictMode>));
    assert.equal(callbacks.size, 0); assert.equal(graphChanges, 0);
    await act(async () => root.render(<StrictMode><MicrophonePreview connection={connection} paused={false} recording recordingError="upload interrupted" /></StrictMode>));
    tick(400); assert.equal(reads, 3); assert.equal(graphChanges, 0);
    await act(async () => root.unmount()); unmounted = true;
    assert.equal(callbacks.size, 0); assert.equal(graphChanges, 0);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    node.remove(); dom.window.close();
  }
});

async function monitorFixture(t: TestContext) {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0, graphChanges = 0, amplitude = 0, commits = 0;
  dom.window.requestAnimationFrame = callback => { callbacks.set(++nextId, callback); return nextId; };
  dom.window.cancelAnimationFrame = id => { callbacks.delete(id); };
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => ({
    setTransform() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  }) });
  let visibility = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", { get: () => visibility });
  const engine = { state: "running" };
  const track = { enabled: true, muted: false, stop() { graphChanges++; } };
  const connection: MicrophoneConnection = {
    instanceId: "m-monitor", deviceId: "microphone", label: "DroidCam Audio", sampleRate: 48000,
    channels: 1, connected: true, error: null,
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
    analyser: { context: engine, fftSize: 16, connect() { graphChanges++; }, disconnect() { graphChanges++; },
      getFloatTimeDomainData(array: Float32Array) { array.fill(amplitude); } } as unknown as AnalyserNode,
  };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async (options: { paused?: boolean; visible?: boolean; error?: string } = {}) => {
    await act(async () => root.render(<Profiler id="monitor" onRender={() => { commits++; }}>
      <MicrophonePreview connection={connection} recording paused={options.paused ?? false}
        visible={options.visible ?? true} recordingError={options.error} />
    </Profiler>));
  };
  const tick = async (time: number) => {
    await act(async () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(time)); });
  };
  t.after(async () => {
    await act(async () => root.unmount());
    assert.equal(callbacks.size, 0);
    assert.equal(graphChanges, 0, "monitor messages never stop tracks or change the audio graph");
    host.remove(); dom.window.close();
  });
  await render();
  return { host, connection, engine, track, render, tick,
    commits: () => commits, amplitude(value: number) { amplitude = value; },
    notice: () => host.querySelector(".workspace-microphone-notice")?.textContent ?? "",
    async sample(from: number, through: number) { for (let time = from; time <= through; time += 250) await tick(time); },
    async visibility(value: string) {
      await act(async () => { visibility = value; document.dispatchEvent(new dom.window.Event("visibilitychange")); });
    },
  };
}

test("five seconds of low audio produces one advisory, clears on sound, and never changes recording", async t => {
  const preview = await monitorFixture(t);
  const initialCommits = preview.commits();
  await preview.sample(0, 4750);
  assert.equal(preview.notice(), "");
  assert.equal(preview.commits(), initialCommits, "meter sampling does not rerender React");
  await preview.tick(5000);
  assert.match(preview.notice(), /暂未检测到明显声音.*DroidCam Client.*Enable Audio/);
  const advisoryCommits = preview.commits();
  assert.equal(advisoryCommits, initialCommits + 1);
  await preview.sample(5250, 6000);
  assert.equal(preview.commits(), advisoryCommits, "an unchanged advisory does not rerender");
  assert.match(preview.host.querySelector(".workspace-microphone-badge")!.textContent!, /正在录制音频/);
  preview.amplitude(0.2);
  await preview.tick(6100);
  assert.notEqual(preview.notice(), "", "status checks are limited to the 4 Hz meter cadence");
  await preview.tick(6250);
  assert.equal(preview.notice(), "");
  assert.equal(preview.connection.connected, true);
  assert.equal(preview.connection.error, null);
});

test("pausing or hiding the preview starts a new quiet observation period on resume", async t => {
  const preview = await monitorFixture(t);
  await preview.sample(0, 4000);
  await preview.render({ paused: true });
  await preview.tick(20000);
  assert.equal(preview.notice(), "");
  await preview.render();
  await preview.sample(20250, 25000);
  assert.equal(preview.notice(), "");
  await preview.tick(25250);
  assert.match(preview.notice(), /暂未检测/);
  await preview.render({ visible: false });
  assert.equal(preview.notice(), "");
  await preview.tick(50000);
  await preview.render();
  await preview.sample(50250, 55000);
  assert.equal(preview.notice(), "");
  await preview.tick(55250);
  assert.match(preview.notice(), /暂未检测/);
});

test("background tabs and long gaps cannot count as continuously observed silence", async t => {
  const preview = await monitorFixture(t);
  await preview.sample(0, 4000);
  await preview.visibility("hidden");
  await preview.tick(20000);
  await preview.visibility("visible");
  await preview.sample(20250, 25000);
  assert.equal(preview.notice(), "");
  await preview.tick(25250);
  assert.match(preview.notice(), /暂未检测/);
  await preview.tick(40000);
  assert.equal(preview.notice(), "", "a long scheduling gap resets observation even without a visibility event");
});

test("real errors precede engine and track state; state recovery restarts quiet observation", async t => {
  const preview = await monitorFixture(t);
  preview.engine.state = "suspended";
  preview.track.enabled = false;
  preview.track.muted = true;
  await preview.tick(0);
  assert.match(preview.notice(), /音频引擎.*suspended/);
  preview.engine.state = "interrupted";
  await preview.tick(250);
  assert.match(preview.notice(), /音频引擎.*interrupted/);
  preview.engine.state = "closed";
  await preview.tick(500);
  assert.match(preview.notice(), /音频引擎.*closed/);
  preview.engine.state = "running";
  await preview.tick(750);
  assert.match(preview.notice(), /音频轨道已禁用/);
  preview.track.enabled = true;
  await preview.tick(1000);
  assert.match(preview.notice(), /音频轨道当前静音/);
  await preview.render({ error: "上传失败" });
  await preview.tick(1250);
  assert.equal(preview.notice(), "上传失败");
  preview.connection.error = "设备连接已中断";
  await preview.render({ error: "上传失败" });
  assert.equal(preview.notice(), "设备连接已中断");
  preview.connection.error = null;
  preview.track.muted = false;
  await preview.render();
  await preview.sample(1500, 6250);
  assert.equal(preview.notice(), "");
  await preview.tick(6500);
  assert.match(preview.notice(), /暂未检测/);
});
