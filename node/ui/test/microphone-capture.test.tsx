import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { useMicrophoneCapture } from "../src/useMicrophoneCapture";
import type { UseMicrophoneCaptureOptions } from "../src/microphone-types";
import { FakeAudioStream, installMicrophoneMediaFixture } from "./microphone-fixture";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
interface Call { route: string; body?: Record<string, unknown>; pcm?: ArrayBuffer; token: string | null;
  mime: string | null; keepalive?: boolean; signal?: AbortSignal | null }
function fixture() {
  const media = installMicrophoneMediaFixture();
  const previousFetch = globalThis.fetch;
  const calls: Call[] = [], totals = new Map<string, number>();
  let interceptor: ((call: Call) => Promise<Response> | undefined) | undefined;
  const json = (body: unknown = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const ack = (call: Call) => {
    const url = new URL(call.route, "http://fixture");
    const key = url.pathname + url.searchParams.get("session_id");
    const bytes = (totals.get(key) ?? 0) + call.pcm!.byteLength; totals.set(key, bytes);
    return json({ next_index: Number(url.searchParams.get("index")) + 1, payload_bytes: bytes,
      sample_count: bytes / 2, bytes_written: bytes + 44 });
  };
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: Call = { route: String(input), token: headers.get("X-Camera-Token"), mime: headers.get("Content-Type"),
      keepalive: init?.keepalive, signal: init?.signal,
      ...(init?.body instanceof ArrayBuffer ? { pcm: init.body } : { body: JSON.parse(String(init?.body ?? "{}")) }) };
    calls.push(call);
    assert.equal(init?.method, "POST");
    const override = interceptor?.(call);
    if (override) return override;
    if (call.route === "/api/cameras/register") return json({ token: `fixture-token-${call.body?.instance_id}-${calls.length}`,
      lease_timeout_ms: 20000, chunk_limit_bytes: 16777216 }, 201);
    if (call.route.includes("/chunks?")) return ack(call);
    if (/^\/api\/cameras\/[\w-]+\/(heartbeat|disconnect|error|finalize)$/.test(call.route)) return json();
    throw new Error(`Unexpected request in microphone fixture: ${call.route}`);
  }) as typeof fetch;
  return { ...media, calls, ack, json,
    intercept(value?: typeof interceptor) { interceptor = value; },
    chunks(id: string) { return calls.filter(call => call.route.startsWith(`/api/cameras/${id}/chunks?`)); },
    restore() { media.restore(); globalThis.fetch = previousFetch; },
  };
}
async function mountHook(t: TestContext, restore: () => void, overrides: Partial<UseMicrophoneCaptureOptions> = {}, strict = false) {
  let latest!: ReturnType<typeof useMicrophoneCapture>;
  let options: UseMicrophoneCaptureOptions = { online: true, recording: false, onDevicesChanged: async () => {}, ...overrides };
  let renders = 0;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  function Harness() { latest = useMicrophoneCapture(options); renders++; return null; }
  const render = () => root.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />);
  await act(async () => render());
  async function unmount() { if (mounted) { mounted = false; await act(async () => root.unmount()); host.remove(); } }
  t.after(async () => { await unmount(); restore(); });
  return { value: () => latest, renders: () => renders, unmount,
    async update(value: Partial<UseMicrophoneCaptureOptions>) { options = { ...options, ...value }; await act(async () => render()); } };
}
async function connectPair(hook: Awaited<ReturnType<typeof mountHook>>) {
  await act(async () => { await hook.value().connect("front", "fixture-microphone"); await hook.value().connect("side", "fixture-microphone"); });
}

