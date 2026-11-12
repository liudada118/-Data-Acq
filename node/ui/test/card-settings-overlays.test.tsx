import test, { after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import { cardStreamIds, createCameraCard, createSdkCard } from "../src/workspace";
import type { WorkspaceState } from "../src/workspace";
import type { SdkConnectionInput, SdkInstanceInfo } from "../src/sdk-types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const click = async (node: HTMLElement) => act(async () => {
  node.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); node.click();
});
const escape = async () => act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Escape", bubbles: true, cancelable: true,
})));
const instance = (id: string): SdkInstanceInfo => ({ instance_id: id, product: "hand-pad", loaded: true,
  connected: true, has_device: true, ready: true, path: id === "a" ? "COM_A" : "COM_B",
  stream_ids: cardStreamIds(createSdkCard("hand-pad", id)) });

async function fixture(t: TestContext) {
  const connects: string[] = [], disconnects: string[] = [];
  let changeConnections!: (instances: SdkInstanceInfo[]) => void;
  let nextConnect: ReturnType<typeof deferred<SdkInstanceInfo>> | undefined;
  let nextDisconnect: ReturnType<typeof deferred<void>> | undefined;
  let added = 0;
  const camera = { connections: {}, devices: [], busyIds: [], scanning: false,
    connect: async () => { connects.push("camera"); }, disconnect: async () => { disconnects.push("camera"); },
  } as unknown as AcquisitionWorkspaceProps["camera"];
  function Harness() {
    const [workspace, setWorkspace] = useState<WorkspaceState>({ version: 1, layout: "grid", cards: [
      { ...createSdkCard("hand-pad", "a"), path: "COM_A" },
      { ...createSdkCard("hand-pad", "b"), path: "COM_B" }, createCameraCard("c-old"),
    ] });
    const [instances, setInstances] = useState<SdkInstanceInfo[]>([]);
    changeConnections = setInstances;
    const sdk = { info: { loaded: true }, instances, ports: [{ path: "COM_A" }, { path: "COM_B" }],
      busyIds: [], scanning: false, scanPorts: async () => {},
      connect: async (input: SdkConnectionInput) => {
        connects.push(input.instance_id!);
        const result = nextConnect ? await nextConnect.promise : instance(input.instance_id!);
        setInstances(current => [...current.filter(item => item.instance_id !== result.instance_id), result]);
        return result;
      },
      disconnect: async (id: string) => {
        disconnects.push(id); if (nextDisconnect) await nextDisconnect.promise;
        setInstances(current => current.filter(item => item.instance_id !== id));
      },
    } as unknown as AcquisitionWorkspaceProps["sdk"];
    return <AcquisitionWorkspace cardContentFullscreen workspace={workspace} sdk={sdk} camera={camera}
      devices={instances.flatMap(current => (current.stream_ids ?? []).map(id => ({ id, name: id, kind: "pressure" as const,
        connected: true, mode: "hardware", transport: "serial", channels: 4, sample_rate: 100, unit: "ADC", rows: 2, cols: 2 })))}
      online recording={false} busy={false} previewPaused={false} previewConnected previewRate={5}
      onTogglePreview={() => {}} onAddSdk={product => setWorkspace(current => ({ ...current,
        cards: [...current.cards, createSdkCard(product, `added-${++added}`)] }))}
      onAddCamera={() => setWorkspace(current => ({ ...current, cards: [...current.cards, createCameraCard(`c-added-${++added}`)] }))}
      onRemove={async () => {}} onLayout={() => {}}
      onUpdate={(id, patch) => setWorkspace(current => ({ ...current,
        cards: current.cards.map(card => card.id === id ? { ...card, ...patch } : card) }))} />;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); });
  await act(async () => root.render(<Harness />));
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-instance-id="${id}"]`)!;
  const panel = (id: string) => card(id).querySelector<HTMLElement>(".workspace-config-panel")!;
  const toggle = (id: string) => card(id).querySelector<HTMLButtonElement>(".workspace-settings-toggle")!;
  return { host, connects, disconnects, card, panel, toggle,
    openIds: () => [...host.querySelectorAll<HTMLElement>(".workspace-config-panel:not([hidden])")]
      .map(node => node.closest<HTMLElement>("[data-instance-id]")!.dataset.instanceId),
    catalog: () => host.querySelector<HTMLElement>(".sensor-catalog")!,
    open: async (id: string) => { await click(toggle(id)); },
    catalogToggle: async () => { await click(host.querySelector<HTMLButtonElement>(".catalog-toggle")!); },
    ready: async (ids: string[]) => { await act(async () => changeConnections(ids.map(instance))); },
    connect: async (id: string) => { await click(panel(id).querySelector<HTMLButtonElement>('button[aria-label^="连接"]')!); },
    disconnect: async (id: string) => { await click(panel(id).querySelector<HTMLButtonElement>(".workspace-disconnect")!); },
    pendingConnect: () => { nextConnect = deferred<SdkInstanceInfo>(); return nextConnect; },
    pendingDisconnect: () => { nextDisconnect = deferred<void>(); return nextDisconnect; },
  };
}

test("catalog temporarily hides disconnected settings and makes the background inert without changing saved open states", async t => {
  const view = await fixture(t);
  const display = view.host.querySelector<HTMLElement>(".display-workspace")!;
  assert.deepEqual(view.openIds(), ["a", "b", "c-old"], "disconnected devices still offer connection setup immediately");
  await view.open("b"); assert.deepEqual(view.openIds(), ["a", "c-old"], "each disconnected card keeps its independent toggle");
  await view.catalogToggle();
  assert.equal(view.catalog().getAttribute("role"), "dialog"); assert.deepEqual(view.openIds(), []);
  assert.equal(display.hasAttribute("inert"), true, "the modal catalog blocks background focus and pointer interaction");
  assert.equal(view.catalog().closest("[inert]"), null, "the catalog itself remains interactive");
  await escape();
  assert.equal(view.catalog().getAttribute("role"), null); assert.equal(display.hasAttribute("inert"), false);
  assert.deepEqual(view.openIds(), ["a", "c-old"], "closing the catalog restores prior multiple-open and manually closed states");
  await view.catalogToggle();
  await click(view.host.querySelector<HTMLButtonElement>('[aria-label="关闭传感器列表"]')!);
  assert.deepEqual(view.openIds(), ["a", "c-old"], "backdrop dismissal also preserves card settings");
  await view.catalogToggle();
  await click(view.catalog().querySelector<HTMLButtonElement>('button[aria-label^="添加"][aria-label$="摄像头"]')!);
  assert.equal(view.catalog().getAttribute("role"), null);
  assert.equal(display.hasAttribute("inert"), false);
  assert.deepEqual(view.openIds(), ["a", "c-old", "c-added-1"], "new disconnected cards keep the existing default-open behavior");
  assert.deepEqual(view.connects, []); assert.deepEqual(view.disconnects, [], "overlay navigation never changes connections");
});

test("late connection failure stays behind the catalog and returns with a visible retry after dismissal", async t => {
  const view = await fixture(t), pending = view.pendingConnect();
  await view.open("b"); await view.connect("a"); await view.catalogToggle();
  await act(async () => pending.reject(new Error("COM_A 占用，请重试。")));
  assert.equal(view.catalog().getAttribute("role"), "dialog");
  assert.deepEqual(view.openIds(), [], "late errors must not render a configuration overlay above the catalog");
  assert.equal(view.host.querySelector(".display-workspace")!.hasAttribute("inert"), true);
  await escape();
  assert.deepEqual(view.openIds(), ["a", "c-old"]);
  const error = view.card("a").querySelector<HTMLElement>('[role="alert"]')!;
  assert.ok(error); assert.equal(error.closest("[hidden]"), null);
  assert.match(error.textContent!, /COM_A 占用/);
  const retry = view.panel("a").querySelector<HTMLButtonElement>('button[aria-label^="连接"]')!;
  assert.equal(retry.disabled, false); assert.equal(retry.textContent, "重试连接");
  const second = view.pendingConnect(); await view.connect("a"); await view.catalogToggle();
  await act(async () => second.resolve(instance("a")));
  assert.equal(view.catalog().getAttribute("role"), "dialog"); assert.deepEqual(view.openIds(), []);
  await escape(); assert.deepEqual(view.openIds(), ["c-old"], "successful connection still closes its setup while the manually closed card remains closed");
  assert.equal(view.card("a").querySelector('[role="alert"]'), null);
  assert.deepEqual(view.connects, ["a", "a"]); assert.deepEqual(view.disconnects, []);
});

test("the real catalog pointerdown and click sequence preserves explicitly opened settings for a ready card", async t => {
  const view = await fixture(t);
  await view.ready(["a", "b"]); await view.open("a");
  assert.deepEqual(view.openIds(), ["a", "c-old"]);
  // A bare click misses the document-level outside-pointer handler, which must
  // not dismiss ready-card settings before the catalog saves their visibility.
  await view.catalogToggle(); assert.deepEqual(view.openIds(), []);
  await escape();
  assert.deepEqual(view.openIds(), ["a", "c-old"]);
  assert.equal(document.activeElement, view.host.querySelector(".catalog-toggle"));
  assert.deepEqual(view.connects, []); assert.deepEqual(view.disconnects, []);
});

test("disconnect and readiness changes stay hidden while the catalog is open and retain existing ready-state defaults afterward", async t => {
  const view = await fixture(t);
  await view.ready(["a", "b"]);
  assert.deepEqual(view.openIds(), ["c-old"]);
  await view.open("a");
  const pending = view.pendingDisconnect(); await view.disconnect("a");
  await view.catalogToggle();
  await act(async () => pending.resolve());
  assert.deepEqual(view.openIds(), []);
  await view.ready([]);
  assert.deepEqual(view.openIds(), []);
  await escape();
  assert.deepEqual(view.openIds(), ["a", "b", "c-old"], "newly disconnected cards retain the existing setup-visible behavior");
  assert.deepEqual(view.connects, []); assert.deepEqual(view.disconnects, ["a"]);
  assert.ok(view.card("a")); assert.ok(view.card("b"));
});
