import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import { cardStreamIds, createSdkCard } from "../src/workspace";
import type { WorkspaceState } from "../src/workspace";
import type { SdkConnectionInput, SdkInstanceInfo } from "../src/sdk-types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { createRoot } = await import("react-dom/client");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function liveInstance(id: string): SdkInstanceInfo {
  return { instance_id: id, product: "hand-pad", loaded: true, connected: true, has_device: true,
    path: "COM_OTHER", stream_ids: cardStreamIds(createSdkCard("hand-pad", id)) };
}

async function mountWorkspace(t: TestContext, sdk: AcquisitionWorkspaceProps["sdk"],
  options: { recording?: boolean; busy?: boolean; online?: boolean } = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const camera = { connections: {}, busyIds: [], devices: [], scanning: false } as unknown as AcquisitionWorkspaceProps["camera"];
  const removals: string[] = [];
  function Harness() {
    const [workspace, setWorkspace] = useState<WorkspaceState>({ version: 1, layout: "grid", cards: [
      { ...createSdkCard("hand-pad", "target"), path: "COM_BUSY" },
      { ...createSdkCard("hand-pad", "other"), path: "COM_OTHER" },
    ] });
    return <AcquisitionWorkspace workspace={workspace} devices={sdk.instances.flatMap(instance =>
      (instance.stream_ids ?? []).map(id => ({ id, name: id, kind: "pressure", connected: instance.connected,
        sample_rate: 100, channels: 1, unit: "ADC", mode: "hardware", transport: "serial" })))} sdk={sdk} camera={camera}
      onAddSim={() => {}} onAddSdk={() => {}} onAddCamera={() => {}} onRemove={async id => { removals.push(id); }}
      onUpdate={(id, patch) => setWorkspace(previous => ({ ...previous,
        cards: previous.cards.map(card => card.id === id ? { ...card, ...patch } : card) }))}
      onLayout={() => {}} online={options.online ?? true} recording={options.recording ?? false} busy={options.busy ?? false} previewPaused={false} previewConnected
      previewRate={10} onTogglePreview={() => {}} />;
  }
  await act(async () => root.render(<Harness />));
  return {
    host, removals,
    refresh: async () => act(async () => root.render(<Harness />)),
    target: host.querySelector<HTMLElement>('[data-instance-id="target"]')!,
    other: host.querySelector<HTMLElement>('[data-instance-id="other"]')!,
  };
}

test("a rejected connection stays visible in either configuration state and can be retried independently", async t => {
  const first = deferred<SdkInstanceInfo>();
  const retry = deferred<SdkInstanceInfo>();
  const calls: SdkConnectionInput[] = [];
  const disconnects: string[] = [];
  const otherInstance = liveInstance("other");
  const sdk = { instances: [otherInstance], ports: [{ path: "COM_BUSY" }, { path: "COM_OTHER" }],
    info: { loaded: true }, busyIds: [], scanning: false, scanPorts: async () => {},
    connect: async (input: SdkConnectionInput) => {
      calls.push(input);
      const result = await (calls.length === 1 ? first.promise : retry.promise);
      sdk.instances = [...sdk.instances.filter(item => item.instance_id !== result.instance_id), result];
      return result;
    },
    disconnect: async (id: string) => { disconnects.push(id); },
  } as unknown as AcquisitionWorkspaceProps["sdk"];
  const { target, other, refresh } = await mountWorkspace(t, sdk);
  const otherHeading = other.querySelector("header")!.textContent;
  const button = target.querySelector<HTMLButtonElement>('button[aria-label^="连接"]')!;
  const panel = target.querySelector<HTMLDivElement>(".workspace-config-panel")!;
  const settings = target.querySelector<HTMLButtonElement>(".workspace-settings-toggle")!;
  await act(async () => button.click());
  assert.equal(button.textContent, "连接中");
  assert.equal(button.disabled, true);
  assert.equal(target.getAttribute("aria-busy"), "true");

  panel.scrollTop = 200;
  await act(async () => settings.click());
  assert.equal(panel.hidden, true);
  const message = "COM_BUSY 串口被其他程序占用，请关闭占用程序后重试。";
  await act(async () => first.reject(new Error(message)));
  assert.equal(panel.hidden, false, "a late failure reopens this card's configuration");
  assert.equal(panel.scrollTop, 0, "the error at the start of the panel is immediately reachable");
  assert.equal(target.querySelectorAll('[role="alert"]').length, 1);
  assert.equal(panel.firstElementChild?.getAttribute("role"), "alert");
  assert.equal(panel.firstElementChild?.textContent, message);
  assert.ok(panel.querySelector('.serial-port-ownership[aria-label="COM_BUSY占用程序"]'), "hardware failure offers an on-demand ownership query below the error");
  assert.match(target.querySelector("header")!.textContent!, /连接失败/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "重试连接");
  assert.equal(target.getAttribute("aria-busy"), "false");

  await act(async () => settings.click());
  const foldedAlert = target.querySelector<HTMLElement>('[role="alert"]')!;
  assert.equal(panel.hidden, true);
  assert.equal(foldedAlert.parentElement, target, "folded error is not inside the hidden panel");
  assert.equal(target.querySelectorAll('[role="alert"]').length, 1, "only one live alert is rendered");
  assert.equal(foldedAlert.textContent, message);
  await act(async () => settings.click());
  assert.equal(panel.firstElementChild?.getAttribute("role"), "alert");

  await act(async () => button.click());
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "连接中");
  assert.equal(target.querySelector('[role="alert"]'), null);
  await act(async () => retry.resolve({ ...liveInstance("target"), path: "COM_BUSY" }));
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "断开");
  assert.equal(target.getAttribute("aria-busy"), "false");
  assert.equal(target.querySelector('[role="alert"]'), null);
  assert.equal(panel.hidden, false, "connection settings remain until the refreshed device catalog confirms readiness");
  await refresh();
  assert.equal(panel.hidden, true);
  assert.deepEqual(calls.map(call => call.instance_id), ["target", "target"]);
  assert.deepEqual(disconnects, []);
  assert.equal(other.querySelector("header")!.textContent, otherHeading);
  assert.equal(other.querySelector('[role="alert"]'), null);
  assert.equal(sdk.instances.find(item => item.instance_id === "other"), otherInstance);
});

