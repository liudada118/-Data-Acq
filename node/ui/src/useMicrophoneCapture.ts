import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";
import type { CameraRecordingSource } from "./camera-types";
import type { MicrophoneConnection, MicrophoneOption, UseMicrophoneCaptureOptions, UseMicrophoneCaptureResult } from "./microphone-types";

const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_CHUNKS = 32;
const CHUNK_LIMIT = 16 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const route = (id: string, action: string) => `/api/cameras/${encodeURIComponent(id)}/${action}`;
const errorOf = (cause: unknown) => cause instanceof Error ? cause : new Error("麦克风操作失败。");
function accessError(cause: unknown) {
  const messages: Record<string, string> = {
    NotAllowedError: "未获麦克风权限，请允许当前页面使用麦克风；浏览器提示设置待生效时，请刷新当前页面。",
    NotFoundError: "未检测到所选麦克风；使用手机时，请先启用 DroidCam 音频，再重新检测。",
    NotReadableError: "麦克风被占用或系统无法读取，请关闭其它占用应用后重试。",
    OverconstrainedError: "保存的麦克风不可用，请重新检测并选择设备。",
  };
  if (cause && typeof cause === "object") {
    const value = cause as { name?: string; message?: string };
    if (value.name && Object.hasOwn(messages, value.name)) return new Error(messages[value.name]);
    if (typeof value.message === "string") return new Error(value.message);
  }
  return errorOf(cause);
}
async function microphoneRequest<T>(path: string, options: {
  token?: string; body?: unknown; pcm?: ArrayBuffer; timeout?: number; signal?: AbortSignal; keepalive?: boolean;
} = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": options.pcm ? "application/octet-stream" : "application/json" };
  if (options.token) headers["X-Camera-Token"] = options.token;
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", headers,
    body: options.pcm ?? JSON.stringify(options.body ?? {}), keepalive: options.keepalive,
    signal: options.keepalive ? undefined : options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 15000)])
      : AbortSignal.timeout(options.timeout ?? 15000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(result?.error ?? `麦克风请求失败 (${response.status})`), { status: response.status });
  return result as T;
}
async function bounded<T>(promise: Promise<T>, message: string, timeout = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function stopTracks(stream: MediaStream) { for (const track of stream.getTracks()) track.stop(); }
function mediaAvailable() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前页面无法使用麦克风，请使用本机 localhost 或 HTTPS 并允许麦克风访问。");
}
interface OwnedMicrophone {
  connection: MicrophoneConnection;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  silence: GainNode;
  token: string;
  chunkLimit: number;
  closing: boolean;
  ended: () => void;
  stateChanged: () => void;
  heartbeat?: ReturnType<typeof setTimeout>;
  heartbeatController?: AbortController;
}
interface Lane {
  microphone: OwnedMicrophone;
  node: AudioWorkletNode;
  captureId: string;
  sessionId: string | null;
  started: boolean;
  stopRequested: boolean;
  stopped: boolean;
  discard: boolean;
  startDone: Promise<void>;
  resolveStart: () => void;
  stopDone: Promise<void>;
  resolveStop: () => void;
  startDeadline?: ReturnType<typeof setTimeout>;
  stopDeadline?: ReturnType<typeof setTimeout>;
  tail: Promise<void>;
  queuedBytes: number;
  queuedCount: number;
  generated: number;
  acknowledged: number;
  acknowledgedBytes: number;
  failure: Error | null;
  report: Promise<void> | null;
  startedAt: string;
  stoppedAt: string;
  startClock: number;
  stopClock: number;
  processorError: () => void;
}
function settleStopped(lane: Lane) {
  if (lane.stopped) return;
  lane.stopped = true; lane.stoppedAt = new Date().toISOString(); lane.stopClock = performance.now();
  clearTimeout(lane.startDeadline); clearTimeout(lane.stopDeadline);
  lane.resolveStart(); lane.resolveStop();
}
function detach(lane: Lane) {
  lane.discard = true;
  clearTimeout(lane.startDeadline); clearTimeout(lane.stopDeadline);
  lane.node.port.onmessage = null;
  lane.node.removeEventListener("processorerror", lane.processorError);
  try { lane.node.port.postMessage({ type: "dispose" }); } catch { /* The context may already be closed. */ }
  try { lane.microphone.source.disconnect(lane.node); } catch { /* Already disconnected. */ }
  lane.node.disconnect(); lane.node.port.close();
}

