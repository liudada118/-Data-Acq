import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { workspacePageRange, workspaceViewportLayout } from "../src/viewport-layout";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import { cardStreamIds, createCameraCard, createMicrophoneCard, createSdkCard } from "../src/workspace";
import type { WorkspaceState } from "../src/workspace";

test("monitor displays two, four or six feeds when their minimum viewport sizes fit", () => {
  assert.deepEqual(workspaceViewportLayout(1200, 560, 2), { columns: 2, rows: 1, pageSize: 2 });
  assert.deepEqual(workspaceViewportLayout(1200, 560, 4), { columns: 2, rows: 2, pageSize: 4 });
  assert.deepEqual(workspaceViewportLayout(1200, 560, 6), { columns: 3, rows: 2, pageSize: 6 });
  const small = workspaceViewportLayout(680, 420, 6);
  assert.equal(small.columns, 2); assert.equal(small.rows, 1); assert.equal(small.pageSize, 2);
  const mobile = workspaceViewportLayout(340, 500, 6);
  assert.deepEqual(mobile, { columns: 1, rows: 1, pageSize: 1 });
  assert.equal(workspaceViewportLayout(1400, 600, 6, true).columns, 1);
});

test("page ranges remain valid as cards are removed or viewport capacity changes", () => {
  assert.deepEqual(workspacePageRange(7, 6, 1), { page: 1, pages: 2, start: 6, end: 7 });
  assert.deepEqual(workspacePageRange(4, 6, 1), { page: 0, pages: 1, start: 0, end: 4 });
  assert.deepEqual(workspacePageRange(0, 6, 10), { page: 0, pages: 1, start: 0, end: 0 });
  assert.equal(workspaceViewportLayout(NaN, Infinity, 3).pageSize, 1);
});

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const capturedPointers = new WeakMap<Element, number>();
Object.assign(dom.window.HTMLElement.prototype, {
  setPointerCapture(this: HTMLElement, id: number) { capturedPointers.set(this, id); },
  hasPointerCapture(this: HTMLElement, id: number) { return capturedPointers.get(this) === id; },
  releasePointerCapture(this: HTMLElement) { capturedPointers.delete(this); },
});
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { value: function (this: HTMLElement) {
  return { width: 1200, height: this.classList.contains("workspace-card-grid") ? 560 : 700, top: 100, left: 0, bottom: 800, right: 1200 };
} });
const { createRoot } = await import("react-dom/client");

