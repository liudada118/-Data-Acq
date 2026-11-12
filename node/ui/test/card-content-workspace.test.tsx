import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import { cardStreamIds, createCameraCard, createSdkCard } from "../src/workspace";
import type { WorkspaceState } from "../src/workspace";
import { sensorDisplayName } from "../src/devices";
import { LivePreview } from "../src/LivePreview";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "play", { value: () => Promise.resolve() });
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "pause", { value: () => {} });
let gridSize = { width: 1200, height: 560 };
Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { value: function (this: HTMLElement) {
  return { width: gridSize.width, height: this.classList.contains("media-sensor-layout") ? gridSize.height : 700, top: 0, left: 0, bottom: 700, right: gridSize.width };
} });
const { createRoot } = await import("react-dom/client");

const click = async (element: HTMLElement) => act(async () => {
  element.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); element.click();
});
const escape = async () => act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

test("card-content settings and pagination preserve media, keep stop available, and Escape closes only the top panel", async t => {
  const sensorCards = Array.from({ length: 6 }, (_, index) => createSdkCard("hand-pad", `card-content-${index}`));
  const cameraCard = createCameraCard("c-card-content");
  const mediaStream = { getTracks: () => [] } as unknown as MediaStream;
  const disconnects: string[] = [];
  let stops = 0;
  const devices: AcquisitionWorkspaceProps["devices"] = sensorCards.map(card => ({ id: cardStreamIds(card)[0], kind: "pressure" as const, name: `Shroom ${card.id}`,
    channels: 1024, sample_rate: 20, unit: "ADC", mode: "hardware", transport: "serial", connected: true }));
  devices.push({ id: cardStreamIds(cameraCard)[0], kind: "camera", name: "Fixture camera", channels: 3,
    sample_rate: 30, unit: "RGB", mode: "browser-camera", transport: "browser", connected: true });
  const sdk = { info: { loaded: true }, instances: sensorCards.map(card => ({ instance_id: card.id,
    product: card.product, connected: true, has_device: true, ready: true, frames: 5, stream_ids: cardStreamIds(card) })),
    ports: [], busyIds: [], scanning: false, scanPorts: async () => {}, disconnect: async (id: string) => { disconnects.push(id); }, connect: async () => {} } as unknown as AcquisitionWorkspaceProps["sdk"];
  const camera = { connections: { [cameraCard.id]: { connected: true, stream: mediaStream, label: "Fixture camera", width: 720, height: 480, frameRate: 30 } },
    busyIds: [], devices: [], scanning: false, disconnect: async (id: string) => { disconnects.push(id); } } as unknown as AcquisitionWorkspaceProps["camera"];
  function Harness() {
    const [workspace, setWorkspace] = useState<WorkspaceState>({ version: 1, layout: "grid", cards: [cameraCard, ...sensorCards] });
    return <AcquisitionWorkspace cardContentFullscreen workspace={workspace} devices={devices} sdk={sdk} camera={camera}
      onAddSdk={() => {}} onAddCamera={() => {}} onRemove={async () => {}}
      onUpdate={(id, patch) => setWorkspace(previous => ({ ...previous, cards: previous.cards.map(card => card.id === id ? { ...card, ...patch } : card) }))}
      onLayout={layout => setWorkspace(previous => ({ ...previous, layout }))}
      online recording busy={false} previewPaused={false} previewConnected previewRate={5}
      onTogglePreview={() => {}} onStopRecording={() => { stops++; }} />;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); gridSize = { width: 1200, height: 560 }; });
  await act(async () => root.render(<Harness />));
  const cameraArticle = host.querySelector<HTMLElement>(`[data-instance-id="${cameraCard.id}"]`)!;
  const video = cameraArticle.querySelector<HTMLVideoElement>("video")!;
  const sensor = host.querySelector<HTMLElement>('[data-instance-id="card-content-0"]')!;
  const canvas = sensor.querySelector("canvas")!;
  assert.doesNotMatch(sensor.querySelector("header")!.textContent!, /shroom/i);
  assert.doesNotMatch(host.querySelector(".sensor-catalog")!.textContent!, /shroom/i);
  assert.equal(devices[0].name, "Shroom card-content-0", "UI naming must not rewrite the device descriptor");
  // Filling each card must preserve the normal responsive workspace capacity,
  // including two rows on a tall phone, without replacing any media nodes.
  await act(async () => { gridSize = { width: 375, height: 812 }; window.dispatchEvent(new dom.window.Event("resize")); });
  assert.equal(host.querySelectorAll(".workspace-sensor-card:not([hidden])").length, 2);
  assert.equal(cameraArticle.hidden, false);
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="下一屏传感器"]')!);
  assert.equal(cameraArticle.hidden, false, "camera stays in the permanent media rail"); assert.equal(sensor.hidden, true);
  assert.equal(cameraArticle.querySelector("video"), video); assert.equal(video.srcObject, mediaStream);
  assert.equal(sensor.querySelector("canvas"), canvas);
  await act(async () => { gridSize = { width: 1200, height: 560 }; window.dispatchEvent(new dom.window.Event("resize")); });
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="上一屏传感器"]')!);
  assert.equal(host.querySelectorAll(".workspace-sensor-card:not([hidden])").length, 5, "four sensor tiles beside the camera rail");
  assert.equal(sensor.querySelector("canvas"), canvas); assert.equal(cameraArticle.querySelector("video"), video);
  assert.deepEqual(disconnects, []);
  const cameraPanel = cameraArticle.querySelector<HTMLDivElement>(".workspace-config-panel")!;
  await click(cameraArticle.querySelector<HTMLButtonElement>(".workspace-settings-toggle")!);
  assert.equal(cameraPanel.hidden, false);
  assert.equal(cameraPanel.querySelector<HTMLButtonElement>(".workspace-disconnect")!.disabled, true, "recording still locks connection changes");
  assert.equal(cameraPanel.querySelector<HTMLButtonElement>(".workspace-remove")!.disabled, true);
  await click(sensor.querySelector<HTMLButtonElement>(".workspace-settings-toggle")!);
  assert.equal(cameraPanel.hidden, true, "only the selected device settings remain open");
  const settingsToggle = sensor.querySelector<HTMLButtonElement>(".workspace-settings-toggle")!;
  const settingsPanel = sensor.querySelector<HTMLDivElement>(".workspace-config-panel")!;
  const slot = settingsPanel.querySelector<HTMLDivElement>(".workspace-display-settings-slot")!;
  assert.equal(settingsToggle.textContent, "设置");
  assert.equal(sensor.querySelectorAll(".workspace-settings-toggle").length, 1);
  assert.equal(sensor.querySelector(".preview-display-toggle"), null, "the card has one combined settings entry");
  assert.ok(settingsPanel.querySelector(".workspace-connection"), "connection and display controls share one panel");
  assert.ok(slot.querySelector(".preview-display-settings"));
  assert.ok(slot.querySelector(".pressure-range-controls"));
  const heatmap = Array.from(slot.querySelectorAll("button")).find(button => button.textContent === "热力图")!;
  await act(async () => {
    heatmap.focus();
    heatmap.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assert.equal(settingsPanel.hidden, true, "Escape from a portaled mode button closes the combined settings");
  assert.equal(document.activeElement, settingsToggle);
  await click(settingsToggle);
  const rangeSelect = slot.querySelector<HTMLSelectElement>(".pressure-range-controls select")!;
  await act(async () => { rangeSelect.value = "fixed"; rangeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const upperBound = slot.querySelector<HTMLInputElement>(".pressure-range-maximum input")!;
  await act(async () => {
    upperBound.focus();
    upperBound.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assert.equal(settingsPanel.hidden, true, "Escape from a portaled range input closes the combined settings");
  assert.equal(document.activeElement, settingsToggle);
  assert.equal(sensor.querySelector("canvas"), canvas);
  await click(settingsToggle);
  const numbers = Array.from(slot.querySelectorAll("button")).find(button => button.textContent === "2D 数字")!;
  await click(numbers);
  const numericCanvas = sensor.querySelector(".numeric-pressure-canvas")!;
  assert.ok(numericCanvas);
  assert.ok(slot.querySelector(".numeric-toolbar"), "numeric zoom controls use the same settings panel");
  await click(settingsToggle); assert.equal(settingsPanel.hidden, true);
  assert.equal(sensor.querySelector(".numeric-pressure-canvas"), numericCanvas, "closing settings keeps the numeric canvas mounted");
  await click(settingsToggle); assert.equal(settingsPanel.hidden, false);
  assert.equal(settingsPanel.querySelector(".workspace-display-settings-slot"), slot, "portal target remains stable across toggles");
  assert.equal(sensor.querySelector("canvas"), canvas);
  // Expanding a feed does not replace its camera/canvas or end the capture connection.
  await click(sensor.querySelector<HTMLButtonElement>('button[aria-label^="放大"][aria-label$="展示卡片"]')!);
  assert.ok(host.querySelector(".monitor-single-view"));
  await click(settingsToggle);
  await escape();
  assert.equal(settingsPanel.hidden, true);
  assert.ok(host.querySelector(".monitor-single-view"), "the first Escape closes the combined settings, not the expanded card");
  assert.equal(document.activeElement, settingsToggle);
  await escape();
  assert.equal(host.querySelector(".monitor-single-view"), null);
  assert.equal(sensor.querySelector("canvas"), canvas);
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="下一屏传感器"]')!);
  assert.equal(cameraArticle.hidden, false, "sensor paging never hides the media rail");
  assert.equal(cameraArticle.querySelector("video"), video);
  assert.equal(video.srcObject, mediaStream, "pagination preserves the original media attachment");
  assert.deepEqual(disconnects, []);
  await click(host.querySelector<HTMLButtonElement>(".monitor-focus-toggle")!);
  const stop = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "停止并保存")!;
  assert.ok(stop); await click(stop); assert.equal(stops, 1);
  await escape(); assert.equal(host.querySelector(".monitor-focused"), null);
});

test("sensor display names remove only a leading brand and leave source identifiers intact", () => {
  assert.equal(sensorDisplayName("Shroom 触觉手套"), "触觉手套");
  assert.equal(sensorDisplayName("SHROOM人体全身"), "人体全身");
  assert.equal(sensorDisplayName("Shroom - 压力阵列"), "压力阵列");
  assert.equal(sensorDisplayName("Shrooming sensor"), "Shrooming sensor");
  assert.equal(sensorDisplayName("实验室 Shroom 01"), "实验室 Shroom 01");
  const card = createSdkCard("glove", "shroom-source-id");
  assert.equal(card.id, "shroom-source-id"); assert.equal(card.product, "glove");
  assert.deepEqual(cardStreamIds(card), ["sdk-shroom-source-id-pressure", "sdk-shroom-source-id-imu-raw"]);
});

test("unconnected card-content cards keep connection settings usable and Escape returns focus to their trigger", async t => {
  const card = createSdkCard("hand-pad", "new-card-content");
  const sdk = { info: { loaded: true }, instances: [], ports: [{ path: "COM_FIXTURE" }], busyIds: [], scanning: false,
    scanPorts: async () => {}, connect: async () => {} } as unknown as AcquisitionWorkspaceProps["sdk"];
  const camera = { connections: {}, devices: [], busyIds: [], scanning: false } as unknown as AcquisitionWorkspaceProps["camera"];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<AcquisitionWorkspace cardContentFullscreen workspace={{ version: 1, layout: "grid", cards: [card] }}
    devices={[]} sdk={sdk} camera={camera} onAddSdk={() => {}} onAddCamera={() => {}} onRemove={async () => {}} onUpdate={() => {}} onLayout={() => {}}
    online recording={false} busy={false} previewPaused={false} previewConnected previewRate={5} onTogglePreview={() => {}} />));
  const panel = host.querySelector<HTMLDivElement>(".workspace-config-panel")!;
  const trigger = host.querySelector<HTMLButtonElement>(".workspace-settings-toggle")!;
  assert.equal(panel.hidden, false, "a new device offers connection setup immediately");
  assert.ok(panel.querySelector('select[aria-label$="串口"]'));
  await escape(); assert.equal(panel.hidden, true); assert.equal(document.activeElement, trigger);
  await click(trigger); assert.equal(panel.hidden, false);
});

