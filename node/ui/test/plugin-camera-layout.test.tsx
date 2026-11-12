import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { ComponentProps } from "react";
import { PluginCameraFeeds } from "../src/PluginCameraFeeds";
import type { Device } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
const resizeObservers = new Set<TestResizeObserver>();
class TestResizeObserver {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { resizeObservers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  disconnect() { this.targets.clear(); resizeObservers.delete(this); }
}
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: TestResizeObserver,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const captures = new WeakMap<Element, number>();
let bounds = { width: 800, height: 400 };
Object.assign(dom.window.HTMLElement.prototype, {
  setPointerCapture(this: HTMLElement, id: number) { captures.set(this, id); },
  hasPointerCapture(this: HTMLElement, id: number) { return captures.get(this) === id; },
  releasePointerCapture(this: HTMLElement) { captures.delete(this); },
  getBoundingClientRect(this: HTMLElement) {
    const size = this.getAttribute("role") === "separator" ? { width: 14, height: 14 } : bounds;
    return { x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height,
      width: size.width, height: size.height, toJSON: () => ({}) };
  },
});
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

type Props = ComponentProps<typeof PluginCameraFeeds>;
type LayoutPatch = Parameters<Props["onLayoutChange"]>[0];
const streams: Props["streams"] = [
  { id: "left", name: "左目 RGB", kind: "camera" }, { id: "right", name: "右目 RGB", kind: "camera" },
];
const devices: Device[] = streams.map(stream => ({ id: `plugin-p-stereo-${stream.id}`, name: stream.name,
  kind: "camera", transport: "sdk-plugin", sample_rate: 30, channels: 3, unit: "MJPEG", mode: "sdk-plugin", connected: true }));

async function fixture(t: TestContext, overrides: Partial<Props> = {}) {
  bounds = { width: 800, height: 400 };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const commits: LayoutPatch[] = [];
  let props: Props = { cardId: "p-stereo", streams, devices, active: true, online: true, previewConnected: true,
    paused: false, layout: "horizontal", split: 0.5, ...overrides, onLayoutChange: patch => {
      commits.push(patch);
      props = { ...props, ...(patch.cameraLayout !== undefined ? { layout: patch.cameraLayout } : {}),
        ...(patch.cameraSplit !== undefined ? { split: patch.cameraSplit } : {}) };
      root.render(<PluginCameraFeeds {...props} />);
    } };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<PluginCameraFeeds {...props} />));
  const separator = () => host.querySelector<HTMLElement>('[role="separator"]')!;
  const nodes = () => [...host.querySelectorAll(".workspace-camera-feed, .workspace-camera-feed canvas")];
  const value = () => Number(separator().getAttribute("aria-valuenow"));
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name)!;
  const pointer = async (type: string, x: number, y: number) => act(async () => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 11 }, isPrimary: { value: true } });
    separator().dispatchEvent(event);
  });
  const key = async (key: string, shiftKey = false) => act(async () => {
    separator().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  });
  const render = async (patch: Partial<Props>) => act(async () => { props = { ...props, ...patch }; root.render(<PluginCameraFeeds {...props} />); });
  const resize = async (width: number, height: number) => act(async () => {
    bounds = { width, height };
    for (const observer of [...resizeObservers]) observer.callback([...observer.targets].map(target => ({ target,
      contentRect: target.getBoundingClientRect() })) as ResizeObserverEntry[], observer as unknown as ResizeObserver);
  });
  return { host, commits, separator, nodes, value, button, pointer, key, render, resize };
}

