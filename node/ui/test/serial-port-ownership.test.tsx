import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { SerialPortOwnership } from "../src/SerialPortOwnership";
import type { SerialPortOwner } from "../src/SerialPortOwnership";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
type Props = Parameters<typeof SerialPortOwnership>[0];
interface Call { route: string; body: Record<string, unknown>; signal?: AbortSignal | null }
const external: SerialPortOwner = { id: "external-4242", kind: "external", name: "SerialTool.exe", pid: 4242,
  executable: "C:\\Tools\\SerialTool.exe", can_release: true, release_token: "opaque-external-token" };
const internal: SerialPortOwner = { id: "internal-other", kind: "internal", name: "左手手套", instance_id: "other",
  can_release: true, release_token: "opaque-internal-token" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const inspection = (owners: SerialPortOwner[], port = "COM5") => json({ port, owners, complete: true });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function button(host: ParentNode, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(item => item.textContent === label);
  assert.ok(found, `Expected button ${label}`);
  return found;
}
async function click(element: HTMLButtonElement) { await act(async () => element.click()); }

async function mount(t: TestContext, handler: (call: Call) => Response | Promise<Response>, overrides: Partial<Props> = {}) {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url, options) => {
    const call: Call = { route: String(url), body: JSON.parse(String(options?.body)), signal: options?.signal };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  let refreshes = 0;
  let props: Props = { port: "COM5", online: true, recording: false, onReleased: async () => { refreshes++; }, ...overrides };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(<SerialPortOwnership {...props} />));
  return { host, calls, refreshes: () => refreshes,
    async update(next: Partial<Props>) { props = { ...props, ...next }; await act(async () => root.render(<SerialPortOwnership {...props} />)); } };
}

test("external ownership is queried on demand and release needs a cancellable process-ending confirmation", async t => {
  const queried = deferred<Response>(), released = deferred<Response>();
  const view = await mount(t, call => call.route.endsWith("/inspect") ? queried.promise : released.promise);
  assert.equal(view.calls.length, 0, "mounting an error card never probes or releases a port");
  await click(button(view.host, "查看占用程序"));
  assert.equal(button(view.host, "正在查询占用程序").disabled, true);
  assert.deepEqual(view.calls[0].body, { port: "COM5" });
  await act(async () => queried.resolve(inspection([external])));
  assert.match(view.host.textContent!, /SerialTool.exe/);
  assert.match(view.host.textContent!, /PID 4242/);
  assert.equal(view.host.textContent!.includes(external.release_token!), false);
  await click(button(view.host, "释放串口"));
  assert.match(view.host.textContent!, /将结束「SerialTool.exe」程序（PID 4242），未保存数据可能丢失/);
  assert.equal(view.calls.length, 1);
  await click(button(view.host, "取消"));
  assert.equal(view.host.querySelector('[role="group"]'), null);
  assert.equal(view.calls.length, 1);
  await click(button(view.host, "释放串口"));
  await click(button(view.host, "结束程序并释放"));
  assert.equal(button(view.host, "正在释放串口").disabled, true);
  assert.equal(button(view.host, "取消").disabled, true);
  assert.deepEqual(view.calls[1], { route: "/api/sdk/port/release",
    body: { port: "COM5", release_token: "opaque-external-token", confirm: true }, signal: view.calls[1].signal });
  await act(async () => released.resolve(json({ released: true, port: "COM5", message: "已结束 SerialTool.exe 并释放串口。" })));
  assert.equal(view.refreshes(), 1);
  assert.match(view.host.querySelector('[role="status"]')!.textContent!, /请重新连接传感器/);
  assert.equal(view.host.querySelector('[role="group"]'), null);
  assert.equal(view.calls.some(call => call.route === "/api/sdk/connect"), false, "release never reconnects automatically");
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal(dom.window.sessionStorage.length, 0);
});

