import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { act } from "react";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import { SessionReplay } from "../src/SessionReplay";
import { emptyExperiment } from "../src/workflow";
import { createCameraCard, createMicrophoneCard, createSdkCard, createPluginCard, cardStreamIds } from "../src/workspace";
import type { SensorPlugin } from "../src/plugin-types";
import { cardSizesStorageKey } from "../src/useCardSizes";
import { cardPositionsStorageKey } from "../src/useCardPositions";
import { mediaLayoutStorageKey } from "../src/media-rail-layout";
import type { Device, Session } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const captures = new WeakMap<Element, number>();
Object.assign(dom.window.HTMLElement.prototype, {
  setPointerCapture(this: HTMLElement, id: number) { captures.set(this, id); },
  hasPointerCapture(this: HTMLElement, id: number) { return captures.get(this) === id; },
  releasePointerCapture(this: HTMLElement) { captures.delete(this); },
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 1600, bottom: 700, width: 1600, height: 700, toJSON: () => ({}) }; },
});
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const plays: HTMLMediaElement[] = [], pauses: HTMLMediaElement[] = [];
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "play", { value: async function (this: HTMLMediaElement) { plays.push(this); } });
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "pause", { value: function (this: HTMLMediaElement) { pauses.push(this); } });
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
function sameNodes(actual: Element[], expected: Element[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((node, index) => assert.equal(node, expected[index], "layout changes must retain the original DOM node"));
}

async function fixture(t: TestContext, mode: "live" | "replay") {
  window.localStorage.clear(); plays.length = 0; pauses.length = 0;
  const mediaStorageKey = mediaLayoutStorageKey(mode === "live" ? "live" : "replay:corner-fixture");
  const cameraCard = { ...createCameraCard("c-corner"), deviceId: "fixture-camera" };
  const audioCard = { ...createMicrophoneCard("m-corner"), deviceId: "fixture-audio" };
  const sensors = Array.from({ length: 5 }, (_, index) => createSdkCard("hand-pad", `s-corner-${index}`));
  const sensorStorageKey = cardSizesStorageKey(mode === "live" ? "live:sensors" : "replay:corner-fixture:sensors");
  const positionStorageKey = cardPositionsStorageKey(mode === "live" ? "live:sensors" : "replay:corner-fixture:sensors");
  const connectionCalls: string[] = [];
  const recordConnection = (name: string) => async () => { connectionCalls.push(name); throw new Error(`Layout must not ${name}`); };
  const oldKey = cardSizesStorageKey(mode === "live" ? "live:media" : "replay:corner-fixture:media");
  window.localStorage.setItem(oldKey, JSON.stringify({ version: 1, cards: {
    [mode === "live" ? cameraCard.id : "media:camera-c-corner"]: { width: 950, height: 1900 },
    [mode === "live" ? audioCard.id : "media:microphone-m-corner"]: { width: 950, height: 1800 },
  } }));
  const devices: Device[] = sensors.map(sensor => ({ id: cardStreamIds(sensor)[0], name: "压力阵列", kind: "pressure", mode: "hardware", transport: "serial",
    connected: true, channels: 4, sample_rate: 100, unit: "ADC", rows: 2, cols: 2 }));
  const videoStream = { active: true } as MediaStream;
  const camera = { devices: [], busyIds: [], scanning: false, connect: recordConnection("connect-camera"), disconnect: recordConnection("disconnect-camera"), connections: { [cameraCard.id]: {
    connected: true, label: "Fixture Camera", stream: videoStream, width: 1280, height: 720, frameRate: 30,
  } } } as unknown as AcquisitionWorkspaceProps["camera"];
  const microphone = { devices: [], busyIds: [], scanning: false, connect: recordConnection("connect-microphone"), disconnect: recordConnection("disconnect-microphone"), connections: { [audioCard.id]: {
    connected: true, label: "Fixture Audio", stream: { active: true }, sampleRate: 48000, analyser: { fftSize: 32 },
  } } } as unknown as AcquisitionWorkspaceProps["microphone"];
  const sdk = { info: { loaded: true }, instances: sensors.map((sensor, index) => ({ instance_id: sensor.id, connected: true, has_device: true, ready: true,
    frames: 1, stream_ids: [devices[index].id] })), ports: [], busyIds: [], scanning: false, scanPorts: async () => {}, connect: recordConnection("connect-sdk"), disconnect: recordConnection("disconnect-sdk") } as unknown as AcquisitionWorkspaceProps["sdk"];
  const media = [
    { id: "camera-c-corner", name: "测试摄像头", kind: "camera", mime_type: "video/webm", url: "/fixture/video.webm" },
    { id: "microphone-m-corner", name: "测试麦克风", kind: "audio", mime_type: "audio/wav", sample_rate: 48000, url: "/fixture/audio.wav" },
  ].map(entry => ({ ...entry, offset_s: 0, duration_s: 20 }));
  const session = { id: "corner-fixture", name: "卡片拖动回归", duration_s: 20, status: "complete", streams: devices, media_streams: media } as unknown as Session;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async input => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/annotations")) return json({ schema_version: 1, session_id: session.id, revision: 0,
      experiment: emptyExperiment(), labels: [], annotations: [], history: [] });
    assert.ok(url.pathname.endsWith("/replay"), `Unexpected fixture request: ${url.pathname}`);
    return json({ session_id: session.id, time_s: 0, duration_s: 20, media_streams: media,
      streams: Object.fromEntries(devices.map(device => [device.id, { available: true, relative_time_s: 0, pressure: { rows: 2, cols: 2, values: [1, 2, 3, 4] } }])) });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(mode === "replay"
    ? <SessionReplay session={session} onClose={() => {}} onExport={() => {}} />
    : <AcquisitionWorkspace workspace={{ version: 1, layout: "grid", cards: [...sensors, cameraCard, audioCard] }}
      onAddSdk={() => {}} onAddCamera={() => {}} onAddMicrophone={() => {}} onRemove={async () => {}}
      onUpdate={() => {}} onLayout={() => {}} devices={devices} sdk={sdk} camera={camera} microphone={microphone}
      online recording={false} busy={false} previewPaused={false} previewConnected previewRate={5} onTogglePreview={() => {}} cardContentFullscreen />));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch;
    window.localStorage.clear(); });
  const board = host.querySelector<HTMLElement>(".media-sensor-layout")!;
  const card = host.querySelector<HTMLElement>(mode === "live" ? ".media-camera-card" : ".replay-video-card")!;
  const audio = host.querySelector<HTMLElement>(mode === "live" ? ".media-audio-card" : ".replay-audio-card")!;
  const sensorNodes = () => [...host.querySelectorAll<HTMLElement>(mode === "live" ? '.workspace-card-grid [data-instance-id]' : '.replay-stream-grid [data-replay-id]')];
  const sensorCard = sensorNodes()[2]!;
  const sensorId = mode === "live" ? sensors[2].id : `stream:${devices[2].id}`;
  assert.ok(card.classList.contains("bounded-media-card"));
  assert.equal(card.querySelector(".card-size-controls"), null, "old independent media resizing is not mounted");
  const mediaNodes = () => [...host.querySelectorAll<HTMLMediaElement>("video,audio")];
  const visualNodes = () => [...host.querySelectorAll("video,audio,.workspace-microphone-stage canvas")];
  const pointer = async (type: string, x: number, y: number, targetCard = card, axis = "both") => act(async () => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 71 }, isPrimary: { value: true } });
    const targetGrip = targetCard.classList.contains("independent-size-card")
      ? targetCard.querySelector<HTMLElement>(axis === "width" ? ".card-resize-right" : axis === "height" ? ".card-resize-bottom" : ".card-resize-corner")
      : board.querySelector<HTMLElement>(`[aria-label="${axis === "width" ? "调整音视频栏宽度" : "调整摄像头与麦克风高度"}"]`);
    assert.ok(targetGrip); targetGrip.dispatchEvent(event); if (type === "pointermove") await delay(25);
  });
  const movePointer = async (type: string, x: number, y: number, target: HTMLElement, clickAfter = false) => act(async () => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 89 }, isPrimary: { value: true } });
    target.dispatchEvent(event);
    if (clickAfter) target.click();
  });
  return { host, board, card, audio, sensorCard, sensorNodes, sensorId, sensorStorageKey, mediaNodes, visualNodes, pointer, videoStream, mediaStorageKey,
    connectionCalls, positionStorageKey, movePointer, sensorIds: mode === "live" ? sensors.map(sensor => sensor.id) : devices.map(device => `stream:${device.id}`),
    width: (targetCard = card) => Number.parseFloat(targetCard.classList.contains("independent-size-card") ? targetCard.style.width : board.style.getPropertyValue("--media-rail-width")),
    height: (targetCard = card) => Number.parseFloat(targetCard.style.height),
  };
}

