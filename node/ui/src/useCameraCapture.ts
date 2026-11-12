import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";
import type { CameraConnection, CameraOption, CameraQuality, CameraRecordingSource, UseCameraCaptureOptions, UseCameraCaptureResult } from "./camera-types";

const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const MAX_QUEUE_CHUNKS = 32;
const DEFAULT_CHUNK_LIMIT = 16 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const MIME_TYPES = ["video/webm;codecs=vp8", "video/webm", "video/mp4"];
const errorOf = (value: unknown) => value instanceof Error ? value : new Error("摄像头操作失败");
function cameraAccessError(cause: unknown): Error {
  const messages: Record<string, string> = {
    NotAllowedError: "未获摄像头权限，请允许当前页面使用摄像头；如果浏览器提示设置待生效，请刷新当前页面。内置浏览器受限时，请用 Chrome 或 Edge 打开本机地址。",
    NotFoundError: "未检测到摄像头；使用手机时，请先让 DroidCam 电脑客户端显示画面，再重新检测。",
    NotReadableError: "摄像头被占用或系统无法读取，请关闭其它占用摄像头的应用后重试。",
    OverconstrainedError: "保存的摄像头不可用或不支持当前配置，请重新检测摄像头，或选择 720p 后重试。",
  };
  if (cause && typeof cause === "object") {
    const value = cause as { name?: unknown; message?: unknown };
    if (typeof value.name === "string" && Object.hasOwn(messages, value.name)) return new Error(messages[value.name]);
    if (typeof value.message === "string") return cause instanceof Error ? cause : new Error(value.message);
  }
  return errorOf(cause);
}

interface OwnedCamera {
  connection: CameraConnection;
  token: string;
  chunkLimit: number;
  closing: boolean;
  heartbeat?: ReturnType<typeof setTimeout>;
  heartbeatController?: AbortController;
  ended: () => void;
}
interface RecordingLane {
  camera: OwnedCamera;
  recorder: MediaRecorder;
  mimeType: string;
  sessionId: string | null;
  started: boolean;
  stopRequested: boolean;
  stopped: boolean;
  discard: boolean;
  stopDone: Promise<void>;
  resolveStop: () => void;
  stopDeadline?: ReturnType<typeof setTimeout>;
  tail: Promise<void>;
  queuedBytes: number;
  queuedCount: number;
  generated: number;
  acknowledged: number;
  failure: Error | null;
  report: Promise<void> | null;
  startedAt: string;
  stoppedAt: string;
  startClock: number;
  stopClock: number;
}

