import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { LivePreview } from "../src/LivePreview";
import { NumericPressureView, boundNumericView, fitNumericView, positionNumericTooltip, zoomNumericView } from "../src/NumericPressureView";
import { getNumericLayout } from "../src/numeric-pressure-renderer";
import { PRESSURE_DISPLAY_KEY, readPressureDisplay, readPressureRange, savePressureDisplay } from "../src/pressure-display";
import type { Device, GloveFingerId, PressurePreview, Preview } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
const resizeCallbacks = new Set<() => void>();
let canvasSize = { width: 600, height: 400 };
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class {
  constructor(private callback: () => void) {}
  observe() { resizeCallbacks.add(this.callback); }
  disconnect() { resizeCallbacks.delete(this.callback); }
} });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getBoundingClientRect", { value: () => ({ ...canvasSize, left: 0, top: 0 }) });
const { createRoot } = await import("react-dom/client");
const device: Device = { id: "numeric-test", name: "数字测试阵列", kind: "pressure", connected: true, mode: "hardware", transport: "Serial", sample_rate: 1, channels: 4, rows: 2, cols: 2, unit: "ADC" };
const snapshot: Preview = { timestamp_s: 1, pressure: { rows: 2, cols: 2, values: [0, 255, 256, 4095], full_scale: 4095 } };
const button = (host: HTMLElement, text: string) => {
  const found = Array.from(host.querySelectorAll("button")).find(item => item.textContent === text);
  assert.ok(found, `missing ${text}`); return found;
};

test("numeric zoom preserves cursor anchor and fitting/panning keep data reachable", () => {
  const layout = { width: 1000, height: 800 }, viewport = { width: 600, height: 400 };
  const fit = fitNumericView(layout, viewport);
  assert.ok(layout.width * fit.scale <= 576 && layout.height * fit.scale <= 376);
  const zoomed = zoomNumericView(fit, fit.scale * 3, 173, 92);
  assert.ok(Math.abs((173 - zoomed.offsetX) / zoomed.scale - (173 - fit.offsetX) / fit.scale) < 1e-9);
  assert.ok(Math.abs((92 - zoomed.offsetY) / zoomed.scale - (92 - fit.offsetY) / fit.scale) < 1e-9);
  const bounded = boundNumericView({ ...zoomed, offsetX: -100000, offsetY: 100000 }, layout, viewport);
  assert.equal(bounded.offsetX + layout.width * bounded.scale, 32);
  assert.equal(bounded.offsetY, viewport.height - 32);
});

test("display preference is per device, validated and bounded", () => {
  window.localStorage.setItem(PRESSURE_DISPLAY_KEY, "broken json");
  assert.equal(readPressureDisplay("a"), "heatmap");
  window.localStorage.setItem(PRESSURE_DISPLAY_KEY, JSON.stringify({ a: "unknown", b: "numbers" }));
  assert.equal(readPressureDisplay("a"), "heatmap");
  assert.equal(readPressureDisplay("b"), "numbers");
  for (let i = 0; i < 80; i++) savePressureDisplay(`sensor-${i}`, "numbers");
  assert.equal(Object.keys(JSON.parse(window.localStorage.getItem(PRESSURE_DISPLAY_KEY)!)).length, 64);
  assert.equal(readPressureDisplay("sensor-79"), "numbers");
  assert.equal(readPressureDisplay("sensor-0"), "heatmap");
  window.localStorage.clear();
});