for (const mode of ["live", "replay"] as const) {
  test(`${mode} camera and microphone share width and trade height without exceeding their rail or restarting media`, async t => {
    const view = await fixture(t, mode);
    const nodes = view.visualNodes(), oldWidth = view.width(), oldHeight = view.height();
    const playCount = plays.length, pauseCount = pauses.length, audioHeight = view.height(view.audio), totalHeight = oldHeight + audioHeight;
    assert.equal(view.card.style.width, "100%"); assert.equal(view.audio.style.width, "100%");
    assert.ok(totalHeight < 700, "legacy independent heights of 1900px/1800px cannot restore media overflow");
    await view.pointer("pointerdown", 400, 300, view.card, "width");
    await view.pointer("pointermove", 520, 300, view.card, "width");
    assert.ok(Math.abs(view.width() - oldWidth - 120) < 1e-8);
    assert.equal(view.width(view.audio), view.width());
    assert.equal(window.localStorage.getItem(view.mediaStorageKey), null);
    await view.pointer("pointerup", 520, 300, view.card, "width");
    await view.pointer("pointerdown", 400, 400);
    await view.pointer("pointermove", 400, 300);
    assert.ok(Math.abs(view.height() - oldHeight + 100) < 1e-8);
    assert.ok(Math.abs(view.height(view.audio) - audioHeight - 100) < 1e-8);
    assert.ok(Math.abs(view.height() + view.height(view.audio) - totalHeight) < 1e-8);
    await view.pointer("pointerup", 400, 300);
    assert.ok(window.localStorage.getItem(view.mediaStorageKey));
    sameNodes(view.visualNodes(), nodes);
    if (mode === "live") assert.equal(view.mediaNodes()[0].srcObject, view.videoStream);
    assert.equal(plays.length, playCount); assert.equal(pauses.length, pauseCount);
  });

  test(`${mode} split pointercancel and lost capture restore both media heights without changing saved preferences`, async t => {
    const view = await fixture(t, mode), nodes = view.visualNodes();
    await view.pointer("pointerdown", 400, 500); await view.pointer("pointermove", 460, 440); await view.pointer("pointerup", 460, 440);
    const saved = window.localStorage.getItem(view.mediaStorageKey), width = view.width(), height = view.height(), audioHeight = view.height(view.audio);
    for (const event of ["pointercancel", "lostpointercapture"]) {
      await view.pointer("pointerdown", 460, 440); await view.pointer("pointermove", 540, 360);
      assert.equal(view.width(), width); assert.notEqual(view.height(), height);
      await view.pointer(event, 540, 360);
      assert.equal(view.width(), width); assert.equal(view.height(), height);
      assert.equal(view.height(view.audio), audioHeight);
      assert.equal(window.localStorage.getItem(view.mediaStorageKey), saved);
      sameNodes(view.visualNodes(), nodes);
    }
  });

  test(`${mode} a third-column sensor fills both rows while all five cards stay mounted and media sizes stay unchanged`, async t => {
    const view = await fixture(t, mode), nodes = view.visualNodes(), sensors = view.sensorNodes();
    const media = [view.width(), view.height(), view.height(view.audio)], playCount = plays.length, pauseCount = pauses.length;
    const initial = { width: view.width(view.sensorCard), height: view.height(view.sensorCard) };
    assert.equal(sensors.length, 5);
    assert.equal(view.sensorCard.style.gridColumn, "3");
    assert.equal(view.sensorCard.style.gridRow, "1 / span 1");
    await view.pointer("pointerdown", 400, 400, view.sensorCard, "width");
    await view.pointer("pointermove", 360, 400, view.sensorCard, "width");
    await view.pointer("pointerup", 360, 400, view.sensorCard, "width");
    const width = view.width(view.sensorCard);
    assert.equal(width, Math.max(200, initial.width - 40));
    await act(async () => view.sensorCard.querySelector<HTMLButtonElement>(".card-size-fill-height")!.click());
    assert.equal(view.height(view.sensorCard), view.board.getBoundingClientRect().height - 1, "full height uses the board budget, including the space between grid rows");
    assert.equal(view.width(view.sensorCard), width);
    assert.equal(view.sensorCard.style.gridColumn, "3");
    assert.equal(view.sensorCard.style.gridRow, "1 / span 2");
    assert.equal(view.sensorCard.querySelector(".card-size-fill-height")!.getAttribute("aria-pressed"), "true");
    assert.ok(view.sensorNodes().every(card => !card.hidden), "one full-height column still fits all five source cards on the same page");
    assert.deepEqual(view.sensorNodes().map(card => [card.style.gridColumn, card.style.gridRow]), [
      ["1", "1 / span 1"], ["2", "1 / span 1"], ["3", "1 / span 2"], ["1", "2 / span 1"], ["2", "2 / span 1"],
    ]);
    const saved = JSON.parse(window.localStorage.getItem(view.sensorStorageKey)!);
    assert.equal(saved.cards[view.sensorId].fullHeight, true);
    assert.deepEqual(Object.keys(saved.cards), [view.sensorId], "same-named sensors retain separate size preferences");
    await act(async () => view.sensorCard.querySelector<HTMLButtonElement>(".card-size-fill-height")!.click());
    assert.equal(view.height(view.sensorCard), initial.height);
    assert.equal(view.width(view.sensorCard), width, "restoring only height preserves the customized width");
    assert.equal(view.sensorCard.style.gridRow, "1 / span 1");
    assert.deepEqual([view.width(), view.height(), view.height(view.audio)], media);
    sameNodes(view.sensorNodes(), sensors); sameNodes(view.visualNodes(), nodes);
    assert.equal(plays.length, playCount); assert.equal(pauses.length, pauseCount);
  });

  test(`${mode} bottom-edge End and dragging can fill the board, while cancellation restores the previous row span and persistence`, async t => {
    const view = await fixture(t, mode), nodes = view.visualNodes(), sensors = view.sensorNodes();
    const initialHeight = view.height(view.sensorCard), width = view.width(view.sensorCard);
    const media = [view.width(), view.height(), view.height(view.audio)];
    let bubbledKeys = 0;
    const countBubbledKey = () => bubbledKeys++;
    document.addEventListener("keydown", countBubbledKey);
    t.after(() => document.removeEventListener("keydown", countBubbledKey));
    const bottom = view.sensorCard.querySelector<HTMLElement>(".card-resize-bottom")!;
    await act(async () => bottom.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    assert.equal(view.height(view.sensorCard), 699);
    assert.equal(view.sensorCard.style.gridRow, "1 / span 2");
    assert.equal(bubbledKeys, 0, "resize keyboard controls cannot reach recording shortcuts");
    assert.equal(JSON.parse(window.localStorage.getItem(view.sensorStorageKey)!).cards[view.sensorId].fullHeight, true);
    await act(async () => view.sensorCard.querySelector<HTMLButtonElement>(".card-size-fill-height")!.click());
    const saved = window.localStorage.getItem(view.sensorStorageKey);
    for (const cancel of ["pointercancel", "lostpointercapture"]) {
      await view.pointer("pointerdown", 400, 400, view.sensorCard, "height");
      await view.pointer("pointermove", 400, 1200, view.sensorCard, "height");
      assert.equal(view.height(view.sensorCard), 699);
      assert.equal(view.sensorCard.style.gridRow, "1 / span 2");
      assert.equal(window.localStorage.getItem(view.sensorStorageKey), saved, "drag preview does not save until release");
      await view.pointer(cancel, 400, 1200, view.sensorCard, "height");
      assert.equal(view.height(view.sensorCard), initialHeight);
      assert.equal(view.sensorCard.style.gridRow, "1 / span 1");
      assert.equal(window.localStorage.getItem(view.sensorStorageKey), saved);
    }
    await view.pointer("pointerdown", 400, 400, view.sensorCard, "height");
    await view.pointer("pointermove", 400, 1200, view.sensorCard, "height");
    await view.pointer("pointerup", 400, 1200, view.sensorCard, "height");
    assert.equal(view.height(view.sensorCard), 699);
    assert.equal(view.sensorCard.style.gridRow, "1 / span 2");
    assert.equal(JSON.parse(window.localStorage.getItem(view.sensorStorageKey)!).cards[view.sensorId].fullHeight, true);
    assert.equal(view.width(view.sensorCard), width);
    assert.deepEqual([view.width(), view.height(), view.height(view.audio)], media);
    sameNodes(view.sensorNodes(), sensors); sameNodes(view.visualNodes(), nodes);
  });

  test(`${mode} a later full-height sensor rearranges cards and extra full columns paginate overflow without remounting`, async t => {
    const view = await fixture(t, mode), nodes = view.visualNodes(), sensors = view.sensorNodes();
    await act(async () => sensors[3].querySelector<HTMLButtonElement>(".card-size-fill-height")!.click());
    assert.ok(view.sensorNodes().every(card => !card.hidden), "a full-height fourth card repacks the same page instead of creating unnecessary pagination");
    assert.equal(sensors[3].style.gridColumn, "1");
    assert.equal(sensors[3].style.gridRow, "1 / span 2");
    await act(async () => view.sensorCard.querySelector<HTMLButtonElement>(".card-size-fill-height")!.click());
    assert.deepEqual(view.sensorNodes().map(card => card.hidden), [false, false, false, false, true]);
    assert.equal(view.sensorCard.style.gridColumn, "3");
    assert.equal(view.sensorCard.style.gridRow, "1 / span 2");
    assert.equal(view.card.hidden, false); assert.equal(view.audio.hidden, false);
    await act(async () => sensors[3].querySelector<HTMLButtonElement>(".card-size-fill-height")!.click());
    assert.ok(view.sensorNodes().every(card => !card.hidden));
    sameNodes(view.sensorNodes(), sensors); sameNodes(view.visualNodes(), nodes);
  });

  test(`${mode} sensor dragging changes the saved grid position without replacing media or calling device connections`, async t => {
    const view = await fixture(t, mode), sensors = view.sensorNodes(), nodes = view.visualNodes();
    const source = sensors[0], handle = source.querySelector<HTMLElement>(".card-move-handle")!;
    const playCount = plays.length, pauseCount = pauses.length;
    const media = [view.width(), view.height(), view.height(view.audio)];
    assert.ok(handle); assert.equal(source.style.gridColumn, "1"); assert.equal(source.style.gridRow, "1 / span 1");
    await view.movePointer("pointerdown", 100, 100, handle);
    await view.movePointer("pointermove", 1450, 500, handle);
    const target = view.host.querySelector<HTMLElement>(".card-drop-target")!;
    assert.ok(target); assert.ok(Number.parseFloat(target.style.left) > 0); assert.ok(Number.parseFloat(target.style.top) > 0);
    assert.equal(window.localStorage.getItem(view.positionStorageKey), null, "drag preview is not persisted before release");
    assert.equal(source.classList.contains("card-is-moving"), true);
    await view.movePointer("pointerup", 1450, 500, handle, true);
    assert.equal(source.style.gridColumn, "3"); assert.equal(source.style.gridRow, "2 / span 1");
    assert.equal(view.host.querySelector(".card-position-menu"), null, "the native click following a drag must not open the positioning menu");
    assert.equal(view.host.querySelector(".card-drop-target"), null);
    const saved = JSON.parse(window.localStorage.getItem(view.positionStorageKey)!);
    const { priority, ...position } = saved.positions[view.sensorIds[0]];
    assert.deepEqual(position, { column: 3, row: 2, columnsAtSave: 3 });
    assert.ok(Number.isSafeInteger(priority) && priority > 0, "the saved card retains a valid placement priority");
    assert.equal(new Set(sensors.map(card => `${card.style.gridColumn}:${card.style.gridRow}`)).size, 5, "other cards make room without overlapping");
    assert.ok(sensors.every(card => !card.hidden));
    sameNodes(view.sensorNodes(), sensors); sameNodes(view.visualNodes(), nodes);
    assert.deepEqual([view.width(), view.height(), view.height(view.audio)], media);
    if (mode === "live") assert.equal(view.mediaNodes()[0].srcObject, view.videoStream);
    assert.deepEqual(view.connectionCalls, []); assert.equal(plays.length, playCount); assert.equal(pauses.length, pauseCount);
  });

  test(`${mode} dropping a sensor onto another card swaps both saved positions without shifting neighbours or restarting media`, async t => {
    const view = await fixture(t, mode), sensors = view.sensorNodes(), nodes = view.visualNodes();
    const source = sensors[0], destination = sensors[4], handle = source.querySelector<HTMLElement>(".card-move-handle")!;
    const coordinates = () => sensors.map(card => [card.style.gridColumn, card.style.gridRow]);
    const initial = coordinates(), media = [view.width(), view.height(), view.height(view.audio)];
    const playCount = plays.length, pauseCount = pauses.length;
    assert.deepEqual(initial[0], ["1", "1 / span 1"]); assert.deepEqual(initial[4], ["2", "2 / span 1"]);
    await view.movePointer("pointerdown", 100, 100, handle);
    await view.movePointer("pointermove", 800, 500, handle);
    assert.ok(view.host.querySelector(".card-drop-target"));
    assert.equal(window.localStorage.getItem(view.positionStorageKey), null, "an occupied drop target is only a preview before release");
    await view.movePointer("pointerup", 800, 500, handle, true);
    const swapped = initial.map((position, index) => index === 0 ? initial[4] : index === 4 ? initial[0] : position);
    assert.deepEqual(coordinates(), swapped, "the destination returns to the source cell and all other cards stay put");
    assert.equal(destination.style.gridColumn, "1"); assert.equal(destination.style.gridRow, "1 / span 1");
    assert.equal(view.host.querySelector(".card-position-menu"), null);
    assert.equal(view.host.querySelector(".card-drop-target"), null);
    let saved = JSON.parse(window.localStorage.getItem(view.positionStorageKey)!);
    for (const index of [0, 4]) {
      assert.equal(saved.positions[view.sensorIds[index]].column, Number(swapped[index][0]));
      assert.equal(saved.positions[view.sensorIds[index]].row, Number.parseInt(swapped[index][1]));
      assert.equal(saved.positions[view.sensorIds[index]].columnsAtSave, 3);
    }
    assert.ok(sensors.every(card => !card.hidden));
    sameNodes(view.sensorNodes(), sensors); sameNodes(view.visualNodes(), nodes);
    assert.deepEqual([view.width(), view.height(), view.height(view.audio)], media);
    if (mode === "live") assert.equal(view.mediaNodes()[0].srcObject, view.videoStream);
    assert.deepEqual(view.connectionCalls, []); assert.equal(plays.length, playCount); assert.equal(pauses.length, pauseCount);

    const firstSaved = window.localStorage.getItem(view.positionStorageKey);
    await view.movePointer("pointerdown", 800, 500, handle);
    await view.movePointer("pointermove", 100, 100, handle);
    assert.equal(window.localStorage.getItem(view.positionStorageKey), firstSaved, "a second exchange still waits for release before saving");
    await view.movePointer("pointerup", 100, 100, handle, true);
    assert.deepEqual(coordinates(), initial, "repeating the exchange restores the entire original arrangement");
    saved = JSON.parse(window.localStorage.getItem(view.positionStorageKey)!);
    for (const index of [0, 4]) {
      assert.equal(saved.positions[view.sensorIds[index]].column, Number(initial[index][0]));
      assert.equal(saved.positions[view.sensorIds[index]].row, Number.parseInt(initial[index][1]));
    }
    sameNodes(view.sensorNodes(), sensors); sameNodes(view.visualNodes(), nodes);
    if (mode === "live") assert.equal(view.mediaNodes()[0].srcObject, view.videoStream);
    assert.deepEqual(view.connectionCalls, []); assert.equal(plays.length, playCount); assert.equal(pauses.length, pauseCount);
  });

  test(`${mode} full-height sensor positioning supports menu and keyboard alternatives, while cancelled header drags leave saved layout intact`, async t => {
    const view = await fixture(t, mode), sensors = view.sensorNodes(), nodes = view.visualNodes();
    const source = sensors[0], handle = source.querySelector<HTMLButtonElement>(".card-move-handle")!;
    const playCount = plays.length, pauseCount = pauses.length;
    await act(async () => source.querySelector<HTMLButtonElement>(".card-size-fill-height")!.click());
    assert.equal(source.style.gridRow, "1 / span 2");
    await act(async () => handle.click());
    const menu = source.querySelector<HTMLElement>(".card-position-menu")!;
    assert.ok(menu);
    assert.equal(menu.querySelector<HTMLButtonElement>('[aria-label$="向上移动"]')!.disabled, true);
    assert.equal(menu.querySelector<HTMLButtonElement>('[aria-label$="向下移动"]')!.disabled, true);
    const right = menu.querySelector<HTMLButtonElement>('[aria-label$="移到最右"]')!;
    await view.movePointer("pointerdown", 100, 100, right);
    assert.equal(view.host.querySelector(".card-drop-target"), null, "menu controls do not start a header drag");
    await view.movePointer("pointerup", 100, 100, right, true);
    assert.equal(source.style.gridColumn, "3"); assert.equal(source.style.gridRow, "1 / span 2");
    assert.equal(source.querySelector(".card-position-menu"), null); assert.equal(document.activeElement, handle);
    assert.ok(sensors.every(card => !card.hidden), "four half-height neighbours still fit beside the full-height column");
    await act(async () => handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    assert.equal(source.style.gridColumn, "2"); assert.equal(source.style.gridRow, "1 / span 2");
    await act(async () => handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    assert.equal(source.style.gridColumn, "3");
    const saved = window.localStorage.getItem(view.positionStorageKey);
    const header = source.querySelector<HTMLElement>(".card-move-header")!;
    await view.movePointer("pointerdown", 1450, 100, header);
    await view.movePointer("pointermove", 100, 100, header);
    assert.ok(view.host.querySelector(".card-drop-target"));
    await view.movePointer("pointercancel", 100, 100, header);
    assert.equal(view.host.querySelector(".card-drop-target"), null);
    assert.equal(window.localStorage.getItem(view.positionStorageKey), saved);
    assert.equal(source.style.gridColumn, "3"); assert.equal(source.style.gridRow, "1 / span 2");
    sameNodes(view.sensorNodes(), sensors); sameNodes(view.visualNodes(), nodes);
    assert.deepEqual(view.connectionCalls, []); assert.equal(plays.length, playCount); assert.equal(pauses.length, pauseCount);
  });
}

async function pluginCameraFixture(t: TestContext) {
  window.localStorage.clear();
  const plugin: SensorPlugin = { id: "fixture-stereo-wide", name: "测试双目 SDK 相机", version: "1.0.0", entry: "adapter.mjs", streams: [
    { id: "rgb_left", name: "左目 RGB", kind: "camera" }, { id: "rgb_right", name: "右目 RGB", kind: "camera" },
  ] };
  const camera = createPluginCard(plugin, "p-wide-camera");
  const sensors = Array.from({ length: 4 }, (_, index) => createSdkCard("hand-pad", `s-wide-neighbour-${index}`));
  const cards = [camera, ...sensors];
  const devices: Device[] = [
    ...plugin.streams.map(stream => ({ id: `plugin-${camera.id}-${stream.id}`, name: stream.name, kind: stream.kind,
      transport: "sdk-plugin", mode: "sdk-plugin", connected: true, sample_rate: 30, channels: 3, unit: "MJPEG" })),
    ...sensors.map(sensor => ({ id: cardStreamIds(sensor)[0], name: "压力阵列", kind: "pressure" as const,
      transport: "serial", mode: "hardware", connected: true, sample_rate: 100, channels: 4, unit: "ADC", rows: 2, cols: 2 })),
  ];
  const mutations: string[] = [];
  const forbidden = (name: string) => async () => { mutations.push(name); };
  const props = {
    workspace: { version: 1, layout: "grid", cards }, devices,
    sdk: { info: { loaded: true }, instances: sensors.map(sensor => ({ instance_id: sensor.id, connected: true,
      has_device: true, ready: true, frames: 1, stream_ids: cardStreamIds(sensor) })), ports: [], busyIds: [], scanning: false,
      scanPorts: async () => {}, connect: forbidden("sdk-connect"), disconnect: forbidden("sdk-disconnect") },
    camera: { devices: [], connections: {}, busyIds: [], scanning: false, connect: forbidden("browser-connect"), disconnect: forbidden("browser-disconnect") },
    plugins: { plugins: [plugin], instances: [{ instance_id: camera.id, plugin_id: plugin.id, connected: true,
      stream_ids: cardStreamIds(camera), received_records: 60 }], busyIds: [], error: "",
      connect: forbidden("plugin-connect"), disconnect: forbidden("plugin-disconnect"), refresh: async () => {} },
    onAddSdk: () => {}, onAddCamera: () => {}, onAddPlugin: () => {}, onRemove: forbidden("remove"), onUpdate: () => {}, onLayout: () => {},
    online: true, recording: false, busy: false, previewPaused: false, previewConnected: true, previewRate: 5,
    onTogglePreview: () => {}, cardContentFullscreen: true,
  } as unknown as AcquisitionWorkspaceProps;
  let generation = 0;
  const bounds = { width: 1600, height: 700 };
  const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
    ...bounds, right: bounds.width, bottom: bounds.height, toJSON: () => ({}) });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = () => act(async () => root.render(<AcquisitionWorkspace {...props} key={generation} />));
  await render();
  t.after(async () => {
    await act(async () => root.unmount()); host.remove();
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalBounds; window.localStorage.clear();
  });
  const article = () => host.querySelector<HTMLElement>(`[data-instance-id="${camera.id}"]`)!;
  const nodes = () => [...host.querySelectorAll(".workspace-sensor-card,canvas")];
  const storageKey = cardSizesStorageKey("live:sensors");
  const saved = () => window.localStorage.getItem(storageKey);
  const pointer = async (type: string, x: number, y: number, axis = "both") => act(async () => {
    const target = article().querySelector<HTMLElement>(axis === "width" ? ".card-resize-right" : axis === "height" ? ".card-resize-bottom" : ".card-resize-corner")!;
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 131 }, isPrimary: { value: true } });
    target.dispatchEvent(event); if (type === "pointermove") await delay(25);
  });
  const occupy = () => {
    const grid = host.querySelector<HTMLElement>(".workspace-card-grid")!;
    const columns = Number(grid.style.getPropertyValue("--monitor-columns"));
    const rows = Number(grid.style.getPropertyValue("--monitor-rows"));
    const used = new Set<string>();
    for (const card of host.querySelectorAll<HTMLElement>(".workspace-sensor-card:not([hidden])")) {
      const [column, columnSpan = "1"] = card.style.gridColumn.split(/\s*\/\s*span\s*/);
      const [row, rowSpan = "1"] = card.style.gridRow.split(/\s*\/\s*span\s*/);
      assert.ok(Number(column) >= 1 && Number(column) + Number(columnSpan) - 1 <= columns, "card must stay within grid columns");
      assert.ok(Number(row) >= 1 && Number(row) + Number(rowSpan) - 1 <= rows, "card must stay within grid rows");
      for (let c = 0; c < Number(columnSpan); c++) for (let r = 0; r < Number(rowSpan); r++) {
        const key = `${Number(column) + c}:${Number(row) + r}`;
        assert.ok(!used.has(key), `visible cards overlap at ${key}`); used.add(key);
      }
    }
  };
  return { host, article, nodes, camera, mutations, pointer, saved, occupy, bounds,
    width: () => parseFloat(article().style.width), height: () => parseFloat(article().style.height),
    remount: async () => { generation++; await render(); },
    resize: async (width: number) => { bounds.width = width; await act(async () => window.dispatchEvent(new dom.window.Event("resize"))); },
  };
}