test("microphone discovery is passive; explicit capture registers the AudioContext rate and keeps playback silent", async t => {
  const service = fixture();
  const hook = await mountHook(t, service.restore);
  assert.deepEqual(hook.value().devices, [{ deviceId: "fixture-microphone", label: "DroidCam Audio fixture" }]);
  await act(async () => { await hook.value().scan(); await assert.rejects(hook.value().connect("front"), /选择麦克风/); });
  assert.equal(service.constraints.length, 0);
  await act(async () => { await hook.value().connect("front", "fixture-microphone"); });
  assert.deepEqual(service.constraints[0], { video: false, audio: { deviceId: { exact: "fixture-microphone" },
    channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  assert.deepEqual(service.calls[0].body, { kind: "audio", instance_id: "front", label: "DroidCam Audio fixture",
    sample_rate: 48000, channels: 1, encoding: "pcm_s16le" });
  assert.equal(hook.value().connections.front.sampleRate, 48000, "the context may resample the track's 44.1kHz input");
  assert.equal("token" in hook.value().connections.front, false);
  assert.equal(service.contexts[0].gains[0].gain.value, 0);
  assert.equal(service.contexts[0].gains[0].connections.has(service.contexts[0].destination), true);
  assert.equal(hook.value().connections.front.analyser, service.contexts[0].analysers[0]);
  assert.deepEqual(service.contexts[0].modules, ["/audio/pcm-capture.worklet.js"]);
  await act(async () => { await hook.value().disconnect("front"); });
  assert.equal(service.streams[0].track.stops, 1);
  assert.equal(service.contexts[0].state, "closed");
  assert.deepEqual(hook.value().connections, {});
});

test("microphone permission failure is recoverable and a scan permission probe is always released", async t => {
  const service = fixture();
  service.setDevices([{ kind: "audioinput", deviceId: "", label: "" }]);
  service.setCapture(async () => { throw new DOMException("Permission denied", "NotAllowedError"); });
  const hook = await mountHook(t, service.restore);
  await act(async () => {
    await assert.rejects(hook.value().scan(), /未获麦克风权限/);
    await assert.rejects(hook.value().connect("front", "fixture-microphone"), /未获麦克风权限/);
  });
  assert.equal(service.calls.length, 0); assert.equal(service.contexts.length, 0);
  assert.equal(hook.value().scanning, false); assert.deepEqual(hook.value().busyIds, []);
  service.setCapture(async () => {
    service.setDevices([{ kind: "audioinput", deviceId: "fixture-microphone", label: "DroidCam Audio" }]);
    return new FakeAudioStream();
  });
  await act(async () => { await hook.value().scan(); });
  assert.deepEqual(service.constraints.at(-1), { video: false, audio: true });
  assert.equal(service.streams[0].track.stops, 1);
  assert.equal(hook.value().error, "");
});

test("two microphone lanes upload sequential PCM and stop only after tail-block ACK and upload drain", async t => {
  const service = fixture();
  const hook = await mountHook(t, service.restore);
  await connectPair(hook);
  await hook.update({ recording: true });
  await act(async () => {
    const sources = await hook.value().prepareRecording(["front", "side"]);
    assert.deepEqual(sources.map(source => [source.instance_id, source.mime_type]), [["front", "audio/wav"], ["side", "audio/wav"]]);
  });
  const [front, side] = service.nodes;
  assert.equal(front.messages.length, 0, "preparing does not start PCM capture");
  assert.equal(front.options.channelCount, 1);
  await act(async () => { await hook.value().startRecording("joint-session"); });
  assert.equal(hook.value().recordingSessionId(), "joint-session");
  const delayed = deferred<Response>();
  service.intercept(call => call.route.endsWith("front/chunks?session_id=joint-session&index=0") ? delayed.promise : undefined);
  const renders = hook.renders();
  await act(async () => { front.emitChunk(); front.emitChunk(); side.emitChunk(); });
  assert.equal(service.chunks("front").length, 1);
  assert.equal(service.chunks("side").length, 1);
  assert.equal(hook.renders(), renders, "PCM transfer does not update React state per block");
  front.autoStop = false;
  let stopping!: Promise<void>;
  await act(async () => { stopping = hook.value().stopRecording(); });
  assert.equal(front.stops, 1);
  await act(async () => { delayed.resolve(service.ack(service.chunks("front")[0])); });
  assert.equal(service.calls.some(call => call.route.endsWith("front/finalize")), false, "still waiting for worklet tail flush");
  await act(async () => { front.finishStop(); await stopping; });
  assert.deepEqual(service.chunks("front").map(call => new URL(call.route, "http://fixture").searchParams.get("index")), ["0", "1", "2"]);
  assert.equal(service.chunks("front")[0].mime, "application/octet-stream");
  assert.deepEqual([...new Int16Array(service.chunks("front")[2].pcm!)], [123, -456]);
  const finalized = service.calls.find(call => call.route.endsWith("front/finalize"))!.body!;
  assert.equal(finalized.next_index, 3);
  assert.equal(finalized.bytes, 16, "finalize counts PCM bytes, not the server's extra 44-byte WAV header");
  assert.ok(Number(finalized.duration_ms) >= 0);
  assert.deepEqual(front.messages.filter(message => message.type === "ack").map(message => message.index), [0, 1, 2]);
  assert.equal(front.port.closed, true);
  assert.equal(service.streams[0].track.stops, 0, "stopping recording keeps the connected microphone available");
});

test("unknown PCM acknowledgement never retries, fails all lanes, and cannot finalize a failed source", async t => {
  const service = fixture(); const hook = await mountHook(t, service.restore); await connectPair(hook);
  await act(async () => { await hook.value().prepareRecording(["front", "side"]); await hook.value().startRecording("lost-ack"); });
  service.intercept(call => call.route.includes("front/chunks?") || call.route.endsWith("front/error")
    ? Promise.reject(new Error("upload acknowledgement lost")) : undefined);
  await act(async () => { service.nodes[0].emitChunk(); service.nodes[0].emitChunk(); });
  await act(async () => { await assert.rejects(hook.value().stopRecording(), /acknowledgement lost/); });
  assert.equal(service.chunks("front").length, 1);
  assert.equal(service.nodes[1].stops, 1);
  assert.equal(service.calls.some(call => call.route.endsWith("front/finalize")), false);
  assert.equal(hook.value().recordingSessionId(), "lost-ack", "the owner can still stop its incomplete session");
  assert.match(hook.value().connections.front.error!, /acknowledgement lost/);
});

test("an inconsistent PCM byte acknowledgement is treated as failure without a retry", async t => {
  const service = fixture(); const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().connect("front", "fixture-microphone");
    await hook.value().prepareRecording(["front"]); await hook.value().startRecording("bad-ack"); });
  service.intercept(call => call.route.includes("/chunks?") ? Promise.resolve(service.json({ next_index: 1, payload_bytes: 999, bytes_written: 1043 })) : undefined);
  await act(async () => { service.nodes[0].emitChunk(); });
  await act(async () => { await assert.rejects(hook.value().stopRecording(), /确认与数据不一致/); });
  assert.equal(service.chunks("front").length, 1);
  assert.equal(service.calls.some(call => call.route.endsWith("/finalize")), false);
});

test("a stalled uploader has a bounded main-thread queue and stops peers when full", async t => {
  const service = fixture(); const hook = await mountHook(t, service.restore); await connectPair(hook);
  await act(async () => { await hook.value().prepareRecording(["front", "side"]); await hook.value().startRecording("bounded"); });
  const delayed = deferred<Response>();
  service.intercept(call => call.route.includes("front/chunks?") ? delayed.promise : undefined);
  await act(async () => { service.nodes[0].emitChunk(); });
  await act(async () => { for (let count = 0; count < 32; count++) service.nodes[0].emitChunk(); });
  assert.match(hook.value().error, /缓冲已满/);
  assert.equal(service.nodes[1].stops, 1);
  await act(async () => { delayed.resolve(service.ack(service.chunks("front")[0])); await assert.rejects(hook.value().stopRecording(), /缓冲已满/); });
  assert.equal(service.chunks("front").length, 1);
});

for (const failure of ["track", "processor", "context"] as const) {
  test(`microphone ${failure} failure reports an incomplete source and stops its other selected lane`, async t => {
    const service = fixture(); const hook = await mountHook(t, service.restore); await connectPair(hook);
    await act(async () => { await hook.value().prepareRecording(["front", "side"]); await hook.value().startRecording(`failure-${failure}`); });
    await act(async () => {
      if (failure === "track") service.streams[0].track.end();
      else if (failure === "processor") service.nodes[0].processorError();
      else service.contexts[0].changeState("suspended");
    });
    await act(async () => { await assert.rejects(hook.value().stopRecording()); });
    assert.equal(service.nodes[1].stops, 1);
    assert.equal(service.calls.some(call => call.route.endsWith("front/error")), true);
    assert.equal(service.calls.some(call => call.route.endsWith("front/finalize")), false);
    assert.ok(hook.value().connections.front.error);
    if (failure !== "processor") assert.equal(hook.value().connections.front.connected, false);
  });
}

test("prepared microphone cancellation and empty microphone sessions do not leave active processors", async t => {
  const service = fixture(); const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().prepareRecording([]); await hook.value().startRecording("camera-only"); await hook.value().stopRecording(); });
  assert.equal(service.calls.length, 0);
  await act(async () => { await hook.value().connect("front", "fixture-microphone"); await hook.value().prepareRecording(["front"]); await hook.value().cancelPrepared(); });
  assert.equal(service.nodes[0].port.closed, true);
  assert.equal(service.nodes[0].messages.some(message => message.type === "start"), false);
  assert.equal(service.contexts[0].state, "running");
  assert.equal(service.streams[0].track.stops, 0);
});

