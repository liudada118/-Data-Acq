import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { ContinuityReport, continuityDownloadName } from "../src/ContinuityReport";
import type { ContinuityData, ContinuityJob, ContinuityStream } from "../src/continuity-types";
import type { Session } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value() { this.setAttribute("open", ""); } });
const { createRoot } = await import("react-dom/client");
const session: Session = { id: "session-short", name: "抓握实验 / 左右手", started_at: "2026-11-05T08:14:00.201Z",
  duration_s: 67, bytes_written: 1000, record_count: 3, status: "complete", finalized: true, device_ids: ["left-pressure"], source: "hardware" };
const stream = (patch: Partial<ContinuityStream> = {}): ContinuityStream => ({ id: "left-pressure", name: "手套", sensor_label: "左手 · 触觉手套 · 压力",
  kind: "pressure", time_basis: "host_receive", available: true, records: 3, samples: 3, interval_count: 2, mean_hz: 10,
  p50_interval_ms: 5, p95_interval_ms: 195, p99_interval_ms: 195, max_gap_ms: 195, max_gap_time_s: .2, gaps_over_threshold: 1,
  sequence_gap_events: 0, sequence_missing_records: "0", duplicate_sequences: 0, backward_sequences: 0, backward_timestamps: 0,
  duplicate_timestamps: 0, source_bytes: 116, validated_bytes: 116, first_time_s: 0, last_time_s: .2, completion: "complete", error: null,
  timeline: [{ start_s: 0, end_s: 1, interval_count: 2, gaps: 1, max_gap_ms: 195, sequence_gap_events: 0, backward_timestamps: 0 }],
  anomalies: [{ type: "gap", time_s: .2, interval_ms: 195, sequence: "2" }], anomalies_total: 1, anomalies_truncated: false, ...patch });
const report = (patch: Partial<ContinuityData> = {}): ContinuityData => ({ session_id: session.id, threshold_ms: 100, source_status: "complete",
  checked_at: "2026-11-06T08:00:00Z", duration_s: 67, warnings: [], quantile_method: "bounded histogram", streams: [stream()], media_streams: [], ...patch });
const job = (patch: Partial<ContinuityJob> = {}): ContinuityJob => ({ id: "job-one", session_id: session.id, threshold_ms: 100, status: "running", progress: .5,
  scanned_bytes: 58, total_bytes: 116, current_stream_id: "left-pressure", created_at: "2026-11-06T08:00:00Z", completed_at: null, error: null, ...patch });
const response = (value: ContinuityJob | null) => new Response(JSON.stringify({ job: value }), { status: 200, headers: { "Content-Type": "application/json" } });
const button = (host: HTMLElement, label: string) => { const item = [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === label); assert.ok(item, label); return item; };
async function mount(t: test.TestContext, props: Partial<Parameters<typeof ContinuityReport>[0]> = {}) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ContinuityReport session={session} onClose={() => {}} {...props} />));
  return { host, root };
}
function mockFetch(t: test.TestContext, handle: (path: string, options?: RequestInit) => Promise<Response>) {
  const previous = globalThis.fetch;
  globalThis.fetch = ((input, options) => handle(String(input), options)) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
}

test("opening a long recording only reads status; explicit start is guarded from duplicate clicks", async t => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  mockFetch(t, async (path, options) => { calls.push({ path, method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : null }); return response(options?.method === "POST" ? job() : null); });
  const { host } = await mount(t, { session: { ...session, duration_s: 44752 } });
  assert.equal(calls.length, 1); assert.equal(calls[0].method, "GET");
  assert.match(host.textContent ?? "", /不是行业标准/); assert.match(host.textContent ?? "", /还没有这段录制/);
  await act(async () => { button(host, "开始检查").click(); button(host, "开始检查").click(); });
  assert.equal(calls.filter(item => item.method === "POST").length, 1);
  assert.deepEqual(calls[1].body, { threshold_ms: 100 });
  assert.ok(host.querySelector("progress")); assert.ok(button(host, "取消检查"));
});