test("a connected stereo plugin grows past its original column, neighbours repack and both preview canvases remain mounted", async t => {
  const view = await pluginCameraFixture(t), originalNodes = view.nodes();
  const originalWidth = view.width(), originalHeight = view.height();
  assert.equal(view.article().querySelectorAll(".workspace-camera-feed canvas").length, 2);
  assert.ok(Number(view.article().querySelector(".card-resize-right")!.getAttribute("aria-valuemax")) > originalWidth * 2,
    "the right handle maximum is the display width, not one grid column");
  await view.pointer("pointerdown", 400, 350, "width");
  await view.pointer("pointermove", 600, 350, "width");
  assert.equal(view.width(), originalWidth + 200);
  assert.equal(view.height(), originalHeight);
  assert.match(view.article().style.gridColumn, /\/ span 2$/);
  assert.equal(view.saved(), null, "resize preview does not persist until release");
  assert.ok([...view.host.querySelectorAll<HTMLElement>(".workspace-sensor-card")].every(card => !card.hidden),
    "one two-column camera plus four single-cell cards fit in the six-cell board");
  view.occupy(); sameNodes(view.nodes(), originalNodes);
  await view.pointer("pointerup", 600, 350, "width");
  const savedWidth = JSON.parse(view.saved()!).cards[view.camera.id].width;
  assert.equal(savedWidth, originalWidth + 200);
  assert.deepEqual(view.mutations, []);
  await view.remount();
  assert.equal(view.width(), savedWidth); assert.match(view.article().style.gridColumn, /\/ span 2$/);
  view.occupy();
  const restoredNodes = view.nodes(), saved = view.saved();
  await view.resize(500);
  assert.ok(view.width() <= 499 && view.width() > 490);
  assert.equal(view.saved(), saved, "a narrow viewport constrains the rendered width without replacing the preferred width");
  sameNodes(view.nodes(), restoredNodes); view.occupy();
  await view.resize(1600);
  assert.equal(view.width(), savedWidth); assert.equal(view.saved(), saved);
  sameNodes(view.nodes(), restoredNodes); view.occupy(); assert.deepEqual(view.mutations, []);
});

