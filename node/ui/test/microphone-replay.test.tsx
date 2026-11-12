import test from "node:test";
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
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("real microphone media replays as audible WAV with its own download and shares global play, speed and pause", async t => {
  const originalFetch = globalThis.fetch;
  const microphone = { id: "microphone-m-test", name: "DroidCam Audio", kind: "audio", sample_rate: 48000,
    channels: 1, mime_type: "audio/wav", url: "/api/files/session-test/microphone-m-test.wav", offset_s: 0, duration_s: 8 };
  const camera = { id: "camera-c-test", name: "DroidCam Video", kind: "camera", mime_type: "video/webm",
    url: "/api/files/session-test/camera-c-test.webm", offset_s: 0, duration_s: 8 };
  globalThis.fetch = (async input => String(input).includes("/replay?")
    ? json({ session_id: "session-test", time_s: 0, duration_s: 10, streams: {}, media_streams: [microphone, camera] })
    : json({ schema_version: 1, session_id: "session-test", revision: 0, experiment: emptyExperiment(), labels: [], annotations: [], history: [] })) as typeof fetch;
  const session = { id: "session-test", name: "合成音视频回放", duration_s: 10, bytes_written: 1000,
    status: "complete", streams: [], media_streams: [microphone, camera] } as unknown as Session;
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(<SessionReplay session={session} onClose={() => {}} onExport={() => {}} />));
  const audio = element.querySelector("audio")!;
  assert.ok(audio, "WAV must have a native audio player, not a black video tile");
  assert.equal(element.querySelectorAll("audio").length, 1);
  assert.equal(element.querySelectorAll("video").length, 1);
  assert.equal(audio.muted, false);
  assert.equal(audio.controls, true);
  assert.equal(audio.getAttribute("src"), microphone.url);
  const download = element.querySelector('a[download][href$=".wav"]');
  assert.equal(download?.textContent, "下载 WAV");
  assert.match(element.textContent ?? "", /48,?000 Hz/);
  await act(async () => audio.dispatchEvent(new dom.window.Event("loadedmetadata")));
  assert.equal(plays.includes(audio), false, "opening a recording must not autoplay sound");
  await act(async () => (element.querySelector('[aria-label="播放录制"]') as HTMLButtonElement).click());
  assert.equal(plays.includes(audio), true);
  const speed = element.querySelector('[aria-label="回放速度"]') as HTMLSelectElement;
  await act(async () => { speed.value = "2"; speed.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  assert.equal(audio.playbackRate, 2);
  const pauseCount = pauses.filter(media => media === audio).length;
  await act(async () => (element.querySelector('[aria-label="暂停回放"]') as HTMLButtonElement).click());
  assert.ok(pauses.filter(media => media === audio).length > pauseCount);
});
