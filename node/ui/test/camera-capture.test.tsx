import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { useCameraCapture } from "../src/useCameraCapture";
import type { UseCameraCaptureOptions } from "../src/camera-types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeTrack extends EventTarget {
  readyState = "live";
  label = "Fixture camera";
  stops = 0;
  settings: MediaTrackSettings = { deviceId: "fixture-camera", width: 960, height: 540, frameRate: 25 };
  stop() { this.stops++; this.readyState = "ended"; }
  getSettings() { return this.settings; }
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
class FakeStream {
  track = new FakeTrack();
  getTracks() { return [this.track]; }
  getVideoTracks() { return [this.track]; }
}
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static supported = new Set(["video/webm;codecs=vp8", "video/webm", "video/mp4"]);
  static isTypeSupported(type: string) { return FakeRecorder.supported.has(type); }
  state = "inactive";
  mimeType: string;
  timeslice?: number;
  stops = 0;
  finalChunk = new Blob(["last-frame"]);
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: Error }) => void) | null = null;
  constructor(readonly stream: FakeStream, readonly options: MediaRecorderOptions) {
    this.mimeType = options.mimeType!; FakeRecorder.instances.push(this);
  }
  start(timeslice: number) { this.timeslice = timeslice; this.state = "recording"; }
  emit(data: Blob = new Blob(["frame"])) { this.ondataavailable?.({ data }); }
  stop() {
    this.stops++; this.state = "inactive";
    queueMicrotask(() => { this.emit(this.finalChunk); this.onstop?.(); });
  }
}
interface Call {
  route: string; body?: Record<string, unknown>; blob?: Blob; token: string | null;
  mime: string | null; keepalive?: boolean; signal?: AbortSignal | null;
}
function fixture(t: TestContext) {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const streams: FakeStream[] = [];
  const constraints: MediaStreamConstraints[] = [];
  const calls: Call[] = [];
  let capture: (() => Promise<FakeStream>) | undefined;
  let enumerationFailure: Error | undefined;
  let enumerationCount = 0;
  let deviceList = [
    { kind: "videoinput", deviceId: "fixture-camera", label: "Fixture camera" },
    { kind: "audioinput", deviceId: "not-video", label: "Fixture microphone" },
  ];
  let enumerateOverride: (() => Promise<typeof deviceList>) | undefined;
  let intercept: ((call: Call) => Promise<Response> | undefined) | undefined;
  FakeRecorder.instances = [];
  FakeRecorder.supported = new Set(["video/webm;codecs=vp8", "video/webm", "video/mp4"]);
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, writable: true, value: FakeRecorder });
  const mediaDevices = Object.assign(new EventTarget(), {
    async getUserMedia(input: MediaStreamConstraints) {
      constraints.push(input);
      const stream = capture ? await capture() : new FakeStream();
      streams.push(stream); return stream;
    },
    async enumerateDevices() {
      enumerationCount++;
      if (enumerationFailure) throw enumerationFailure;
      return enumerateOverride ? enumerateOverride() : deviceList;
    },
  });
  const permission = new EventTarget();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices,
    permissions: { async query() { return permission; } },
  } });
  const json = (body: unknown = {}, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (url, options) => {
    const headers = new Headers(options?.headers);
    const call: Call = { route: String(url), token: headers.get("X-Camera-Token"), mime: headers.get("Content-Type"),
      keepalive: options?.keepalive, signal: options?.signal,
      ...(options?.body instanceof Blob ? { blob: options.body } : { body: JSON.parse(String(options?.body ?? "{}")) }) };
    calls.push(call);
    assert.equal(options?.method, "POST");
    const intercepted = intercept?.(call);
    if (intercepted) return intercepted;
    if (call.route === "/api/cameras/register") return json({ token: `token-${call.body?.instance_id}`,
      lease_timeout_ms: 20000, chunk_limit_bytes: 16777216 }, 201);
    if (/^\/api\/cameras\/[\w-]+\/(heartbeat|disconnect|chunks|error|finalize)(?:\?|$)/.test(call.route)) return json();
    throw new Error(`Unexpected request in isolated camera test: ${call.route}`);
  }) as typeof fetch;
  // Register cleanup after the hook so unmount can still send only stubbed requests.
  const restore = () => {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder);
    else Reflect.deleteProperty(globalThis, "MediaRecorder");
  };
  return { calls, streams, constraints, json, restore, mediaDevices, permission,
    intercept(handler?: typeof intercept) { intercept = handler; },
    capture(handler?: typeof capture) { capture = handler; },
    failEnumeration(error?: Error) { enumerationFailure = error; },
    devices(list: typeof deviceList) { deviceList = list; },
    enumerateWith(handler?: typeof enumerateOverride) { enumerateOverride = handler; },
    enumerations: () => enumerationCount,
    chunks(id: string) { return calls.filter(call => call.route.startsWith(`/api/cameras/${id}/chunks?`)); },
  };
}
async function mountHook(t: TestContext, restore: () => void, overrides: Partial<UseCameraCaptureOptions> = {}, strict = false) {
  let latest!: ReturnType<typeof useCameraCapture>;
  let refreshes = 0;
  let options: UseCameraCaptureOptions = { online: true, recording: false,
    onDevicesChanged: async () => { refreshes++; }, ...overrides };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let mounted = true;
  function Harness() { latest = useCameraCapture(options); return null; }
  const render = () => root.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />);
  await act(async () => render());
  async function unmount() {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    element.remove();
  }
  t.after(async () => { await unmount(); restore(); });
  return { value: () => latest, refreshes: () => refreshes, unmount,
    async update(next: Partial<UseCameraCaptureOptions>) { options = { ...options, ...next }; await act(async () => render()); } };
}

