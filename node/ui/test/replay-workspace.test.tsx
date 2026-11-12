import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { act } from "react";
import { SessionReplay } from "../src/SessionReplay";
import { groupReplayStreams } from "../src/replay-layout";
import { emptyExperiment } from "../src/workflow";
import type { Device, Session } from "../src/types";
import { mediaLayoutStorageKey } from "../src/media-rail-layout";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
let gridBounds = { width: 1100, height: 500 };
const observers = new Set<FixtureResizeObserver>();
class FixtureResizeObserver {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: FixtureResizeObserver,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const pointerCaptures = new WeakMap<Element, number>();
Object.assign(dom.window.HTMLElement.prototype, {
  setPointerCapture(this: HTMLElement, id: number) { pointerCaptures.set(this, id); },
  hasPointerCapture(this: HTMLElement, id: number) { return pointerCaptures.get(this) === id; },
  releasePointerCapture(this: HTMLElement) { pointerCaptures.delete(this); },
});
const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return this.classList.contains("media-sensor-layout")
    ? { ...gridBounds, x: 0, y: 0, top: 0, left: 0, right: gridBounds.width, bottom: gridBounds.height, toJSON: () => ({}) }
    : originalBounds.call(this);
};
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const plays: HTMLMediaElement[] = [], pauses: HTMLMediaElement[] = [];
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "play", { value: async function (this: HTMLMediaElement) { plays.push(this); } });
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "pause", { value: function (this: HTMLMediaElement) { pauses.push(this); } });
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
function sameMedia(actual: HTMLMediaElement[], expected: HTMLMediaElement[], message?: string) {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((node, index) => assert.equal(node, expected[index], message ?? "Media DOM identity changed"));
}

function stream(id: string, kind: Device["kind"], instance?: string): Device {
  return { id, name: id, kind, mode: "hardware", transport: "serial", connected: true,
    channels: kind === "imu" ? 6 : 4, sample_rate: 100, unit: kind === "imu" ? "raw" : "ADC",
    ...(kind === "pressure" ? { rows: 2, cols: 2 } : {}), ...(instance ? { metadata: { instance_id: instance } } : {}) };
}
const streams = [
  stream("sdk-pair-pressure", "pressure"), stream("sdk-pair-imu-raw", "imu"),
  stream("external-pressure", "pressure", "explicit"), stream("external-motion", "imu", "explicit"),
  stream("pressure-standalone-a", "pressure"), stream("pressure-standalone-b", "pressure"), stream("motion-standalone", "imu"),
];
const media = [
  { id: "camera-c-front", name: "前方摄像头", kind: "camera", mime_type: "video/webm", url: "/api/files/replay-layout/front.webm" },
  { id: "microphone-m-room", name: "房间麦克风", kind: "audio", mime_type: "audio/wav", sample_rate: 48000, channels: 1, url: "/api/files/replay-layout/room.wav" },
  { id: "camera-c-side", name: "侧方摄像头", kind: "camera", mime_type: "video/webm", url: "/api/files/replay-layout/side.webm" },
].map(item => ({ ...item, offset_s: 0, duration_s: 20 }));
const session = { id: "replay-layout", name: "多路回放布局回归", duration_s: 30, bytes_written: 1000,
  status: "complete", streams, media_streams: media } as unknown as Session;
const annotation = { id: "point-contact", label_id: "contact", label_name: "接触时刻", kind: "point",
  start_ns: "4250000000", end_ns: "4250000000", stream_ids: ["sdk-pair-imu-raw"], color: "#149d88", note: "" };

test("replay grouping preserves ambiguous and unrelated streams while explicit metadata takes precedence", () => {
  const unrelated = [stream("external-same-pressure", "pressure"), stream("external-same-imu-raw", "imu")];
  const ambiguous = [stream("pressure-a", "pressure", "ambiguous"), stream("pressure-b", "pressure", "ambiguous"),
    stream("imu-a", "imu", "ambiguous")];
  const explicit = [stream("sdk-left-pressure", "pressure", "explicit-owner"), stream("sdk-right-imu-raw", "imu", "explicit-owner")];
  assert.equal(groupReplayStreams(unrelated).length, 2, "similar names without SDK IDs or metadata are independent");
  assert.equal(groupReplayStreams(ambiguous).length, 3, "multiple pressure streams must not be arbitrarily paired with one IMU");
  assert.deepEqual(groupReplayStreams(explicit).map(group => ({ id: group.id, ids: group.streams.map(item => item.id) })),
    [{ id: "instance:explicit-owner", ids: explicit.map(item => item.id) }], "explicit metadata wins over differing SDK ID prefixes");
  const all = [...unrelated, ...ambiguous, ...explicit];
  assert.deepEqual(groupReplayStreams(all).flatMap(group => group.streams.map(item => item.id)).sort(),
    all.map(item => item.id).sort(), "grouping retains every original stream exactly once");
});