test("existing results expose partial streams, unknown device loss and anomaly seek", async t => {
  const seeks: number[] = [];
  const result = report({ source_status: "incomplete", streams: [stream(), stream({ id: "right-pressure", sensor_label: "右手 · 触觉手套", completion: "partial", error: "Truncated payload", validated_bytes: 80 })] });
  mockFetch(t, async () => response(job({ status: "complete", progress: 1, report: result })));
  const { host } = await mount(t, { onSeek: value => seeks.push(value) });
  assert.equal(host.querySelectorAll(".continuity-stream").length, 2);
  assert.match(host.textContent ?? "", /仅检查可读前缀/); assert.match(host.textContent ?? "", /Truncated payload/);
  assert.match(host.textContent ?? "", /设备侧丢帧率未知/); assert.match(host.textContent ?? "", /未评判信号内容质量/);
  await act(async () => (host.querySelector('button[aria-label^="回放至"]') as HTMLButtonElement).click());
  assert.deepEqual(seeks, [.2]); assert.ok(button(host, "下载报告 JSON"));
  assert.doesNotMatch(host.textContent ?? "", /质量合格|硬件零丢帧/);
});

test("polling completes without starting another scan and cancellation is explicit", async t => {
  let current = job(); const posts: string[] = [];
  mockFetch(t, async (path, options) => {
    if (options?.method === "POST") { posts.push(path); current = job({ status: "cancelled" }); }
    return response(current);
  });
  const { host } = await mount(t);
  assert.ok(button(host, "取消检查"));
  await act(async () => { button(host, "取消检查").click(); button(host, "取消检查").click(); });
  assert.deepEqual(posts, [`/api/sessions/${session.id}/continuity/cancel`]);
  assert.match(host.textContent ?? "", /检查已取消/); assert.equal(host.querySelector("progress"), null);
});

test("a running scan is polled and transitions to the completed report", async t => {
  let reads = 0;
  mockFetch(t, async (_path, options) => { assert.equal(options?.method, "GET"); reads++; return response(reads === 1 ? job() : job({ status: "complete", progress: 1, report: report() })); });
  const { host } = await mount(t);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
  assert.equal(reads, 2); assert.equal(host.querySelector("progress"), null);
  assert.ok(button(host, "下载报告 JSON"));
});

test("media-only reports show unknown continuity and repeated timestamps are not labeled clean", async t => {
  const result = report({ streams: [], media_streams: [{ id: "video", name: "DroidCam Video", kind: "camera", available: true, declared_duration_s: 67 },
    { id: "audio", name: "手机麦克风", kind: "audio", available: false, error: "缺少第2段", missing_segments: 1, segment_gap_samples: "48000", segment_overlap_samples: "0" }] });
  let current = result;
  mockFetch(t, async () => response(job({ status: "complete", progress: 1, report: current })));
  const { host, root } = await mount(t);
  assert.equal(host.querySelectorAll(".continuity-media").length, 2);
  assert.match(host.textContent ?? "", /实际采集掉帧：未知/); assert.match(host.textContent ?? "", /没有可统计记录间隔/);
  assert.match(host.querySelector(".continuity-summary")?.textContent ?? "", /未检测/);
  current = report({ streams: [stream({ gaps_over_threshold: 0, duplicate_timestamps: 1 })] });
  await act(async () => root.render(<ContinuityReport session={{ ...session, id: "session-next" }} onClose={() => {}} />));
  assert.match(host.querySelector(".continuity-state")?.textContent ?? "", /发现时间或序号异常/);
});

