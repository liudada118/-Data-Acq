import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, useRef } from "react";
import { cardPositionsStorageKey, normalizeCardPositions, useCardPositions } from "../src/useCardPositions";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const captures = new WeakMap<Element, number>();
Object.assign(dom.window.HTMLElement.prototype, {
  setPointerCapture(this: HTMLElement, id: number) { captures.set(this, id); },
  hasPointerCapture(this: HTMLElement, id: number) { return captures.get(this) === id; },
  releasePointerCapture(this: HTMLElement) { captures.delete(this); },
});
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

const defaults = [
  { id: "pressure-a", height: 294 }, { id: "pressure-b", height: 294 }, { id: "body-full", height: 600 },
  { id: "glove-left", height: 294 }, { id: "glove-right", height: 294 },
];

function verifyOccupancy(plan: ReturnType<typeof useCardPositions>["plan"], columns: number, rows: number, expected = defaults) {
  const used = new Set<string>();
  assert.deepEqual(plan.pages.flatMap(page => page.ids), expected.map(card => card.id));
  for (const [id, placement] of Object.entries(plan.placements)) {
    assert.ok(placement.column >= 1 && placement.column + placement.columnSpan - 1 <= columns);
    assert.ok(placement.row >= 1 && placement.row + placement.rowSpan - 1 <= rows);
    for (let offset = 0; offset < placement.rowSpan; offset++) for (let across = 0; across < placement.columnSpan; across++) {
      const cell = `${placement.page}:${placement.column + across}:${placement.row + offset}`;
      assert.ok(!used.has(cell), `${id} must not overlap another card at ${cell}`);
      used.add(cell);
    }
  }
}

async function fixture(t: TestContext, initialCards: Array<{id: string; height: number; width?: number}> = defaults) {
  window.localStorage.clear();
  let scope = "position-fixture", columns = 3, rows = 2, generation = 0, disabled = false;
  let cards = initialCards.map(card => ({ ...card }));
  const bounds = { left: 100, top: 50, width: 920, height: 600 };
  let current: ReturnType<typeof useCardPositions>;
  const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-sensor-grid")) return { ...bounds, x: bounds.left, y: bounds.top,
      right: bounds.left + bounds.width, bottom: bounds.top + bounds.height, toJSON: () => ({}) };
    return originalBounds.call(this);
  };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const gridRef = useRef<HTMLDivElement>(null);
    const positions = useCardPositions({ scope, gridRef, layout: { columns, rows, pageSize: columns * rows }, cards,
      viewportHeight: bounds.height, viewportWidth: bounds.width, disabled });
    current = positions;
    return <div><video /><audio /><div ref={gridRef} data-sensor-grid>
      {cards.map(card => { const placement = positions.plan.placements[card.id]; return <article key={card.id} data-card-id={card.id}
        style={{ gridColumn: `${placement.column} / span ${placement.columnSpan}`, gridRow: `${placement.row} / span ${placement.rowSpan}` }}>
        <header {...positions.headerProps(card.id)} tabIndex={0}><span>同名传感器</span><button type="button" data-settings>设置</button></header>
        <canvas /><button type="button" data-move {...positions.handleProps(card.id)}>移动</button>
      </article>; })}
      {positions.indicatorStyle && <div data-drop-indicator style={positions.indicatorStyle} />}
    </div><output aria-live="polite">{positions.announcement}</output></div>;
  }
  const render = async () => act(async () => root.render(<Harness key={generation} />));
  await render();
  t.after(async () => { await act(async () => root.unmount()); host.remove();
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalBounds; window.localStorage.clear(); });
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
  const handle = (id: string, selector = "[data-move]") => card(id).querySelector<HTMLElement>(selector)!;
  const pointer = async (id: string, type: string, x: number, y: number, selector = "[data-move]", pointerId = 17) => act(async () => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
    handle(id, selector).dispatchEvent(event);
  });
  const keyboard = async (id: string, key: string) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => handle(id).dispatchEvent(event)); return event;
  };
  return { host, card, handle, pointer, keyboard, controller: () => current!,
    saved: () => window.localStorage.getItem(cardPositionsStorageKey(scope)),
    nodes: () => [...host.querySelectorAll("article,video,audio,canvas")],
    remount: async () => { generation++; await render(); },
    setScope: async (next: string) => { scope = next; await render(); },
    setDisabled: async (next: boolean) => { disabled = next; await render(); },
    resize: async (width: number, nextColumns: number, height = 600, nextRows = 2) => {
      bounds.width = width; bounds.height = height; columns = nextColumns; rows = nextRows; await render();
    },
    setHeight: async (id: string, height: number) => { cards = cards.map(card => card.id === id ? { ...card, height } : card); await render(); },
    setWidth: async (id: string, width: number) => { cards = cards.map(card => card.id === id ? { ...card, width } : card); await render(); },
  };
}