export function useMicrophoneCapture(options: UseMicrophoneCaptureOptions): UseMicrophoneCaptureResult {
  const [devices, setDevices] = useState<MicrophoneOption[]>([]);
  const [connections, setConnections] = useState<Record<string, MicrophoneConnection>>({});
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(options); current.current = options;
  const mounted = useRef(false), generation = useRef(0), enumerationSequence = useRef(0);
  const owned = useRef(new Map<string, OwnedMicrophone>()), locks = useRef(new Set<string>());
  const scanLock = useRef(false), lanes = useRef(new Map<string, Lane>());
  const phase = useRef<"idle" | "preparing" | "prepared" | "recording" | "stopping">("idle");
  const stopping = useRef<Promise<void> | null>(null), sessionOwner = useRef<string | null>(null);
  const lastFailure = useRef<Error | null>(null), stopRef = useRef<() => Promise<void>>(async () => {});
  const publish = useCallback(() => {
    if (mounted.current) setConnections(Object.fromEntries([...owned.current].map(([id, item]) => [id, { ...item.connection }])));
  }, []);
  const reportFailure = useCallback((lane: Lane, cause: unknown) => {
    if (lane.discard || lanes.current.get(lane.microphone.connection.instanceId) !== lane) return;
    const failure = errorOf(cause);
    lane.failure ??= failure; lastFailure.current ??= failure;
    lane.microphone.connection.error = failure.message;
    if (mounted.current) setError(failure.message);
    publish(); lane.resolveStart(); clearTimeout(lane.startDeadline);
    if (lane.sessionId && !lane.report) lane.report = microphoneRequest(route(lane.microphone.connection.instanceId, "error"), {
      token: lane.microphone.token, body: { session_id: lane.sessionId, error: failure.message.slice(0, 500) }, timeout: 10000,
    }).then(() => {}, () => {});
    if (phase.current === "recording") void stopRef.current().catch(() => {});
  }, [publish]);
  const release = useCallback((microphone: OwnedMicrophone) => {
    if (microphone.closing) return;
    microphone.closing = true;
    clearTimeout(microphone.heartbeat); microphone.heartbeatController?.abort();
    for (const track of microphone.connection.stream.getAudioTracks()) track.removeEventListener("ended", microphone.ended);
    microphone.context.removeEventListener("statechange", microphone.stateChanged);
    stopTracks(microphone.connection.stream);
    microphone.source.disconnect(); microphone.connection.analyser.disconnect(); microphone.silence.disconnect();
    void microphone.context.close().catch(() => {});
    microphone.connection.connected = false;
  }, []);
  const failConnection = useCallback((microphone: OwnedMicrophone, cause: unknown) => {
    if (microphone.closing || owned.current.get(microphone.connection.instanceId) !== microphone) return;
    const failure = errorOf(cause), lane = lanes.current.get(microphone.connection.instanceId);
    microphone.connection.error = failure.message;
    if (lane) { reportFailure(lane, failure); settleStopped(lane); }
    release(microphone); publish();
    if (mounted.current) setError(failure.message);
    void microphoneRequest(route(microphone.connection.instanceId, "disconnect"), { token: microphone.token, keepalive: true }).catch(() => {});
    void current.current.onDevicesChanged().catch(() => {});
  }, [publish, release, reportFailure]);
  const heartbeat = useCallback((microphone: OwnedMicrophone) => {
    async function ping() {
      if (!mounted.current || microphone.closing) return;
      microphone.heartbeatController = new AbortController();
      try { await microphoneRequest(route(microphone.connection.instanceId, "heartbeat"), {
        token: microphone.token, signal: microphone.heartbeatController.signal, timeout: 6000,
      }); } catch { if (!microphone.closing) failConnection(microphone, new Error("麦克风与采集服务连接中断，请重新连接。")); }
      if (mounted.current && !microphone.closing) microphone.heartbeat = setTimeout(() => void ping(), 5000);
    }
    microphone.heartbeat = setTimeout(() => void ping(), 5000);
  }, [failConnection]);
  const assertEditable = useCallback(() => {
    if (!mounted.current || !current.current.online) throw new Error("采集服务离线，请恢复连接后重试。");
    if (current.current.recording || phase.current !== "idle") throw new Error("录制期间无法更改麦克风，请先停止录制。");
  }, []);
  const enumerate = useCallback(async () => {
    const run = generation.current, sequence = ++enumerationSequence.current;
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter(device => device.kind === "audioinput" && device.deviceId);
    const list = inputs.map((device, index) => ({ deviceId: device.deviceId, label: device.label || `麦克风 ${index + 1}` }));
    if (mounted.current && generation.current === run && enumerationSequence.current === sequence) setDevices(list);
    return inputs.some(device => device.label.trim());
  }, []);
  const scan = useCallback(async () => {
    assertEditable(); mediaAvailable();
    if (scanLock.current) throw new Error("正在检测麦克风，请稍候。");
    scanLock.current = true; setScanning(true); setError("");
    const run = generation.current;
    let temporary: MediaStream | undefined;
    try {
      const named = await enumerate().catch(() => false);
      if (!mounted.current || generation.current !== run || named) return;
      if (![...owned.current.values()].some(item => item.connection.connected))
        temporary = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      if (mounted.current && generation.current === run) await enumerate();
    } catch (cause) {
      const failure = accessError(cause);
      if (mounted.current && generation.current === run) await enumerate().catch(() => {});
      if (mounted.current && generation.current === run) setError(failure.message);
      throw failure;
    } finally {
      if (temporary) stopTracks(temporary);
      if (generation.current === run) { scanLock.current = false; if (mounted.current) setScanning(false); }
    }
  }, [assertEditable, enumerate]);
  const connect = useCallback(async (instanceId: string, deviceId?: string): Promise<MicrophoneConnection> => {
    assertEditable(); mediaAvailable();
    if (!SAFE_ID.test(instanceId)) throw new Error("麦克风配置无效。");
    if (!deviceId?.trim()) throw new Error("请先检测并选择麦克风，再点击连接。");
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") throw new Error("当前浏览器不支持 AudioWorklet，请使用新版 Chrome 或 Edge。");
    if (locks.current.has(instanceId)) throw new Error("麦克风连接操作正在进行，请稍候。");
    if (owned.current.get(instanceId)?.connection.connected) throw new Error("该麦克风已经连接，请先断开。");
    locks.current.add(instanceId); setBusyIds([...locks.current]); setError("");
    const run = generation.current;
    let stream: MediaStream | undefined, context: AudioContext | undefined, registeredToken: string | undefined;
    const valid = () => mounted.current && generation.current === run && current.current.online;
    try {
      const previous = owned.current.get(instanceId);
      if (previous) { release(previous); await microphoneRequest(route(instanceId, "disconnect"), { token: previous.token }).catch(() => {});
        if (owned.current.get(instanceId) === previous) owned.current.delete(instanceId); }
      if (!valid()) throw new Error("麦克风连接已取消。");
      stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { deviceId: { exact: deviceId },
        channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (!valid()) throw new Error("麦克风连接已取消。");
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== "live") throw new Error("麦克风没有提供可用的音频轨道。");
      context = new AudioContext({ latencyHint: "interactive" });
      await bounded(context.resume(), "音频引擎启动超时，请点击连接重试。");
      if (!valid()) throw new Error("麦克风连接已取消。");
      if (context.state !== "running" || !context.audioWorklet) throw new Error("音频引擎未运行，请允许音频访问后重试。");
      await bounded(context.audioWorklet.addModule(`${import.meta.env?.BASE_URL ?? "/"}audio/pcm-capture.worklet.js`), "音频采集模块加载超时，请刷新页面重试。");
      if (!valid()) throw new Error("麦克风连接已取消。");
      const source = context.createMediaStreamSource(stream), analyser = context.createAnalyser(), silence = context.createGain();
      analyser.fftSize = 1024; silence.gain.value = 0;
      source.connect(analyser); analyser.connect(silence); silence.connect(context.destination);
      const sampleRate = context.sampleRate;
      if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error("音频引擎采样率不受支持。");
      const label = track.label || "本机麦克风";
      const registered = await microphoneRequest<{ token: string; chunk_limit_bytes?: number }>("/api/cameras/register", {
        body: { kind: "audio", instance_id: instanceId, label, sample_rate: sampleRate, channels: 1, encoding: "pcm_s16le" },
      });
      if (typeof registered?.token !== "string" || !registered.token) throw new Error("服务未返回有效的麦克风连接信息。");
      registeredToken = registered.token;
      if (!valid() || track.readyState !== "live" || context.state !== "running") throw new Error("麦克风连接已取消或设备已断开。");
      const connection: MicrophoneConnection = { instanceId, deviceId: track.getSettings().deviceId || deviceId, label,
        stream, sampleRate, channels: 1, analyser, connected: true, error: null };
      const microphone: OwnedMicrophone = { connection, context, source, silence, token: registeredToken,
        chunkLimit: Math.min(CHUNK_LIMIT, registered.chunk_limit_bytes || CHUNK_LIMIT), closing: false,
        ended: () => failConnection(microphone, new Error("麦克风音频轨道已结束，请检查设备连接。")),
        stateChanged: () => {
          if (microphone.context.state === "closed" || (lanes.current.get(instanceId)?.started && microphone.context.state !== "running"))
            failConnection(microphone, new Error("音频引擎已暂停或关闭，请重新连接麦克风。"));
        },
      };
      owned.current.set(instanceId, microphone);
      for (const audioTrack of stream.getAudioTracks()) audioTrack.addEventListener("ended", microphone.ended);
      context.addEventListener("statechange", microphone.stateChanged);
      heartbeat(microphone); publish();
      await enumerate().catch(() => {}); await current.current.onDevicesChanged();
      return connection;
    } catch (cause) {
      const failure = accessError(cause), item = owned.current.get(instanceId);
      if (item && item.token === registeredToken) { release(item); owned.current.delete(instanceId); }
      else { if (stream) stopTracks(stream); if (context) void context.close().catch(() => {}); }
      if (registeredToken) void microphoneRequest(route(instanceId, "disconnect"), { token: registeredToken, keepalive: true }).catch(() => {});
      if (mounted.current && generation.current === run) { setError(failure.message); publish(); }
      throw failure;
    } finally {
      if (generation.current === run) { locks.current.delete(instanceId); if (mounted.current) setBusyIds([...locks.current]); }
    }
  }, [assertEditable, enumerate, failConnection, heartbeat, publish, release]);
  const disconnect = useCallback(async (instanceId: string) => {
    const microphone = owned.current.get(instanceId);
    if (!microphone) return;
    if (current.current.recording || phase.current !== "idle") throw new Error("录制期间无法更改麦克风，请先停止录制。");
    if (locks.current.has(instanceId)) throw new Error("麦克风连接操作正在进行，请稍候。");
    locks.current.add(instanceId); setBusyIds([...locks.current]);
    try {
      release(microphone);
      if (current.current.online) {
        try { await microphoneRequest(route(instanceId, "disconnect"), { token: microphone.token }); }
        catch (cause) { if (![404, 409, 410].includes((cause as { status?: number })?.status ?? 0)) throw cause; }
      } else void microphoneRequest(route(instanceId, "disconnect"), { token: microphone.token, keepalive: true }).catch(() => {});
      if (owned.current.get(instanceId) === microphone) owned.current.delete(instanceId);
      publish(); if (current.current.online) await current.current.onDevicesChanged();
    } catch (cause) { microphone.connection.error = errorOf(cause).message; publish(); if (mounted.current) setError(errorOf(cause).message); throw cause; }
    finally { locks.current.delete(instanceId); if (mounted.current) setBusyIds([...locks.current]); }
  }, [publish, release]);

  const prepareRecording = useCallback(async (instanceIds: string[]): Promise<CameraRecordingSource[]> => {
    if (!mounted.current || !current.current.online) throw new Error("采集服务离线。");
    if (phase.current !== "idle") throw new Error("麦克风录制尚未结束。");
    phase.current = "preparing"; lastFailure.current = null; sessionOwner.current = null; setError("");
    const run = generation.current, preparing = new Map<string, Lane>(); lanes.current = preparing;
    try {
      for (const id of new Set(instanceIds)) {
        const microphone = owned.current.get(id);
        if (!microphone?.connection.connected || microphone.closing || microphone.connection.stream.getAudioTracks().some(track => track.readyState !== "live"))
          throw new Error("请先连接展示区内的所有麦克风。");
        await bounded(microphone.context.resume(), "音频引擎未就绪，请重新连接麦克风。");
        if (!mounted.current || generation.current !== run || lanes.current !== preparing || microphone.closing || microphone.context.state !== "running") throw new Error("麦克风录制准备已取消。");
        const node = new AudioWorkletNode(microphone.context, "synapse-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1,
          outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
        let resolveStart!: () => void, resolveStop!: () => void;
        const lane: Lane = { microphone, node, captureId: crypto.randomUUID(), sessionId: null, started: false, stopRequested: false,
          stopped: false, discard: false, startDone: new Promise<void>(resolve => { resolveStart = resolve; }), resolveStart: () => resolveStart(),
          stopDone: new Promise<void>(resolve => { resolveStop = resolve; }), resolveStop: () => resolveStop(), tail: Promise.resolve(),
          queuedBytes: 0, queuedCount: 0, generated: 0, acknowledged: 0, acknowledgedBytes: 0, failure: null, report: null,
          startedAt: "", stoppedAt: "", startClock: 0, stopClock: 0,
          processorError: () => { reportFailure(lane, new Error("麦克风音频处理器异常，录制已中止。")); settleStopped(lane); },
        };
        preparing.set(id, lane);
        node.port.onmessage = event => {
          const message = event.data;
          if (lane.discard || lanes.current.get(id) !== lane || message?.capture_id !== lane.captureId) return;
          if (message.type === "started") { clearTimeout(lane.startDeadline); lane.resolveStart(); return; }
          if (message.type === "stopped") {
            settleStopped(lane);
            if (lane.started && !lane.stopRequested) reportFailure(lane, new Error("音频处理器提前结束了录制。"));
            return;
          }
          if (message.type === "error") { reportFailure(lane, new Error(message.error || "麦克风音频处理失败。")); return; }
          if (message.type !== "chunk" || lane.failure || !lane.sessionId) return;
          const buffer = message.buffer;
          if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength % 2 || message.index !== lane.generated) {
            reportFailure(lane, new Error("麦克风音频块顺序或数据无效，录制已中止。")); return;
          }
          const size = buffer.byteLength;
          if (size > microphone.chunkLimit || lane.queuedBytes + size > MAX_QUEUE_BYTES || lane.queuedCount >= MAX_QUEUE_CHUNKS) {
            reportFailure(lane, new Error("麦克风上传缓冲已满或单块过大，录制已中止。")); return;
          }
          const index = lane.generated++; lane.queuedBytes += size; lane.queuedCount++;
          lane.tail = lane.tail.then(async () => {
            if (lane.failure || lane.discard || lanes.current.get(id) !== lane) return;
            const response = await microphoneRequest<{ next_index: number; payload_bytes: number }>(`${route(id, "chunks")}?session_id=${encodeURIComponent(lane.sessionId!)}&index=${index}`, {
              token: microphone.token, pcm: buffer, timeout: 20000,
            });
            if (lane.discard || lanes.current.get(id) !== lane) return;
            if (response?.next_index !== index + 1 || response.payload_bytes !== lane.acknowledgedBytes + size)
              throw new Error("麦克风上传确认与数据不一致，录制已中止；不会重传未知结果。");
            lane.acknowledged++; lane.acknowledgedBytes += size;
            node.port.postMessage({ type: "ack", capture_id: lane.captureId, index });
          }).catch(cause => reportFailure(lane, cause)).finally(() => { lane.queuedBytes -= size; lane.queuedCount--; });
        };
        node.addEventListener("processorerror", lane.processorError);
        microphone.source.connect(node); node.connect(microphone.silence);
        microphone.connection.error = null;
      }
      if (!mounted.current || generation.current !== run || lanes.current !== preparing) throw new Error("麦克风录制准备已取消。");
      phase.current = "prepared"; publish();
      return [...preparing].map(([instance_id, lane]) => ({ instance_id, token: lane.microphone.token, mime_type: "audio/wav" }));
    } catch (cause) {
      for (const lane of preparing.values()) detach(lane);
      if (lanes.current === preparing) { lanes.current = new Map(); phase.current = "idle"; }
      if (mounted.current && generation.current === run) setError(errorOf(cause).message);
      throw cause;
    }
  }, [publish, reportFailure]);
  const stopRecording = useCallback((): Promise<void> => {
    if (stopping.current) return stopping.current;
    if (phase.current === "idle") return lastFailure.current ? Promise.reject(lastFailure.current) : Promise.resolve();
    const stoppingLanes = lanes.current, selected = [...stoppingLanes.values()];
    phase.current = "stopping";
    const completion = (async () => {
      await Promise.all(selected.map(async lane => {
        try {
          if (!lane.started) settleStopped(lane);
          else if (!lane.stopped && !lane.stopRequested) {
            lane.stopRequested = true;
            if (lane.microphone.closing || lane.microphone.context.state !== "running") {
              reportFailure(lane, new Error("音频引擎未运行，无法保存最后的音频块。")); settleStopped(lane);
            } else {
              lane.stopDeadline = setTimeout(() => { reportFailure(lane, new Error("等待音频尾块确认超时。")); settleStopped(lane); }, 5000);
              try { lane.node.port.postMessage({ type: "stop", capture_id: lane.captureId }); }
              catch (cause) { reportFailure(lane, cause); settleStopped(lane); }
            }
          }
          await lane.stopDone; await lane.tail; await lane.report;
          if (lane.sessionId && !lane.failure && !lane.discard && lanes.current.get(lane.microphone.connection.instanceId) === lane) {
            try { await microphoneRequest(route(lane.microphone.connection.instanceId, "finalize"), {
              token: lane.microphone.token, timeout: 20000, body: { session_id: lane.sessionId, next_index: lane.acknowledged,
                bytes: lane.acknowledgedBytes, started_at: lane.startedAt, stopped_at: lane.stoppedAt,
                duration_ms: Math.max(0, lane.stopClock - lane.startClock) },
            }); } catch (cause) { reportFailure(lane, cause); await lane.report; }
          }
        } finally { detach(lane); }
      }));
      const failure = selected.find(lane => lane.failure)?.failure;
      if (failure) throw failure;
    })().finally(() => {
      if (lanes.current === stoppingLanes) { lanes.current = new Map(); phase.current = "idle"; publish(); }
      if (stopping.current === completion) stopping.current = null;
    });
    stopping.current = completion;
    return completion;
  }, [publish, reportFailure]);
  stopRef.current = stopRecording;
  const startRecording = useCallback(async (sessionId: string) => {
    if (phase.current !== "prepared" || !sessionId) throw new Error("麦克风尚未准备好录制，或会话标识无效。");
    const startingLanes = lanes.current, selected = [...startingLanes.values()];
    phase.current = "recording"; sessionOwner.current = sessionId;
    for (const lane of selected) { lane.sessionId = sessionId; lane.startedAt = new Date().toISOString(); lane.startClock = performance.now(); }
    try {
      for (const lane of selected) {
        if (!lane.microphone.connection.connected || lane.microphone.closing || lane.microphone.context.state !== "running") throw new Error("麦克风在开始录制前已断开或暂停。");
        lane.started = true;
        lane.startDeadline = setTimeout(() => reportFailure(lane, new Error("音频处理器开始录制超时。")), 5000);
        lane.node.port.postMessage({ type: "start", capture_id: lane.captureId });
      }
      await Promise.all(selected.map(lane => lane.startDone));
      const failure = selected.find(lane => lane.failure)?.failure;
      if (failure) throw failure;
      if (lanes.current !== startingLanes || selected.some(lane => lane.discard || lane.stopped)) throw new Error("麦克风录制启动已取消。");
    } catch (cause) {
      for (const lane of selected) reportFailure(lane, cause);
      if (lanes.current === startingLanes) await stopRecording().catch(() => {});
      throw cause;
    }
  }, [reportFailure, stopRecording]);
  const cancelPrepared = useCallback(async () => {
    if (phase.current !== "prepared") return;
    for (const lane of lanes.current.values()) detach(lane);
    lanes.current = new Map(); phase.current = "idle";
  }, []);
  useEffect(() => {
    mounted.current = true; generation.current++;
    const leave = () => {
      generation.current++; enumerationSequence.current++;
      for (const lane of lanes.current.values()) {
        if (lane.sessionId) void microphoneRequest(route(lane.microphone.connection.instanceId, "error"), {
          token: lane.microphone.token, keepalive: true, body: { session_id: lane.sessionId, error: "麦克风采集页面已关闭或离开。" },
        }).catch(() => {});
        detach(lane); settleStopped(lane);
      }
      for (const microphone of owned.current.values()) {
        release(microphone);
        void microphoneRequest(route(microphone.connection.instanceId, "disconnect"), { token: microphone.token, keepalive: true }).catch(() => {});
      }
      owned.current.clear(); lanes.current = new Map(); phase.current = "idle"; stopping.current = null;
      sessionOwner.current = null; locks.current.clear(); scanLock.current = false;
      if (mounted.current) { setBusyIds([]); setScanning(false); } publish();
    };
    window.addEventListener("pagehide", leave);
    return () => { mounted.current = false; window.removeEventListener("pagehide", leave); leave(); };
  }, [publish, release]);
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let disposed = false, permission: PermissionStatus | undefined;
    const run = generation.current;
    const refresh = () => { if (!disposed && mounted.current) void enumerate().catch(() => {}); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    media.addEventListener?.("devicechange", refresh); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible); refresh();
    if (navigator.permissions?.query) void navigator.permissions.query({ name: "microphone" as PermissionName }).then(status => {
      if (!disposed && mounted.current && generation.current === run) { permission = status; status.addEventListener("change", refresh); }
    }).catch(() => {});
    return () => { disposed = true; media.removeEventListener?.("devicechange", refresh); window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible); permission?.removeEventListener("change", refresh); };
  }, [enumerate]);
  useEffect(() => { if (!options.online) for (const microphone of owned.current.values()) failConnection(microphone, new Error("采集服务离线，麦克风已停止。")); }, [options.online, failConnection]);
  const recordingSessionId = useCallback(() => sessionOwner.current, []);
  return { devices, connections, busyIds, scanning, error, scan, connect, disconnect, prepareRecording, startRecording, stopRecording, cancelPrepared, recordingSessionId };
}
