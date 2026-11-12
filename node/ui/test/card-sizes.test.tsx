import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { act } from "react";
import { CardResizeControls } from "../src/CardResizeControls";
import { cardSizesStorageKey, useCardSizes } from "../src/useCardSizes";

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
const scope = "independent-card-fixture", storageKey = cardSizesStorageKey(scope);
const defaults = [
  { id: "camera-a", kind: "camera" as const, defaultWidth: 420, defaultHeight: 320 },
  { id: "camera-b", kind: "camera" as const, defaultWidth: 420, defaultHeight: 320 },
  { id: "microphone", kind: "microphone" as const, defaultWidth: 420, defaultHeight: 180 },
  { id: "sensor", kind: "sensor" as const, defaultWidth: 320, defaultHeight: 260 },
];

async function fixture(t: TestContext) {
  window.localStorage.removeItem(storageKey);
  let maxWidth = 1000, maxHeight = 2000, generation = 0, current: ReturnType<typeof useCardSizes>;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const sizes = useCardSizes({ scope, cards: defaults.map(card => ({ ...card, maxWidth, maxHeight })) });
    current = sizes;
    return <div className="independent-card-board">{defaults.map(card => <article key={card.id} data-card-id={card.id}
      className="independent-size-card" style={sizes.style(card.id)}>
      <header>{card.kind === "camera" ? "同名摄像头" : card.kind}</header>
      {card.kind === "camera" ? <video /> : card.kind === "microphone" ? <audio /> : <canvas />}
      <CardResizeControls sizes={sizes} cardId={card.id} />
    </article>)}</div>;
  }
  const render = async () => act(async () => root.render(<Harness key={generation} />));
  await render();
  const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (host.contains(this)) {
      const card = this.closest<HTMLElement>("[data-card-id]");
      const size = current.getSize(card?.dataset.cardId ?? "camera-a");
      return { x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, width: size.width, height: size.height, toJSON: () => ({}) };
    }
    return originalBounds.call(this);
  };
  t.after(async () => { await act(async () => root.unmount()); host.remove();
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalBounds;
    window.localStorage.removeItem(storageKey); });
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
  const pointer = async (id: string, axis: "width" | "height" | "both", type: string, x = 400, y = 300, pointerId = 19) => act(async () => {
    const grip = card(id).querySelector<HTMLElement>(axis === "width" ? ".card-resize-right" : axis === "height" ? ".card-resize-bottom" : ".card-resize-corner");
    assert.ok(grip, `${id} has its own ${axis} handle`);
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
    grip.dispatchEvent(event); if (type === "pointermove") await delay(25);
  });
  const dimensions = (id: string) => { const { width, height } = current!.getSize(id); return { width, height }; };
  return { host, card, pointer, dimensions, sizes: () => current!,
    resize: async (width: number, height = 2000) => { maxWidth = width; maxHeight = height; await render(); },
    remount: async () => { generation++; await render(); },
  };
}

test("camera vertical drag adds the full 200px and diagonal drag changes its width and height independently", async t => {
  const view = await fixture(t), video = view.card("camera-a").querySelector("video")!;
  const otherSizes = defaults.slice(1).map(card => view.dimensions(card.id));
  await view.pointer("camera-a", "height", "pointerdown", 400, 300);
  await view.pointer("camera-a", "height", "pointermove", 400, 500);
  assert.deepEqual(view.dimensions("camera-a"), { width: 420, height: 520 }, "height is not capped by the microphone or viewport remainder");
  assert.equal(window.localStorage.getItem(storageKey), null, "drag frames do not write persistent storage");
  await view.pointer("camera-a", "height", "pointerup", 400, 500);
  await view.pointer("camera-a", "both", "pointerdown", 400, 500);
  await view.pointer("camera-a", "both", "pointermove", 520, 580);
  await view.pointer("camera-a", "both", "pointerup", 520, 580);
  assert.deepEqual(view.dimensions("camera-a"), { width: 540, height: 600 });
  assert.deepEqual(defaults.slice(1).map(card => view.dimensions(card.id)), otherSizes);
  assert.equal(view.card("camera-a").querySelector("video"), video);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(storageKey)!).cards["camera-a"], { width: 540, height: 600 });
});

test("microphone and sensor cards resize without changing cameras and same-named cameras persist by ID", async t => {
  const view = await fixture(t);
  const camera = view.dimensions("camera-a"), video = view.card("camera-a").querySelector("video"), audio = view.card("microphone").querySelector("audio");
  await view.pointer("microphone", "both", "pointerdown", 420, 180);
  await view.pointer("microphone", "both", "pointermove", 320, 140);
  await view.pointer("microphone", "both", "pointerup", 320, 140);
  assert.deepEqual(view.dimensions("microphone"), { width: 320, height: 140 });
  assert.deepEqual(view.dimensions("camera-a"), camera);
  await view.pointer("sensor", "both", "pointerdown", 320, 260);
  await view.pointer("sensor", "both", "pointermove", 420, 410);
  await view.pointer("sensor", "both", "pointerup", 420, 410);
  assert.deepEqual(view.dimensions("sensor"), { width: 420, height: 410 });
  await view.pointer("camera-b", "both", "pointerdown", 420, 320);
  await view.pointer("camera-b", "both", "pointermove", 460, 350);
  await view.pointer("camera-b", "both", "pointerup", 460, 350);
  assert.deepEqual(view.dimensions("camera-a"), camera);
  assert.deepEqual(view.dimensions("camera-b"), { width: 460, height: 350 });
  assert.equal(view.card("camera-a").querySelector("video"), video);
  assert.equal(view.card("microphone").querySelector("audio"), audio);
  await view.remount();
  assert.deepEqual(view.dimensions("camera-a"), camera);
  assert.deepEqual(view.dimensions("camera-b"), { width: 460, height: 350 });
  assert.deepEqual(view.dimensions("microphone"), { width: 320, height: 140 });
  assert.deepEqual(view.dimensions("sensor"), { width: 420, height: 410 });
});