test("embedded recorded pressure switches immediately, remembers mode and clears missing frames", async t => {
  window.localStorage.clear();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  await act(async () => root.render(<LivePreview device={device} enabled connected paused={false} embedded snapshot={snapshot} />));
  assert.equal(button(host, "热力图").getAttribute("aria-pressed"), "true");
  await act(async () => button(host, "2D 数字").click());
  assert.equal(button(host, "2D 数字").getAttribute("aria-pressed"), "true");
  assert.match(host.querySelector(".numeric-pressure-canvas")?.getAttribute("aria-label") || "", /4 个采样点/);
  assert.equal(readPressureDisplay(device.id), "numbers");
  assert.match(host.textContent || "", /4095\.0/);
  const initialZoom = host.querySelector('output[aria-label="数字视图缩放比例"]')!.textContent;
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="放大数字视图"]')!.click());
  assert.notEqual(host.querySelector('output[aria-label="数字视图缩放比例"]')!.textContent, initialZoom);
  // Incoming data must not reset zoom or pan.
  const zoomed = host.querySelector('output[aria-label="数字视图缩放比例"]')!.textContent;
  await act(async () => root.render(<LivePreview device={device} enabled connected paused={false} embedded snapshot={{ timestamp_s: 2, pressure: { ...snapshot.pressure!, values: [17, 0, 300, 4095] } }} />));
  assert.equal(host.querySelector('output[aria-label="数字视图缩放比例"]')!.textContent, zoomed);
  await act(async () => root.render(<LivePreview device={device} enabled connected paused={false} embedded snapshot={null} />));
  assert.match(host.textContent || "", /此时刻尚无已保存数据/);
  assert.match(host.querySelector(".numeric-pressure-canvas")?.getAttribute("aria-label") || "", /0 个采样点/);
  await act(async () => root.render(<LivePreview key="remount" device={device} enabled connected paused={false} embedded snapshot={snapshot} />));
  assert.equal(button(host, "2D 数字").getAttribute("aria-pressed"), "true");
});

test("paused numeric preview retains displayed values and other modalities have no pressure modes", async t => {
  savePressureDisplay(device.id, "numbers");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  await act(async () => root.render(<LivePreview device={device} enabled connected paused={false} snapshot={snapshot} />));
  await act(async () => root.render(<LivePreview device={device} enabled connected paused snapshot={{ timestamp_s: 2, pressure: { rows: 1, cols: 1, values: [7] } }} />));
  assert.match(host.querySelector(".numeric-pressure-canvas")?.getAttribute("aria-label") || "", /4 个采样点/);
  assert.match(host.textContent || "", /4095\.0/);
  assert.match(host.textContent || "", /预览已暂停/);
  await act(async () => button(host, "热力图").click());
  await act(async () => button(host, "2D 数字").click());
  assert.match(host.querySelector(".numeric-pressure-canvas")?.getAttribute("aria-label") || "", /4 个采样点/);
  await act(async () => root.render(<LivePreview device={{ ...device, id: "imu", kind: "imu" }} enabled connected paused={false} snapshot={{ timestamp_s: 1, imu: { values: [1, 2, 3] } }} />));
  assert.equal(host.querySelector(".pressure-display-toolbar"), null);
  assert.equal(host.querySelector(".numeric-pressure-canvas"), null);
});

const gloveFrame = (side: "left" | "right", offset = 0): PressurePreview => ({
  rows: 13, cols: 15, values: Array(195).fill(255),
  glove: {
    side,
    fingers: Object.fromEntries((["little", "ring", "middle", "index", "thumb"] as GloveFingerId[]).map((id, i) => [id, {
      values: Array.from({ length: 12 }, (_, n) => offset + i * 13 + n), pulp: offset + i * 13 + 12,
      source_indices: Array.from({ length: 12 }, (_, n) => i * 13 + n), pulp_source_index: i * 13 + 12,
    }])) as NonNullable<PressurePreview["glove"]>["fingers"],
    palm: { values: Array.from({ length: 72 }, (_, n) => offset + n + 65),
      source_indices: Array.from({ length: 72 }, (_, n) => n + 65), row_lengths: [12, 15, 15, 15, 15] },
  },
});