test("scan lists named devices without opening a default source; explicit connections report actual settings", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().scan(); });
  assert.deepEqual(hook.value().devices, [{ deviceId: "fixture-camera", label: "Fixture camera" }]);
  assert.equal(service.constraints.length, 0, "enumeration does not request camera access");
  await act(async () => { await hook.value().connect("front", "fixture-camera", "1080p"); await hook.value().connect("side", "fixture-camera"); });
  assert.deepEqual(service.constraints[0], { audio: false, video: { deviceId: { exact: "fixture-camera" },
    width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } } });
  assert.deepEqual(service.calls[0].body, { instance_id: "front", label: "Fixture camera", width: 960, height: 540, frame_rate: 25 });
  assert.equal(hook.value().connections.front.stream, service.streams[0]);
  assert.equal("token" in hook.value().connections.front, false);
  await act(async () => { await hook.value().disconnect("front"); });
  assert.equal(service.streams[0].track.stops, 1);
  assert.equal(service.streams[1].track.stops, 0);
  assert.deepEqual(Object.keys(hook.value().connections), ["side"]);
  assert.equal(service.calls.find(call => call.route.endsWith("front/disconnect"))?.token, "token-front");
  assert.equal(hook.refreshes(), 3);
});

test("camera permission denial surfaces Chinese guidance and scanning releases any acquired probe", async t => {
  const service = fixture(t);
  service.devices([{ kind: "videoinput", deviceId: "", label: "" }]);
  const hook = await mountHook(t, service.restore);
  service.capture(async () => { throw new DOMException("Permission denied", "NotAllowedError"); });
  await act(async () => {
    await assert.rejects(hook.value().scan(), /未获摄像头权限.*Chrome.*Edge/);
    await assert.rejects(hook.value().connect("front", "fixture-camera"), /未获摄像头权限.*Chrome.*Edge/);
  });
  assert.match(hook.value().error, /未获摄像头权限/);
  assert.equal(hook.value().scanning, false);
  assert.deepEqual(hook.value().busyIds, []);
  assert.equal(service.calls.length, 0, "permission denial never registers a camera");

  service.capture();
  service.failEnumeration(new DOMException("Permission changed", "NotAllowedError"));
  await act(async () => { await assert.rejects(hook.value().scan(), /未获摄像头权限/); });
  assert.equal(service.streams[0].track.stops, 1, "a probe is released even if permission changes during enumeration");
  assert.equal(hook.value().scanning, false);
  assert.match(hook.value().error, /请允许当前页面/);
});