test("a stored JPEG with failed preview is shown as an invalid frame rather than absent recorded data", async t => {
  const originalFetch = globalThis.fetch;
  const jpegSession = { ...session, id: "replay-invalid-jpeg", media_streams: [], streams: [{
    id: "plugin-left-jpeg", name: "左目相机", kind: "camera", encoding: "mjpeg", mode: "sdk-plugin", transport: "SDK plugin",
    connected: true, channels: 3, sample_rate: 30, unit: "MJPEG", width: 3, height: 2,
    metadata: { pixel_format: "mjpeg" },
  }] } as Session;
  globalThis.fetch = (async input => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/replay")) return json({ session_id: jpegSession.id, time_s: 0, duration_s: 30,
      media_streams: [], streams: { "plugin-left-jpeg": { available: false, relative_time_s: 0,
        note: "原始帧仍保留供检查", camera: { width: 3, height: 2, sequence: 1, preview_status: "invalid-jpeg" } } } });
    return json({ schema_version: 1, session_id: jpegSession.id, revision: 0, experiment: emptyExperiment(), labels: [], annotations: [], history: [] });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(<SessionReplay session={jpegSession} onClose={() => {}} onExport={() => {}} />));
  assert.match(host.textContent ?? "", /当前 JPEG 帧结构异常，无法预览；原始帧保留供检查/);
  assert.doesNotMatch(host.textContent ?? "", /此时刻尚无已保存数据/);
});

async function fixture(t: TestContext) {
  gridBounds = { width: 1100, height: 500 }; plays.length = 0; pauses.length = 0;
  window.localStorage.clear();
  const originalFetch = globalThis.fetch;
  const requests: number[] = [], pending: { resolve: (response: Response) => void; time: number }[] = [];
  let hold = false;
  const frame = (time: number) => ({ session_id: session.id, time_s: time, duration_s: 30, media_streams: media,
    streams: Object.fromEntries(streams.map(device => [device.id, { available: true, relative_time_s: time,
      ...(device.kind === "pressure" ? { pressure: { rows: 2, cols: 2, values: [1, 2, 3, 4] } } : { imu: { values: [1, 2, 3, 4, 5, 6] } }) }])) });
  globalThis.fetch = (async input => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/replay")) {
      const time = Number(url.searchParams.get("time_s")); requests.push(time);
      if (hold) return new Promise<Response>(resolve => pending.push({ resolve, time }));
      return json(frame(time));
    }
    assert.ok(url.pathname.endsWith("/annotations"), `Unexpected fixture request: ${url.pathname}`);
    return json({ schema_version: 1, session_id: session.id, revision: 0, experiment: emptyExperiment(),
      labels: [{ id: "contact", name: "接触时刻", kind: "point", color: "#149d88", shortcut: "" }], annotations: [annotation], history: [] });
  }) as typeof fetch;
  // Keep playback progression deterministic. Layout changes must not cause play()
  // merely because a media card moved to a new page; no wall-clock tick runs here.
  const originalInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    if (args[1] === 200) { const handle = {} as ReturnType<typeof setInterval>; intervals.add(handle); return handle; }
    return originalInterval(...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => { if (!intervals.delete(handle)) originalClearInterval(handle); }) as typeof clearInterval;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const item of pending.splice(0)) item.resolve(json(frame(item.time)));
    host.remove(); globalThis.fetch = originalFetch;
    window.localStorage.clear();
    globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval;
  });
  let inspections = 0;
  const render = async (seekRequest?: { time_s: number; key: number }) => act(async () => root.render(<SessionReplay session={session} onClose={() => {}} onExport={() => {}} onInspectContinuity={() => { inspections++; }} seekRequest={seekRequest} />));
  await render();
  const button = (label: string) => {
    const result = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(result, `Missing button: ${label}`); return result;
  };
  const mediaNodes = () => [...host.querySelectorAll<HTMLMediaElement>("audio,video")];
  await act(async () => { for (const element of mediaNodes()) element.dispatchEvent(new dom.window.Event("loadedmetadata")); });
  return {
    host, button, mediaNodes, requests,
    externalSeek: (time_s: number, key: number) => render({ time_s, key }), inspections: () => inspections,
    cursor: () => Number(host.querySelector<HTMLInputElement>('[aria-label="回放时间秒数"]')!.value),
    cards: () => [...host.querySelectorAll<HTMLElement>('[data-replay-id]')],
    click: async (label: string) => { await act(async () => button(label).click()); },
    speed: async (value: string) => { await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="回放速度"]')!;
      select.value = value; select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    }); },
    resize: async (width: number, height: number) => { await act(async () => {
      gridBounds = { width, height };
      for (const observer of observers) {
        if ([...observer.targets].some(target => target.classList.contains("media-sensor-layout")))
          observer.callback([], observer as unknown as ResizeObserver);
      }
    }); },
    seekAnnotation: async () => { await act(async () => host.querySelector<HTMLButtonElement>(".timeline-annotation")!.click()); },
    holdFrames: () => { hold = true; },
    releaseFrames: async () => { await act(async () => {
      hold = false;
      for (const item of pending.splice(0)) item.resolve(json(frame(item.time)));
    }); },
    waitForRequest: async (time: number) => { for (let attempt = 0; attempt < 30 && !requests.includes(time); attempt++)
      await act(async () => { await delay(20); }); assert.ok(requests.includes(time), `Missing replay request at ${time}`); },
  };
}