test("gloves default to physical numbers, retain paused frames and respect an explicit heatmap preference", async t => {
  window.localStorage.clear();
  const hand: Device = { ...device, id: "left-glove", name: "左手布局验证", rows: 13, cols: 15, channels: 256,
    metadata: { product: "glove", side: "left" } };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  await act(async () => root.render(<LivePreview device={hand} enabled connected paused={false}
    snapshot={{ timestamp_s: 1, pressure: gloveFrame("left") }} />));
  assert.equal(button(host, "2D 数字").getAttribute("aria-pressed"), "true");
  assert.match(host.querySelector(".numeric-pressure-canvas")!.getAttribute("aria-label")!, /137 个采样点.*五指/);
  assert.match(host.textContent!, /左手 · 分区 ADC/);
  assert.match(host.textContent!, /左手 · 137 个物理点/);
  assert.match(host.textContent!, /峰值 136\.0/, "summary excludes the unrelated legacy matrix");
  await act(async () => root.render(<LivePreview device={hand} enabled connected paused
    snapshot={{ timestamp_s: 2, pressure: gloveFrame("right", 1) }} />));
  assert.match(host.textContent!, /左手 · 分区 ADC/);
  await act(async () => root.render(<LivePreview device={hand} enabled connected paused={false}
    snapshot={{ timestamp_s: 2, pressure: gloveFrame("right", 1) }} />));
  assert.match(host.textContent!, /右手 · 分区 ADC/);
  await act(async () => button(host, "热力图").click());
  await act(async () => root.render(<LivePreview key="remount-glove" device={hand} enabled connected paused={false}
    snapshot={{ timestamp_s: 2, pressure: gloveFrame("right", 1) }} />));
  assert.equal(button(host, "热力图").getAttribute("aria-pressed"), "true");
});

test("glove metadata cannot turn an unmapped old recording into physical points", async t => {
  window.localStorage.clear();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const hand = { ...device, id: "legacy-glove", metadata: { product: "glove", side: "left" } };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  await act(async () => root.render(<LivePreview device={hand} enabled connected paused={false}
    snapshot={{ timestamp_s: 1, pressure: { rows: 16, cols: 16, values: Array(256).fill(0) } }} />));
  assert.match(host.querySelector(".numeric-pressure-canvas")!.getAttribute("aria-label")!, /256 个采样点/);
  assert.doesNotMatch(host.textContent!, /分区 ADC|物理点/);
  await act(async () => root.render(<LivePreview device={hand} enabled connected paused={false} snapshot={null} />));
  assert.match(host.querySelector(".numeric-pressure-canvas")!.getAttribute("aria-label")!, /0 个采样点/);
  assert.match(host.textContent!, /此时刻尚无已保存数据/);
});

test("canvas resizing cannot undo manual 1:1 zoom while fit mode still follows resizing", async t => {
  window.localStorage.clear(); canvasSize = { width: 274, height: 438 };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const hand = { ...device, id: "resize-glove", metadata: { product: "glove", side: "left" } };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); canvasSize = { width: 600, height: 400 }; });
  await act(async () => root.render(<LivePreview device={hand} enabled connected paused={false}
    snapshot={{ timestamp_s: 1, pressure: gloveFrame("left") }} />));
  const zoom = () => host.querySelector('output[aria-label="数字视图缩放比例"]')!.textContent;
  assert.notEqual(zoom(), "100%");
  await act(async () => button(host, "1:1").click());
  assert.equal(zoom(), "100%");
  await act(async () => { canvasSize = { width: 274, height: 470 }; resizeCallbacks.forEach(callback => callback()); });
  assert.equal(zoom(), "100%", "density hint removal must not reset the requested zoom");
  await act(async () => button(host, "适应").click());
  assert.notEqual(zoom(), "100%");
  const before = zoom();
  await act(async () => { canvasSize = { width: 450, height: 470 }; resizeCallbacks.forEach(callback => callback()); });
  assert.notEqual(zoom(), before, "explicit fit mode still responds to a changed viewport");
});