test("late worklet callbacks from an earlier recording cannot damage a new recording", async t => {
  const service = fixture(); const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().connect("front", "fixture-microphone"); await hook.value().prepareRecording(["front"]); await hook.value().startRecording("old-session"); });
  const oldNode = service.nodes[0], oldHandler = oldNode.port.onmessage!;
  await act(async () => { await hook.value().stopRecording(); await hook.value().prepareRecording(["front"]); await hook.value().startRecording("new-session"); });
  const before = service.calls.length;
  await act(async () => {
    oldHandler({ data: { type: "error", capture_id: oldNode.captureId, error: "stale failure" } } as MessageEvent);
    oldHandler({ data: { type: "chunk", capture_id: oldNode.captureId, index: 99, buffer: new ArrayBuffer(2) } } as MessageEvent);
  });
  assert.equal(service.calls.length, before);
  assert.equal(hook.value().error, "");
  assert.equal(hook.value().recordingSessionId(), "new-session");
  await act(async () => { await hook.value().stopRecording(); });
});

test("offline microphones can release resources and pending permission tracks are stopped after unmount", async t => {
  const service = fixture(); const hook = await mountHook(t, service.restore);
  await act(async () => { await hook.value().connect("front", "fixture-microphone"); });
  await hook.update({ online: false });
  await act(async () => { await hook.value().disconnect("front"); });
  assert.deepEqual(hook.value().connections, {});
  assert.equal(service.contexts[0].closes, 1); assert.equal(service.streams[0].track.stops, 1);
  await hook.update({ online: true });
  const permission = deferred<FakeAudioStream>(); service.setCapture(() => permission.promise);
  let connecting!: Promise<unknown>;
  await act(async () => { connecting = hook.value().connect("pending", "fixture-microphone").catch(error => error); });
  await act(async () => { await assert.rejects(hook.value().connect("pending", "fixture-microphone"), /正在进行/); });
  await hook.unmount();
  const orphan = new FakeAudioStream(); permission.resolve(orphan);
  assert.match((await connecting as Error).message, /已取消/);
  assert.equal(orphan.track.stops, 1);
  assert.equal(service.contexts.length, 1, "no AudioContext is created for a canceled permission request");
});

