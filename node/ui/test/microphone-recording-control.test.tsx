import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import App from "../src/App";
import { emptyExperiment } from "../src/workflow";
import type { Device, Status } from "../src/types";
import { installMicrophoneMediaFixture } from "./microphone-fixture";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
dom.window.HTMLMediaElement.prototype.play = async () => {};
dom.window.HTMLMediaElement.prototype.pause = () => {};
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

const CAMERA_ID = "c-session", MICROPHONE_ID = "m-session", SESSION_ID = "session-audio-video";
const VIDEO_DEVICE = "fixture-video", AUDIO_DEVICE = "fixture-microphone";
const cameraStreamId = `camera-${CAMERA_ID}`, microphoneStreamId = `microphone-${MICROPHONE_ID}`;
const idle: Status = { state: "idle", session_id: null, elapsed_s: 0, bytes_written: 0, queue_depth: 0,
  queue_capacity: 4096, dropped_records: 0, record_counts: {}, selected_ids: [] };
const json = (value: unknown = {}, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class FakeVideoTrack extends EventTarget {
  readyState = "live";
  label = "DroidCam Video fixture";
  stop() { this.readyState = "ended"; }
  getSettings() { return { deviceId: VIDEO_DEVICE, width: 1280, height: 720, frameRate: 30 }; }
}
class FakeVideoStream {
  track = new FakeVideoTrack();
  getTracks() { return [this.track]; }
  getVideoTracks() { return [this.track]; }
  getAudioTracks() { return []; }
}
class FakeVideoRecorder {
  static instances: FakeVideoRecorder[] = [];
  static isTypeSupported(type: string) { return type.startsWith("video/webm"); }
  state = "inactive";
  stops = 0;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: Error }) => void) | null = null;
  constructor(readonly stream: FakeVideoStream, options: MediaRecorderOptions) {
    this.mimeType = options.mimeType!; FakeVideoRecorder.instances.push(this);
  }
  start() { this.state = "recording"; }
  stop() {
    this.stops++; this.state = "inactive";
    queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["last-video-frame"]) }); this.onstop?.(); });
  }
}
interface Call { path: string; body?: Record<string, unknown>; bytes: number; token: string | null }