test("point tooltips stay adjacent to the pointer and inside normal, edge and narrow viewports", () => {
  const cases = [
    { pointer: { x: 90, y: 80 }, viewport: { width: 600, height: 400 }, size: { width: 200, height: 52 } },
    { pointer: { x: 596, y: 398 }, viewport: { width: 600, height: 400 }, size: { width: 200, height: 52 } },
    { pointer: { x: 45, y: 30 }, viewport: { width: 90, height: 60 }, size: { width: 220, height: 64 } },
  ];
  for (const { pointer, viewport, size } of cases) {
    const point = positionNumericTooltip(pointer, viewport, size);
    assert.ok(point.left >= 0 && point.top >= 0);
    assert.ok(point.left + Math.min(size.width, viewport.width - 16) <= viewport.width);
    assert.ok(point.top + Math.min(size.height, viewport.height - 16) <= viewport.height);
  }
  const edge = positionNumericTooltip(cases[1].pointer, cases[1].viewport, cases[1].size);
  assert.ok(edge.left + cases[1].size.width < cases[1].pointer.x, "right edge flips to the pointer's left");
  assert.ok(edge.top + cases[1].size.height < cases[1].pointer.y, "bottom edge flips above the pointer");
});

test("hover shows only a local single-point tooltip without a readout row or viewport changes", async t => {
  canvasSize = { width: 600, height: 400 };
  const pressure = gloveFrame("left"), layout = getNumericLayout(pressure);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<NumericPressureView pressure={pressure} name="单点测试" unit="ADC" />));
  const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
  Object.defineProperties(canvas, { setPointerCapture: { value: () => {} }, hasPointerCapture: { value: () => false } });
  const transform = () => [canvas.dataset.numericScale, canvas.dataset.numericOffsetX, canvas.dataset.numericOffsetY,
    canvas.dataset.numericViewportWidth, canvas.dataset.numericViewportHeight];
  const before = transform();
  const cell = layout.cells.find(item => item.sourceIndex === 0)!;
  const position = () => ({ x: (cell.x + cell.width / 2) * Number(canvas.dataset.numericScale) + Number(canvas.dataset.numericOffsetX),
    y: (cell.y + cell.height / 2) * Number(canvas.dataset.numericScale) + Number(canvas.dataset.numericOffsetY) });
  const pointEvent = async (type: string, x: number, y: number) => act(async () => {
    canvas.dispatchEvent(new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true,
      ...(type === "pointerout" ? { relatedTarget: document.body } : {}) }));
  });
  assert.equal(host.querySelector(".numeric-readout"), null);
  assert.equal(host.querySelector('[role="tooltip"]'), null);
  let point = position(); await pointEvent("pointermove", point.x, point.y);
  const tooltip = host.querySelector<HTMLElement>('[role="tooltip"]')!;
  assert.ok(tooltip); assert.match(tooltip.textContent!, /ADC 通道 1/); assert.equal(tooltip.querySelector("strong")!.textContent, "0 ADC");
  assert.equal(tooltip.parentElement, canvas.parentElement, "tooltip is local to the numeric canvas area");
  assert.ok(canvas.getAttribute("aria-describedby")!.includes(tooltip.id));
  assert.deepEqual(transform(), before, "hover never changes the canvas size, zoom or pan");
  await pointEvent("pointerout", point.x, point.y); assert.equal(host.querySelector('[role="tooltip"]'), null);
  await pointEvent("pointermove", point.x, point.y);
  await act(async () => canvas.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(host.querySelector('[role="tooltip"]'), null);
  for (const id of canvas.getAttribute("aria-describedby")!.split(" ")) assert.ok(document.getElementById(id), "instructions have no dangling aria reference");
  await pointEvent("pointermove", point.x, point.y); await pointEvent("pointerdown", point.x, point.y);
  assert.equal(host.querySelector('[role="tooltip"]'), null, "starting a pan hides the tooltip");
  await pointEvent("pointermove", point.x + 10, point.y + 10); assert.equal(host.querySelector('[role="tooltip"]'), null);
  await pointEvent("pointerup", point.x + 10, point.y + 10); assert.equal(host.querySelector('[role="tooltip"]'), null);
  point = position(); await pointEvent("pointermove", point.x, point.y); assert.ok(host.querySelector('[role="tooltip"]'));
  await pointEvent("pointermove", canvasSize.width + 20, canvasSize.height + 20); assert.equal(host.querySelector('[role="tooltip"]'), null, "captured off-canvas coordinates never show a point");
});