test("pagehide releases graph and tracks, and late upload completion cannot clear a resumed recording", async t => {
  const service = fixture(); const hook = await mountHook(t, service.restore, {}, true);
  await act(async () => { await hook.value().connect("front", "fixture-microphone"); await hook.value().prepareRecording(["front"]); await hook.value().startRecording("old-session"); });
  const delayed = deferred<Response>();
  service.intercept(call => call.route.includes("session_id=old-session&index=0") ? delayed.promise : undefined);
  await act(async () => { service.nodes[0].emitChunk(); });
  let oldStop!: Promise<void>;
  await act(async () => { oldStop = hook.value().stopRecording(); });
  await act(async () => window.dispatchEvent(new dom.window.Event("pagehide")));
  assert.equal(service.contexts[0].closes, 1); assert.equal(service.streams[0].track.stops, 1);
  assert.equal(service.calls.find(call => call.route.endsWith("/disconnect"))?.keepalive, true);
  assert.equal(service.calls.find(call => call.route.endsWith("/error"))?.keepalive, true);
  assert.deepEqual(hook.value().busyIds, []); assert.equal(hook.value().scanning, false);
  await act(async () => { await hook.value().connect("front", "fixture-microphone"); await hook.value().prepareRecording(["front"]); await hook.value().startRecording("resumed-session"); });
  await act(async () => { delayed.resolve(service.ack(service.chunks("front")[0])); await oldStop; });
  assert.equal(hook.value().recordingSessionId(), "resumed-session");
  assert.equal(hook.value().connections.front.connected, true);
  await act(async () => { await hook.value().stopRecording(); });
  assert.equal(service.calls.filter(call => call.route.endsWith("/finalize")).length, 1);
  assert.equal(service.calls.find(call => call.route.endsWith("/finalize"))?.body?.session_id, "resumed-session");
});