test("combined glove settings retain both recorded stream views while connection changes stay locked", async t => {
  const card = createSdkCard("glove", "combined-glove");
  const streamIds = cardStreamIds(card);
  const devices: AcquisitionWorkspaceProps["devices"] = streamIds.map((id, index) => ({ id,
    kind: index ? "imu" : "pressure", name: index ? "Shroom IMU 原始字节" : "Shroom 手套原始压力", connected: true,
    mode: "hardware", transport: "serial", sample_rate: 0, channels: index ? 16 : 256, unit: index ? "raw-byte" : "ADC",
    metadata: { product: "glove" }, ...(index ? { preview_supported: false } : {}) }));
  const sdk = { info: { loaded: true }, instances: [{ instance_id: card.id, product: "glove", connected: true,
    ready: true, frames: 5, stream_ids: streamIds }], ports: [], busyIds: [], scanning: false,
    scanPorts: async () => {} } as unknown as AcquisitionWorkspaceProps["sdk"];
  const camera = { connections: {}, devices: [], busyIds: [], scanning: false } as unknown as AcquisitionWorkspaceProps["camera"];
  const updates: object[] = [];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  await act(async () => root.render(<AcquisitionWorkspace cardContentFullscreen workspace={{ version: 1, layout: "grid", cards: [card] }}
    devices={devices} sdk={sdk} camera={camera} onAddSdk={() => {}} onAddCamera={() => {}} onRemove={async () => {}}
    onUpdate={(_id, patch) => { updates.push(patch); }} onLayout={() => {}}
    online recording busy={false} previewPaused={false} previewConnected previewRate={5} onTogglePreview={() => {}} />));
  await click(host.querySelector<HTMLButtonElement>(".workspace-settings-toggle")!);
  const panel = host.querySelector<HTMLDivElement>(".workspace-config-panel")!;
  assert.ok(panel.querySelector('[role="group"][aria-label="手套展示数据"]'));
  assert.ok(panel.querySelector(".pressure-display-toolbar"));
  assert.ok(panel.querySelector(".numeric-toolbar"));
  assert.equal(panel.querySelector<HTMLButtonElement>(".workspace-disconnect")!.disabled, true);
  assert.equal(panel.querySelector<HTMLButtonElement>(".workspace-remove")!.disabled, true);
  const imu = Array.from(panel.querySelectorAll("button")).find(button => button.textContent === "IMU 原始字节")!;
  assert.equal(imu.disabled, false); await click(imu);
  assert.deepEqual(updates.at(-1), { view: "imu" });
  assert.equal(host.querySelector(".preview-display-toggle"), null);
});

test("standalone replay preview retains its own display settings when no external panel is supplied", async t => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  const device: AcquisitionWorkspaceProps["devices"][number] = { id: "standalone-replay", name: "Shroom 压力阵列", kind: "pressure",
    mode: "hardware", connected: true, sample_rate: 0, channels: 4, unit: "ADC", transport: "serial" };
  await act(async () => root.render(<LivePreview device={device} enabled connected paused={false} embedded cardContentFullscreen
    snapshot={{ timestamp_s: 1, pressure: { rows: 2, cols: 2, values: [0, 1, 2, 3] } }} />));
  const canvas = host.querySelector("canvas");
  const toggle = host.querySelector<HTMLButtonElement>(".preview-display-toggle")!;
  assert.equal(toggle.getAttribute("aria-label"), "压力阵列显示设置");
  await click(toggle); assert.equal(host.querySelector<HTMLDivElement>(".preview-display-settings")!.hidden, false);
  await escape(); assert.equal(host.querySelector<HTMLDivElement>(".preview-display-settings")!.hidden, true);
  assert.equal(host.querySelector("canvas"), canvas); assert.equal(device.name, "Shroom 压力阵列");
});