test("internal release disconnects the named connection and recording or offline states forbid it", async t => {
  const view = await mount(t, call => call.route.endsWith("/inspect") ? inspection([internal])
    : json({ released: true, port: "COM5", message: "已断开左手手套。" }));
  await click(button(view.host, "查看占用程序"));
  await view.update({ recording: true });
  assert.equal(button(view.host, "释放串口").disabled, true);
  assert.match(view.host.textContent!, /录制期间不能释放串口/);
  await view.update({ recording: false });
  await click(button(view.host, "释放串口"));
  assert.match(view.host.textContent!, /将断开本工作站的「左手手套」连接/);
  assert.equal(view.host.textContent!.includes("未保存数据可能丢失"), false);
  await view.update({ online: false });
  assert.equal(button(view.host, "断开连接并释放").disabled, true);
  assert.equal(button(view.host, "重新查询占用程序").disabled, true);
  await click(button(view.host, "断开连接并释放"));
  assert.equal(view.calls.length, 1);
  await view.update({ online: true, recording: true });
  assert.equal(button(view.host, "断开连接并释放").disabled, true);
  await view.update({ recording: false, disabled: true });
  assert.equal(button(view.host, "断开连接并释放").disabled, true);
  await view.update({ disabled: false });
  await click(button(view.host, "断开连接并释放"));
  assert.deepEqual(view.calls[1].body, { port: "COM5", release_token: "opaque-internal-token", confirm: true });
  assert.equal(view.refreshes(), 1);
});

test("unknown or unsafe ownership has explanations without offering speculative release", async t => {
  const view = await mount(t, () => json({ port: "COM5", owners: [], complete: false, reason: "系统未提供可验证的进程信息。" }));
  await click(button(view.host, "查看占用程序"));
  assert.match(view.host.textContent!, /暂时无法确认占用程序/);
  assert.match(view.host.textContent!, /系统未提供可验证的进程信息/);
  assert.equal([...view.host.querySelectorAll("button")].some(item => item.textContent === "释放串口"), false);

  await view.update({ port: "COM6" });
  // Invalid/missing ownership information must not become an executable release action.
  globalThis.fetch = (async () => inspection([
    { ...external, can_release: false, release_reason: "该程序属于系统服务，不能在此结束。" },
    { ...external, id: "unknown-pid", pid: undefined },
    { ...internal, release_token: undefined },
  ], "COM6")) as typeof fetch;
  await click(button(view.host, "查看占用程序"));
  assert.match(view.host.textContent!, /该程序属于系统服务/);
  assert.equal([...view.host.querySelectorAll("button")].some(item => item.textContent === "释放串口"), false);
});

test("query and release failures remain visible and a failed release requires fresh ownership information", async t => {
  let queries = 0;
  const view = await mount(t, call => {
    if (call.route.endsWith("/inspect")) return ++queries === 1 ? json({ error: "系统查询失败" }, 500) : inspection([external]);
    return json({ error: "占用进程已变化，请重新查询。" }, 409);
  });
  await click(button(view.host, "查看占用程序"));
  assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /查询占用程序失败：系统查询失败/);
  assert.equal(button(view.host, "查看占用程序").disabled, false);
  await click(button(view.host, "查看占用程序"));
  assert.equal(view.host.querySelector('[role="alert"]'), null);
  await click(button(view.host, "释放串口"));
  await click(button(view.host, "结束程序并释放"));
  assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /释放串口失败：占用进程已变化/);
  assert.equal(view.host.querySelector('[role="group"]'), null);
  assert.equal(view.refreshes(), 0);
  assert.equal(view.calls.length, 3);
  assert.equal(button(view.host, "查看占用程序").disabled, false);
});

test("switching ports cancels stale queries and discards previous release credentials and confirmation", async t => {
  const old = deferred<Response>();
  const view = await mount(t, call => call.body.port === "COM5" ? old.promise : inspection([external], "COM6"));
  await click(button(view.host, "查看占用程序"));
  const oldSignal = view.calls[0].signal;
  await view.update({ port: "COM6" });
  assert.equal(oldSignal?.aborted, true);
  await act(async () => old.resolve(inspection([external])));
  assert.equal(view.host.textContent!.includes("SerialTool.exe"), false);
  assert.equal(view.host.querySelector("section")!.getAttribute("aria-label"), "COM6占用程序");
  await click(button(view.host, "查看占用程序"));
  await click(button(view.host, "释放串口"));
  assert.ok(view.host.querySelector('[role="group"]'));
  await view.update({ port: "COM7" });
  assert.equal(view.host.querySelector('[role="group"]'), null);
  assert.equal(view.host.textContent!.includes("SerialTool.exe"), false);
  assert.equal(view.calls.filter(call => call.route.endsWith("/release")).length, 0);
});