test("heatmap range controls validate fixed bounds, show saturation and persist independently of numeric mode", async t => {
  window.localStorage.clear();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  const array = { ...device, id: "range-array", dtype: "uint16", metadata: { full_scale: 4095 } };
  const render = (key: string) => root.render(<LivePreview key={key} device={array} enabled connected paused={false} snapshot={snapshot} />);
  await act(async () => render("first"));
  assert.match(host.querySelector(".pressure-color-scale")!.textContent!, /自动逐帧.*0–4095 ADC/);
  const rangeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="数字测试阵列热图量程"]')!;
  await act(async () => { rangeSelect.value = "fixed"; rangeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  const upper = () => host.querySelector<HTMLInputElement>('input[aria-label="数字测试阵列热图量程上限"]')!;
  assert.equal(upper().value, "4095", "12-bit default follows the known source range");
  const apply = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(upper(), value);
      upper().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector("form.pressure-range-controls")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  };
  await apply("0");
  assert.match(host.querySelector(".pressure-range-error")!.textContent!, /大于 0/);
  assert.deepEqual(readPressureRange(array.id), { mode: "fixed", maximum: 4095 });
  await apply("255");
  assert.equal(host.querySelector(".pressure-range-error"), null);
  assert.match(host.querySelector(".pressure-color-scale")!.textContent!, /固定量程.*0–255 ADC/);
  assert.match(host.querySelector(".pressure-range-warning")!.textContent!, /2 个点高于上限/);
  assert.match(host.textContent!, /峰值 4095\.0/, "display clipping must not alter the reported raw peak");
  await act(async () => button(host, "2D 数字").click());
  assert.equal(host.querySelector(".pressure-range-controls"), null);
  assert.equal(host.querySelector(".pressure-color-scale"), null);
  await act(async () => render("remount"));
  await act(async () => button(host, "热力图").click());
  assert.equal(upper().value, "255");
  assert.match(host.querySelector(".pressure-color-scale")!.textContent!, /固定量程.*0–255 ADC/);
  await act(async () => root.render(<LivePreview device={{ ...device, id: "other-range" }} enabled connected paused={false} snapshot={snapshot} />));
  assert.match(host.querySelector(".pressure-color-scale")!.textContent!, /自动逐帧/);
});

test("physical glove heatmaps share the visible scale and preserve ADC as their unit", async t => {
  window.localStorage.clear();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  await act(async () => root.render(<LivePreview device={{ ...device, id: "range-glove", metadata: { product: "glove", full_scale: 255 } }}
    enabled connected paused={false} snapshot={{ timestamp_s: 1, pressure: gloveFrame("left") }} />));
  assert.equal(host.querySelector(".pressure-color-scale"), null, "numeric glove view needs no heatmap controls");
  await act(async () => button(host, "热力图").click());
  assert.match(host.querySelector(".pressure-color-scale")!.textContent!, /自动逐帧.*0–136 ADC/);
  assert.ok(host.querySelector(".pressure-color-gradient"));
});