test("pagination and focus keep all sensor components mounted and expose stop while recording", async t => {
  const cards = Array.from({ length: 7 }, (_, i) => createSdkCard("hand-pad", `s-monitor-${i}`));
  const devices = cards.map(card => ({ id: cardStreamIds(card)[0], kind: "pressure" as const, name: card.id,
    channels: 1024, sample_rate: 20, unit: "ADC", mode: "hardware", transport: "serial", connected: true }));
  const disconnects: string[] = [];
  const sdk = { info: { loaded: true }, instances: cards.map(card => ({ instance_id: card.id, product: "hand-pad", connected: true, has_device: true, ready: true, frames: 5, stream_ids: cardStreamIds(card) })),
    ports: [], busyIds: [], scanning: false, scanPorts: async () => {}, disconnect: async (id: string) => { disconnects.push(id); }, connect: async () => {} } as unknown as AcquisitionWorkspaceProps["sdk"];
  const camera = { connections: {}, busyIds: [], devices: [], scanning: false } as unknown as AcquisitionWorkspaceProps["camera"];
  let stops = 0;
  function Harness() {
    const [workspace, setWorkspace] = useState<WorkspaceState>({ version: 1, layout: "grid", cards });
    return <AcquisitionWorkspace workspace={workspace} onAddSim={() => {}} onAddSdk={() => {}} onAddCamera={() => {}} onRemove={async () => {}}
      onUpdate={(id, patch) => setWorkspace(previous => ({ ...previous, cards: previous.cards.map(card => card.id === id ? { ...card, ...patch } : card) }))}
      onLayout={layout => setWorkspace(previous => ({ ...previous, layout }))} devices={devices} sdk={sdk} camera={camera}
      online recording busy={false} previewPaused={false} previewConnected previewRate={5} onTogglePreview={() => {}} onStopRecording={() => { stops++; }} />;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<Harness />));
  const catalog = host.querySelector('.sensor-catalog')!;
  assert.doesNotMatch(catalog.textContent ?? "", /模拟|链路测试/);
  assert.equal(catalog.querySelectorAll('.catalog-item').length, 6, "catalog only offers four real SDK products, camera and microphone");
  const first = host.querySelector('[data-instance-id="s-monitor-0"]')!;
  assert.equal(host.querySelectorAll(".workspace-sensor-card").length, 7);
  assert.equal(host.querySelectorAll(".workspace-sensor-card:not([hidden])").length, 6);
  assert.equal(first.querySelector<HTMLElement>(".workspace-config-panel")!.hidden, true, "connected controls start folded");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="下一屏传感器"]')!.click());
  assert.equal(host.querySelectorAll(".workspace-sensor-card:not([hidden])").length, 1);
  assert.equal(host.querySelector('[data-instance-id="s-monitor-0"]'), first, "hidden feeds retain the same component DOM");
  assert.deepEqual(disconnects, []);
  await act(async () => host.querySelector<HTMLButtonElement>(".monitor-focus-toggle")!.click());
  assert.ok(host.querySelector(".monitor-focused"));
  const stop = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "停止并保存");
  assert.ok(stop); assert.equal(stop.disabled, false);
  await act(async () => stop.click());
  assert.equal(stops, 1);
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(host.querySelector(".monitor-focused"), null);
});