test("diagonal stereo resizing spans rows and columns with bounded pagination, and cancellation restores the original layout", async t => {
  const view = await pluginCameraFixture(t), originalNodes = view.nodes();
  const originalWidth = view.width(), originalHeight = view.height();
  await view.pointer("pointerdown", 400, 350);
  await view.pointer("pointermove", 650, 450);
  assert.equal(view.width(), originalWidth + 250); assert.equal(view.height(), originalHeight + 100);
  assert.match(view.article().style.gridColumn, /\/ span 2$/); assert.equal(view.article().style.gridRow, "1 / span 2");
  view.occupy(); sameNodes(view.nodes(), originalNodes);
  const cards = [...view.host.querySelectorAll<HTMLElement>(".workspace-sensor-card")];
  assert.ok(cards.some(card => card.hidden), "cards that cannot fit beside the wide/tall camera move to another page");
  assert.equal(view.article().hidden, false, "the card being resized stays on the active page");
  await view.pointer("pointercancel", 650, 450);
  assert.equal(view.width(), originalWidth); assert.equal(view.height(), originalHeight);
  assert.equal(view.saved(), null); assert.ok(cards.every(card => !card.hidden));
  sameNodes(view.nodes(), originalNodes); view.occupy();
  await view.pointer("pointerdown", 400, 350);
  await view.pointer("pointermove", 650, 450);
  await view.pointer("pointerup", 650, 450);
  assert.equal(JSON.parse(view.saved()!).cards[view.camera.id].width, originalWidth + 250);
  assert.equal(JSON.parse(view.saved()!).cards[view.camera.id].height, originalHeight + 100);
  sameNodes(view.nodes(), originalNodes); view.occupy(); assert.deepEqual(view.mutations, []);
  await view.remount();
  assert.equal(view.width(), originalWidth + 250); assert.equal(view.height(), originalHeight + 100);
  assert.match(view.article().style.gridColumn, /\/ span 2$/); assert.equal(view.article().style.gridRow, "1 / span 2");
  view.occupy(); assert.deepEqual(view.mutations, []);
});