async function fixture(t: TestContext, initial: Status = idle) {
  const media = installMicrophoneMediaFixture();
  media.setDevices([{ kind: "audioinput", deviceId: AUDIO_DEVICE, label: "DroidCam Audio fixture" },
    { kind: "videoinput", deviceId: VIDEO_DEVICE, label: "DroidCam Video fixture" }]);
  const captureAudio = media.mediaDevices.getUserMedia.bind(media.mediaDevices);
  media.mediaDevices.getUserMedia = (async (constraints: MediaStreamConstraints) =>
    constraints.video ? new FakeVideoStream() : captureAudio(constraints)) as typeof media.mediaDevices.getUserMedia;
  const previousRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, writable: true, value: FakeVideoRecorder });
  FakeVideoRecorder.instances = [];
  const previousFetch = globalThis.fetch;
  window.localStorage.clear();
  window.localStorage.setItem("synapse-node.workspace.v1", JSON.stringify({ version: 1, layout: "grid", cards: [
    { id: CAMERA_ID, source: "camera", deviceId: VIDEO_DEVICE, quality: "720p", expanded: false },
    { id: MICROPHONE_ID, source: "microphone", deviceId: AUDIO_DEVICE, expanded: false },
  ] }));
  const calls: Call[] = [], completed: string[] = [], failures = new Set<string>();
  const devices = new Map<string, Device>(), uploadedBytes = new Map<string, number>();
  let current = { ...initial };
  let intercept: ((call: Call) => Response | Promise<Response> | undefined) | undefined;
  globalThis.fetch = (async (input, options) => {
    const path = String(input), binary = options?.body instanceof Blob || options?.body instanceof ArrayBuffer;
    const call: Call = { path, bytes: options?.body instanceof Blob ? options.body.size : options?.body instanceof ArrayBuffer ? options.body.byteLength : 0,
      ...(options?.body && !binary ? { body: JSON.parse(String(options.body)) } : {}),
      token: new Headers(options?.headers).get("X-Camera-Token") };
    calls.push(call);
    let response: Response;
    const overridden = intercept?.(call);
    if (overridden !== undefined) response = await overridden;
    else if (path === "/api/status") response = json(current);
    else if (path === "/api/devices") response = json({ devices: [...devices.values()] });
    else if (path === "/api/sdk/info") response = json({ loaded: true, connected: false, instances: [], version: "fixture" });
    else if (path === "/api/sdk/ports") response = json({ ports: [] });
    else if (["/api/sessions", "/api/export/formats", "/api/export/jobs"].includes(path))
      response = json(path.endsWith("sessions") ? { sessions: [] } : path.endsWith("formats") ? { formats: [] } : { jobs: [] });
    else if (path.startsWith("/api/preview")) response = json({ timestamp_s: 1, devices: {} });
    else if (path.endsWith("/annotations")) response = json({ schema_version: 1, session_id: path.split("/")[3], revision: 0,
      experiment: emptyExperiment(), labels: [], annotations: [], history: [] });
    else if (path === "/api/cameras/register") {
      const id = String(call.body!.instance_id), audio = call.body!.kind === "audio";
      devices.set(id, { id: `${audio ? "microphone" : "camera"}-${id}`, name: String(call.body!.label), kind: audio ? "audio" : "camera",
        mode: "hardware", transport: "Browser", connected: true, channels: audio ? 1 : 3,
        sample_rate: Number(audio ? call.body!.sample_rate : call.body!.frame_rate), unit: audio ? "PCM16" : "frame", preview_supported: false });
      response = json({ token: `fixture-token-${id}`, chunk_limit_bytes: 16777216, lease_timeout_ms: 20000 }, 201);
    } else if (path === "/api/sessions/start") {
      current = { ...idle, state: "recording", session_id: SESSION_ID, selected_ids: call.body!.device_ids as string[], camera_stop_requires_owner: true };
      response = json({ session_id: SESSION_ID, status: current });
    } else if (path === "/api/sessions/stop") {
      current = { ...idle };
      response = json({ status: current, session: { id: SESSION_ID, name: "Audio video fixture", started_at: "2026-11-05T00:00:00Z",
        duration_s: 1, bytes_written: 16, record_counts: {}, devices: [...devices.values()], status: failures.size ? "incomplete" : "complete" } });
    } else {
      const endpoint = /^\/api\/cameras\/([^/]+)\/(heartbeat|disconnect|chunks|finalize|error)(?:\?|$)/.exec(path);
      if (!endpoint) throw new Error(`Unexpected audio/video App request: ${path}`);
      const [, id, action] = endpoint;
      if (action === "error") failures.add(id);
      if (action === "disconnect") devices.delete(id);
      if (action === "chunks") {
        const count = (uploadedBytes.get(id) ?? 0) + call.bytes; uploadedBytes.set(id, count);
        response = json({ next_index: Number(new URL(path, "http://localhost").searchParams.get("index")) + 1, payload_bytes: count });
      } else response = json();
    }
    completed.push(path); return response;
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch;
    media.restore(); window.localStorage.clear();
    if (previousRecorder) Object.defineProperty(globalThis, "MediaRecorder", previousRecorder);
    else Reflect.deleteProperty(globalThis, "MediaRecorder");
  });
  await act(async () => root.render(<App />));
  function button(text: string) {
    const found = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
    assert.ok(found, `Expected ${text}`); return found;
  }
  async function clickLabel(label: string) {
    const found = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(found, `Expected ${label}`); assert.equal(found.disabled, false, `${label} is enabled`);
    await act(async () => found.click());
  }
  return { host, media, calls, completed, button,
    intercept(value?: typeof intercept) { intercept = value; },
    async start() {
      await clickLabel("检测并授权安卓 / 系统摄像头"); await clickLabel("检测并授权麦克风");
      await clickLabel("连接安卓 / 系统摄像头"); await clickLabel("连接麦克风");
      const start = button("开始采集"); assert.equal(start.disabled, false);
      await act(async () => start.click());
      assert.equal(FakeVideoRecorder.instances[0]?.state, "recording");
      assert.equal(media.nodes.length, 1); assert.ok(media.nodes[0].captureId);
      assert.ok(button("停止并保存"));
    },
    async stop() { await act(async () => button("停止并保存").click()); },
    serverStops: () => calls.filter(call => call.path === "/api/sessions/stop"),
  };
}