test("narrow viewports clamp only visible width and restore each preferred size on widening or remount", async t => {
  const view = await fixture(t);
  await act(async () => { view.sizes().setSize("camera-a", { width: 700, height: 750 }); view.sizes().setSize("camera-b", { width: 560, height: 420 }); });
  const saved = window.localStorage.getItem(storageKey), nodes = [...view.host.querySelectorAll("video,audio")];
  await view.resize(300);
  assert.deepEqual(view.dimensions("camera-a"), { width: 300, height: 750 });
  assert.deepEqual(view.dimensions("camera-b"), { width: 300, height: 420 });
  assert.equal(window.localStorage.getItem(storageKey), saved);
  await view.resize(1000);
  assert.deepEqual(view.dimensions("camera-a"), { width: 700, height: 750 });
  assert.deepEqual(view.dimensions("camera-b"), { width: 560, height: 420 });
  [...view.host.querySelectorAll("video,audio")].forEach((node, i) => assert.equal(node, nodes[i]));
  await view.remount();
  assert.deepEqual(view.dimensions("camera-a"), { width: 700, height: 750 });
  assert.deepEqual(view.dimensions("camera-b"), { width: 560, height: 420 });
});

test("cancelled independent-card drags restore both axes and never overwrite a different card", async t => {
  const view = await fixture(t);
  await act(async () => view.sizes().setSize("microphone", { width: 330, height: 160 }));
  const saved = window.localStorage.getItem(storageKey);
  for (const end of ["pointercancel", "lostpointercapture"]) {
    await view.pointer("camera-a", "both", "pointerdown");
    await view.pointer("camera-a", "both", "pointermove", 550, 480);
    assert.deepEqual(view.dimensions("camera-a"), { width: 570, height: 500 });
    await view.pointer("camera-a", "both", end, 550, 480);
    assert.deepEqual(view.dimensions("camera-a"), { width: 420, height: 320 });
    assert.deepEqual(view.dimensions("microphone"), { width: 330, height: 160 });
    assert.equal(window.localStorage.getItem(storageKey), saved);
  }
});

test("per-card restore and keyboard resizing affect only the focused card and suppress global shortcuts", async t => {
  const view = await fixture(t);
  await act(async () => { view.sizes().setSize("camera-a", { width: 600, height: 600 }); view.sizes().setSize("sensor", { width: 450, height: 350 }); });
  const leaked: string[] = [], listener = (event: KeyboardEvent) => leaked.push(event.key);
  document.addEventListener("keydown", listener); t.after(() => document.removeEventListener("keydown", listener));
  const grip = view.card("sensor").querySelector<HTMLElement>(".card-resize-corner")!;
  for (const key of ["ArrowRight", "ArrowDown", "r", " "]) await act(async () => grip.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  assert.ok(view.dimensions("sensor").width > 450 && view.dimensions("sensor").height > 350);
  assert.deepEqual(view.dimensions("camera-a"), { width: 600, height: 600 });
  assert.deepEqual(leaked, []);
  const restore = view.card("sensor").querySelector<HTMLButtonElement>(".card-size-reset");
  assert.ok(restore); await act(async () => restore.click());
  assert.deepEqual(view.dimensions("sensor"), { width: 320, height: 260 });
  assert.deepEqual(view.dimensions("camera-a"), { width: 600, height: 600 });
});

test("sensor cells clamp saved width and height without losing the preference when the viewport grows again", async t => {
  const view = await fixture(t);
  await act(async () => view.sizes().setSize("sensor", { width: 600, height: 700 }));
  const saved = window.localStorage.getItem(storageKey);
  await view.resize(300, 250);
  assert.deepEqual(view.dimensions("sensor"), { width: 300, height: 250 });
  assert.equal(window.localStorage.getItem(storageKey), saved);
  await view.resize(1000, 800);
  assert.deepEqual(view.dimensions("sensor"), { width: 600, height: 700 });
  await view.resize(300, 250);
  await view.pointer("sensor", "both", "pointerdown", 300, 250);
  await view.pointer("sensor", "both", "pointermove", 1000, 1000);
  await view.pointer("sensor", "both", "pointerup", 1000, 1000);
  assert.deepEqual(view.dimensions("sensor"), { width: 300, height: 250 }, "dragging against the cell boundary cannot grow or overflow the page");
  assert.equal(window.localStorage.getItem(storageKey), saved, "a drag already against its limit preserves the larger saved preference");
});

test("full-height preference follows the screen on resize and reload, and restoring height preserves width", async t => {
  const view = await fixture(t);
  await view.resize(1000, 760);
  await act(async () => view.sizes().setSize("sensor", { width: 410, height: 760 }));
  assert.equal(JSON.parse(window.localStorage.getItem(storageKey)!).cards.sensor.fullHeight, true);
  await view.resize(600, 540);
  assert.deepEqual(view.dimensions("sensor"), { width: 410, height: 540 });
  await view.resize(1000, 900);
  await view.remount();
  assert.deepEqual(view.dimensions("sensor"), { width: 410, height: 900 });
  await act(async () => view.sizes().resetHeight("sensor"));
  assert.deepEqual(view.dimensions("sensor"), { width: 410, height: 260 });
  assert.deepEqual(JSON.parse(window.localStorage.getItem(storageKey)!).cards.sensor, { width: 410 });
});