test("disconnect feedback names the pending action and preserves an active device on failure", async t => {
  const pending = deferred<void>();
  const targetInstance = liveInstance("target");
  const disconnects: string[] = [];
  const sdk = { instances: [targetInstance, liveInstance("other")], info: { loaded: true },
    ports: [{ path: "COM_OTHER" }], busyIds: [], scanning: false, scanPorts: async () => {},
    connect: async () => { throw new Error("Unexpected connection attempt"); },
    disconnect: async (id: string) => { disconnects.push(id); await pending.promise; },
  } as unknown as AcquisitionWorkspaceProps["sdk"];
  const { target, other } = await mountWorkspace(t, sdk);
  const button = target.querySelector<HTMLButtonElement>('header .workspace-disconnect[aria-label^="断开"]')!;
  assert.ok(button, "disconnect is available in the card title without opening settings");
  assert.equal(target.querySelector<HTMLElement>(".workspace-config-panel")!.hidden, true);
  await act(async () => button.click());
  assert.equal(button.textContent, "断开中");
  assert.match(target.querySelector("header")!.textContent!, /断开中/);
  assert.equal(button.disabled, true);
  await act(async () => pending.reject(new Error("断开请求失败，请重试。")));
  assert.match(target.querySelector("header")!.textContent!, /操作失败/);
  assert.equal(button.textContent, "断开");
  assert.equal(button.disabled, false);
  assert.equal(target.querySelectorAll('[role="alert"]').length, 1);
  assert.equal(target.querySelector(".workspace-config-panel")!.firstElementChild?.getAttribute("role"), "alert");
  assert.deepEqual(disconnects, ["target"]);
  assert.equal(targetInstance.connected, true);
  assert.equal(other.querySelector('[role="alert"]'), null);
});

test("header SDK disconnect retains its card and serial settings without affecting another connected device", async t => {
  const otherInstance = liveInstance("other"), calls: string[] = [];
  const sdk = { instances: [{ ...liveInstance("target"), path: "COM_BUSY" }, otherInstance], info: { loaded: true },
    ports: [{ path: "COM_BUSY" }, { path: "COM_OTHER" }], busyIds: [], scanning: false, scanPorts: async () => {},
    disconnect: async (id: string) => { calls.push(id); sdk.instances = sdk.instances.filter(item => item.instance_id !== id); },
  } as unknown as AcquisitionWorkspaceProps["sdk"];
  const { host, target, other, removals } = await mountWorkspace(t, sdk);
  const otherHeading = other.querySelector("header")!.textContent;
  const panel = target.querySelector<HTMLElement>(".workspace-config-panel")!;
  assert.equal(panel.hidden, true);
  const button = target.querySelector<HTMLButtonElement>("header .workspace-disconnect")!;
  assert.ok(button); assert.equal(button.closest("[hidden]"), null);
  await act(async () => button.click());
  assert.deepEqual(calls, ["target"]); assert.deepEqual(removals, []);
  assert.equal(host.querySelector('[data-instance-id="target"]'), target);
  assert.equal(panel.hidden, false, "disconnect opens the retained settings for reconnecting");
  assert.equal(target.querySelector<HTMLSelectElement>('select[aria-label$="串口"]')!.value, "COM_BUSY");
  assert.equal(target.querySelector<HTMLButtonElement>('button[aria-label^="连接"]')!.disabled, false);
  assert.equal(target.querySelector("header .workspace-disconnect"), null);
  assert.equal(other.querySelector("header")!.textContent, otherHeading);
  assert.equal(sdk.instances[0], otherInstance);
});

test("header SDK disconnect respects recording, global busy, instance busy, offline and unloaded locks", async t => {
  for (const state of ["recording", "busy", "instance-busy", "offline", "unloaded"]) {
    const calls: string[] = [];
    const sdk = { instances: [liveInstance("target")], info: { loaded: state !== "unloaded" }, ports: [],
      busyIds: state === "instance-busy" ? ["target"] : [], scanning: false, scanPorts: async () => {},
      disconnect: async (id: string) => { calls.push(id); },
    } as unknown as AcquisitionWorkspaceProps["sdk"];
    const { target } = await mountWorkspace(t, sdk, { recording: state === "recording", busy: state === "busy", online: state !== "offline" });
    const button = target.querySelector<HTMLButtonElement>("header .workspace-disconnect")!;
    assert.ok(button, state); assert.equal(button.disabled, true, state);
    await act(async () => button.click()); assert.deepEqual(calls, [], state);
  }
});
