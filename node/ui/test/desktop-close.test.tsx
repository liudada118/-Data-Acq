import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import App from "../src/App";
import { useDesktopBeforeClose } from "../src/desktop";
import type { DesktopBeforeCloseHandler, DesktopCloseResult } from "../src/desktop";
import { emptyExperiment } from "../src/workflow";
import type { Status } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { createRoot } = await import("react-dom/client");
const idle: Status = { state: "idle", session_id: null, elapsed_s: 0, bytes_written: 0, queue_depth: 0,
  queue_capacity: 4096, dropped_records: 0, record_counts: {}, selected_ids: [] };
const pressure = { id: "sdk-s-fixture-pressure", name: "压力阵列", kind: "pressure", mode: "hardware", connected: true,
  sample_rate: 100, channels: 1, unit: "ADC", transport: "Serial", rows: 1, cols: 1 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const session = (status = "complete") => ({ id: "session-owned", name: "Fixture recording", status,
  duration_s: 1, started_at: "2026-11-05T00:00:00Z" });
const recording = (id = "session-owned"): Status => ({ ...idle, state: "recording", session_id: id, selected_ids: [pressure.id] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function bridge() {
  const handlers = new Set<DesktopBeforeCloseHandler>();
  let subscriptions = 0;
  window.synapseDesktop = { onBeforeClose(handler) {
    subscriptions++; handlers.add(handler); return () => { handlers.delete(handler); };
  } };
  return { handlers, subscriptions: () => subscriptions, request() {
    assert.equal(handlers.size, 1, "exactly one desktop handler owns the close request");
    return [...handlers][0]();
  } };
}
interface Call { path: string; body?: Record<string, unknown> }
async function fixture(t: TestContext, initial: Status = idle) {
  window.localStorage.clear();
  window.localStorage.setItem("synapse-node.workspace.v1", JSON.stringify({ version: 1, layout: "grid",
    cards: [{ id: "s-fixture", source: "sdk", product: "hand-pad", path: "COM_TEST", side: "left", view: "primary", expanded: false }] }));
  const previousFetch = globalThis.fetch;
  const previousBridge = window.synapseDesktop;
  const desktop = bridge();
  let current = { ...initial };
  const calls: Call[] = [];
  let interceptor: ((call: Call) => Response | Promise<Response> | undefined) | undefined;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    const call = { path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const override = interceptor?.(call);
    if (override) return override;
    if (path === "/api/status") return json(current);
    if (path === "/api/sessions/start") { current = recording(); return json({ session_id: current.session_id, status: current }); }
    if (path === "/api/sessions/stop") { current = { ...idle }; return json({ status: current, session: session() }); }
    if (path === "/api/devices") return json({ devices: [pressure] });
    if (path === "/api/sdk/info") return json({ loaded: true, connected: false, instances: [{ instance_id: "s-fixture", loaded: true,
      connected: true, has_device: true, ready: true, product: "hand-pad", path: "COM_TEST", stream_ids: [pressure.id] }], version: "fixture" });
    if (path === "/api/sdk/ports") return json({ ports: [] });
    if (path === "/api/sessions") return json({ sessions: [] });
    if (path === "/api/export/formats") return json({ formats: [] });
    if (path === "/api/export/jobs") return json({ jobs: [] });
    if (path === "/api/preview") return json({ timestamp_s: 1, pressure: { rows: 1, cols: 1, values: [10] } });
    if (path.endsWith("/annotations")) return json({ schema_version: 1, session_id: path.split("/")[3], revision: 0,
      experiment: emptyExperiment(), labels: [], annotations: [], history: [] });
    throw new Error(`Unexpected request in desktop UI fixture: ${path}`);
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch;
    window.synapseDesktop = previousBridge; window.localStorage.clear(); });
  await act(async () => root.render(<App />));
  return { calls, host, desktop, setStatus(value: Status) { current = value; },
    intercept(value?: typeof interceptor) { interceptor = value; },
    async start() {
      const start = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "开始采集");
      assert.ok(start); assert.equal(start.disabled, false);
      await act(async () => start.click());
    },
    async close() { let result!: DesktopCloseResult; await act(async () => { result = await desktop.request(); }); return result; },
    stops() { return calls.filter(call => call.path === "/api/sessions/stop"); },
  };
}

test("desktop subscription uses the latest callback, rejects duplicate close work, and unsubscribes", async t => {
  const desktop = bridge();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  t.after(async () => { if (mounted) await act(async () => root.unmount()); host.remove(); delete window.synapseDesktop; });
  function Harness({ handler }: { handler: DesktopBeforeCloseHandler }) { useDesktopBeforeClose(handler); return null; }
  await act(async () => root.render(<Harness handler={async () => ({ ok: false, message: "old" })} />));
  const pending = deferred<DesktopCloseResult>();
  await act(async () => root.render(<Harness handler={() => pending.promise} />));
  assert.equal(desktop.subscriptions(), 1);
  const first = desktop.request();
  assert.deepEqual(await desktop.request(), { ok: false, message: "正在确认退出，请稍候。" });
  pending.resolve({ ok: true }); assert.deepEqual(await first, { ok: true });
  await act(async () => root.unmount()); mounted = false;
  assert.equal(desktop.handlers.size, 0);
});

test("a confirmed idle desktop closes without writing to the capture service", async t => {
  const app = await fixture(t);
  assert.deepEqual(await app.close(), { ok: true });
  assert.equal(app.calls.some(call => call.body), false);
});

test("desktop waits for stop completion and a fresh idle status before accepting close", async t => {
  const app = await fixture(t); await app.start();
  const confirmation = deferred<Response>();
  let reads = 0;
  app.intercept(call => call.path === "/api/status" && ++reads === 2 ? confirmation.promise : undefined);
  let result!: Promise<DesktopCloseResult>;
  let resolved = false;
  await act(async () => { result = app.desktop.request().then(value => { resolved = true; return value; }); });
  assert.equal(app.stops().length, 1);
  assert.deepEqual(app.stops()[0].body, { session_id: "session-owned" });
  assert.equal(reads, 2);
  assert.equal(resolved, false, "a successful stop response is insufficient without the final GET");
  await act(async () => { confirmation.resolve(json(idle)); assert.deepEqual(await result, { ok: true }); });
});

test("a swallowed stop exception cannot approve close even when the server actually became idle", async t => {
  const app = await fixture(t); await app.start();
  app.intercept(call => {
    if (call.path === "/api/sessions/stop") { app.setStatus(idle); throw new Error("stop acknowledgement lost"); }
    return undefined;
  });
  const result = await app.close();
  assert.equal(result.ok, false);
  assert.match(result.message!, /stop acknowledgement lost/);
  const stopIndex = app.calls.indexOf(app.stops()[0]);
  assert.ok(app.calls.slice(stopIndex + 1).some(call => call.path === "/api/status"),
    "close must recheck status after the failed stop; background preview polling may also run");
  assert.equal(app.stops().length, 1);
});

test("incomplete saves are reported before a later idle close can succeed", async t => {
  const app = await fixture(t); await app.start();
  app.intercept(call => {
    if (call.path === "/api/sessions/stop") { app.setStatus(idle); return json({ status: idle, session: session("incomplete") }); }
    return undefined;
  });
  const result = await app.close();
  assert.equal(result.ok, false); assert.match(result.message!, /数据不完整/);
  assert.deepEqual(await app.close(), { ok: true });
  assert.equal(app.stops().length, 1);
});

test("another page's camera owner prevents desktop exit and receives no stop request", async t => {
  const app = await fixture(t, { ...recording("session-other-page"), selected_ids: ["camera-external"], camera_stop_requires_owner: true });
  const result = await app.close();
  assert.equal(result.ok, false); assert.match(result.message!, /另一个页面.*开始录制的页面/);
  assert.equal(app.stops().length, 0);
});

test("an external sensor-only recording is not automatically stopped when the desktop exits", async t => {
  const app = await fixture(t, recording("session-browser-sensors"));
  const result = await app.close();
  assert.equal(result.ok, false);
  assert.match(result.message!, /由其他页面发起.*原页面.*停止并保存/);
  assert.equal(app.stops().length, 0, "observing a sensor session does not grant ownership to the desktop");
});

test("a recording that changed during close verification is never stopped", async t => {
  const app = await fixture(t); await app.start();
  app.setStatus(recording("session-new"));
  const result = await app.close();
  assert.equal(result.ok, false); assert.match(result.message!, /会话已变化/);
  assert.equal(app.stops().length, 0);
});

test("a new session after stopping the owned session prevents exit without another stop", async t => {
  const app = await fixture(t); await app.start();
  app.intercept(call => {
    if (call.path === "/api/sessions/stop") { app.setStatus(recording("session-new")); return json({ status: idle, session: session() }); }
    return undefined;
  });
  const result = await app.close();
  assert.equal(result.ok, false); assert.match(result.message!, /另一段录制.*新会话未被停止/);
  assert.deepEqual(app.stops().map(call => call.body), [{ session_id: "session-owned" }]);
});

test("desktop close refuses an in-flight start and an unreachable status service", async t => {
  const app = await fixture(t);
  const starting = deferred<Response>();
  app.intercept(call => call.path === "/api/sessions/start" ? starting.promise : undefined);
  await app.start();
  const busyResult = await app.close();
  assert.equal(busyResult.ok, false); assert.match(busyResult.message!, /操作正在进行/);
  assert.equal(app.stops().length, 0);
  app.setStatus(recording());
  await act(async () => starting.resolve(json({ session_id: "session-owned", status: recording() })));
  app.intercept(call => { if (call.path === "/api/status") throw new Error("offline fixture"); return undefined; });
  const offlineResult = await app.close();
  assert.equal(offlineResult.ok, false); assert.match(offlineResult.message!, /无法确认采集已结束.*offline fixture/);
  assert.equal(app.stops().length, 0);
});
