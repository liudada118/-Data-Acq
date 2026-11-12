import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { RecoveryInspection } from "../src/RecoveryInspection";
import App from "../src/App";
import type { RecoveryReport } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value() { this.setAttribute("open", ""); } });
const { createRoot } = await import("react-dom/client");
const formats = [{ id: "json", label: "原始数据", available: true, description: "" }];
const report = (): RecoveryReport => ({ session_id: "incomplete-a", source_status: "incomplete", source_finalized: true,
  recovery: true, incomplete: true, checked_at: "2026-11-05T00:00:00Z", has_data: true, dropped_records: 2, error: "采集停止",
  warnings: ["文件结构自洽不代表信号质量合格"], streams: [{ id: "imu", name: "惯性传感器", kind: "imu", records: 2,
    samples: 2, payload_bytes: 8, start_s: 0, end_s: 1, observed_span_s: 1, nominal_sample_duration_s: .02,
    record_sequence_gaps: "1", error: null }], media_streams: [] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
  assert.ok(found, `missing button ${text}`); return found;
}

test("inspection requires opt-in, resets confirmation after recheck, and keeps a valid report on export failure", async t => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const exports: string[] = [], props = { report: report(), loading: false, error: "", exporting: false, formats,
    onRetry() {}, onExport(format: string) { exports.push(format); } };
  await act(async () => root.render(<RecoveryInspection {...props} />));
  assert.equal(button(host, "创建不完整数据包").disabled, true);
  assert.match(host.textContent ?? "", /观察跨度是首末记录时间之差/);
  await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await act(async () => button(host, "创建不完整数据包").click());
  assert.deepEqual(exports, ["json"]);
  await act(async () => root.render(<RecoveryInspection {...props} exportError="导出队列已满" />));
  assert.match(host.textContent ?? "", /已验证现存文件结构与计数/);
  assert.doesNotMatch(host.textContent ?? "", /检查未通过/);
  assert.equal(host.querySelectorAll("tbody tr").length, 1);
  await act(async () => root.render(<RecoveryInspection {...props} report={report()} />));
  assert.equal(button(host, "创建不完整数据包").disabled, true);
  await act(async () => root.render(<RecoveryInspection {...props} report={{ ...report(), has_data: false }} />));
  assert.match(host.textContent ?? "", /没有可导出的样本或媒体块/);
  assert.equal(button(host, "创建不完整数据包").disabled, true);
});

test("loading and failed structural checks never expose a recovery export action", async t => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const props = { report: null, loading: true, error: "", exporting: false, formats, onRetry() {}, onExport() {} };
  await act(async () => root.render(<RecoveryInspection {...props} />));
  assert.match(host.textContent ?? "", /正在快速检查/); assert.equal(host.querySelector('input[type="checkbox"]'), null);
  await act(async () => root.render(<RecoveryInspection {...props} loading={false} error="Truncated payload" />));
  assert.match(host.textContent ?? "", /原文件已保留/); assert.equal(host.querySelector('input[type="checkbox"]'), null);
  assert.ok(button(host, "重新检查"));
});

test("recording library opens a single read-only inspection and explicitly submits an incomplete job", async t => {
  localStorage.clear();
  const previousFetch = globalThis.fetch, requests: { path: string; body: unknown }[] = [];
  let resolveInspection!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveInspection = resolve; });
  const session = { id: "incomplete-a", name: "异常实验", started_at: "2026-11-05T00:00:00Z", duration_s: 2,
    status: "incomplete", finalized: true, source: "hardware", device_ids: ["imu"], bytes_written: 80, streams: [] };
  globalThis.fetch = (async (input, options) => {
    const path = String(input), body = options?.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ path, body });
    if (path.endsWith("/recovery")) return pending;
    if (path === "/api/export/jobs" && options?.method === "POST") return json({ id: "job-a", session_id: session.id, recovery: true,
      format: "json", status: "pending", progress: 0, filename: "incomplete-a-json-incomplete.zip" });
    if (path === "/api/export/jobs") return json({ jobs: [] });
    if (path === "/api/export/formats") return json({ formats });
    if (path === "/api/sessions") return json({ sessions: [session] });
    if (path === "/api/status") return json({ state: "idle", session_id: null, elapsed_s: 0, bytes_written: 0,
      queue_depth: 0, queue_capacity: 4096, dropped_records: 0, record_counts: {}, selected_ids: [] });
    if (path === "/api/devices") return json({ devices: [] });
    if (path === "/api/sdk/info") return json({ loaded: false, connected: false, instances: [] });
    if (path === "/api/sdk/ports") return json({ ports: [] });
    if (path === "/api/preview") return json({ timestamp_s: 0, streams: {} });
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { resolveInspection(json(report())); await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; localStorage.clear(); });
  await act(async () => root.render(<App />));
  await act(async () => (host.querySelector('button[aria-label="录制记录"]') as HTMLButtonElement).click());
  assert.match(host.textContent ?? "", /数据不完整/);
  await act(async () => { const inspect = button(host, "检查异常录制"); inspect.click(); inspect.click(); });
  assert.equal(requests.filter(item => item.path.endsWith("/recovery")).length, 1);
  assert.deepEqual(requests.find(item => item.path.endsWith("/recovery"))?.body, { allow_incomplete: true });
  assert.match(host.textContent ?? "", /正在快速检查/);
  await act(async () => resolveInspection(json(report())));
  assert.equal(button(host, "创建不完整数据包").disabled, true);
  await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await act(async () => { const exportButton = button(host, "创建不完整数据包"); exportButton.click(); exportButton.click(); });
  const submissions = requests.filter(item => item.path === "/api/export/jobs" && item.body);
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].body, { session_id: session.id, format: "json", recovery: true });
  assert.match(host.textContent ?? "", /不完整数据包/);
});

