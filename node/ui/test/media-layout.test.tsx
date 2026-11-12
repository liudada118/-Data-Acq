import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { act } from "react";
import { useMediaLayout } from "../src/useMediaLayout";
import { DEFAULT_MEDIA_LAYOUT, mediaLayoutMetrics } from "../src/media-rail-layout";

test("bounded camera and microphone share the exact rail height at every viewport and preference", () => {
  for (const width of [300, 759, 760, 1600]) for (const height of [200, 300, 700]) {
    for (const cameraRatio of [.35, .78, .92]) {
      const metrics = mediaLayoutMetrics({ width, height, cameraCount: 1, audioCount: 1, sensorCount: 3 }, { widthRatio: .6, cameraRatio });
      assert.ok(metrics.railWidth > 0 && metrics.railWidth <= width);
      assert.ok(metrics.railHeight > 0 && metrics.railHeight <= height);
      assert.ok(metrics.cameraHeight > 0 && metrics.audioHeight > 0);
      assert.ok(Math.abs(metrics.cameraHeight + metrics.audioHeight + 28 - metrics.railHeight) < 1e-8,
        `${width}×${height}: camera + microphone + two 8px gaps and 12px divider must fill, never exceed, the rail`);
    }
  }
});

test("multiple media cards and single-kind rails remain bounded instead of enforcing overflowing minimums", () => {
  for (const [cameraCount, audioCount] of [[2, 1], [1, 2], [0, 2], [2, 0], [1, 0], [0, 1]]) {
    for (const height of [150, 300, 700]) {
      const metrics = mediaLayoutMetrics({ width: 500, height, cameraCount, audioCount, sensorCount: 0 }, DEFAULT_MEDIA_LAYOUT);
      const divider = cameraCount > 0 && audioCount > 0;
      const overhead = (cameraCount + audioCount + Number(divider) - 1) * 8 + (divider ? 12 : 0);
      assert.ok(Math.abs(cameraCount * metrics.cameraHeight + audioCount * metrics.audioHeight + overhead - metrics.railHeight) < 1e-8,
        `${cameraCount} cameras / ${audioCount} microphones: computed cards cannot force the rail to scroll`);
    }
  }
});

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const captures = new WeakMap<Element, number>();
Object.assign(dom.window.HTMLElement.prototype, {
  setPointerCapture(this: HTMLElement, id: number) { captures.set(this, id); },
  hasPointerCapture(this: HTMLElement, id: number) { return captures.get(this) === id; },
  releasePointerCapture(this: HTMLElement) { captures.delete(this); },
});
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

async function fixture(t: TestContext) {
  window.localStorage.clear();
  let width = 1200, height = 700, generation = 0, current: ReturnType<typeof useMediaLayout>;
  const scope = "bounded-media-fixture", key = `shroom:media-layout:v2:${encodeURIComponent(scope)}`;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const layout = useMediaLayout({ width, height, cameraCount: 1, audioCount: 1, sensorCount: 3 }, scope);
    current = layout;
    return <div style={layout.style}>
      <section><video /><div data-axis="width" {...layout.separatorProps("width")} /></section>
      <div data-axis="camera" {...layout.separatorProps("camera")} />
      <section><audio /></section>
    </div>;
  }
  const render = async () => act(async () => root.render(<Harness key={generation} />));
  await render();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  const pointer = async (axis: "width" | "camera", type: string, x = 400, y = 400) => act(async () => {
    const handle = host.querySelector<HTMLElement>(`[data-axis="${axis}"]`)!;
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 37 }, isPrimary: { value: true } });
    handle.dispatchEvent(event); if (type === "pointermove") await delay(25);
  });
  return { host, key, pointer, layout: () => current!,
    resize: async (nextWidth: number, nextHeight: number) => { width = nextWidth; height = nextHeight; await render(); },
    remount: async () => { generation++; await render(); },
  };
}

test("dragging the microphone boundary trades equal height with the camera and persists only the completed split", async t => {
  const view = await fixture(t), video = view.host.querySelector("video"), audio = view.host.querySelector("audio");
  const original = view.layout().metrics;
  await view.pointer("camera", "pointerdown", 400, 400);
  await view.pointer("camera", "pointermove", 400, 300);
  assert.ok(Math.abs(view.layout().metrics.cameraHeight - original.cameraHeight + 100) < 1e-8);
  assert.ok(Math.abs(view.layout().metrics.audioHeight - original.audioHeight - 100) < 1e-8);
  assert.equal(window.localStorage.getItem(view.key), null);
  await view.pointer("camera", "pointerup", 400, 300);
  const saved = window.localStorage.getItem(view.key);
  assert.ok(saved);
  assert.equal(view.host.querySelector("video"), video); assert.equal(view.host.querySelector("audio"), audio);
  const ratio = view.layout().preferences.cameraRatio;
  await view.remount(); assert.equal(view.layout().preferences.cameraRatio, ratio);
  await view.pointer("camera", "pointerdown", 400, 300);
  await view.pointer("camera", "pointermove", 400, -5000);
  const bounded = view.layout().metrics;
  assert.ok(Math.abs(bounded.cameraHeight + bounded.audioHeight + 28 - bounded.railHeight) < 1e-8);
  assert.ok(bounded.cameraHeight > 0 && bounded.audioHeight > 0);
  await view.pointer("camera", "pointercancel", 400, -5000);
  assert.equal(view.layout().preferences.cameraRatio, ratio);
  assert.equal(window.localStorage.getItem(view.key), saved);
});

test("shared width, cancel and viewport clamping preserve the saved split and mounted media", async t => {
  const view = await fixture(t), original = view.layout().metrics.railWidth;
  const video = view.host.querySelector("video"), audio = view.host.querySelector("audio");
  await view.pointer("width", "pointerdown", 400);
  await view.pointer("width", "pointermove", 520);
  await view.pointer("width", "pointerup", 520);
  assert.equal(view.layout().metrics.railWidth, original + 120);
  const saved = window.localStorage.getItem(view.key), preferences = { ...view.layout().preferences };
  await view.resize(320, 200);
  assert.ok(view.layout().metrics.railWidth <= 320);
  assert.ok(view.layout().metrics.cameraHeight + view.layout().metrics.audioHeight + 28 <= view.layout().metrics.railHeight + 1e-8);
  assert.equal(window.localStorage.getItem(view.key), saved);
  await view.resize(1200, 700);
  assert.equal(view.layout().metrics.railWidth, original + 120);
  assert.deepEqual(view.layout().preferences, preferences);
  await view.pointer("width", "pointerdown", 520); await view.pointer("width", "pointermove", 600); await view.pointer("width", "lostpointercapture", 600);
  assert.deepEqual(view.layout().preferences, preferences);
  assert.equal(window.localStorage.getItem(view.key), saved);
  assert.equal(view.host.querySelector("video"), video); assert.equal(view.host.querySelector("audio"), audio);
});