test("only an explicit scan obtains permission for anonymous devices and releases its temporary track", async t => {
  const service = fixture(t);
  service.devices([{ kind: "videoinput", deviceId: "", label: "" }]);
  service.capture(async () => {
    service.devices([{ kind: "videoinput", deviceId: "droidcam", label: "DroidCam Video" }]);
    return new FakeStream();
  });
  const hook = await mountHook(t, service.restore);
  assert.equal(service.constraints.length, 0, "passive mount discovery cannot open a permission prompt");
  assert.deepEqual(hook.value().devices, []);
  await act(async () => { await hook.value().scan(); });
  assert.deepEqual(service.constraints, [{ video: true, audio: false }]);
  assert.equal(service.streams[0].track.stops, 1);
  assert.deepEqual(hook.value().devices, [{ deviceId: "droidcam", label: "DroidCam Video" }]);
  assert.equal(service.calls.length, 0, "permission probing does not register a capture stream");
});

test("a broken default camera does not hide another enumerated source and re-scanning can recover", async t => {
  const service = fixture(t);
  service.devices([{ kind: "videoinput", deviceId: "hidden-default", label: "" }]);
  const hook = await mountHook(t, service.restore);
  service.capture(async () => {
    service.devices([
      { kind: "videoinput", deviceId: "todesk", label: "ToDesk Camera" },
      { kind: "videoinput", deviceId: "droidcam", label: "DroidCam Video" },
    ]);
    throw new DOMException("Cannot read default source", "NotReadableError");
  });
  await act(async () => { await assert.rejects(hook.value().scan(), /被占用或系统无法读取/); });
  assert.deepEqual(hook.value().devices.map(device => device.deviceId), ["todesk", "droidcam"]);
  const before = service.constraints.length;
  await act(async () => { await hook.value().scan(); });
  assert.equal(service.constraints.length, before, "known named devices bypass the broken default source");
  assert.equal(hook.value().error, "");

  service.failEnumeration(new Error("enumeration temporarily unavailable"));
  await act(async () => { service.mediaDevices.dispatchEvent(new Event("devicechange")); });
  assert.deepEqual(hook.value().devices.map(device => device.deviceId), ["todesk", "droidcam"],
    "failed passive enumeration retains the last known list");
});

test("connection requires an explicit device ID and never falls back to the browser default", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  await act(async () => {
    await assert.rejects(hook.value().connect("front"), /选择摄像头/);
    await assert.rejects(hook.value().connect("front", "   "), /选择摄像头/);
  });
  assert.equal(service.constraints.length, 0);
  service.capture(async () => { throw new DOMException("Saved source disappeared", "NotFoundError"); });
  await act(async () => { await assert.rejects(hook.value().connect("front", "droidcam"), /未检测到摄像头/); });
  assert.equal(service.constraints.length, 1);
  assert.deepEqual((service.constraints[0].video as MediaTrackConstraints).deviceId, { exact: "droidcam" });
  assert.equal(service.calls.length, 0);
});