async function cameraRequest<T>(path: string, options: {
  token?: string; body?: unknown; blob?: Blob; mime?: string;
  timeout?: number; signal?: AbortSignal; keepalive?: boolean;
} = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers["X-Camera-Token"] = options.token;
  headers["Content-Type"] = options.blob ? options.mime || options.blob.type || "application/octet-stream" : "application/json";
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST", headers,
    body: options.blob ?? JSON.stringify(options.body ?? {}),
    signal: options.keepalive ? undefined : options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 15000)])
      : AbortSignal.timeout(options.timeout ?? 15000),
    keepalive: options.keepalive,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result?.error === "Camera recording session does not match"
      ? "摄像头所属录制已结束或发生变化，请在开始录制的页面停止保存，再重新开始。"
      : result?.error ?? `摄像头请求失败 (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return result as T;
}
const route = (id: string, action: string) => `/api/cameras/${encodeURIComponent(id)}/${action}`;
function stopTracks(stream: MediaStream) { for (const track of stream.getTracks()) track.stop(); }
function mediaAvailable() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器无法使用摄像头，请使用本机 localhost 页面或 HTTPS，并检查摄像头权限。");
}
function settleStopped(lane: RecordingLane) {
  if (lane.stopped) return;
  lane.stopped = true;
  lane.stoppedAt = new Date().toISOString();
  lane.stopClock = performance.now();
  clearTimeout(lane.stopDeadline);
  lane.resolveStop();
}
function detachRecorder(lane: RecordingLane) {
  lane.recorder.ondataavailable = null;
  lane.recorder.onstop = null;
  lane.recorder.onerror = null;
  clearTimeout(lane.stopDeadline);
}

export function useCameraCapture(options: UseCameraCaptureOptions): UseCameraCaptureResult {
  const [devices, setDevices] = useState<CameraOption[]>([]);
  const [connections, setConnections] = useState<Record<string, CameraConnection>>({});
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(options);
  current.current = options;
  const mounted = useRef(false);
  const generation = useRef(0);
  const owned = useRef(new Map<string, OwnedCamera>());
  const locks = useRef(new Set<string>());
  const scanLock = useRef(false);
  const enumerationSequence = useRef(0);
  const lanes = useRef(new Map<string, RecordingLane>());
  const phase = useRef<"idle" | "prepared" | "recording" | "stopping">("idle");
  const stopping = useRef<Promise<void> | null>(null);
  const lastRecordingFailure = useRef<Error | null>(null);
  const sessionOwner = useRef<string | null>(null);
  const stopRef = useRef<() => Promise<void>>(async () => {});

  const publish = useCallback(() => {
    if (mounted.current) setConnections(Object.fromEntries([...owned.current].map(([id, item]) => [id, { ...item.connection }])));
  }, []);
  const reportFailure = useCallback((lane: RecordingLane, cause: unknown) => {
    if (lane.discard || lanes.current.get(lane.camera.connection.instanceId) !== lane) return;
    const failure = errorOf(cause);
    lane.failure ??= failure;
    lastRecordingFailure.current ??= failure;
    lane.camera.connection.error = failure.message;
    publish();
    if (mounted.current) setError(failure.message);
    if (lane.sessionId && !lane.report) lane.report = cameraRequest(route(lane.camera.connection.instanceId, "error"), {
      token: lane.camera.token, body: { session_id: lane.sessionId, error: failure.message.slice(0, 500) }, timeout: 10000,
    }).then(() => {}, () => {});
    // Stop all selected cameras together. The parent still closes the session manifest.
    if (phase.current === "recording") void stopRef.current().catch(() => {});
  }, [publish]);

  const releaseTracks = useCallback((camera: OwnedCamera) => {
    camera.closing = true;
    clearTimeout(camera.heartbeat);
    camera.heartbeatController?.abort();
    for (const track of camera.connection.stream.getVideoTracks()) track.removeEventListener("ended", camera.ended);
    stopTracks(camera.connection.stream);
    camera.connection.connected = false;
  }, []);

  const failConnection = useCallback((camera: OwnedCamera, cause: unknown) => {
    if (camera.closing || owned.current.get(camera.connection.instanceId) !== camera) return;
    const failure = errorOf(cause);
    camera.connection.error = failure.message;
    const lane = lanes.current.get(camera.connection.instanceId);
    if (lane) reportFailure(lane, failure);
    releaseTracks(camera);
    publish();
    if (mounted.current) setError(failure.message);
    void cameraRequest(route(camera.connection.instanceId, "disconnect"), { token: camera.token, keepalive: true }).catch(() => {});
    void current.current.onDevicesChanged().catch(() => {});
  }, [publish, releaseTracks, reportFailure]);

  const heartbeat = useCallback((camera: OwnedCamera) => {
    async function ping() {
      if (!mounted.current || camera.closing) return;
      camera.heartbeatController = new AbortController();
      try {
        await cameraRequest(route(camera.connection.instanceId, "heartbeat"), {
          token: camera.token, signal: camera.heartbeatController.signal, timeout: 6000,
        });
      } catch {
        if (!camera.closing) failConnection(camera, new Error("摄像头与本地采集服务连接中断，请重新连接摄像头。"));
      }
      if (mounted.current && !camera.closing) camera.heartbeat = setTimeout(() => void ping(), 5000);
    }
    camera.heartbeat = setTimeout(() => void ping(), 5000);
  }, [failConnection]);

  const assertEditable = useCallback(() => {
    if (!mounted.current || !current.current.online) throw new Error("采集服务离线，请恢复连接后重试。");
    if (current.current.recording || phase.current !== "idle") throw new Error("录制期间无法更改摄像头，请先停止录制。");
  }, []);
  const enumerate = useCallback(async () => {
    const run = generation.current;
    const sequence = ++enumerationSequence.current;
    const list = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = list.filter(device => device.kind === "videoinput" && device.deviceId);
    const cameras = videoDevices.map((device, index) => ({
      deviceId: device.deviceId, label: device.label || `摄像头 ${index + 1}`,
    }));
    if (mounted.current && generation.current === run && enumerationSequence.current === sequence) setDevices(cameras);
    return { cameras, hasNamedDevice: videoDevices.some(device => device.label.trim()) };
  }, []);

  const scan = useCallback(async () => {
    assertEditable();
    mediaAvailable();
    if (scanLock.current) throw new Error("正在刷新摄像头列表，请稍候。");
    scanLock.current = true;
    setScanning(true);
    setError("");
    const run = generation.current;
    let temporary: MediaStream | undefined;
    try {
      // Listing already-authorized devices must not open an unrelated default camera.
      const available = await enumerate().catch(() => null);
      if (!mounted.current || generation.current !== run) return;
      if (available?.hasNamedDevice) return;
      if (![...owned.current.values()].some(camera => camera.connection.connected))
        temporary = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (!mounted.current || generation.current !== run) return;
      await enumerate();
    } catch (cause) {
      const failure = cameraAccessError(cause);
      // A failed default-device permission probe must not hide other enumerated devices.
      if (mounted.current && generation.current === run) await enumerate().catch(() => {});
      if (mounted.current && generation.current === run) setError(failure.message);
      throw failure;
    } finally {
      if (temporary) stopTracks(temporary);
      if (generation.current === run) { scanLock.current = false; if (mounted.current) setScanning(false); }
    }
  }, [assertEditable, enumerate]);

  const connect = useCallback(async (instanceId: string, deviceId?: string, quality: CameraQuality = "720p") => {
    assertEditable();
    mediaAvailable();
    if (!SAFE_ID.test(instanceId) || !["720p", "1080p"].includes(quality)) throw new Error("摄像头配置无效。");
    if (!deviceId?.trim()) throw new Error("请先检测并选择摄像头，再点击连接。");
    if (locks.current.has(instanceId)) throw new Error("摄像头连接操作正在进行，请稍候。");
    if (owned.current.get(instanceId)?.connection.connected) throw new Error("该摄像头已经连接，请先断开。");
    locks.current.add(instanceId); setBusyIds([...locks.current]); setError("");
    const run = generation.current;
    let stream: MediaStream | undefined;
    let registeredToken: string | undefined;
    try {
      const previous = owned.current.get(instanceId);
      if (previous) {
        releaseTracks(previous);
        await cameraRequest(route(instanceId, "disconnect"), { token: previous.token }).catch(() => {});
        owned.current.delete(instanceId);
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        deviceId: { exact: deviceId },
        width: { ideal: quality === "1080p" ? 1920 : 1280 }, height: { ideal: quality === "1080p" ? 1080 : 720 },
        frameRate: { ideal: 30, max: 30 },
      } });
      if (!mounted.current || generation.current !== run || !current.current.online) throw new Error("摄像头连接已取消。");
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState !== "live") throw new Error("摄像头没有提供可用的视频轨道。");
      const settings = track.getSettings();
      // Missing browser settings are unknown, not the requested ideal capture dimensions.
      const width = settings.width ?? 0;
      const height = settings.height ?? 0;
      const frameRate = settings.frameRate ?? 0;
      const label = track.label || "本机摄像头";
      const registered = await cameraRequest<{ token: string; chunk_limit_bytes?: number }>("/api/cameras/register", {
        body: { instance_id: instanceId, label, width, height, frame_rate: frameRate },
      });
      if (typeof registered?.token !== "string" || !registered.token) throw new Error("采集服务未返回有效的摄像头连接信息。");
      registeredToken = registered.token;
      if (!mounted.current || generation.current !== run || !current.current.online) throw new Error("摄像头连接已取消。");
      const connection: CameraConnection = { instanceId, deviceId: settings.deviceId || deviceId || "", label,
        stream, width, height, frameRate, quality, connected: true, error: null };
      const camera: OwnedCamera = { connection, token: registered.token,
        chunkLimit: Math.min(DEFAULT_CHUNK_LIMIT, registered.chunk_limit_bytes || DEFAULT_CHUNK_LIMIT), closing: false,
        ended: () => failConnection(camera, new Error("摄像头视频轨道已结束，请检查设备连接。")),
      };
      owned.current.set(instanceId, camera);
      track.addEventListener("ended", camera.ended);
      heartbeat(camera); publish();
      await enumerate().catch(() => {});
      await current.current.onDevicesChanged();
      return connection;
    } catch (cause) {
      const failure = cameraAccessError(cause);
      if (stream) stopTracks(stream);
      if (registeredToken) void cameraRequest(route(instanceId, "disconnect"), { token: registeredToken, keepalive: true }).catch(() => {});
      const item = owned.current.get(instanceId);
      if (item && item.token === registeredToken) { releaseTracks(item); owned.current.delete(instanceId); }
      if (mounted.current && generation.current === run) { setError(failure.message); publish(); }
      throw failure;
    } finally {
      if (generation.current === run) { locks.current.delete(instanceId); if (mounted.current) setBusyIds([...locks.current]); }
    }
  }, [assertEditable, enumerate, failConnection, heartbeat, publish, releaseTracks]);

  const disconnect = useCallback(async (instanceId: string) => {
    const camera = owned.current.get(instanceId);
    if (!camera) return;
    if (current.current.recording || phase.current !== "idle") throw new Error("录制期间无法更改摄像头，请先停止录制。");
    if (locks.current.has(instanceId)) throw new Error("摄像头连接操作正在进行，请稍候。");
    locks.current.add(instanceId); setBusyIds([...locks.current]);
    try {
      releaseTracks(camera);
      if (current.current.online) {
        try { await cameraRequest(route(instanceId, "disconnect"), { token: camera.token }); }
        catch (cause) {
          // An expired registration has no live camera to release on the server.
          if (![404, 409, 410].includes((cause as { status?: number })?.status ?? 0)) throw cause;
        }
      } else {
        void cameraRequest(route(instanceId, "disconnect"), { token: camera.token, keepalive: true }).catch(() => {});
      }
      owned.current.delete(instanceId); publish();
      if (current.current.online) await current.current.onDevicesChanged();
    } catch (cause) {
      camera.connection.error = errorOf(cause).message;
      publish(); if (mounted.current) setError(errorOf(cause).message);
      throw cause;
    } finally { locks.current.delete(instanceId); if (mounted.current) setBusyIds([...locks.current]); }
  }, [publish, releaseTracks]);

  const prepareRecording = useCallback(async (instanceIds: string[]): Promise<CameraRecordingSource[]> => {
    if (!mounted.current || !current.current.online) throw new Error("采集服务离线。");
    if (phase.current !== "idle") throw new Error("摄像头录制尚未结束。");
    lastRecordingFailure.current = null;
    sessionOwner.current = null;
    setError("");
    if (instanceIds.length === 0) { phase.current = "prepared"; return []; }
    if (typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持摄像头录制，请更新浏览器。");
    const mime = MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error("当前浏览器没有可用的视频录制格式。");
    try {
      for (const id of new Set(instanceIds)) {
        const camera = owned.current.get(id);
        if (!camera?.connection.connected || camera.closing || camera.connection.stream.getVideoTracks().some(track => track.readyState !== "live"))
          throw new Error("请先连接展示区内的所有摄像头。");
        const recorder = new MediaRecorder(camera.connection.stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
        let resolveStop!: () => void;
        const stopDone = new Promise<void>(resolve => { resolveStop = resolve; });
        const lane: RecordingLane = { camera, recorder, mimeType: recorder.mimeType || mime, sessionId: null,
          started: false, stopRequested: false, stopped: false, discard: false, stopDone, resolveStop,
          tail: Promise.resolve(), queuedBytes: 0, queuedCount: 0, generated: 0, acknowledged: 0,
          failure: null, report: null, startedAt: "", stoppedAt: "", startClock: 0, stopClock: 0 };
        recorder.ondataavailable = event => {
          const blob = event.data;
          if (!blob.size || lane.discard || lane.failure || !lane.sessionId || lanes.current.get(id) !== lane) return;
          if (blob.size > camera.chunkLimit || lane.queuedBytes + blob.size > MAX_QUEUE_BYTES || lane.queuedCount >= MAX_QUEUE_CHUNKS) {
            reportFailure(lane, new Error("视频上传缓冲已满或单块过大，录制已中止以避免丢失数据。")); return;
          }
          const index = lane.generated++;
          lane.queuedBytes += blob.size; lane.queuedCount++;
          lane.tail = lane.tail.then(async () => {
            if (lane.failure || lane.discard) return;
            await cameraRequest(`${route(id, "chunks")}?session_id=${encodeURIComponent(lane.sessionId!)}&index=${index}`, {
              token: camera.token, blob, mime: lane.mimeType, timeout: 20000,
            });
            lane.acknowledged++;
          }).catch(cause => { reportFailure(lane, cause); }).finally(() => {
            lane.queuedBytes -= blob.size; lane.queuedCount--;
          });
        };
        recorder.onstop = () => {
          settleStopped(lane);
          if (lane.started && !lane.stopRequested && !lane.discard)
            reportFailure(lane, new Error("浏览器提前结束了视频录制。"));
        };
        recorder.onerror = event => reportFailure(lane, (event as Event & { error?: DOMException }).error ?? new Error("浏览器视频编码失败。"));
        camera.connection.error = null;
        lanes.current.set(id, lane);
      }
      phase.current = "prepared"; publish();
      return [...lanes.current].map(([instance_id, lane]) => ({ instance_id, token: lane.camera.token, mime_type: lane.mimeType }));
    } catch (cause) {
      for (const lane of lanes.current.values()) detachRecorder(lane);
      lanes.current.clear(); phase.current = "idle";
      setError(errorOf(cause).message); throw cause;
    }
  }, [publish, reportFailure]);

  const stopRecording = useCallback((): Promise<void> => {
    if (stopping.current) return stopping.current;
    if (phase.current === "idle") return lastRecordingFailure.current ? Promise.reject(lastRecordingFailure.current) : Promise.resolve();
    const selected = [...lanes.current.values()];
    phase.current = "stopping";
    const completion = (async () => {
      await Promise.all(selected.map(async lane => {
        if (!lane.started) settleStopped(lane);
        else if (!lane.stopped && !lane.stopRequested) {
          lane.stopRequested = true;
          lane.stopDeadline = setTimeout(() => {
            reportFailure(lane, new Error("等待浏览器结束视频录制超时。"));
            lane.discard = true; settleStopped(lane);
          }, 10000);
          try { if (lane.recorder.state !== "inactive") lane.recorder.stop(); }
          catch (cause) { reportFailure(lane, cause); settleStopped(lane); }
        }
        await lane.stopDone;
        await lane.tail;
        await lane.report;
        // An unfinalized source guarantees an incomplete session even if /error was lost.
        if (lane.sessionId && !lane.failure && !lane.discard) {
          try {
            await cameraRequest(route(lane.camera.connection.instanceId, "finalize"), {
              token: lane.camera.token, body: {
                session_id: lane.sessionId, next_index: lane.acknowledged,
                started_at: lane.startedAt, stopped_at: lane.stoppedAt,
                duration_ms: Math.max(0, lane.stopClock - lane.startClock),
              }, timeout: 20000,
            });
          } catch (cause) { reportFailure(lane, cause); await lane.report; }
        }
        lane.discard = true;
        detachRecorder(lane);
      }));
      const failure = selected.find(lane => lane.failure)?.failure ?? lastRecordingFailure.current;
      if (failure) throw failure;
    })().finally(() => {
      lanes.current.clear(); phase.current = "idle"; stopping.current = null; publish();
    });
    stopping.current = completion;
    return completion;
  }, [publish, reportFailure]);
  stopRef.current = stopRecording;

  const startRecording = useCallback(async (sessionId: string) => {
    if (phase.current !== "prepared") throw new Error("摄像头尚未准备好录制。");
    if (!sessionId) throw new Error("录制会话标识无效。");
    phase.current = "recording";
    sessionOwner.current = sessionId;
    const selected = [...lanes.current.values()];
    for (const lane of selected) {
      lane.sessionId = sessionId; lane.startedAt = new Date().toISOString(); lane.startClock = performance.now();
    }
    try {
      for (const lane of selected) {
        if (!lane.camera.connection.connected || lane.camera.closing) throw new Error("摄像头在开始录制前已断开。");
        lane.recorder.start(1000); lane.started = true;
      }
    } catch (cause) {
      // Mark every registered source, including recorders that failed before producing a chunk.
      phase.current = "stopping";
      for (const lane of selected) reportFailure(lane, cause);
      await stopRecording().catch(() => {});
      throw cause;
    }
  }, [reportFailure, stopRecording]);

  const cancelPrepared = useCallback(async () => {
    if (phase.current !== "prepared") return;
    for (const lane of lanes.current.values()) { lane.discard = true; detachRecorder(lane); }
    lanes.current.clear(); phase.current = "idle";
  }, []);

  useEffect(() => {
    mounted.current = true; generation.current++;
    const leave = () => {
      generation.current++;
      enumerationSequence.current++;
      for (const lane of lanes.current.values()) {
        lane.discard = true;
        if (lane.sessionId) void cameraRequest(route(lane.camera.connection.instanceId, "error"), {
          token: lane.camera.token, body: { session_id: lane.sessionId, error: "摄像头采集页面已关闭或离开。" }, keepalive: true,
        }).catch(() => {});
        detachRecorder(lane);
        try { if (lane.recorder.state !== "inactive") lane.recorder.stop(); } catch { /* Tracks are released below. */ }
        settleStopped(lane);
      }
      for (const camera of owned.current.values()) {
        releaseTracks(camera);
        void cameraRequest(route(camera.connection.instanceId, "disconnect"), { token: camera.token, keepalive: true }).catch(() => {});
      }
      owned.current.clear(); lanes.current.clear(); phase.current = "idle"; locks.current.clear(); scanLock.current = false;
      sessionOwner.current = null;
      if (mounted.current) { setBusyIds([]); setScanning(false); }
      publish();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false; generation.current++;
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [publish, releaseTracks]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    let disposed = false;
    let permission: PermissionStatus | undefined;
    const run = generation.current;
    // Passive discovery never requests camera access, starts tracks, or clears recording errors.
    const refresh = () => { if (!disposed && mounted.current) void enumerate().catch(() => {}); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    mediaDevices.addEventListener?.("devicechange", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    refresh();
    if (navigator.permissions?.query) {
      void navigator.permissions.query({ name: "camera" as PermissionName }).then(status => {
        if (disposed || !mounted.current || generation.current !== run) return;
        permission = status;
        permission.addEventListener("change", refresh);
      }).catch(() => {});
    }
    return () => {
      disposed = true;
      mediaDevices.removeEventListener?.("devicechange", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
      permission?.removeEventListener("change", refresh);
    };
  }, [enumerate]);

  useEffect(() => {
    if (!options.online) for (const camera of owned.current.values())
      failConnection(camera, new Error("采集服务连接中断，摄像头已停止。"));
  }, [options.online, failConnection]);

  const recordingSessionId = useCallback(() => sessionOwner.current, []);
  return { devices, connections, busyIds, scanning, error, scan, connect, disconnect,
    prepareRecording, startRecording, recordingSessionId, stopRecording, cancelPrepared };
}