async function processorFixture() {
  const messages: Array<{ type: string; capture_id?: string; buffer?: ArrayBuffer; index?: number; error?: string }> = [];
  const transfers: unknown[][] = [];
  let Constructor!: new () => { port: { onmessage: (event: { data: unknown }) => void }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
  class Processor {
    port = { onmessage: null as unknown, postMessage(value: typeof messages[number], transfer: unknown[] = []) {
      messages.push(value); transfers.push(transfer);
    } };
  }
  const source = await readFile(new URL("../public/audio/pcm-capture.worklet.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { sampleRate: 8000, AudioWorkletProcessor: Processor,
    registerProcessor(name: string, value: typeof Constructor) { assert.equal(name, "synapse-pcm-capture"); Constructor = value; } });
  const processor = new Constructor();
  return { processor, messages, transfers, send(data: unknown) { processor.port.onmessage({ data }); } };
}

test("the actual worklet mixes mono PCM16LE, transfers 250ms blocks and flushes tail before stopped ACK", async () => {
  const fixture = await processorFixture();
  fixture.send({ type: "start", capture_id: "processor-test" });
  const output = new Float32Array(2000).fill(1);
  fixture.processor.process([[new Float32Array(2000).fill(1), new Float32Array(2000)]], [[output]]);
  const full = fixture.messages.find(message => message.type === "chunk")!;
  assert.equal(full.buffer!.byteLength, 4000);
  assert.equal(new DataView(full.buffer!).getInt16(0, true), 16384);
  assert.equal(fixture.transfers[1].length, 1);
  assert.equal(fixture.transfers[1][0], full.buffer);
  assert.ok(output.every(value => value === 0), "processor output cannot monitor the microphone");
  fixture.send({ type: "ack", capture_id: "processor-test", index: 0 });
  fixture.processor.process([[new Float32Array([-1, 1, 0, 3, Number.NaN])]], [[new Float32Array(5)]]);
  fixture.send({ type: "stop", capture_id: "processor-test" });
  const tail = fixture.messages.at(-2)!;
  assert.equal(tail.type, "chunk"); assert.equal(tail.index, 1);
  const view = new DataView(tail.buffer!);
  assert.deepEqual([0, 2, 4, 6, 8].map(offset => view.getInt16(offset, true)), [-32768, 32767, 0, 32767, 0]);
  assert.equal(fixture.messages.at(-1)?.type, "stopped");
  const count = fixture.messages.length;
  fixture.processor.process([[new Float32Array(2000).fill(1)]], [[new Float32Array(2000)]]);
  assert.equal(fixture.messages.length, count, "no samples are emitted after stop");
});

test("the actual worklet bounds messages even when the main thread never acknowledges them", async () => {
  const fixture = await processorFixture();
  fixture.send({ type: "start", capture_id: "bounded-worklet" });
  for (let count = 0; count < 40; count++) fixture.processor.process([[new Float32Array(2000).fill(0.5)]], [[new Float32Array(2000)]]);
  assert.equal(fixture.messages.filter(message => message.type === "chunk").length, 32);
  assert.equal(fixture.messages.filter(message => message.type === "error").length, 1);
  assert.match(fixture.messages.find(message => message.type === "error")!.error!, /缓冲已满/);
  fixture.send({ type: "stop", capture_id: "bounded-worklet" });
  assert.equal(fixture.messages.at(-1)?.type, "stopped");
  fixture.send({ type: "dispose" });
  assert.equal(fixture.processor.process([], []), false);
});
