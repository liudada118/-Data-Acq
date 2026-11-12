import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import { createSdkCard } from "../src/workspace";
import type { WorkspaceState } from "../src/workspace";
import type { SdkConnectionInput } from "../src/sdk-types";
import { SdkPanel } from "../src/SdkPanel";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => { element.value = value; element.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
}

test("insole card controls send selected firmware settings and lock during recording", async t => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const calls: SdkConnectionInput[] = [];
  const sdk = { instances: [], ports: [{ path: "COM_TEST" }], busyIds: [], scanning: false, info: { loaded: true },
    connect: async (value: SdkConnectionInput) => { calls.push(value); },
    disconnect: async () => {}, scanPorts: async () => {} } as unknown as AcquisitionWorkspaceProps["sdk"];
  const camera = { connections: {}, busyIds: [], devices: [], scanning: false } as unknown as AcquisitionWorkspaceProps["camera"];
  function Harness({ recording = false }: { recording?: boolean }) {
    const [workspace, setWorkspace] = useState<WorkspaceState>({ version: 1, layout: "grid", cards: [
      { ...createSdkCard("insole", "foot"), path: "COM_TEST" }, createSdkCard("body", "body"),
    ] });
    return <AcquisitionWorkspace workspace={workspace} onAddSim={() => {}} onAddSdk={() => {}} onAddCamera={() => {}}
      onRemove={async () => {}} onUpdate={(id, patch) => setWorkspace(w => ({ ...w, cards: w.cards.map(c => c.id === id ? { ...c, ...patch } : c) }))}
      onLayout={() => {}} devices={[]} sdk={sdk} camera={camera} online recording={recording} busy={false}
      previewPaused={false} previewConnected previewRate={10} onTogglePreview={() => {}} />;
  }
  await act(async () => root.render(<Harness />));
  const shoe = host.querySelector('[data-instance-id="foot"]')!;
  const body = host.querySelector('[data-instance-id="body"]')!;
  assert.match(host.textContent!, /添加到展示区/);
  assert.equal(body.querySelectorAll("select").length, 1, "body needs a port selector only");
  const side = shoe.querySelector('select[aria-label$="左右脚"]') as HTMLSelectElement;
  const protocol = shoe.querySelector('select[aria-label$="数据格式"]') as HTMLSelectElement;
  const baud = shoe.querySelector('select[aria-label$="波特率"]') as HTMLSelectElement;
  assert.equal(protocol.value, "12bit"); assert.equal(baud.value, "921600");
  await choose(side, "right"); await choose(protocol, "8bit"); await choose(baud, "1500000");
  await act(async () => (shoe.querySelector('button[aria-label="连接鞋垫 A 版"]') as HTMLButtonElement).click());
  assert.deepEqual(calls, [{ instance_id: "foot", product: "insole", path: "COM_TEST", side: "right", protocol: "8bit", baudRate: 1500000 }]);
  await act(async () => root.render(<Harness recording />));
  assert.equal(side.disabled, true); assert.equal(protocol.disabled, true); assert.equal(baud.disabled, true);
  assert.equal((shoe.querySelector('button[aria-label="连接鞋垫 A 版"]') as HTMLButtonElement).disabled, true);
});

test("legacy SDK panel exposes insole options and transmits them without changing body options", async t => {
  const previousFetch = globalThis.fetch;
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url, options) => {
    const route = String(url);
    if (route === "/api/sdk/connect") posts.push(JSON.parse(String(options?.body)));
    const body = route === "/api/sdk/ports" ? { ports: [] } : { loaded: true, connected: false, version: "0.3.0", path: null };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; });
  await act(async () => root.render(<SdkPanel online recording={false} onDevicesChanged={async () => {}} />));
  const product = host.querySelector("#sdk-product") as HTMLSelectElement;
  await choose(product, "insole");
  assert.match(host.querySelector('label[for="sdk-side"]')!.textContent!, /左右脚/);
  await choose(host.querySelector("#sdk-side") as HTMLSelectElement, "right");
  await choose(host.querySelector("#sdk-protocol") as HTMLSelectElement, "8bit");
  await choose(host.querySelector("#sdk-baud-rate") as HTMLSelectElement, "9600");
  // Native setter is needed to let React observe an input event in jsdom.
  const port = host.querySelector("#sdk-port") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(port, "COM_TEST");
    port.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const connect = [...host.querySelectorAll("button")].find(b => b.textContent === "连接传感器")!;
  await act(async () => connect.click());
  assert.deepEqual(posts, [{ product: "insole", path: "COM_TEST", side: "right", protocol: "8bit", baudRate: 9600 }]);
  await choose(product, "body");
  assert.equal(host.querySelector("#sdk-side"), null);
  assert.equal(host.querySelector("#sdk-protocol"), null);
  assert.equal(host.querySelector("#sdk-baud-rate"), null);
});

test("glove card selects its packet protocol and reflects the active connection", async t => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const calls: SdkConnectionInput[] = [];
  const sdk = { instances: [], ports: [{ path: "COM_GLOVE" }], busyIds: [], scanning: false, info: { loaded: true },
    connect: async (value: SdkConnectionInput) => { calls.push(value); },
    disconnect: async () => {}, scanPorts: async () => {} } as unknown as AcquisitionWorkspaceProps["sdk"];
  const camera = { connections: {}, busyIds: [], devices: [], scanning: false } as unknown as AcquisitionWorkspaceProps["camera"];
  function Harness({ recording = false }: { recording?: boolean }) {
    const [workspace, setWorkspace] = useState<WorkspaceState>({ version: 1, layout: "grid", cards: [
      { ...createSdkCard("glove", "hand"), path: "COM_GLOVE" },
    ] });
    return <AcquisitionWorkspace workspace={workspace} onAddSim={() => {}} onAddSdk={() => {}} onAddCamera={() => {}}
      onRemove={async () => {}} onUpdate={(id, patch) => setWorkspace(w => ({ ...w, cards: w.cards.map(c => c.id === id ? { ...c, ...patch } : c) }))}
      onLayout={() => {}} devices={[]} sdk={sdk} camera={camera} online recording={recording} busy={false}
      previewPaused={false} previewConnected previewRate={10} onTogglePreview={() => {}} />;
  }
  await act(async () => root.render(<Harness />));
  const hand = host.querySelector('[data-instance-id="hand"]')!;
  const protocol = hand.querySelector('select[aria-label$="手套协议"]') as HTMLSelectElement;
  assert.equal(protocol.value, "segmented");
  assert.deepEqual([...protocol.options].map(option => option.textContent), ["分包（0.4+）", "整包（兼容旧设备）"]);
  assert.equal(hand.querySelector('select[aria-label$="数据格式"]'), null);
  await choose(protocol, "full-packet");
  const connect = hand.querySelector('button[aria-label^="连接"]') as HTMLButtonElement;
  await act(async () => connect.click());
  assert.deepEqual(calls, [{ instance_id: "hand", product: "glove", path: "COM_GLOVE", side: "left", gloveProtocol: "full-packet" }]);
  await act(async () => root.render(<Harness recording />));
  assert.equal(protocol.disabled, true);
  sdk.instances = [{ instance_id: "hand", product: "glove", loaded: true, connected: true, has_device: true,
    protocol: "segmented", stream_ids: [] }];
  await act(async () => root.render(<Harness />));
  assert.equal(protocol.disabled, true);
  assert.equal(protocol.value, "segmented", "live protocol takes priority over a saved full-packet preference");
});
