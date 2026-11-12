import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { useSdkConnections } from "../src/useSdkConnections";
import type { SdkConnectionInput, SdkInfo, SdkInstanceInfo } from "../src/sdk-types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

type Hook = ReturnType<typeof useSdkConnections>;
type HookOptions = Parameters<typeof useSdkConnections>[0];
interface Call { route: string; method: string; body?: Record<string, unknown>; signal?: AbortSignal | null }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", aborted));
  });
}
function instance(input: SdkConnectionInput): SdkInstanceInfo {
  const prefix = input.instance_id === "default" ? "sdk" : `sdk-${input.instance_id}`;
  return { instance_id: input.instance_id, loaded: true, connected: true, has_device: true,
    product: input.product, path: input.path ?? null, side: input.side ?? null, frames: 0,
    protocol: input.product === "glove" ? input.gloveProtocol ?? "segmented" : input.protocol, baudRate: input.baudRate,
    device_id: `${prefix}-pressure`,
    stream_ids: input.product === "glove" || input.product === "insole" ? [`${prefix}-pressure`, `${prefix}-imu-raw`] : [`${prefix}-pressure`] };
}
function fakeService(t: TestContext) {
  const originalFetch = globalThis.fetch;
  const instances = new Map<string, SdkInstanceInfo>();
  const calls: Call[] = [];
  let loaded = true;
  let interceptor: ((call: Call) => Promise<Response> | undefined) | undefined;
  const snapshot = (): SdkInfo => ({ loaded, connected: false, version: "0.2.0", instances: structuredClone([...instances.values()]) });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (url, options) => {
    const call: Call = { route: String(url), method: options?.method ?? "GET",
      body: options?.body ? JSON.parse(String(options.body)) : undefined, signal: options?.signal };
    calls.push(call);
    const intercepted = interceptor?.(call);
    if (intercepted) return abortable(intercepted, call.signal);
    if (call.route === "/api/sdk/info") return json(snapshot());
    if (call.route === "/api/sdk/ports") return json({ ports: [{ path: "COM_TEST", friendlyName: "Fixture only" }] });
    if (call.route === "/api/sdk/connect") {
      const next = instance(call.body as unknown as SdkConnectionInput);
      instances.set(next.instance_id, next);
      return json(next);
    }
    if (call.route === "/api/sdk/disconnect") {
      const id = String(call.body?.instance_id);
      const previous = instances.get(id);
      if (!previous) return json({ error: "No such fixture instance" }, 404);
      instances.delete(id);
      return json({ ...previous, connected: false, has_device: false });
    }
    throw new Error(`Unexpected request in isolated UI test: ${call.route}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  return { calls, instances, snapshot, json,
    setLoaded(value: boolean) { loaded = value; },
    intercept(value?: typeof interceptor) { interceptor = value; } };
}
async function mountHook(t: TestContext, overrides: Partial<HookOptions> = {}, strict = false) {
  let latest!: Hook;
  let deviceRefreshes = 0;
  let options: HookOptions = { online: true, recording: false,
    onDevicesChanged: async () => { deviceRefreshes++; }, ...overrides };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let mounted = true;
  function Harness({ value }: { value: HookOptions }) { latest = useSdkConnections(value); return null; }
  const render = () => root.render(strict ? <StrictMode><Harness value={options} /></StrictMode> : <Harness value={options} />);
  await act(async () => { render(); });
  async function unmount() {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    element.remove();
  }
  t.after(unmount);
  return { value: () => latest, refreshes: () => deviceRefreshes, unmount,
    async update(next: Partial<HookOptions>) { options = { ...options, ...next }; await act(async () => { render(); }); } };
}

test("HTTP port failures release the connection lock, keep other sensors live, and allow retry", async t => {
  const service = fakeService(t);
  const hook = await mountHook(t);
  await act(async () => { await hook.value().connect({ instance_id: "reference", product: "mock" }); });
  const input: SdkConnectionInput = { instance_id: "sensor", product: "body", path: "COM29" };
  service.intercept(call => call.route === "/api/sdk/connect"
    ? Promise.resolve(service.json({ error: "PERMISSION_DENIED: Opening COM29: Access denied" }, 422)) : undefined);
  await act(async () => { await assert.rejects(hook.value().connect(input), /COM29.*可能被其他程序占用，或没有访问权限/); });
  assert.deepEqual(hook.value().busyIds, []);
  assert.equal(hook.value().instances.find(item => item.instance_id === "reference")?.connected, true);
  assert.equal(hook.value().instances.some(item => item.instance_id === "sensor"), false);
  service.intercept(call => call.route === "/api/sdk/connect"
    ? Promise.resolve(service.json({ error: "采集子进程暂不可用" }, 500)) : undefined);
  await act(async () => { await assert.rejects(hook.value().connect(input), /采集子进程暂不可用/); });
  assert.deepEqual(hook.value().busyIds, []);
  service.intercept(undefined);
  await act(async () => { await hook.value().connect(input); });
  assert.equal(hook.value().instances.find(item => item.instance_id === "sensor")?.connected, true);
  assert.deepEqual(hook.value().busyIds, []);
});

test("two sensor cards send their own connection settings and disconnect independently", async t => {
  const service = fakeService(t);
  const hook = await mountHook(t);
  await act(async () => {
    await Promise.all([
      hook.value().connect({ instance_id: "left-hand", product: "glove", path: " COM_TEST ", side: "right" }),
      hook.value().connect({ instance_id: "reference", product: "mock" }),
    ]);
  });
  const posted = service.calls.filter(call => call.route === "/api/sdk/connect").map(call => call.body);
  assert.deepEqual(posted, [
    { instance_id: "left-hand", product: "glove", path: "COM_TEST", side: "right", gloveProtocol: "segmented" },
    { instance_id: "reference", product: "mock", mode: "mock" },
  ]);
  assert.deepEqual(hook.value().instances.map(item => item.instance_id).sort(), ["left-hand", "reference"]);
  assert.deepEqual(hook.value().instances.find(item => item.instance_id === "left-hand")?.stream_ids,
    ["sdk-left-hand-pressure", "sdk-left-hand-imu-raw"]);
  await act(async () => { await hook.value().disconnect("left-hand"); });
  assert.deepEqual(service.calls.find(call => call.route === "/api/sdk/disconnect")?.body, { instance_id: "left-hand" });
  assert.equal(hook.value().instances.length, 1);
  assert.equal(hook.value().instances[0].instance_id, "reference");
  assert.equal(hook.value().instances[0].connected, true);
  assert.deepEqual(hook.value().busyIds, []);

  // High-frequency frame counters must not repeatedly trigger the device-list fetch.
  const before = hook.refreshes();
  service.instances.get("reference")!.frames = 500;
  await act(async () => { await hook.value().refresh(); });
  assert.equal(hook.value().instances[0].frames, 500);
  assert.equal(hook.refreshes(), before);
  service.instances.get("reference")!.connected = false;
  await act(async () => { await hook.value().refresh(); });
  assert.equal(hook.refreshes(), before + 1);
});

test("offline, recording and unavailable SDK states cannot change physical connections", async t => {
  const service = fakeService(t);
  const hook = await mountHook(t, { online: false });
  const input: SdkConnectionInput = { instance_id: "sensor", product: "hand-pad", path: "COM_TEST" };
  await act(async () => {
    await assert.rejects(hook.value().connect(input), /离线/);
    await assert.rejects(hook.value().disconnect("sensor"), /离线/);
    await assert.rejects(hook.value().scanPorts(), /离线/);
  });
  assert.equal(service.calls.length, 0);
  await hook.update({ online: true, recording: true });
  await act(async () => {
    await assert.rejects(hook.value().connect(input), /录制期间/);
    await assert.rejects(hook.value().disconnect("sensor"), /录制期间/);
    await assert.rejects(hook.value().scanPorts(), /录制期间/);
  });
  await hook.update({ recording: false });
  service.setLoaded(false);
  await act(async () => {
    await hook.value().refresh();
    await assert.rejects(hook.value().connect(input), /SDK 尚未加载/);
  });
  assert.equal(service.calls.some(call => call.method === "POST" || call.route === "/api/sdk/ports"), false);
});

test("a second click cannot start another connection for the same card", async t => {
  const service = fakeService(t);
  const hook = await mountHook(t);
  const response = deferred<Response>();
  service.intercept(call => call.route === "/api/sdk/connect" ? response.promise : undefined);
  let connecting!: Promise<SdkInstanceInfo>;
  await act(async () => { connecting = hook.value().connect({ instance_id: "sensor", product: "mock" }); });
  assert.deepEqual(hook.value().busyIds, ["sensor"]);
  await act(async () => {
    await assert.rejects(hook.value().connect({ instance_id: "sensor", product: "mock" }), /正在进行/);
    await assert.rejects(hook.value().disconnect("sensor"), /正在进行/);
  });
  assert.equal(service.calls.filter(call => call.method === "POST").length, 1);
  const connected = instance({ instance_id: "sensor", product: "mock" });
  service.instances.set("sensor", connected);
  await act(async () => { response.resolve(service.json(connected)); await connecting; });
  assert.equal(hook.value().instances[0].connected, true);
  assert.deepEqual(hook.value().busyIds, []);
});

test("a delayed status response cannot erase a newly connected sensor", async t => {
  const service = fakeService(t);
  const hook = await mountHook(t);
  const delayed = deferred<Response>();
  const oldSnapshot = service.snapshot();
  let holdNextInfo = true;
  service.intercept(call => {
    if (call.route === "/api/sdk/info" && holdNextInfo) { holdNextInfo = false; return delayed.promise; }
    return undefined;
  });
  let refreshing!: Promise<void>, connecting!: Promise<SdkInstanceInfo>;
  await act(async () => {
    refreshing = hook.value().refresh();
    connecting = hook.value().connect({ instance_id: "new-sensor", product: "mock" });
  });
  await act(async () => {
    delayed.resolve(service.json(oldSnapshot));
    await Promise.all([refreshing, connecting]);
  });
  assert.equal(hook.value().instances.find(item => item.instance_id === "new-sensor")?.connected, true);
  assert.ok(service.calls.filter(call => call.route === "/api/sdk/info").length >= 3,
    "the stale response is followed by a current snapshot");
});

test("leaving the workspace cancels pending requests and clears the next status poll", async t => {
  const service = fakeService(t);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const polls = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = originalSetTimeout(handler, delay, ...args);
    if (delay === 2000) polls.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    polls.delete(timer); originalClearTimeout(timer);
  }) as typeof clearTimeout;
  t.after(() => { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; });
  const hook = await mountHook(t, {}, true);
  assert.equal(polls.size, 1, "StrictMode still leaves only one polling timer");
  const delayed = deferred<Response>();
  service.intercept(call => call.route === "/api/sdk/info" ? delayed.promise : undefined);
  let pending!: Promise<unknown>;
  await act(async () => { pending = hook.value().refresh().catch(error => error); });
  const signal = service.calls.at(-1)?.signal;
  const refreshes = hook.refreshes();
  await hook.unmount();
  assert.equal(signal?.aborted, true);
  assert.equal(polls.size, 0);
  assert.equal((await pending as Error).name, "AbortError");
  delayed.resolve(service.json(service.snapshot()));
  await Promise.resolve();
  assert.equal(hook.refreshes(), refreshes);
});

test("new product options reach the SDK and readiness changes refresh capture descriptors once", async t => {
  const service = fakeService(t);
  const hook = await mountHook(t);
  await act(async () => {
    await hook.value().connect({ instance_id: "body", product: "body", path: "COM_BODY" });
    await hook.value().connect({ instance_id: "foot", product: "insole", path: " COM_FOOT ", side: "right", protocol: "8bit", baudRate: 1500000 });
    await hook.value().connect({ instance_id: "default-foot", product: "insole", path: "COM_DEFAULT", side: "left" });
  });
  assert.deepEqual(service.calls.filter(c => c.route === "/api/sdk/connect").map(c => c.body), [
    { instance_id: "body", product: "body", path: "COM_BODY" },
    { instance_id: "foot", product: "insole", path: "COM_FOOT", side: "right", protocol: "8bit", baudRate: 1500000 },
    { instance_id: "default-foot", product: "insole", path: "COM_DEFAULT", side: "left", protocol: "12bit", baudRate: 921600 },
  ]);
  service.instances.get("foot")!.ready = false;
  await act(async () => { await hook.value().refresh(); });
  const before = hook.refreshes();
  service.instances.get("foot")!.ready = true;
  await act(async () => { await hook.value().refresh(); });
  assert.equal(hook.refreshes(), before + 1, "first mapped frame publishes new schemas");
  service.instances.get("foot")!.frames = 100;
  await act(async () => { await hook.value().refresh(); });
  assert.equal(hook.refreshes(), before + 1);
  const posted = service.calls.filter(c => c.route === "/api/sdk/connect").length;
  await act(async () => {
    await assert.rejects(hook.value().connect({ instance_id: "invalid-side", product: "insole", path: "COM_X" }), /左右脚/);
    await assert.rejects(hook.value().connect({ instance_id: "invalid-protocol", product: "insole", path: "COM_X", side: "left", protocol: "auto" as never }), /格式/);
    await assert.rejects(hook.value().connect({ instance_id: "invalid-baud", product: "insole", path: "COM_X", side: "left", baudRate: 1000000 as never }), /波特率/);
  });
  assert.equal(service.calls.filter(c => c.route === "/api/sdk/connect").length, posted);
});

test("glove protocol choice is explicit and independent of insole firmware options", async t => {
  const service = fakeService(t);
  const hook = await mountHook(t);
  await act(async () => {
    await hook.value().connect({ instance_id: "legacy-hand", product: "glove", path: "COM_GLOVE", side: "left",
      gloveProtocol: "full-packet", protocol: "8bit", baudRate: 1500000 });
    await hook.value().connect({ instance_id: "shoe", product: "insole", path: "COM_SHOE", side: "right",
      gloveProtocol: "full-packet" });
  });
  assert.deepEqual(service.calls.filter(c => c.route === "/api/sdk/connect").map(c => c.body), [
    { instance_id: "legacy-hand", product: "glove", path: "COM_GLOVE", side: "left", gloveProtocol: "full-packet" },
    { instance_id: "shoe", product: "insole", path: "COM_SHOE", side: "right", protocol: "12bit", baudRate: 921600 },
  ]);
  assert.equal(hook.value().instances.find(item => item.instance_id === "legacy-hand")?.protocol, "full-packet");
  await act(async () => {
    await assert.rejects(hook.value().connect({ instance_id: "invalid-hand", product: "glove", path: "COM_BAD",
      side: "left", gloveProtocol: "12bit" as never }), /手套协议/);
  });
  assert.equal(service.calls.filter(c => c.route === "/api/sdk/connect").length, 2);
});
