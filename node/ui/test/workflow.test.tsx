import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { defaultLabels, editedTimeNs, emptyExperiment, nsToSeconds, parseDraft, sameScope, secondsToNs, shortcutAllowed } from "../src/workflow";
import type { AnnotationDocument, AnnotationMutation } from "../src/workflow";
import { useAnnotations } from "../src/useAnnotations";
import { AnnotationPanel } from "../src/AnnotationPanel";
import { LivePreview } from "../src/LivePreview";
import { startPreviewPolling } from "../src/preview";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { createRoot } = await import("react-dom/client");
const doc = (id = "session-test", revision = 0): AnnotationDocument => ({ schema_version: 1, session_id: id, revision, experiment: emptyExperiment(), labels: defaultLabels(), annotations: [], history: [] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("experiment storage is bounded, drops unknown fields and rejects duplicate shortcut ownership", () => {
  const parsed = parseDraft({ experiment: { subject: "P001", project: "研究", notes: "n".repeat(3000), tags: ["左手", 1], secret: "discard" }, labels: [defaultLabels()[0], { ...defaultLabels()[1], shortcut: "1" }, { ...defaultLabels()[2], id: "../bad" }] });
  assert.equal(parsed.experiment.subject, "P001");
  assert.equal(parsed.experiment.notes.length, 2000);
  assert.deepEqual(parsed.experiment.tags, ["左手"]);
  assert.equal("secret" in parsed.experiment, false);
  assert.equal(parsed.labels.length, 2);
  assert.equal(parsed.labels[1].shortcut, "");
});

test("note-only editing preserves original nanoseconds; explicit edits use session-relative seconds", () => {
  assert.equal(editedTimeNs("1234567891", "1.235", "1.235"), "1234567891");
  assert.equal(editedTimeNs("1234567891", "1.235", "1.400"), "1400000000");
  assert.equal(secondsToNs(12.3), "12300000000");
  assert.equal(nsToSeconds("12300000000"), 12.3);
  assert.throws(() => secondsToNs(-1));
  assert.throws(() => secondsToNs(Number.NaN));
  assert.equal(sameScope(["left", "right"], ["right", "left"]), true);
  assert.equal(sameScope([], ["left"]), false);
});

test("shortcuts work with button focus but never interrupt text editing or modified/repeated keys", () => {
  const base = { repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, target: document.createElement("button") };
  assert.equal(shortcutAllowed(base), true);
  for (const tag of ["input", "textarea", "select"]) assert.equal(shortcutAllowed({ ...base, target: document.createElement(tag) }), false);
  const editable = document.createElement("div"), child = document.createElement("span"); editable.setAttribute("contenteditable", ""); editable.append(child);
  assert.equal(shortcutAllowed({ ...base, target: child }), false);
  assert.equal(shortcutAllowed({ ...base, repeat: true }), false);
  assert.equal(shortcutAllowed({ ...base, ctrlKey: true }), false);
  assert.equal(shortcutAllowed({ ...base, isComposing: true }), false);
});

test("conflicting annotation edits refresh the document and never automatically replay the write", async t => {
  let state = doc(), posts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, options) => {
    if (options?.method === "POST") { posts++; state = doc("session-test", 2); return json({ error: "conflict" }, 409); }
    return json(state);
  }) as typeof fetch;
  let hook!: ReturnType<typeof useAnnotations>;
  function Harness() { hook = useAnnotations("session-test"); return null; }
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(<Harness />));
  await act(async () => assert.equal(await hook.mutate({ op: "mark", label_id: "contact" }), false));
  assert.equal(posts, 1);
  assert.equal(hook.document?.revision, 2);
  assert.match(hook.error, /最新版本/);
});

