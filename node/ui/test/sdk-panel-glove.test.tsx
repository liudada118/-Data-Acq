import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { SdkPanel } from "../src/SdkPanel";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const onDevicesChanged = async () => {};

async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

test("SDK panel sends the selected glove protocol independently of insole settings", async t => {
  const previousFetch = globalThis.fetch;
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url, options) => {
    if (String(url) === "/api/sdk/connect") posts.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ loaded: true, connected: false, version: "0.4.0" }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; });
  await act(async () => root.render(<SdkPanel online recording={false} onDevicesChanged={onDevicesChanged} />));
  const product = host.querySelector("#sdk-product") as HTMLSelectElement;
  await choose(product, "insole");
  await choose(host.querySelector("#sdk-protocol") as HTMLSelectElement, "8bit");
  await choose(product, "glove");
  const protocol = host.querySelector("#sdk-glove-protocol") as HTMLSelectElement;
  assert.equal(protocol.value, "segmented");
  assert.match(protocol.textContent!, /分包（0.4\+）/);
  assert.match(protocol.textContent!, /整包（兼容旧设备）/);
  assert.equal(host.querySelector("#sdk-protocol"), null);
  assert.doesNotMatch(product.textContent!, /Full Packet/);
  const port = host.querySelector("#sdk-port") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(port, "COM_TEST");
    port.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const connect = [...host.querySelectorAll("button")].find(button => button.textContent === "连接传感器")!;
  await act(async () => connect.click());
  await choose(protocol, "full-packet");
  await act(async () => connect.click());
  assert.deepEqual(posts, [
    { product: "glove", path: "COM_TEST", side: "left", gloveProtocol: "segmented" },
    { product: "glove", path: "COM_TEST", side: "left", gloveProtocol: "full-packet" },
  ]);
  await choose(product, "insole");
  assert.equal(host.querySelector("#sdk-glove-protocol"), null);
  assert.equal((host.querySelector("#sdk-protocol") as HTMLSelectElement).value, "8bit");
  await choose(product, "body");
  assert.equal(host.querySelector("#sdk-glove-protocol"), null);
});

test("SDK panel restores a connected glove protocol and keeps it locked during recording", async t => {
  const previousFetch = globalThis.fetch;
  let connected = true;
  globalThis.fetch = (async url => {
    if (String(url) === "/api/sdk/disconnect") connected = false;
    return new Response(JSON.stringify({
      loaded: true, connected, version: "0.4.0", product: "glove", protocol: "full-packet",
      side: "right", path: "COM_TEST", ready: true,
    }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; });
  await act(async () => root.render(<SdkPanel online recording={false} onDevicesChanged={onDevicesChanged} />));
  const protocol = host.querySelector("#sdk-glove-protocol") as HTMLSelectElement;
  assert.equal((host.querySelector("#sdk-product") as HTMLSelectElement).value, "glove");
  assert.equal((host.querySelector("#sdk-side") as HTMLSelectElement).value, "right");
  assert.equal(protocol.value, "full-packet");
  assert.equal(protocol.disabled, true);
  const disconnect = [...host.querySelectorAll("button")].find(button => button.textContent === "断开传感器")!;
  await act(async () => disconnect.click());
  assert.equal(protocol.disabled, false);
  assert.equal(protocol.value, "full-packet");
  await act(async () => root.render(<SdkPanel online recording onDevicesChanged={onDevicesChanged} />));
  assert.equal(protocol.disabled, true);
});