test("header dragging onto the lower half of a tall card previews and saves a two-way swap while keeping mounted nodes", async t => {
  const view = await fixture(t), nodes = view.nodes();
  const initial = structuredClone(view.controller().plan);
  await view.pointer("pressure-a", "pointerdown", 200, 100, "header span");
  assert.equal(view.handle("pressure-a", "header").hasPointerCapture(17), true);
  await view.pointer("pressure-a", "pointermove", 950, 500, "header span");
  assert.equal(view.controller().draggingId, "pressure-a");
  assert.deepEqual(view.controller().indicatorStyle, { left: 620, top: 0, width: 300, height: 600 });
  assert.equal(view.controller().swapTargetId, "body-full");
  assert.equal(view.controller().indicatorLabel, "松开交换位置");
  assert.equal(view.saved(), null);
  assert.deepEqual(view.controller().plan.pages, initial.pages);
  await view.pointer("pressure-a", "pointerup", 950, 500, "header span");
  assert.equal(view.controller().draggingId, null);
  assert.equal(view.handle("pressure-a", "header").hasPointerCapture(17), false);
  assert.deepEqual(view.controller().plan.placements["pressure-a"], { page: 0, row: 1, column: 3, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(view.controller().plan.placements["body-full"], { page: 0, row: 1, column: 1, rowSpan: 2, columnSpan: 1 });
  const saved = JSON.parse(view.saved()!).positions;
  assert.equal(saved["pressure-a"].column, 3);
  assert.equal(saved["body-full"].column, 1);
  assert.match(view.host.querySelector("output")!.textContent!, /两张卡片已交换位置/);
  view.nodes().forEach((node, index) => assert.equal(node, nodes[index]));
  verifyOccupancy(view.controller().plan, 3, 2);
});

test("pointer cancellation, lost capture and Escape restore the saved layout without saving the preview", async t => {
  const view = await fixture(t);
  await act(async () => view.controller().moveToEdge("pressure-b", "right"));
  const saved = view.saved(), plan = JSON.stringify(view.controller().plan);
  for (const reason of ["pointercancel", "lostpointercapture", "Escape"]) {
    await view.pointer("pressure-a", "pointerdown", 200, 100);
    await view.pointer("pressure-a", "pointermove", 950, 500);
    assert.ok(view.controller().indicatorStyle);
    if (reason === "Escape") await view.keyboard("pressure-a", "Escape");
    else await view.pointer("pressure-a", reason, 950, 500);
    assert.equal(view.controller().indicatorStyle, null);
    assert.equal(view.handle("pressure-a").hasPointerCapture(17), false);
    await view.pointer("pressure-a", "pointerup", 950, 500);
    assert.equal(view.saved(), saved); assert.equal(JSON.stringify(view.controller().plan), plan);
  }
});

test("outside releases never save, even when the last pointermove was inside, and a click is not a drag", async t => {
  const view = await fixture(t);
  for (const outsideMove of [true, false]) {
    await view.pointer("pressure-a", "pointerdown", 200, 100);
    await view.pointer("pressure-a", "pointermove", 950, 500);
    if (outsideMove) {
      await view.pointer("pressure-a", "pointermove", 1050, 500);
      assert.equal(view.controller().indicatorStyle, null);
    }
    await view.pointer("pressure-a", "pointerup", 1050, 500);
    assert.equal(view.saved(), null);
    assert.deepEqual(view.controller().plan.placements["pressure-a"], { page: 0, row: 1, column: 1, rowSpan: 1, columnSpan: 1 });
  }
  await view.pointer("pressure-a", "pointerdown", 200, 100);
  await view.pointer("pressure-a", "pointermove", 203, 102);
  await view.pointer("pressure-a", "pointerup", 203, 102);
  assert.equal(view.saved(), null); assert.equal(view.controller().draggingId, null);
});

test("release coordinates determine the final cell and keyboard/edge commands stay inside the grid", async t => {
  const view = await fixture(t);
  await view.pointer("pressure-a", "pointerdown", 200, 100);
  await view.pointer("pressure-a", "pointermove", 500, 100);
  await view.pointer("pressure-a", "pointerup", 950, 500);
  assert.deepEqual(view.controller().plan.placements["pressure-a"], { page: 0, row: 1, column: 3, rowSpan: 1, columnSpan: 1 });
  let globalKeys = 0;
  const count = () => globalKeys++;
  document.addEventListener("keydown", count); t.after(() => document.removeEventListener("keydown", count));
  for (const [key, column, row] of [["Home", 1, 1], ["ArrowDown", 1, 2], ["ArrowRight", 2, 2], ["End", 3, 1], ["ArrowRight", 3, 1]] as const) {
    assert.equal((await view.keyboard("pressure-a", key)).defaultPrevented, true);
    assert.deepEqual(view.controller().plan.placements["pressure-a"], { page: 0, column, row, rowSpan: 1, columnSpan: 1 });
    verifyOccupancy(view.controller().plan, 3, 2);
  }
  assert.equal(globalKeys, 0, "move shortcuts must not reach global recording controls");
  await act(async () => view.controller().moveToEdge("pressure-b", "left"));
  await act(async () => view.controller().moveToEdge("pressure-b", "right"));
  assert.equal(view.controller().plan.placements["pressure-b"].column, 3);
  const saved = JSON.parse(view.saved()!).positions;
  assert.ok(saved["pressure-b"].priority > saved["pressure-a"].priority);
  assert.notDeepEqual(view.controller().plan.placements["pressure-a"], view.controller().plan.placements["pressure-b"]);
});

test("a full-height drag keeps its full column, persists by stable ID and restores after remount or viewport expansion", async t => {
  const view = await fixture(t);
  await view.pointer("body-full", "pointerdown", 900, 100);
  await view.pointer("body-full", "pointermove", 950, 600);
  assert.deepEqual(view.controller().indicatorStyle, { left: 620, top: 0, width: 300, height: 600 });
  await view.pointer("body-full", "pointerup", 950, 600);
  assert.equal(view.saved(), null, "dropping onto any part of the same tall card is a no-op");
  await act(async () => view.controller().move("pressure-a", 1, 2));
  const saved = view.saved(), restored = JSON.stringify(view.controller().plan);
  assert.deepEqual(Object.keys(JSON.parse(saved!).positions).sort(), defaults.map(card => card.id).sort());
  await view.remount();
  assert.equal(JSON.stringify(view.controller().plan), restored);
  const nodes = view.nodes();
  await view.resize(610, 2);
  assert.equal(view.controller().plan.placements["body-full"].column, 2);
  assert.equal(view.controller().plan.placements["body-full"].row, 1);
  verifyOccupancy(view.controller().plan, 2, 2);
  assert.equal(view.saved(), saved, "viewport constraints must not replace the saved rightmost-column preference");
  await view.resize(920, 3);
  assert.equal(JSON.stringify(view.controller().plan), restored);
  view.nodes().forEach((node, index) => assert.equal(node, nodes[index]));
});

test("scope changes, disabled controls, layout changes and span changes cancel active drags and release capture", async t => {
  const view = await fixture(t);
  const begin = async () => { await view.pointer("pressure-a", "pointerdown", 200, 100); await view.pointer("pressure-a", "pointermove", 950, 500); };
  await begin();
  await view.setScope("another-position-fixture");
  assert.equal(view.controller().indicatorStyle, null);
  assert.equal(view.handle("pressure-a").hasPointerCapture(17), false);
  await view.pointer("pressure-a", "pointerup", 950, 500);
  assert.equal(view.saved(), null);
  assert.equal(window.localStorage.getItem(cardPositionsStorageKey("position-fixture")), null);
  await begin(); await view.setDisabled(true);
  assert.equal(view.controller().indicatorStyle, null); assert.equal(view.handle("pressure-a").hasPointerCapture(17), false);
  await view.pointer("pressure-a", "pointerup", 950, 500); assert.equal(view.saved(), null);
  await view.setDisabled(false); await begin(); await view.resize(610, 2);
  assert.equal(view.controller().indicatorStyle, null); assert.equal(view.handle("pressure-a").hasPointerCapture(17), false);
  await view.resize(920, 3); await begin(); await view.setHeight("pressure-a", 600);
  assert.equal(view.controller().indicatorStyle, null); assert.equal(view.handle("pressure-a").hasPointerCapture(17), false);
  assert.equal(view.saved(), null);
});

test("header settings buttons do not start dragging and resetting one card retains other saved positions", async t => {
  const view = await fixture(t);
  await view.pointer("pressure-a", "pointerdown", 200, 100, "[data-settings]");
  await view.pointer("pressure-a", "pointermove", 950, 500, "[data-settings]");
  await view.pointer("pressure-a", "pointerup", 950, 500, "[data-settings]");
  assert.equal(view.saved(), null); assert.equal(view.controller().draggingId, null);
  await act(async () => view.controller().moveToEdge("pressure-a", "right"));
  await act(async () => view.controller().moveToEdge("pressure-b", "left"));
  const retained = JSON.parse(view.saved()!).positions;
  delete retained["pressure-a"];
  await act(async () => view.controller().reset("pressure-a"));
  assert.deepEqual(JSON.parse(view.saved()!).positions, retained);
  verifyOccupancy(view.controller().plan, 3, 2);
});

test("saved position normalization rejects malformed values and keeps prototype-like IDs as own data", () => {
  const normalized = normalizeCardPositions(JSON.parse('{"version":1,"positions":{"__proto__":{"column":3,"row":2,"columnsAtSave":3,"priority":1},"bad":{"column":4,"row":1,"columnsAtSave":3,"priority":2},"fraction":{"column":1.5,"row":1,"columnsAtSave":3,"priority":3},"negative":{"column":1,"row":1,"columnsAtSave":3,"priority":-1}}}'));
  assert.equal(Object.getPrototypeOf(normalized), null);
  assert.deepEqual(Object.keys(normalized), ["__proto__"]);
  assert.deepEqual(normalized.__proto__, { column: 3, row: 2, columnsAtSave: 3, priority: 1 });
  assert.deepEqual(Object.keys(normalizeCardPositions({ version: 2, positions: {} })), []);
});

test("wide-card pointer and keyboard moves reserve their whole footprint and persist without replacing preview nodes", async t => {
  const cards = [{ id: "camera", width: 610, height: 294 }, { id: "pressure", width: 300, height: 294 },
    { id: "imu", width: 300, height: 294 }];
  const view = await fixture(t, cards), nodes = view.nodes();
  assert.equal(view.controller().plan.placements.camera.columnSpan, 2);
  await view.pointer("camera", "pointerdown", 200, 100, "header span");
  await view.pointer("camera", "pointermove", 950, 550, "header span");
  assert.equal(view.controller().swapTargetId, null);
  assert.deepEqual(view.controller().indicatorStyle, { left: 310, top: 305, width: 610, height: 295 });
  await view.pointer("camera", "pointerup", 950, 550, "header span");
  assert.deepEqual(view.controller().plan.placements.camera, { page: 0, column: 2, row: 2, rowSpan: 1, columnSpan: 2 });
  const persisted = view.saved();
  verifyOccupancy(view.controller().plan, 3, 2, cards);
  view.nodes().forEach((node, index) => assert.equal(node, nodes[index]));
  await view.keyboard("camera", "End");
  await view.keyboard("camera", "ArrowRight");
  assert.equal(view.saved(), persisted, "right-boundary moves stay on the existing footprint");
  await view.keyboard("camera", "Home");
  assert.equal(view.controller().plan.placements.camera.column, 1);
  await view.keyboard("camera", "ArrowRight");
  assert.equal(view.controller().plan.placements.camera.column, 2, "right arrow skips its own covered cell");
  verifyOccupancy(view.controller().plan, 3, 2, cards);
  view.nodes().forEach((node, index) => assert.equal(node, nodes[index]));
  const final = JSON.stringify(view.controller().plan);
  await view.remount();
  assert.equal(JSON.stringify(view.controller().plan), final);
  await view.resize(610, 2);
  assert.equal(view.controller().plan.placements.camera.column, 1);
  verifyOccupancy(view.controller().plan, 2, 2, cards);
  await view.resize(920, 3);
  assert.equal(JSON.stringify(view.controller().plan), final);
});

test("dropping over any column of a wide card highlights it, and span changes cancel an active move", async t => {
  const cards = [{ id: "camera", width: 610, height: 294 }, { id: "pressure", width: 300, height: 294 }];
  const view = await fixture(t, cards);
  await view.pointer("pressure", "pointerdown", 950, 100);
  await view.pointer("pressure", "pointermove", 600, 100);
  assert.equal(view.controller().swapTargetId, "camera");
  assert.deepEqual(view.controller().indicatorStyle, { left: 0, top: 0, width: 610, height: 295 });
  await view.pointer("pressure", "pointercancel", 600, 100);
  assert.equal(view.saved(), null);
  await view.pointer("camera", "pointerdown", 200, 100);
  await view.pointer("camera", "pointermove", 950, 550);
  assert.ok(view.controller().indicatorStyle);
  await view.setWidth("camera", 920);
  assert.equal(view.controller().indicatorStyle, null);
  assert.equal(view.handle("camera").hasPointerCapture(17), false);
  await view.pointer("camera", "pointerup", 950, 550);
  assert.equal(view.saved(), null);
  verifyOccupancy(view.controller().plan, 3, 2, cards);
});