test("replay pagination and resize preserve media nodes, cursor and global playback state without restarting media", async t => {
  const view = await fixture(t), nodes = view.mediaNodes();
  assert.ok(view.host.querySelector(".session-replay.replay-workspace"));
  assert.equal(nodes.length, 3); assert.equal(plays.length, 0, "opening a replay never autoplays sound");
  assert.equal(view.cards().length, 8, "two explicit pressure/IMU pairs each occupy one card");
  assert.equal(view.cards().filter(card => !card.hidden).length, 7, "three media cards stay in the rail beside four sensor tiles");
  assert.ok(nodes.every(node => node.closest(".media-rail") && !node.closest<HTMLElement>("[data-replay-id]")!.hidden), "media are independent of sensor pagination");
  assert.equal(view.host.querySelector(".media-sensor-layout")!.firstElementChild?.getAttribute("aria-label"), "回放影像与声音");
  await view.seekAnnotation(); await view.waitForRequest(4.25);
  assert.equal(view.cursor(), 4.25);
  await view.speed("2"); await view.click("播放录制");
  assert.ok(nodes.every(node => node.playbackRate === 2 && plays.includes(node)));
  const playCount = plays.length, cursor = view.cursor();
  await view.click("下一屏回放");
  sameMedia(view.mediaNodes(), nodes); assert.equal(view.cursor(), cursor);
  assert.equal(plays.length, playCount, "pagination must not issue another play on existing media");
  assert.equal(view.cards().filter(card => !card.hidden).length, 4, "second page has one sensor and all three media");
  await view.resize(500, 300);
  assert.ok(window.innerWidth >= 760, "fixture window remains wide while the board narrows");
  assert.ok(view.host.querySelector(".media-sensor-layout.media-stacked"), "rail responds to board width, not browser width");
  sameMedia(view.mediaNodes(), nodes); assert.equal(view.cursor(), cursor);
  assert.equal(view.cards().filter(card => !card.hidden).length, 4, "narrow sensor page does not remove media");
  assert.equal(plays.length, playCount);
  assert.equal(view.host.querySelector<HTMLElement>(".replay-stream-grid")!.style.getPropertyValue("--replay-columns"), "1");
  await view.click("暂停回放");
  const pausedPlays = plays.length;
  await view.click("下一屏回放"); await view.resize(1100, 500);
  assert.equal(view.host.querySelector(".media-sensor-layout.media-stacked"), null);
  assert.ok(view.button("播放录制")); assert.equal(plays.length, pausedPlays);
  sameMedia(view.mediaNodes(), nodes); assert.equal(view.cursor(), cursor);
  assert.ok(nodes.every(node => node.playbackRate === 2 && pauses.includes(node)));
  await view.click("放大房间麦克风回放");
  assert.equal(view.cards().filter(card => !card.hidden).length, 1);
  assert.equal(view.cards().find(card => !card.hidden)!.dataset.replayId, "media:microphone-m-room");
  await view.click("还原房间麦克风回放");
  sameMedia(view.mediaNodes(), nodes); assert.equal(view.cursor(), cursor);
  assert.equal(plays.length, pausedPlays, "focusing and restoring a card preserve the paused state");
});