test("device, permission and page visibility changes refresh only the list and preserve recording errors", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  await act(async () => {
    await hook.value().connect("front", "fixture-camera");
    await hook.value().prepareRecording(["front"]); await hook.value().startRecording("failed-recording");
    FakeRecorder.instances[0].onerror?.({ error: new Error("recording failure remains visible") });
    await assert.rejects(hook.value().stopRecording(), /recording failure/);
  });
  const priorCaptures = service.constraints.length;
  const refreshWith = async (id: string, dispatch: () => void) => {
    service.devices([{ kind: "videoinput", deviceId: id, label: id }]);
    await act(async () => dispatch());
    assert.deepEqual(hook.value().devices, [{ deviceId: id, label: id }]);
    assert.equal(hook.value().error, "recording failure remains visible");
  };
  await refreshWith("plugged-in", () => service.mediaDevices.dispatchEvent(new Event("devicechange")));
  await refreshWith("permission-updated", () => service.permission.dispatchEvent(new Event("change")));
  await refreshWith("focused", () => window.dispatchEvent(new dom.window.Event("focus")));
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  t.after(() => {
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  const beforeHidden = service.enumerations();
  await act(async () => document.dispatchEvent(new dom.window.Event("visibilitychange")));
  assert.equal(service.enumerations(), beforeHidden);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await refreshWith("visible", () => document.dispatchEvent(new dom.window.Event("visibilitychange")));
  assert.equal(service.constraints.length, priorCaptures, "passive refreshes never open a media stream");
  await hook.unmount();
  const beforeUnmountedEvents = service.enumerations();
  service.mediaDevices.dispatchEvent(new Event("devicechange"));
  service.permission.dispatchEvent(new Event("change"));
  window.dispatchEvent(new dom.window.Event("focus"));
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await Promise.resolve();
  assert.equal(service.enumerations(), beforeUnmountedEvents, "all passive listeners are removed on unmount");
});

test("late enumeration results cannot overwrite a newer device list or update an unmounted hook", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore, {}, true);
  const delayed = deferred<Array<{ kind: string; deviceId: string; label: string }>>();
  let first = true;
  service.enumerateWith(() => {
    if (first) { first = false; return delayed.promise; }
    return Promise.resolve([{ kind: "videoinput", deviceId: "new-camera", label: "New camera" }]);
  });
  await act(async () => service.mediaDevices.dispatchEvent(new Event("devicechange")));
  await act(async () => window.dispatchEvent(new dom.window.Event("focus")));
  assert.equal(hook.value().devices[0].deviceId, "new-camera");
  await act(async () => delayed.resolve([{ kind: "videoinput", deviceId: "old-camera", label: "Old camera" }]));
  assert.equal(hook.value().devices[0].deviceId, "new-camera");
  const abandoned = deferred<Array<{ kind: string; deviceId: string; label: string }>>();
  service.enumerateWith(() => abandoned.promise);
  await act(async () => service.mediaDevices.dispatchEvent(new Event("devicechange")));
  await hook.unmount();
  abandoned.resolve([{ kind: "videoinput", deviceId: "unmounted", label: "Unmounted" }]);
  await Promise.resolve();
  assert.equal(hook.value().devices[0].deviceId, "new-camera");
  assert.equal(service.constraints.length, 0);
});

test("two cameras prepare first, serialize each stream, and drain the final chunk before finalize", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().connect("front", "fixture-camera"); await hook.value().connect("side", "fixture-camera"); });
  await hook.update({ recording: true }); // The parent uses busy || recording while preparing/stopping.
  let sources;
  await act(async () => { sources = await hook.value().prepareRecording(["front", "side"]); });
  assert.deepEqual(sources, [
    { instance_id: "front", token: "token-front", mime_type: "video/webm;codecs=vp8" },
    { instance_id: "side", token: "token-side", mime_type: "video/webm;codecs=vp8" },
  ]);
  const [front, side] = FakeRecorder.instances;
  assert.equal(front.state, "inactive");
  assert.equal(front.options.videoBitsPerSecond, 4_000_000);
  const delayed = deferred<Response>();
  service.intercept(call => call.route.endsWith("front/chunks?session_id=joint-session&index=0") ? delayed.promise : undefined);
  await act(async () => { await hook.value().startRecording("joint-session"); front.emit(); front.emit(); side.emit(); });
  assert.equal(front.timeslice, 1000);
  assert.equal(service.chunks("front").length, 1, "the second chunk cannot overtake the first");
  assert.equal(service.chunks("side").length, 1, "independent cameras upload concurrently");
  await act(async () => { await hook.value().cancelPrepared(); });
  assert.equal(front.state, "recording", "cancelPrepared must leave running recorders alone");
  let stopping!: Promise<void>;
  await act(async () => { stopping = hook.value().stopRecording(); });
  assert.equal(front.stops, 1);
  assert.equal(service.calls.some(call => call.route.endsWith("front/finalize")), false);
  await act(async () => { delayed.resolve(service.json()); await stopping; });
  assert.deepEqual(service.chunks("front").map(call => new URL(call.route, "http://test").searchParams.get("index")), ["0", "1", "2"]);
  assert.equal(await service.chunks("front")[2].blob?.text(), "last-frame");
  assert.equal(service.chunks("front")[0].mime, "video/webm;codecs=vp8");
  assert.equal(service.chunks("front")[0].token, "token-front");
  const finalized = service.calls.find(call => call.route.endsWith("front/finalize"))!.body!;
  assert.equal(finalized.next_index, 3);
  assert.ok(Number.isFinite(Date.parse(String(finalized.started_at))));
  assert.ok(Number(finalized.duration_ms) >= 0);
  assert.equal(service.calls.find(call => call.route.endsWith("side/finalize"))?.body?.next_index, 2);
  assert.equal(hook.value().error, "");
});