test("numeric controls portal once while canvas, manual zoom and pan survive settings closing and reopening", async t => {
  const host = document.createElement("div"), settings = document.createElement("div");
  document.body.append(host, settings);
  const root = createRoot(host);
  const pressure: PressurePreview = { rows: 32, cols: 32, values: Array(1024).fill(3456), full_scale: 4095 };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); settings.remove(); });
  const render = (container?: HTMLElement | null, frame = pressure) => root.render(
    <NumericPressureView pressure={frame} name="保留数字视图" unit="ADC" controlsContainer={container} />);
  await act(async () => render());
  const canvas = host.querySelector<HTMLCanvasElement>(".numeric-pressure-canvas")!;
  const transform = () => [canvas.dataset.numericScale, canvas.dataset.numericOffsetX, canvas.dataset.numericOffsetY];
  const initialScale = Number(canvas.dataset.numericScale);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="放大数字视图"]')!.click());
  await act(async () => canvas.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  const zoomedAndPanned = transform();
  assert.ok(Number(canvas.dataset.numericScale) > initialScale);

  await act(async () => render(settings));
  assert.equal(host.querySelector(".numeric-toolbar"), null);
  assert.equal(settings.querySelectorAll(".numeric-toolbar").length, 1);
  assert.equal(document.querySelectorAll('[aria-label="保留数字视图数字视图控制"]').length, 1);
  assert.equal(host.querySelector("canvas"), canvas, "moving controls never remounts the drawing canvas");
  assert.deepEqual(transform(), zoomedAndPanned);

  settings.hidden = true;
  await act(async () => render(settings, { ...pressure, values: pressure.values.map(value => value + 1) }));
  assert.deepEqual(transform(), zoomedAndPanned, "closed settings and incoming data retain the user's transform");
  settings.hidden = false;
  await act(async () => render(settings));
  assert.deepEqual(transform(), zoomedAndPanned);
  await act(async () => settings.querySelector<HTMLButtonElement>('button[aria-label="放大数字视图"]')!.click());
  const afterPortalZoom = transform();
  assert.notDeepEqual(afterPortalZoom, zoomedAndPanned, "portaled buttons still operate the same canvas state");

  await act(async () => render(null));
  assert.equal(settings.querySelector(".numeric-toolbar"), null);
  assert.equal(host.querySelectorAll(".numeric-toolbar").length, 1);
  assert.equal(host.querySelector("canvas"), canvas);
  assert.deepEqual(transform(), afterPortalZoom, "returning to inline controls does not reset zoom or pan");
  const wheel = new dom.window.WheelEvent("wheel", { deltaY: -100, clientX: 200, clientY: 120, bubbles: true, cancelable: true });
  await act(async () => canvas.dispatchEvent(wheel));
  assert.equal(wheel.defaultPrevented, true);
  assert.ok(Number(canvas.dataset.numericScale) > Number(afterPortalZoom[0]));
});

test("numeric fit uses the measured canvas drawing area and exposes its actual CSS-pixel transform", async t => {
  canvasSize = { width: 360, height: 224 };
  const host = document.createElement("div"), settings = document.createElement("div");
  document.body.append(host, settings);
  const root = createRoot(host);
  const pressure: PressurePreview = { rows: 32, cols: 32, values: Array(1024).fill(7) };
  const layout = getNumericLayout(pressure);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); settings.remove(); canvasSize = { width: 600, height: 400 }; });
  await act(async () => root.render(<NumericPressureView pressure={pressure} name="实际绘图区" unit="ADC" controlsContainer={settings} />));
  const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
  const checkFit = () => {
    const expected = fitNumericView(layout, canvasSize);
    assert.equal(Number(canvas.dataset.numericScale), expected.scale);
    assert.equal(Number(canvas.dataset.numericOffsetX), expected.offsetX);
    assert.equal(Number(canvas.dataset.numericOffsetY), expected.offsetY);
    assert.equal(Number(canvas.dataset.numericLayoutWidth), layout.width);
    assert.equal(Number(canvas.dataset.numericLayoutHeight), layout.height);
    assert.equal(Number(canvas.dataset.numericViewportWidth), canvasSize.width);
    assert.equal(Number(canvas.dataset.numericViewportHeight), canvasSize.height);
  };
  checkFit();
  await act(async () => button(settings, "1:1").click());
  assert.equal(Number(canvas.dataset.numericScale), 1);
  await act(async () => { canvasSize = { width: 260, height: 260 }; resizeCallbacks.forEach(callback => callback()); });
  assert.equal(Number(canvas.dataset.numericScale), 1, "a drawing-area resize preserves manual magnification");
  await act(async () => button(settings, "适应").click());
  checkFit();
  await act(async () => { canvasSize = { width: 480, height: 280 }; resizeCallbacks.forEach(callback => callback()); });
  checkFit();
  assert.equal(host.querySelector("canvas"), canvas);
});