function sameNodes(actual: Element[], expected: Element[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((node, index) => assert.equal(node, expected[index], "layout changes must preserve each eye's live preview node"));
}

test("changing camera arrangement preserves both independently named live preview nodes", async t => {
  const view = await fixture(t), original = view.nodes();
  assert.equal(view.host.querySelectorAll("canvas").length, 2);
  for (const stream of streams) {
    const feed = view.host.querySelector(`[data-stream-id="plugin-p-stereo-${stream.id}"]`)!;
    assert.equal(feed.querySelector("h4")?.textContent, stream.name);
    assert.match(feed.querySelector("canvas")!.getAttribute("aria-label")!, new RegExp(stream.name));
  }
  assert.equal(view.separator().getAttribute("aria-orientation"), "vertical");
  await act(async () => view.button("上下排列").click());
  assert.equal(view.separator().getAttribute("aria-orientation"), "horizontal");
  assert.equal(view.button("上下排列").getAttribute("aria-pressed"), "true");
  sameNodes(view.nodes(), original);
  await act(async () => view.button("左右排列").click());
  assert.equal(view.separator().getAttribute("aria-orientation"), "vertical");
  sameNodes(view.nodes(), original);
  assert.deepEqual(view.commits, [{ cameraLayout: "vertical" }, { cameraLayout: "horizontal" }]);
});

test("horizontal split follows horizontal dragging, commits once at release and stays bounded", async t => {
  const view = await fixture(t), original = view.nodes();
  await view.pointer("pointerdown", 400, 200);
  await view.pointer("pointermove", 400, 350);
  assert.equal(view.value(), 50, "vertical movement cannot change a side-by-side split");
  await view.pointer("pointermove", 557.2, 350);
  assert.equal(view.value(), 70);
  assert.deepEqual(view.commits, [], "dragging must not save on every mouse movement");
  await view.pointer("pointerup", 557.2, 350);
  assert.equal(view.commits.length, 1);
  assert.ok(Math.abs(view.commits[0].cameraSplit! - 0.7) < 1e-9);
  sameNodes(view.nodes(), original);
  await view.pointer("pointerdown", 557.2, 200);
  await view.pointer("pointermove", 3000, 200);
  assert.equal(view.value(), 80, "the other eye retains at least 20% of the space");
  await view.pointer("pointerup", 3000, 200);
  assert.equal(view.commits.at(-1)?.cameraSplit, 0.8);
  await view.pointer("pointerdown", 3000, 200);
  await view.pointer("pointermove", -3000, 200);
  assert.equal(view.value(), 20);
  await view.pointer("pointerup", -3000, 200);
  assert.equal(view.commits.at(-1)?.cameraSplit, 0.2);
  sameNodes(view.nodes(), original);
});

test("vertical split follows height and restores the saved value on cancelled drags", async t => {
  const view = await fixture(t, { layout: "vertical", split: 0.6 }), original = view.nodes();
  await view.pointer("pointerdown", 300, 200);
  await view.pointer("pointermove", 600, 200);
  assert.equal(view.value(), 60, "horizontal movement cannot change the height split");
  await view.pointer("pointermove", 600, 161.4);
  assert.equal(view.value(), 50);
  await view.pointer("pointerup", 600, 161.4);
  const savedCommits = view.commits.length;
  assert.equal(view.commits.at(-1)?.cameraSplit, 0.5);
  for (const cancellation of ["pointercancel", "lostpointercapture", "Escape", "blur"]) {
    await view.pointer("pointerdown", 400, 200);
    await view.pointer("pointermove", 400, 277.2);
    assert.equal(view.value(), 70);
    if (cancellation === "Escape") await view.key("Escape");
    else if (cancellation === "blur") await act(async () => window.dispatchEvent(new dom.window.Event("blur")));
    else await view.pointer(cancellation, 400, 277.2);
    assert.equal(view.value(), 50, `${cancellation} must restore the last committed height`);
    await view.pointer("pointerup", 400, 277.2);
    assert.equal(view.commits.length, savedCommits, `${cancellation} must not persist a partial drag`);
    sameNodes(view.nodes(), original);
  }
});

test("keyboard resizing uses the displayed axis, consumes adjustment keys and supports equal sizing", async t => {
  const view = await fixture(t, { layout: "vertical", split: 0.6 });
  let bubbledKeys = 0;
  const onKey = () => bubbledKeys++;
  document.addEventListener("keydown", onKey); t.after(() => document.removeEventListener("keydown", onKey));
  await view.key("ArrowUp"); assert.equal(view.value(), 58);
  await view.key("ArrowDown", true); assert.equal(view.value(), 68);
  await view.key("Home"); assert.equal(view.value(), 50);
  assert.equal(bubbledKeys, 0, "layout shortcuts must not reach recording hotkeys");
  const count = view.commits.length;
  await view.key("ArrowRight"); assert.equal(view.commits.length, count);
  await act(async () => view.button("左右排列").click());
  await view.key("ArrowRight"); assert.equal(view.value(), 52);
  await view.key("ArrowLeft", true); assert.equal(view.value(), 42);
  await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="恢复均分"]')!.click());
  assert.equal(view.value(), 50); assert.equal(view.commits.at(-1)?.cameraSplit, 0.5);
});

test("restored split preferences apply independently of automatic orientation and resizing cancels stale drags", async t => {
  const view = await fixture(t, { layout: "auto", split: 0.65 }), original = view.nodes();
  assert.equal(view.value(), 65);
  assert.equal(view.button("自动").getAttribute("aria-pressed"), "true");
  await view.resize(400, 800);
  assert.equal(view.separator().getAttribute("aria-orientation"), "horizontal");
  assert.equal(view.value(), 65);
  await view.pointer("pointerdown", 200, 400);
  await view.pointer("pointermove", 200, 480);
  assert.notEqual(view.value(), 65);
  await view.resize(400, 500);
  assert.equal(view.value(), 65, "a parent resize invalidates the drag's original pixel budget");
  await view.pointer("pointerup", 200, 480);
  assert.deepEqual(view.commits, []);
  await view.resize(800, 200);
  assert.equal(view.separator().getAttribute("aria-orientation"), "vertical", "short cards must avoid stacking two tiny eyes");
  await view.render({ layout: "vertical", split: 0.35 });
  assert.equal(view.value(), 35, "restoring persisted preferences updates both the divider and displayed ratio");
  assert.equal(view.separator().getAttribute("aria-orientation"), "horizontal");
  sameNodes(view.nodes(), original);
});

test("missing camera delivery retains a labelled placeholder and single-camera views do not expose a split handle", async t => {
  const view = await fixture(t, { devices: devices.slice(0, 1) });
  const left = view.host.querySelector('[data-stream-id="plugin-p-stereo-left"]')!;
  const right = view.host.querySelector('[data-stream-id="plugin-p-stereo-right"]')!;
  assert.ok(left.querySelector("canvas")); assert.equal(right.querySelector("canvas"), null);
  assert.match(right.textContent!, /右目 RGB.*等待该路画面/);
  await view.render({ streams: streams.slice(0, 1) });
  assert.equal(view.host.querySelector('[role="separator"]'), null);
  assert.equal(view.host.querySelector('.workspace-camera-layout-toolbar'), null);
  assert.equal(view.host.querySelector('[data-stream-id="plugin-p-stereo-left"]'), left);
  assert.ok(left.querySelector("canvas"));
});