test("metadata-only inspection labels unverified counts and unknown ranges while retaining per-stream failures", async t => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const value: RecoveryReport = { ...report(), inspection_mode: "metadata", fully_scanned: false,
    streams: [true, false].map((available, index) => ({ ...report().streams[0], id: `stream-${index}`, available,
      counts_verified: false, verified: false, start_s: null, end_s: null, observed_span_s: null,
      record_sequence_gaps: null, error: available ? null : "文件缺失" })) };
  await act(async () => root.render(<RecoveryInspection report={value} loading={false} error="" exporting={false} formats={formats} onRetry={() => {}} onExport={() => {}} />));
  assert.match(host.textContent ?? "", /尚未逐条验证/); assert.match(host.textContent ?? "", /清单计数/);
  assert.match(host.textContent ?? "", /观察跨度未检查/); assert.match(host.textContent ?? "", /文件缺失/);
  assert.equal(host.querySelectorAll("tbody tr").length, 2);
  assert.doesNotMatch(host.textContent ?? "", /已验证现存文件结构与计数/);
});

test("stopped incomplete recordings can replay and submit recovery exports without first inspecting the whole recording", async t => {
  localStorage.clear();
  const previousFetch = globalThis.fetch, requests: { path: string; body: unknown }[] = [];
  const stopped = { id: "partial-stopped", name: "长录制已停止", started_at: "2026-11-06T00:00:00Z", duration_s: 40000,
    status: "incomplete", finalized: true, error: "WAV limit", source: "hardware", device_ids: [], bytes_written: 36000000000, streams: [] };
  const ongoing = { ...stopped, id: "partial-open", name: "尚未停止", finalized: false };
  globalThis.fetch = (async (input, options) => {
    const path = String(input), body = options?.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ path, body });
    if (path === "/api/export/jobs") return json(body ? { id: "direct-job", session_id: stopped.id, format: "json", recovery: true, status: "pending", progress: 0 } : { jobs: [] });
    if (path === "/api/export/formats") return json({ formats });
    if (path === "/api/sessions") return json({ sessions: [stopped, ongoing] });
    if (path === "/api/status") return json({ state: "idle", session_id: null, elapsed_s: 0, bytes_written: 0, queue_depth: 0, queue_capacity: 4096, dropped_records: 0, record_counts: {}, selected_ids: [] });
    if (path === "/api/devices") return json({ devices: [] });
    if (path === "/api/sdk/info") return json({ loaded: false, connected: false, instances: [] });
    if (path === "/api/sdk/ports") return json({ ports: [] });
    if (path === "/api/preview") return json({ timestamp_s: 0, streams: {} });
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; localStorage.clear(); });
  await act(async () => root.render(<App />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="录制记录"]')!.click());
  assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="回放与标注长录制已停止"]')!.disabled, false);
  assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="回放与标注尚未停止"]')!.disabled, true);
  const row = host.querySelector('[aria-label="回放与标注长录制已停止"]')!.closest("tr")!;
  await act(async () => [...row.querySelectorAll("button")].find(item => item.textContent?.trim() === "导出")!.click());
  assert.equal(host.querySelector<HTMLSelectElement>("#export-session")!.value, stopped.id);
  assert.equal([...host.querySelectorAll<HTMLOptionElement>("#export-session option")].some(option => option.value === ongoing.id), false);
  await act(async () => host.querySelector<HTMLInputElement>('input[name="export-format"][value="json"]')!.click());
  assert.equal(button(host, "创建导出任务").disabled, true);
  await act(async () => host.querySelector<HTMLInputElement>('.export-create .recovery-confirmation input')!.click());
  assert.equal(button(host, "创建导出任务").disabled, false);
  await act(async () => button(host, "创建导出任务").click());
  assert.equal(requests.some(item => item.path.endsWith("/recovery")), false);
  assert.deepEqual(requests.find(item => item.path === "/api/export/jobs" && item.body)?.body,
    { session_id: stopped.id, format: "json", recovery: true });
});