test("seeking keeps loaded media mounted while the next frame is pending and labels retain all original stream IDs", async t => {
  const view = await fixture(t), nodes = view.mediaNodes();
  const labels = view.button("显示标签面板");
  assert.equal(labels.getAttribute("aria-expanded"), "false");
  assert.equal(view.host.querySelector<HTMLElement>("#replay-annotations")!.hidden, true);
  await view.speed("4"); await view.click("播放录制");
  view.holdFrames(); await view.seekAnnotation();
  assert.equal(view.cursor(), 4.25);
  sameMedia(view.mediaNodes(), nodes, "clearing the numeric preview frame must not unmount media");
  assert.ok(nodes.every(node => node.currentTime === 4.25 && node.playbackRate === 4));
  const playCount = plays.length;
  await view.waitForRequest(4.25);
  sameMedia(view.mediaNodes(), nodes, "in-flight replay fetch must retain decoder/player identity");
  assert.ok(view.button("播放录制"), "seek pauses the global replay");
  await view.click("显示标签面板");
  assert.equal(view.host.querySelector<HTMLElement>("#replay-annotations")!.hidden, false);
  const options = [...view.host.querySelectorAll<HTMLOptionElement>('[aria-label="新标签作用范围"] option')].map(option => option.value).filter(Boolean);
  assert.deepEqual(options, [...streams, ...media].map(stream => stream.id), "visual grouping must not merge annotation/export stream identities");
  await view.click("收起标签栏");
  assert.equal(view.host.querySelector<HTMLElement>("#replay-annotations")!.hidden, true);
  await view.seekAnnotation();
  assert.equal(view.cursor(), 4.25); sameMedia(view.mediaNodes(), nodes);
  await view.releaseFrames();
  assert.equal(plays.length, playCount, "frame arrival and label toggles must not resume playback");
  sameMedia(view.mediaNodes(), nodes);
});


test("continuity report seeks preserve media nodes and remain paused", async t => {
  const view = await fixture(t), nodes = view.mediaNodes();
  await view.click("检查数据连续性"); assert.equal(view.inspections(), 1);
  await view.externalSeek(8.5, 1); await view.waitForRequest(8.5);
  assert.equal(view.cursor(), 8.5); sameMedia(view.mediaNodes(), nodes);
  assert.ok(view.button("播放录制"));
  await view.externalSeek(2.25, 2); await view.waitForRequest(2.25);
  assert.equal(view.cursor(), 2.25); sameMedia(view.mediaNodes(), nodes);
});

test("resizing and resetting replay media keeps decoders, playback and cursor intact", async t => {
  const view = await fixture(t), nodes = view.mediaNodes();
  await view.seekAnnotation(); await view.waitForRequest(4.25);
  await view.speed("2"); await view.click("播放录制");
  const playCount = plays.length, pauseCount = pauses.length, cursor = view.cursor();
  const board = view.host.querySelector<HTMLElement>(".media-sensor-layout")!;
  const initialWidth = board.style.getPropertyValue("--media-rail-width");
  assert.ok(initialWidth, "the media rail owns the shared camera and microphone width");
  const divider = board.querySelector<HTMLElement>('[aria-label="调整音视频栏宽度"]')!;
  assert.ok(divider);
  const pointer = async (type: string, x: number) => act(async () => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 200 });
    Object.defineProperties(event, { pointerId: { value: 37 }, isPrimary: { value: true } });
    divider.dispatchEvent(event);
    if (type === "pointermove") await delay(25);
  });
  await pointer("pointerdown", 420); await pointer("pointermove", 540); await pointer("pointerup", 540);
  const resizedWidth = board.style.getPropertyValue("--media-rail-width");
  assert.notEqual(resizedWidth, initialWidth);
  const key = mediaLayoutStorageKey(`replay:${session.id}`);
  const saved = window.localStorage.getItem(key);
  assert.ok(saved, "a completed drag persists the bounded media layout");
  sameMedia(view.mediaNodes(), nodes);
  await view.click("下一屏回放");
  await view.resize(500, 300);
  assert.ok(board.classList.contains("media-stacked"));
  assert.equal(window.localStorage.getItem(key), saved, "responsive clamping does not overwrite the user's preferred card width");
  sameMedia(view.mediaNodes(), nodes);
  await view.resize(1100, 500);
  assert.equal(board.style.getPropertyValue("--media-rail-width"), resizedWidth, "widening restores the shared width");
  const reset = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("恢复卡片大小"));
  assert.ok(reset); await act(async () => reset.click());
  assert.equal(board.style.getPropertyValue("--media-rail-width"), initialWidth);
  sameMedia(view.mediaNodes(), nodes);
  assert.equal(view.cursor(), cursor);
  assert.equal(plays.length, playCount, "drag, reset, resize and pagination never restart media");
  assert.equal(pauses.length, pauseCount, "layout controls never pause playback");
  assert.ok(nodes.every(node => node.playbackRate === 2));
});