test("one session includes camera and microphone sources, and server stop waits for both finalizers", async t => {
  const app = await fixture(t);
  const cameraFinal = deferred<Response>(), microphoneFinal = deferred<Response>();
  t.after(() => { cameraFinal.resolve(json()); microphoneFinal.resolve(json()); });
  app.intercept(call => call.path === `/api/cameras/${CAMERA_ID}/finalize` ? cameraFinal.promise
    : call.path === `/api/cameras/${MICROPHONE_ID}/finalize` ? microphoneFinal.promise : undefined);
  await app.start();
  const start = app.calls.find(call => call.path === "/api/sessions/start")!;
  assert.deepEqual(start.body!.device_ids, [cameraStreamId, microphoneStreamId]);
  assert.deepEqual(start.body!.camera_sources, [
    { instance_id: CAMERA_ID, token: `fixture-token-${CAMERA_ID}`, mime_type: "video/webm;codecs=vp8" },
    { instance_id: MICROPHONE_ID, token: `fixture-token-${MICROPHONE_ID}`, mime_type: "audio/wav" },
  ]);
  await app.stop();
  for (const id of [CAMERA_ID, MICROPHONE_ID]) {
    const finalize = app.calls.find(call => call.path === `/api/cameras/${id}/finalize`);
    assert.ok(finalize, `both sources must drain concurrently: ${id}`);
    assert.equal(finalize.body!.session_id, SESSION_ID);
    assert.equal(finalize.body!.next_index, 1);
    assert.ok(app.calls.some(call => call.path.startsWith(`/api/cameras/${id}/chunks?session_id=${SESSION_ID}`)));
  }
  assert.equal(app.serverStops().length, 0);
  await act(async () => cameraFinal.resolve(json()));
  assert.equal(app.serverStops().length, 0, "audio still owns an unfinished tail");
  await act(async () => microphoneFinal.resolve(json()));
  assert.equal(app.serverStops().length, 1);
  assert.deepEqual(app.serverStops()[0].body, { session_id: SESSION_ID });
  const serverStop = app.completed.indexOf("/api/sessions/stop");
  assert.ok(serverStop > app.completed.indexOf(`/api/cameras/${CAMERA_ID}/finalize`));
  assert.ok(serverStop > app.completed.indexOf(`/api/cameras/${MICROPHONE_ID}/finalize`));
  assert.ok(app.button("开始采集"));
});

test("a page without the microphone worklet cannot stop another page's audio recording", async t => {
  const app = await fixture(t, { ...idle, state: "recording", session_id: "session-other-page",
    selected_ids: [microphoneStreamId], camera_stop_requires_owner: true });
  await app.stop();
  assert.equal(app.serverStops().length, 0);
  assert.equal(app.media.nodes.length, 0);
  assert.equal(app.media.constraints.length, 0);
  assert.match(app.host.textContent ?? "", /请回到开始录制的页面/);
});

test("a microphone processor failure stops the camera too and waits for its tail before saving incomplete", async t => {
  const app = await fixture(t), cameraFinal = deferred<Response>();
  t.after(() => cameraFinal.resolve(json()));
  app.intercept(call => call.path === `/api/cameras/${CAMERA_ID}/finalize` ? cameraFinal.promise : undefined);
  await app.start();
  await act(async () => app.media.nodes[0].processorError());
  assert.equal(FakeVideoRecorder.instances[0].state, "inactive");
  assert.equal(FakeVideoRecorder.instances[0].stops, 1);
  assert.ok(app.calls.some(call => call.path === `/api/cameras/${MICROPHONE_ID}/error`));
  assert.equal(app.calls.some(call => call.path === `/api/cameras/${MICROPHONE_ID}/finalize`), false);
  assert.equal(app.serverStops().length, 0);
  await act(async () => cameraFinal.resolve(json()));
  assert.equal(app.serverStops().length, 1);
  assert.deepEqual(app.serverStops()[0].body, { session_id: SESSION_ID });
  assert.equal(app.media.nodes[0].port.closed, true);
  assert.match(app.host.textContent ?? "", /录制已停止，但数据不完整/);
});