test("late callbacks from a finished recorder cannot fail or upload into the next recording", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  await act(async () => {
    await hook.value().connect("front", "fixture-camera");
    await hook.value().prepareRecording(["front"]); await hook.value().startRecording("first-session");
  });
  const old = FakeRecorder.instances[0];
  const lateData = old.ondataavailable!, lateError = old.onerror!, lateStop = old.onstop!;
  await act(async () => { old.emit(); await hook.value().stopRecording(); });
  const priorChunks = service.chunks("front").length;
  await act(async () => {
    await hook.value().prepareRecording(["front"]); await hook.value().startRecording("second-session");
    lateData({ data: new Blob(["old data"]) });
    lateError({ error: new Error("late encoder event from first session") });
    lateStop();
  });
  assert.equal(hook.value().error, "", 'retired callbacks must not fail the current camera');
  assert.equal(FakeRecorder.instances[1].state, "recording");
  assert.equal(service.chunks("front").length, priorChunks);
  await act(async () => { FakeRecorder.instances[1].emit(); await hook.value().stopRecording(); });
  assert.deepEqual(service.calls.filter(call => call.route.endsWith('/finalize')).map(call => call.body?.session_id), ['first-session', 'second-session']);
});

test("camera recording ownership is local to its page and remains available after encoder failure cleanup", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  assert.equal(hook.value().recordingSessionId(), null);
  await act(async () => {
    await hook.value().connect("front", "fixture-camera");
    await hook.value().prepareRecording(["front"]);
  });
  assert.equal(hook.value().recordingSessionId(), null, 'a connection alone does not own another page recording');
  await act(async () => { await hook.value().startRecording("owned-session"); });
  assert.equal(hook.value().recordingSessionId(), "owned-session");
  await act(async () => {
    FakeRecorder.instances[0].onerror?.({ error: new Error("encoder failed") });
    await assert.rejects(hook.value().stopRecording(), /encoder failed/);
  });
  assert.equal(hook.value().recordingSessionId(), "owned-session", 'the owning page must still finalize its failed backend session');
  await act(async () => { await hook.value().prepareRecording(["front"]); });
  assert.equal(hook.value().recordingSessionId(), null);
  await act(async () => { await hook.value().cancelPrepared(); });
});

test("unknown upload acknowledgement is never retried and a failed source is never finalized", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().connect("front", "fixture-camera"); await hook.value().connect("side", "fixture-camera");
    await hook.value().prepareRecording(["front", "side"]); await hook.value().startRecording("broken-session"); });
  service.intercept(call => call.route.includes("front/chunks?") || call.route.endsWith("front/error")
    ? Promise.reject(new Error("connection lost after upload")) : undefined);
  await act(async () => { FakeRecorder.instances[0].emit(); FakeRecorder.instances[0].emit(); });
  await act(async () => { await assert.rejects(hook.value().stopRecording(), /connection lost/); });
  assert.equal(service.chunks("front").length, 1, "no retry after an unknown ACK and queued chunks are abandoned");
  assert.equal(FakeRecorder.instances[1].stops, 1, "one failure stops every selected recorder");
  assert.equal(service.calls.some(call => call.route.endsWith("front/finalize")), false,
    "unfinalized state guarantees incomplete even when /error itself is lost");
  assert.match(hook.value().error, /connection lost/);
  service.intercept();
  await act(async () => { await hook.value().prepareRecording(["front"]); await hook.value().cancelPrepared(); });
  assert.equal(hook.value().error, "", "failure cleanup does not strand the hook in stopping state");
});