test("live camera and microphone stay in the left rail through sensor pages, layout changes and focus", async t => {
  window.localStorage.clear();
  const sensors = Array.from({ length: 5 }, (_, i) => createSdkCard("hand-pad", `s-rail-${i}`));
  const phone = { ...createCameraCard("c-rail"), deviceId: "phone-video" };
  const mic = { ...createMicrophoneCard("m-rail"), deviceId: "phone-audio" };
  const cards = [...sensors, phone, mic];
  const devices = cards.map(card => ({ id: cardStreamIds(card)[0], kind: card.source === "camera" ? "camera" as const : card.source === "microphone" ? "audio" as const : "pressure" as const,
    name: card.id, channels: 1, sample_rate: 100, unit: "raw", mode: "hardware", transport: "fixture", connected: true }));
  const sdk = { info: { loaded: true }, instances: sensors.map(card => ({ instance_id: card.id, connected: true, has_device: true, ready: true, frames: 5, stream_ids: cardStreamIds(card) })),
    ports: [], busyIds: [], scanning: false, scanPorts: async () => {} } as unknown as AcquisitionWorkspaceProps["sdk"];
  const videoStream = { active: true } as MediaStream;
  const camera = { devices: [{ deviceId: "phone-video", label: "DroidCam Video" }], busyIds: [], scanning: false,
    connections: { [phone.id]: { connected: true, label: "DroidCam Video", stream: videoStream, width: 1280, height: 720, frameRate: 30 } } } as unknown as AcquisitionWorkspaceProps["camera"];
  const microphone = { devices: [{ deviceId: "phone-audio", label: "DroidCam Audio" }], busyIds: [], scanning: false,
    connections: { [mic.id]: { connected: true, label: "DroidCam Audio", stream: { active: true }, sampleRate: 48000, analyser: { fftSize: 32 } } } } as unknown as AcquisitionWorkspaceProps["microphone"];
  const originalPlay = dom.window.HTMLMediaElement.prototype.play, originalPause = dom.window.HTMLMediaElement.prototype.pause;
  let plays = 0;
  dom.window.HTMLMediaElement.prototype.play = async () => { plays++; };
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  function Harness() {
    const [workspace, setWorkspace] = useState<WorkspaceState>({ version: 1, layout: "grid", cards });
    return <AcquisitionWorkspace workspace={workspace} onAddSdk={() => {}} onAddCamera={() => {}} onAddMicrophone={() => {}} onRemove={async () => {}}
      onUpdate={(id, patch) => setWorkspace(previous => ({ ...previous, cards: previous.cards.map(card => card.id === id ? { ...card, ...patch } : card) }))}
      onLayout={layout => setWorkspace(previous => ({ ...previous, layout }))} devices={devices} sdk={sdk} camera={camera} microphone={microphone}
      online recording={false} busy={false} previewPaused={false} previewConnected previewRate={5} onTogglePreview={() => {}} cardContentFullscreen />;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); dom.window.HTMLMediaElement.prototype.play = originalPlay; dom.window.HTMLMediaElement.prototype.pause = originalPause;
    window.localStorage.clear(); });
  await act(async () => root.render(<Harness />));
  const video = host.querySelector("video")!, waveform = host.querySelector(".workspace-microphone-stage canvas")!;
  const rail = host.querySelector<HTMLElement>('.media-rail[aria-label="影像与声音"]')!;
  assert.ok(video && waveform); assert.ok(rail.contains(video) && rail.contains(waveform));
  const mediaCards = rail.querySelectorAll(":scope > [data-instance-id]");
  assert.equal(mediaCards[0].getAttribute("data-instance-id"), phone.id);
  assert.equal(mediaCards[1].getAttribute("data-instance-id"), mic.id);
  assert.equal(rail.parentElement!.firstElementChild, rail);
  const click = async (label: string) => { const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); assert.ok(button, label); await act(async () => button.click()); };
  await click("下一屏传感器");
  assert.equal(host.querySelector("video"), video); assert.equal(host.querySelector(".workspace-microphone-stage canvas"), waveform);
  assert.equal(video.closest<HTMLElement>('[data-instance-id]')!.hidden, false);
  assert.equal(waveform.closest<HTMLElement>('[data-instance-id]')!.hidden, false);
  await click("纵向布局"); await click("放大麦克风展示卡片");
  assert.equal(host.querySelector("video"), video); assert.equal(video.closest<HTMLElement>('[data-instance-id]')!.hidden, true);
  assert.equal(host.querySelector(".workspace-microphone-stage canvas"), waveform);
  await click("缩小麦克风展示卡片"); await click("网格布局");
  assert.equal(host.querySelector("video"), video); assert.equal(video.srcObject, videoStream);
  assert.equal(host.querySelector(".workspace-microphone-stage canvas"), waveform);
  const beforeResizePlays = plays;
  const board = host.querySelector<HTMLElement>(".media-sensor-layout")!;
  const initialWidth = board.style.getPropertyValue("--media-rail-width");
  const divider = board.querySelector<HTMLElement>('[aria-label="调整音视频栏宽度"]')!;
  assert.ok(divider);
  for (const [type, clientX] of [["pointerdown", 450], ["pointermove", 580], ["pointerup", 580]] as const) {
    await act(async () => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 300 });
      Object.defineProperties(event, { pointerId: { value: 51 }, isPrimary: { value: true } });
      divider.dispatchEvent(event); if (type === "pointermove") await delay(25);
    });
  }
  assert.notEqual(board.style.getPropertyValue("--media-rail-width"), initialWidth);
  assert.equal(host.querySelector("video"), video); assert.equal(video.srcObject, videoStream);
  assert.equal(host.querySelector(".workspace-microphone-stage canvas"), waveform);
  const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("恢复卡片大小"));
  assert.ok(reset); await act(async () => reset.click());
  assert.equal(board.style.getPropertyValue("--media-rail-width"), initialWidth);
  assert.equal(host.querySelector("video"), video); assert.equal(video.srcObject, videoStream);
  assert.equal(host.querySelector(".workspace-microphone-stage canvas"), waveform);
  assert.equal(plays, beforeResizePlays, "dragging and resetting never reconnect or restart the camera");
});