test("a lost annotation response reads actual server state without duplicating the event", async t => {
  let state = doc(), posts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, options) => {
    if (options?.method === "POST") { posts++; state = { ...doc("session-test", 1), annotations: [{ id: "saved-on-server", label_id: "contact", label_name: "接触", color: "#25866b", kind: "point", start_ns: "1000000000", end_ns: "1000000000", stream_ids: [], note: "", source: "live", created_at: "", updated_at: "" }] }; throw new Error("connection lost"); }
    return json(state);
  }) as typeof fetch;
  let hook!: ReturnType<typeof useAnnotations>;
  function Harness() { hook = useAnnotations("session-test"); return null; }
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(<Harness />));
  await act(async () => assert.equal(await hook.mutate({ op: "mark", label_id: "contact" }), false));
  assert.equal(posts, 1);
  assert.equal(hook.document?.annotations[0].id, "saved-on-server");
  assert.match(hook.error, /最新标注记录/);
});

test("an open interval on one sensor is not ended when marking another scope", async t => {
  const state = doc(); state.annotations.push({ id: "left-open", label_id: "grasp", label_name: "抓握", color: "#b37b39", kind: "interval", start_ns: "1000000000", end_ns: null, stream_ids: ["left"], note: "", source: "live", created_at: "", updated_at: "" });
  const mutations: AnnotationMutation[] = [];
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); });
  await act(async () => root.render(<AnnotationPanel document={state} live busy={false} error="" streams={[{ id: "left", name: "左手" }, { id: "right", name: "右手" }]} cursor={2} duration={2} onSettings={() => {}} onMutate={async input => { mutations.push(input); return true; }} />));
  const select = element.querySelector('select[aria-label="新标签作用范围"]') as HTMLSelectElement;
  await act(async () => { select.value = "right"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await act(async () => (element.querySelector('button[aria-label="开始抓握"]') as HTMLButtonElement).click());
  assert.equal(mutations[0].op, "begin");
  assert.deepEqual(mutations[0].stream_ids, ["right"]);
  assert.equal(element.textContent?.includes("结束此区间"), true);
});

test("recorded preview never subscribes to live data and clears a missing replay frame", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => json({ timestamp_s: 88, streams: { pressure: { timestamp_s: 88, pressure: { rows: 1, cols: 1, values: [999] } } } })) as typeof fetch;
  const device = { id: "pressure", kind: "pressure" as const, name: "压力", connected: true, mode: "hardware", transport: "Serial", sample_rate: 1, channels: 1, rows: 1, cols: 1, unit: "ADC" };
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  let stop = () => {};
  t.after(async () => { stop(); await act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(<LivePreview device={device} enabled connected paused={false} snapshot={{ timestamp_s: 1, pressure: { rows: 1, cols: 1, values: [12] } }} />));
  await act(async () => { stop = startPreviewPolling(10000, () => {}); });
  assert.match(element.textContent ?? "", /12\.0/);
  assert.doesNotMatch(element.textContent ?? "", /999/);
  await act(async () => root.render(<LivePreview device={device} enabled connected paused={false} snapshot={null} />));
  assert.match(element.textContent ?? "", /此时刻尚无已保存数据/);
});

test("older annotations remain reachable for editing beyond the initial 100 rows", async t => {
  const state = doc();
  state.annotations = Array.from({ length: 105 }, (_, index) => ({ id: `a-${index}`, label_id: "contact", label_name: `标注${index}`, color: "#25866b", kind: "point" as const, start_ns: secondsToNs(index), end_ns: secondsToNs(index), stream_ids: [], note: "", source: "review", created_at: "", updated_at: "" }));
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); });
  await act(async () => root.render(<AnnotationPanel document={state} live={false} busy={false} error="" streams={[]} cursor={0} duration={120} onSettings={() => {}} onMutate={async () => true} />));
  assert.equal(element.querySelector('button[aria-label="编辑标注标注0"]'), null);
  const more = Array.from(element.querySelectorAll("button")).find(button => button.textContent?.startsWith("显示更早"));
  assert.ok(more);
  await act(async () => more.click());
  assert.ok(element.querySelector('button[aria-label="编辑标注标注0"]'));
});