test("the chunk count limit bounds a stalled uploader and stops all recording lanes", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().connect("front", "fixture-camera"); await hook.value().connect("side", "fixture-camera");
    await hook.value().prepareRecording(["front", "side"]); await hook.value().startRecording("bounded-session"); });
  const delayed = deferred<Response>();
  service.intercept(call => call.route.includes("front/chunks?") ? delayed.promise : undefined);
  await act(async () => { FakeRecorder.instances[0].emit(); });
  await act(async () => { for (let i = 0; i < 32; i++) FakeRecorder.instances[0].emit(); });
  assert.match(hook.value().error, /缓冲已满/);
  assert.equal(FakeRecorder.instances[1].stops, 1);
  await act(async () => { delayed.resolve(service.json()); await assert.rejects(hook.value().stopRecording(), /缓冲已满/); });
  assert.equal(service.chunks("front").length, 1);
  assert.equal(service.calls.some(call => call.route.endsWith("front/finalize")), false);
});

test("track loss reports failure and stops other cameras without finalizing the failed source", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().connect("front", "fixture-camera"); await hook.value().connect("side", "fixture-camera");
    await hook.value().prepareRecording(["front", "side"]); await hook.value().startRecording("ended-session"); });
  await act(async () => { service.streams[0].track.end(); });
  await act(async () => { await assert.rejects(hook.value().stopRecording(), /视频轨道已结束/); });
  assert.equal(hook.value().connections.front.connected, false);
  assert.equal(FakeRecorder.instances[1].state, "inactive");
  assert.equal(service.calls.find(call => call.route.endsWith("front/error"))?.body?.session_id, "ended-session");
  assert.equal(service.calls.some(call => call.route.endsWith("front/finalize")), false);
});

test("empty camera sessions work without MediaRecorder and MP4 fallback is prepared before starting", async t => {
  const service = fixture(t);
  const hook = await mountHook(t, service.restore);
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: undefined });
  await act(async () => {
    assert.deepEqual(await hook.value().prepareRecording([]), []);
    await hook.value().startRecording("sdk-only"); await hook.value().stopRecording();
  });
  assert.equal(service.calls.length, 0);
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  FakeRecorder.supported = new Set(["video/mp4"]);
  await act(async () => { await hook.value().connect("front", "fixture-camera");
    const prepared = await hook.value().prepareRecording(["front"]);
    assert.equal(prepared[0].mime_type, "video/mp4"); await hook.value().cancelPrepared(); });
  assert.equal(FakeRecorder.instances[0].state, "inactive");
  assert.equal(FakeRecorder.instances[0].ondataavailable, null);
  FakeRecorder.supported.clear();
  await act(async () => { await assert.rejects(hook.value().prepareRecording(["front"]), /没有可用/); });
  assert.equal(service.chunks("front").length, 0);
});

test("expired and offline registrations can be removed locally; unknown settings remain unknown", async t => {
  const service = fixture(t);
  service.capture(async () => { const stream = new FakeStream(); stream.track.settings = {}; return stream; });
  const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().connect("front", "fixture-camera"); await hook.value().connect("side", "fixture-camera"); });
  assert.deepEqual(service.calls[0].body, { instance_id: "front", label: "Fixture camera", width: 0, height: 0, frame_rate: 0 });
  service.intercept(call => call.route.endsWith("/disconnect") ? Promise.resolve(service.json({ error: "expired" }, 409)) : undefined);
  await act(async () => { await hook.value().disconnect("front"); });
  assert.equal(hook.value().connections.front, undefined);
  await hook.update({ online: false });
  await act(async () => { await hook.value().disconnect("side"); await hook.value().disconnect("absent"); });
  assert.deepEqual(hook.value().connections, {});
  assert.ok(service.streams.every(stream => stream.track.readyState === "ended"));
  await act(async () => { await assert.rejects(hook.value().connect("offline", "fixture-camera"), /离线/); });
  assert.equal(service.constraints.length, 2);
});

