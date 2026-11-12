import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import App from "../src/App";
import { emptyExperiment } from "../src/workflow";
import type { Status } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { createRoot } = await import("react-dom/client");
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const idle: Status = { state: "idle", session_id: null, elapsed_s: 0, bytes_written: 0, queue_depth: 0, queue_capacity: 4096, dropped_records: 0, record_counts: {}, selected_ids: [] };
const pressure = { id: "sdk-s-fixture-pressure", name: "压力阵列", kind: "pressure", mode: "hardware", connected: true, sample_rate: 100, channels: 1, unit: "ADC", transport: "Serial", rows: 1, cols: 1 };
const findButton = (host: HTMLElement, text: string) => {
  const found = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.trim() === text);
  assert.ok(found, `missing button ${text}`); return found;
};
function commonResponse(path: string) {
  if (path === "/api/devices") return json({ devices: [pressure] });
  if (path === "/api/sdk/info") return json({ loaded: true, connected: false, instances: [{ instance_id: "s-fixture", loaded: true,
    connected: true, has_device: true, ready: true, product: "hand-pad", path: "COM_TEST", stream_ids: [pressure.id] }], version: "test" });
  if (path === "/api/sdk/ports") return json({ ports: [] });
  if (path === "/api/sessions") return json({ sessions: [] });
  if (path === "/api/export/formats") return json({ formats: [] });
  if (path === "/api/export/jobs") return json({ jobs: [] });
  if (path === "/api/preview") return json({ timestamp_s: 1, pressure: { rows: 1, cols: 1, values: [10] } });
  if (path.endsWith("/annotations")) return json({ schema_version: 1, session_id: path.split("/")[3], revision: 0, experiment: emptyExperiment(), labels: [], annotations: [], history: [] });
  throw new Error(`Unexpected request ${path}`);
}

test("start/stop are single flight and a pre-start status response cannot revert the active recording", async t => {
  window.localStorage.clear();
  window.localStorage.setItem("synapse-node.workspace.v1", JSON.stringify({ version: 1, layout: "grid", cards: [{ id: "s-fixture", source: "sdk", product: "hand-pad", path: "COM_TEST", side: "left", view: "primary", expanded: false }] }));
  const previousFetch = globalThis.fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let current = { ...idle }, polls = 0, starts = 0, stops = 0;
  let resolveOld: ((value: Response) => void) | null = null;
  const stalePoll = new Promise<Response>(resolve => { resolveOld = resolve; });
  let stopBody: unknown;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/status") { polls++; return polls === 2 ? stalePoll : json(current); }
    if (path === "/api/sessions/start") {
      starts++; current = { ...idle, state: "recording", session_id: "session-control-test", selected_ids: [pressure.id] };
      return json({ session_id: current.session_id, status: current });
    }
    if (path === "/api/sessions/stop") {
      stops++; stopBody = JSON.parse(String(init?.body)); current = { ...idle };
      return json({ status: current, session: { id: "session-control-test", name: "test", status: "complete", duration_s: 1, started_at: "2026-11-04T00:00:00Z" } });
    }
    return commonResponse(path);
  }) as typeof fetch;
  t.after(async () => { resolveOld?.(json(idle)); await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; window.localStorage.clear(); });
  await act(async () => root.render(<App />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  assert.equal(polls, 2);
  await act(async () => { const start = findButton(host, "开始采集"); assert.equal(start.disabled, false); start.click(); start.click(); });
  assert.equal(starts, 1);
  assert.ok(findButton(host, "停止并保存"));
  await act(async () => { resolveOld?.(json(idle)); await stalePoll; });
  assert.ok(findButton(host, "停止并保存"), "old idle response must not undo start acknowledgement");
  await act(async () => { const stop = findButton(host, "停止并保存"); stop.click(); stop.click(); });
  assert.equal(stops, 1);
  assert.deepEqual(stopBody, { session_id: "session-control-test" });
  assert.ok(findButton(host, "开始采集"));
});

test("a page without the camera recorder cannot seal another page's active recording", async t => {
  window.localStorage.clear();
  const previousFetch = globalThis.fetch;
  let stops = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/status") return json({ ...idle, state: "recording", session_id: "session-other-page", selected_ids: ["camera-camera-one"] });
    if (path === "/api/sessions/stop") { stops++; return json({ status: idle }); }
    return commonResponse(path);
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; window.localStorage.clear(); });
  await act(async () => root.render(<App />));
  await act(async () => findButton(host, "停止并保存").click());
  assert.equal(stops, 0);
  assert.match(host.textContent || "", /请回到开始录制的页面/);
});

test("an orphaned camera recording can be closed with its matching session ID", async t => {
  window.localStorage.clear();
  const previousFetch = globalThis.fetch;
  let stopBody: unknown;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/status") return json({ ...idle, state: "recording", session_id: "session-orphan", selected_ids: ["camera-camera-one"], camera_stop_requires_owner: false });
    if (path === "/api/sessions/stop") {
      stopBody = JSON.parse(String(init?.body));
      return json({ status: idle, session: { id: "session-orphan", name: "orphan", status: "incomplete", duration_s: 1, started_at: "2026-11-04T00:00:00Z" } });
    }
    return commonResponse(path);
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; window.localStorage.clear(); });
  await act(async () => root.render(<App />));
  await act(async () => findButton(host, "停止并保存").click());
  assert.deepEqual(stopBody, { session_id: "session-orphan" });
});
