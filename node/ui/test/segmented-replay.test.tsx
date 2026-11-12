import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { SessionReplay } from "../src/SessionReplay";
import { emptyExperiment } from "../src/workflow";
import type { Session } from "../src/types";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const plays: HTMLMediaElement[] = [], pauses: HTMLMediaElement[] = [];
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "play", { value: async function (this: HTMLMediaElement) { plays.push(this); } });
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "pause", { value: function (this: HTMLMediaElement) { pauses.push(this); } });
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("incomplete replay uses one audio element across segment boundaries and seeks, preserves gaps and isolates missing streams", async t => {
  const oldFetch = globalThis.fetch;
  const audioMedia = { id: "microphone-room", name: "Room audio", kind: "audio", sample_rate: 48000,
    channels: 1, mime_type: "audio/wav", url: "/files/first.wav", offset_s: 0, duration_s: 5,
    available: true, finalized: false, error: "尾段未收尾", segments: [
      { index: 0, url: "/files/first.wav", offset_s: 0, duration_s: .15 },
      { index: 1, url: "/files/second.wav", offset_s: .15, duration_s: 1.35 },
      { index: 2, offset_s: 1.5, duration_s: 1.5, error: "文件缺失" },
      { index: 3, url: "/files/last.wav.part", offset_s: 3, duration_s: 2 },
    ] };
  const missing = { id: "camera-missing", name: "Missing video", kind: "camera", url: null, available: false, error: "视频文件缺失", offset_s: null };
  const sensor = { id: "broken-imu", name: "Broken IMU", kind: "imu", channels: 6, sample_rate: 100 };
  const points = [["origin", 0], ["gap", 2], ["later", 3.5]].map(([id, at]) => ({ id, label_id: id, label_name: id,
    kind: "point", start_ns: String(Number(at) * 1e9), end_ns: String(Number(at) * 1e9), stream_ids: [], color: "#149d88", note: "" }));
  globalThis.fetch = (async input => String(input).includes("/replay?")
    ? json({ session_id: "segmented", time_s: 0, duration_s: 5, incomplete: true, validation: "on-demand-records",
      warnings: ["仅校验当前读取记录"], stream_errors: { "broken-imu": "记录已截断" },
      streams: { "broken-imu": { available: false, error: "记录已截断" } }, media_streams: [audioMedia, missing] })
    : json({ schema_version: 1, session_id: "segmented", revision: 0, experiment: emptyExperiment(), labels: [], annotations: points, history: [] })) as typeof fetch;
  const session = { id: "segmented", name: "不完整分段录音", duration_s: 5, bytes_written: 1000,
    status: "incomplete", finalized: true, error: "WAV limit", streams: [sensor], media_streams: [audioMedia, missing] } as unknown as Session;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch; });
  await act(async () => root.render(<SessionReplay session={session} onClose={() => {}} onExport={() => {}} />));
  const audio = host.querySelector("audio")!;
  const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  const metadata = async () => act(async () => audio.dispatchEvent(new dom.window.Event("loadedmetadata")));
  assert.ok(audio); assert.equal(host.querySelectorAll("audio").length, 1); assert.equal(host.querySelectorAll("video").length, 0);
  assert.match(host.textContent ?? "", /数据不完整/); assert.match(host.textContent ?? "", /记录已截断/); assert.match(host.textContent ?? "", /视频文件缺失/);
  assert.equal(audio.getAttribute("src"), "/files/first.wav"); assert.equal(audio.muted, false);
  assert.equal(host.querySelectorAll('.replay-audio-segments a[download]').length, 3);
  assert.equal(host.querySelector('[aria-label="下载第 3 段 WAV"]'), null, "a missing file must not get a fabricated download URL");
  await metadata(); await click('[aria-label="播放录制"]');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
  assert.equal(host.querySelector("audio"), audio); assert.equal(audio.getAttribute("src"), "/files/second.wav");
  const played = plays.length; await metadata(); assert.ok(plays.length > played, "new segment resumes after its own metadata arrives");
  assert.ok(audio.currentTime >= 0 && audio.currentTime < .5, "source time is relative to the active segment");
  await click('.timeline-annotation[title^="gap"]');
  assert.equal(audio.getAttribute("src"), "/files/second.wav");
  assert.match(host.textContent ?? "", /此时刻不在可播放的音频片段内/);
  const gapPlays = plays.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  await click('[aria-label="播放录制"]'); assert.equal(plays.length, gapPlays, "missing interval never continues an adjacent segment");
  await click('.timeline-annotation[title^="later"]');
  assert.equal(host.querySelector("audio"), audio); assert.equal(audio.getAttribute("src"), "/files/last.wav.part");
  const latePlays = plays.length;
  await metadata(); assert.equal(audio.currentTime, .5);
  assert.equal(plays.length, latePlays, "seek leaves global playback paused");
  await click('.timeline-annotation[title^="origin"]'); await metadata();
  assert.equal(audio.getAttribute("src"), "/files/first.wav"); assert.equal(audio.currentTime, 0);
  assert.ok(pauses.includes(audio));
});

test("segments with unknown time mapping remain selectable native audio rather than using invented offsets", async t => {
  const oldFetch = globalThis.fetch;
  const media = { id: "mic-unknown", name: "Unknown timing", kind: "audio", offset_s: null,
    segments: [{ index: 0, url: "/one.wav", offset_s: null }, { index: 1, url: "/two.wav", offset_s: null }] };
  globalThis.fetch = (async input => String(input).includes("/replay?")
    ? json({ streams: {}, media_streams: [media], incomplete: true })
    : new Response(JSON.stringify({ error: "标注 JSON 损坏" }), { status: 400, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch; });
  await act(async () => root.render(<SessionReplay session={{ id: "unknown", status: "incomplete", duration_s: 10, media_streams: [media] } as unknown as Session} onClose={() => {}} onExport={() => {}} />));
  const audio = host.querySelector("audio")!, select = host.querySelector<HTMLSelectElement>('[aria-label="音频分段"]')!;
  assert.equal(audio.getAttribute("src"), "/one.wav"); assert.ok(audio.controls); assert.match(host.textContent ?? "", /缺少时间映射/);
  assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="播放录制"]')!.disabled, false, "annotation errors do not block main replay");
  await act(async () => { select.value = "1"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  assert.equal(host.querySelector("audio"), audio); assert.equal(audio.getAttribute("src"), "/two.wav");
});