test("pending getUserMedia is single-flight and releases orphan tracks after unmount", async t => {
  const service = fixture(t);
  const permission = deferred<FakeStream>();
  service.capture(() => permission.promise);
  const hook = await mountHook(t, service.restore);
  let connecting!: Promise<unknown>;
  await act(async () => { connecting = hook.value().connect("front", "fixture-camera").catch(error => error); });
  await act(async () => { await assert.rejects(hook.value().connect("front", "fixture-camera"), /正在进行/); });
  assert.equal(service.constraints.length, 1);
  await hook.unmount();
  const orphan = new FakeStream(); permission.resolve(orphan);
  assert.match((await connecting as Error).message, /已取消/);
  assert.equal(orphan.track.stops, 1);
  assert.equal(service.calls.length, 0);
});

test("pagehide clears pending camera operations and their late results cannot replace a resumed connection", async t => {
  const service = fixture(t);
  service.devices([{ kind: "videoinput", deviceId: "", label: "" }]);
  const scanPermission = deferred<FakeStream>();
  const connectPermission = deferred<FakeStream>();
  let captures = 0;
  service.capture(() => {
    captures++;
    return captures === 1 ? scanPermission.promise : captures === 2 ? connectPermission.promise : Promise.resolve(new FakeStream());
  });
  const hook = await mountHook(t, service.restore);
  let scanning!: Promise<void>;
  let connecting!: Promise<unknown>;
  await act(async () => { scanning = hook.value().scan(); });
  await act(async () => { connecting = hook.value().connect("front", "fixture-camera").catch(error => error); });
  assert.equal(hook.value().scanning, true);
  assert.deepEqual(hook.value().busyIds, ["front"]);
  await act(async () => window.dispatchEvent(new dom.window.Event("pagehide")));
  assert.equal(hook.value().scanning, false);
  assert.deepEqual(hook.value().busyIds, []);
  await act(async () => { await hook.value().connect("front", "fixture-camera"); });
  const resumed = hook.value().connections.front;
  const oldScan = new FakeStream();
  const oldConnect = new FakeStream();
  await act(async () => {
    scanPermission.resolve(oldScan); connectPermission.resolve(oldConnect);
    await scanning; assert.match((await connecting as Error).message, /已取消/);
  });
  assert.equal(oldScan.track.stops, 1);
  assert.equal(oldConnect.track.stops, 1);
  assert.equal(hook.value().connections.front.stream, resumed.stream);
  assert.equal(hook.value().connections.front.connected, true);
  assert.equal((resumed.stream as unknown as FakeStream).track.stops, 0);
  assert.equal(hook.value().scanning, false);
  assert.deepEqual(hook.value().busyIds, []);
});

test("heartbeat persists while recording and pagehide clears timers, tracks and private registrations", async t => {
  const service = fixture(t);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const heartbeats = new Map<ReturnType<typeof setTimeout>, () => void>();
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    const timer = originalSetTimeout(handler, delay);
    if (delay === 5000) heartbeats.set(timer, handler);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    heartbeats.delete(timer); originalClearTimeout(timer);
  }) as typeof clearTimeout;
  const hook = await mountHook(t, () => { service.restore();
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
    for (const timer of heartbeats.keys()) originalClearTimeout(timer);
  }, {}, true);
  await act(async () => { await hook.value().connect("front", "fixture-camera");
    await hook.value().prepareRecording(["front"]); await hook.value().startRecording("leaving-session"); });
  assert.equal(heartbeats.size, 1);
  await act(async () => {
    const [timer, tick] = [...heartbeats][0]; clearTimeout(timer); tick();
  });
  assert.equal(service.calls.filter(call => call.route.endsWith("/heartbeat")).length, 1);
  assert.equal(heartbeats.size, 1);
  await act(async () => { window.dispatchEvent(new dom.window.Event("pagehide")); });
  assert.equal(heartbeats.size, 0);
  assert.equal(service.streams[0].track.stops, 1);
  assert.equal(FakeRecorder.instances[0].state, "inactive");
  assert.equal(service.calls.find(call => call.route.endsWith("/error"))?.keepalive, true);
  assert.equal(service.calls.find(call => call.route.endsWith("/disconnect"))?.keepalive, true);
  assert.deepEqual(hook.value().connections, {});
  await hook.unmount();
  assert.equal(service.streams[0].track.stops, 1, "cleanup remains idempotent after pagehide");
});