test("report filename is readable, timestamped and safe on Windows", () => {
  const name = continuityDownloadName(session, 100);
  assert.match(name, /^抓握实验 _ 左右手_2026-11-05-16-14-00_时间连续性_100ms\.json$/);
  assert.doesNotMatch(name, /session-short|[<>:"/\\|?*]/);
  assert.ok(continuityDownloadName({ name: "🟢".repeat(200), started_at: "bad" }, .001).length < 255);
  assert.match(continuityDownloadName({ name: "CON", started_at: "bad" }, 1), /^录制_CON_/);
});

test("software discard remains independent from sequence loss and missing origins cannot seek", async t => {
  const result = report({ dropped_records: 104, dropped_batches: 104, source_error: "WAV size limit", source_status: "incomplete",
    streams: [stream({ time_origin: "first_record", seekable: false, sequence_missing_records: "5", first_time_s: null, last_time_s: null,
      max_gap_time_s: null, anomalies: [{ type: "gap", time_s: null, interval_ms: 195 }] })] });
  mockFetch(t, async () => response(job({ status: "complete", report: result })));
  const { host } = await mount(t, { onSeek: () => assert.fail("unknown recording origin must not seek") });
  const summary = host.querySelector(".continuity-summary")?.textContent ?? "";
  assert.match(summary, /录制时软件丢弃104 数据块/); assert.doesNotMatch(summary, /109|208/);
  assert.match(host.textContent ?? "", /录制起点未知/); assert.match(host.textContent ?? "", /WAV size limit/);
  assert.equal(host.querySelector('button[aria-label^="回放至"]'), null);
  assert.equal([...host.querySelectorAll("button")].some(item => item.textContent?.includes("定位最长间隔")), false);
});

test("a failed start must refresh job state before another attempt", async t => {
  let posts = 0;
  mockFetch(t, async (_path, options) => {
    if (options?.method === "POST") { posts++; throw new Error("network interrupted"); }
    return response(null);
  });
  const { host } = await mount(t);
  await act(async () => button(host, "开始检查").click());
  assert.equal(posts, 1); assert.equal(button(host, "开始检查").disabled, true);
  assert.match(host.textContent ?? "", /启动检查未确认/);
  await act(async () => button(host, "刷新任务状态").click());
  assert.equal(button(host, "开始检查").disabled, false);
});

test("a fully scanned file with manifest count mismatch is distinguished from a readable prefix", async t => {
  const result = report({ streams: [stream({ id: "full-file", sensor_label: "人体", completion: "partial", scan_complete: true, error: "记录数与清单不一致" }),
    stream({ id: "prefix", sensor_label: "左手", completion: "partial", scan_complete: false, validated_bytes: 80, error: "记录负载被截断" })] });
  mockFetch(t, async () => response(job({ status: "complete", report: result })));
  const { host } = await mount(t);
  const cards = host.querySelectorAll(".continuity-stream");
  assert.match(cards[0].querySelector(".continuity-state")?.textContent ?? "", /已检查全文件，清单不一致/);
  assert.doesNotMatch(cards[0].textContent ?? "", /仅检查可读前缀/);
  assert.match(cards[1].querySelector(".continuity-state")?.textContent ?? "", /仅检查可读前缀/);
});

test("report separates average rate, threshold interval share and missing application records", async t => {
  const result = report({ threshold_ms: 6, streams: [
    stream({ records: 10158850, interval_count: 10158849, mean_hz: 227, gaps_over_threshold: 3381913, p50_interval_ms: 3.27, p95_interval_ms: 7.03, p99_interval_ms: 8.84, max_gap_ms: 693.15 }),
    stream({ id: "body", sensor_label: "人体全身", records: 4345366, interval_count: 4345365, mean_hz: 97.1, gaps_over_threshold: 4275217 }),
  ] });
  mockFetch(t, async (_path, options) => { assert.equal(options?.method, "GET"); return response(job({ status: "complete", threshold_ms: 6, report: result })); });
  const { host } = await mount(t);
  const [glove, body] = host.querySelectorAll(".continuity-stream");
  assert.match(glove.textContent ?? "", /换算平均间隔 4.41 ms/);
  assert.match(glove.textContent ?? "", /占已统计间隔 33.29% · 不是丢帧率/);
  assert.match(glove.querySelector(".continuity-state")?.textContent ?? "", /^存在超阈间隔$/);
  assert.match(glove.textContent ?? "", /主机接收时刻，不能直接当作设备采样间隔/);
  assert.equal(glove.querySelector(".continuity-threshold-caution"), null);
  assert.match(body.querySelector(".continuity-threshold-caution")?.textContent ?? "", /6 ms 低于这一路约 10.3 ms/);
  assert.match(body.textContent ?? "", /98.39% · 不是丢帧率/);
});

test("unavailable interval statistics do not invent a percentage or average period", async t => {
  const result = report({ streams: [stream({ records: 1, interval_count: 0, mean_hz: null, gaps_over_threshold: 0 })] });
  mockFetch(t, async () => response(job({ status: "complete", report: result })));
  const { host } = await mount(t);
  const card = host.querySelector(".continuity-stream")!;
  assert.equal(card.querySelectorAll(".continuity-metric-note").length, 0);
  assert.doesNotMatch(card.textContent ?? "", /NaN|Infinity|换算平均间隔|占已统计间隔/);
});

test("recorded source quality remains distinct from application sequence and warns on partial indices or reversals", async t => {
  const quality: NonNullable<ContinuityStream["recorded_quality"]> = {
    scope: "recorded-frames", provenance: "manifest-snapshot", rescanned: false, validation: "not-rescanned",
    scan_record_count_matches: true, jpeg_decode_verified: false, observed_frames: 3,
    source_sequence_status: "partial", source_sequence_supported: true, source_indexed_frames: 2, source_unindexed_frames: 1,
    source_missing_frames: "0", source_gap_events: 0, source_duplicates: 0, source_reversals: 1,
    invalid_jpeg_frames: 1, jpeg_warning_frames: 2,
  };
  mockFetch(t, async () => response(job({ status: "complete", report: report({ streams: [stream({
    kind: "camera", encoding: "mjpeg", gaps_over_threshold: 0, sequence_missing_records: "0", recorded_quality_status: "available", recorded_quality: quality,
  })] }) })));
  const { host } = await mount(t);
  const card = host.querySelector(".continuity-stream")!;
  assert.match(card.querySelector(".continuity-state")!.textContent!, /录制期发现源帧或 JPEG 异常/);
  assert.match(card.textContent!, /应用序号缺失记录0/);
  assert.match(card.textContent!, /设备源序号缺口0/);
  assert.match(card.textContent!, /源序号重复 \/ 倒序0 \/ 1/);
  assert.match(card.textContent!, /JPEG 结构异常1/);
  assert.match(card.textContent!, /其中 1 帧未提供源序号/);
  assert.match(card.textContent!, /不能据此判断完整录制是否无丢帧/);
  assert.match(card.textContent!, /本次未重扫源序号或解码 JPEG/);
  assert.match(card.textContent!, /JPEG 结构正常不代表图像已成功解码/);
  assert.doesNotMatch(card.querySelector(".continuity-state")!.textContent!, /未发现/);
});

test("legacy or invalid source quality displays unknown instead of zero and RGB does not claim JPEG inspection", async t => {
  mockFetch(t, async () => response(job({ status: "complete", report: report({ streams: [
    stream({ id: "old", kind: "camera", encoding: "mjpeg", recorded_quality_status: "unavailable", recorded_quality: null }),
    stream({ id: "invalid", kind: "camera", encoding: "rgb8", recorded_quality_status: "invalid", recorded_quality: null }),
  ] }) })));
  const { host } = await mount(t);
  const [old, invalid] = host.querySelectorAll(".continuity-source-quality");
  assert.match(old.textContent!, /设备源序号缺口未提供/);
  assert.match(old.textContent!, /JPEG 结构异常未记录/);
  assert.match(old.textContent!, /未提供不等于零丢帧/);
  assert.match(invalid.textContent!, /源帧统计无效/);
  assert.doesNotMatch(invalid.textContent!, /JPEG 结构异常0|JPEG 结构异常/);
});
