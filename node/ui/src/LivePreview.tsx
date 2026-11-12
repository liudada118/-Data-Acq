import { memo, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Camera,
  Maximize2,
  Mic,
  Minimize2,
  ScanLine,
  Settings2,
} from "lucide-react";
import { subscribePreview } from "./preview";
import { drawPressure, pressureDescription, pressureValues } from "./pressure-renderer";
import { NumericPressureView } from "./NumericPressureView";
import { decodeJpegPreview, LatestJpegDecoder } from "./jpeg-preview";
import { subscribeCameraPreview } from "./camera-preview-stream";
import { readPressureDisplay, readPressureRange, savePressureDisplay, savePressureRange } from "./pressure-display";
import { defaultPressureMaximum, formatPressureMaximum, isPressureMaximum, resolvePressureRange } from "./pressure-range";
import type { PressureRangeSettings } from "./pressure-range";
import type { CameraQuality, Device, DeviceKind, PressurePreview, Preview } from "./types";
import type { PressureDisplayMode } from "./pressure-display";
import {
  deviceModeLabel,
  deviceSampleRate,
  isSimulatedDevice,
  sensorDisplayName,
} from "./devices";

const metadata = {
  camera: {
    title: "视觉",
    subtitle: "RGB CAMERA",
    color: "#5877a2",
    Icon: Camera,
  },
  pressure: {
    title: "触觉",
    subtitle: "PRESSURE ARRAY",
    color: "#218167",
    Icon: ScanLine,
  },
  audio: {
    title: "声音",
    subtitle: "AUDIO INPUT",
    color: "#9971aa",
    Icon: Mic,
  },
  imu: {
    title: "运动",
    subtitle: "INERTIAL SENSOR",
    color: "#c18238",
    Icon: Activity,
  },
};

function prepareCanvas(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  return context;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dark = false,
) {
  ctx.strokeStyle = dark ? "rgba(255,255,255,.08)" : "#e8ece6";
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = Math.round((height * i) / 5) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (let i = 1; i < 9; i++) {
    const x = Math.round((width * i) / 9) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

export const LivePreview = memo(function LivePreview({
  device,
  enabled,
  paused,
  connected,
  visible = true,
  embedded = false,
  cardContentFullscreen = false,
  settingsContainer,
  summaryContainer,
  snapshot: replaySnapshot,
}: {
  device: Device;
  enabled: boolean;
  paused: boolean;
  connected: boolean;
  visible?: boolean;
  embedded?: boolean;
  cardContentFullscreen?: boolean;
  /** undefined keeps local controls; null reserves controls for a pending external slot. */
  settingsContainer?: HTMLElement | null;
  /** An acquisition status-bar slot; null reserves the slot while it mounts. */
  summaryContainer?: HTMLElement | null;
  snapshot?: Preview | null;
}) {
  const externalSettings = settingsContainer !== undefined;
  const externalSummary = device.kind === "pressure" && summaryContainer !== undefined;
  const displayName = sensorDisplayName(device.name);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestRef = useRef<Preview | null>(null);
  const shownRef = useRef<Preview | null>(null);
  const renderRef = useRef<((preview: Preview) => void) | null>(null);
  const historyRef = useRef<number[][]>([]);
  const imageRef = useRef<HTMLCanvasElement | null>(null);
  const jpegDecoderRef = useRef<LatestJpegDecoder<ImageBitmap> | null>(null);
  const lastSequenceRef = useRef(-1);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const displayEnabledRef = useRef(enabled && !paused && connected && visible && documentVisible);
  displayEnabledRef.current = enabled && !paused && connected && visible && documentVisible;
  const [values, setValues] = useState<number[]>([]);
  const [timestamp, setTimestamp] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [cameraQuality, setCameraQuality] = useState<CameraQuality | undefined>();
  const [jpegDecodeFailures, setJpegDecodeFailures] = useState(0);
  const [cameraPreviewError, setCameraPreviewError] = useState("");
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const displaySettingsRef = useRef<HTMLDivElement>(null);
  const displaySettingsButton = useRef<HTMLButtonElement>(null);
  const displaySettingsId = useId();
  const defaultPressureMode = device.metadata?.product === "glove" ? "numbers" : "heatmap";
  const [pressureMode, setPressureMode] = useState<PressureDisplayMode>(() => readPressureDisplay(device.id, defaultPressureMode));
  const [pressureFrame, setPressureFrame] = useState<PressurePreview | null>(null);
  const [pressureRange, setPressureRange] = useState<PressureRangeSettings>(() => readPressureRange(device.id));
  const defaultMaximum = defaultPressureMaximum(pressureFrame?.full_scale ?? device.metadata?.full_scale, device.dtype);
  const [maximumDraft, setMaximumDraft] = useState(() => String(pressureRange.maximum ?? defaultMaximum));
  const [rangeError, setRangeError] = useState("");
  const rangeErrorId = useId();
  const pressureRangeRef = useRef(pressureRange);
  pressureRangeRef.current = pressureRange;
  const pressureModeRef = useRef(pressureMode);
  pressureModeRef.current = pressureMode;
  const rawImu = device.kind === "imu" && device.preview_supported === false;
  const liveMjpeg = replaySnapshot === undefined && device.kind === "camera" &&
    device.metadata?.pixel_format === "mjpeg" &&
    (device.mode === "sdk-plugin" || device.mode === "plugin" || !!device.metadata.plugin_id);
  const info = rawImu
    ? { ...metadata.imu, title: "IMU 原始数据", subtitle: "UNPARSED BYTES" }
    : metadata[device.kind];

  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    const decoder = new LatestJpegDecoder(decodeJpegPreview, (bitmap, frame) => {
      const image = imageRef.current ?? document.createElement("canvas");
      image.width = bitmap.width;
      image.height = bitmap.height;
      const context = image.getContext("2d");
      if (!context) throw new Error("无法创建摄像头预览画布");
      context.drawImage(bitmap, 0, 0);
      imageRef.current = image;
      lastSequenceRef.current = frame.sequence;
      if (frame.timestamp_s !== undefined) {
        setTimestamp(frame.timestamp_s);
        setValues([frame.sequence]);
      }
      setCameraPreviewError("");
      if (displayEnabledRef.current && shownRef.current) renderRef.current?.(shownRef.current);
    }, () => {
      setJpegDecodeFailures(value => value + 1);
      setCameraPreviewError("当前帧无法解码预览；原始 MJPEG 采集不受预览解码影响。");
    });
    jpegDecoderRef.current = decoder;
    return () => { decoder.dispose(); jpegDecoderRef.current = null; };
  }, []);

  useEffect(() => {
    jpegDecoderRef.current?.reset();
    imageRef.current = null;
    lastSequenceRef.current = -1;
    setJpegDecodeFailures(0);
    setCameraPreviewError("");
    setCameraQuality(undefined);
  }, [device.id, connected]);

  useEffect(() => {
    if (!cardContentFullscreen || externalSettings || !displaySettingsOpen) return;
    const pointerdown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!displaySettingsRef.current?.contains(target) && !displaySettingsButton.current?.contains(target)) setDisplaySettingsOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || (event.target as Element | null)?.closest?.("dialog")) return;
      event.preventDefault(); event.stopPropagation(); setDisplaySettingsOpen(false); displaySettingsButton.current?.focus();
    };
    document.addEventListener("pointerdown", pointerdown);
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("pointerdown", pointerdown); document.removeEventListener("keydown", keydown, true); };
  }, [cardContentFullscreen, externalSettings, displaySettingsOpen]);

  useEffect(() => {
    setPressureMode(readPressureDisplay(device.id, defaultPressureMode));
    setPressureRange(readPressureRange(device.id));
    setRangeError("");
    setPressureFrame(null);
    latestRef.current = null;
    shownRef.current = null;
  }, [device.id, defaultPressureMode]);

  useEffect(() => {
    setMaximumDraft(String(pressureRange.maximum ?? defaultMaximum));
  }, [device.id, pressureRange.maximum, defaultMaximum]);

  useEffect(() => {
    function render(preview: Preview) {
      if (device.kind === "pressure" && pressureModeRef.current === "numbers") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = prepareCanvas(canvas);
      if (!ctx) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (rawImu && preview.raw) {
        ctx.fillStyle = "#fafaf8";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#52634f";
        ctx.font = "14px ui-monospace, monospace";
        const bytes = preview.raw.values;
        for (let row = 0; row < Math.ceil(bytes.length / 8); row++) {
          const line = bytes
            .slice(row * 8, row * 8 + 8)
            .map((value) => value.toString(16).padStart(2, "0").toUpperCase())
            .join(" ");
          ctx.fillText(line, 18, height / 2 - 16 + row * 28);
        }
        ctx.font = "12px sans-serif";
        ctx.fillStyle = "#687963";
        ctx.fillText("保留原始字节 · 未进行六轴解码", 18, height - 22);
      } else if (device.kind === "camera" && preview.camera) {
        const frame = preview.camera;
        if (frame.jpeg_base64 || frame.jpeg_bytes) {
          jpegDecoderRef.current?.offer({ ...frame });
        } else if (frame.sequence !== lastSequenceRef.current && frame.rgb_base64) {
          try {
            const bytes = atob(frame.rgb_base64);
            if (bytes.length >= frame.width * frame.height * 3) {
              const pixels = new Uint8ClampedArray(
                frame.width * frame.height * 4,
              );
              for (let p = 0, i = 0; p < pixels.length; p += 4, i += 3) {
                pixels[p] = bytes.charCodeAt(i);
                pixels[p + 1] = bytes.charCodeAt(i + 1);
                pixels[p + 2] = bytes.charCodeAt(i + 2);
                pixels[p + 3] = 255;
              }
              const image =
                imageRef.current ?? document.createElement("canvas");
              image.width = frame.width;
              image.height = frame.height;
              image
                .getContext("2d")
                ?.putImageData(
                  new ImageData(pixels, frame.width, frame.height),
                  0,
                  0,
                );
              imageRef.current = image;
              lastSequenceRef.current = frame.sequence;
            }
          } catch {
            /* An invalid frame leaves the last valid preview visible. */
          }
        }
        ctx.fillStyle = "#14211e";
        ctx.fillRect(0, 0, width, height);
        if (imageRef.current) {
          const scale = Math.min(width / imageRef.current.width, height / imageRef.current.height);
          const w = imageRef.current.width * scale;
          const h = imageRef.current.height * scale;
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(
            imageRef.current,
            (width - w) / 2,
            (height - h) / 2,
            w,
            h,
          );
        }
      } else if (device.kind === "pressure" && preview.pressure) {
        drawPressure(ctx, width, height, preview.pressure, pressureRangeRef.current);
      } else if (device.kind === "audio" && preview.audio) {
        ctx.fillStyle = "#fafaf8";
        ctx.fillRect(0, 0, width, height);
        drawGrid(ctx, width, height);
        const wave = preview.audio.waveform;
        ctx.strokeStyle = "#8b6a9b";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        wave.forEach((value, index) => {
          const x = (index / Math.max(1, wave.length - 1)) * width;
          const y = height / 2 - value * height * 0.42;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = "#89938b";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText("+1.0", 7, 13);
        ctx.fillText("−1.0", 7, height - 6);
      } else if (device.kind === "imu" && preview.imu) {
        ctx.fillStyle = "#fafaf8";
        ctx.fillRect(0, 0, width, height);
        drawGrid(ctx, width, height);
        const history = historyRef.current;
        const scale = Math.max(
          12,
          ...history.flatMap((row) => row.slice(0, 3).map(Math.abs)),
        );
        ["#c38842", "#27816e", "#8b7caf"].forEach((color, channel) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          history.forEach((row, index) => {
            const x = width - ((history.length - 1 - index) * width) / 99;
            const y =
              height / 2 - ((row[channel] ?? 0) / scale) * height * 0.39;
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        });
        ctx.fillStyle = "#89938b";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(`+${scale.toFixed(0)}`, 7, 13);
        ctx.fillText(`−${scale.toFixed(0)}`, 7, height - 6);
      }
    }
    const receive = (snapshot: Preview) => {
      const stream = snapshot.streams?.[device.id];
      // SDK data must never inherit a simulated stream of the same modality.
      const preview = stream
        ? { ...stream, timestamp_s: stream.timestamp_s ?? snapshot.timestamp_s }
        : device.mode === "simulated"
          ? snapshot
          : null;
      if (!preview || (!preview[device.kind] && !preview.raw)) return;
      if (liveMjpeg && preview.camera?.binary_preview) {
        // JSON carries quality/status only. A slower snapshot must not replace the live image or clock.
        setCameraQuality(preview.camera.quality);
        if (preview.camera.preview_status) {
          setCameraPreviewError(preview.camera.preview_status === "invalid-jpeg"
            ? "当前 JPEG 帧结构异常，无法预览；原始帧保留供检查。"
            : preview.camera.preview_status === "unsupported-jpeg"
              ? "不支持此 JPEG 格式预览；原始数据仍保留。"
              : "当前 JPEG 帧超过预览大小限制；原始采集不受影响。");
        }
        return;
      }
      latestRef.current = preview;
      if (!displayEnabledRef.current) return;
      shownRef.current = preview;
      if (device.kind === "imu" && preview.imu) {
        if (replaySnapshot !== undefined) historyRef.current = [];
        historyRef.current.push(preview.imu.values);
        if (historyRef.current.length > 100) historyRef.current.shift();
      }
      if (rawImu && preview.raw) {
        setValues(preview.raw.values);
      } else if (device.kind === "pressure" && preview.pressure) {
        setPressureFrame(preview.pressure);
        const data = pressureValues(preview.pressure);
        setValues([
          Math.max(0, ...data),
          data.reduce((sum, v) => sum + v, 0) / Math.max(data.length, 1),
        ]);
      } else if (device.kind === "imu" && preview.imu)
        setValues(preview.imu.values);
      else if (device.kind === "audio" && preview.audio)
        setValues([preview.audio.rms]);
      else if (device.kind === "camera" && preview.camera) {
        setValues([preview.camera.sequence]);
        setCameraQuality(preview.camera.quality);
        if (preview.camera.preview_status) {
          jpegDecoderRef.current?.reset();
          imageRef.current = null;
          setCameraPreviewError(preview.camera.preview_status === "invalid-jpeg"
            ? "当前 JPEG 帧结构异常，无法预览；原始帧保留供检查。"
            : preview.camera.preview_status === "unsupported-jpeg"
              ? "不支持此 JPEG 格式预览；原始数据仍保留。"
              : "当前 JPEG 帧超过预览大小限制；原始采集不受影响。");
        } else if (!preview.camera.jpeg_base64) setCameraPreviewError("");
      }
      setTimestamp(preview.timestamp_s ?? 0);
      render(preview);
    };
    renderRef.current = render;
    let unsubscribe = () => {};
    if (replaySnapshot === undefined) unsubscribe = subscribePreview(receive);
    else if (replaySnapshot) receive({ timestamp_s: replaySnapshot.timestamp_s, streams: { [device.id]: replaySnapshot } });
    else {
      jpegDecoderRef.current?.reset();
      imageRef.current = null;
      latestRef.current = null;
      shownRef.current = null;
      setPressureFrame(null);
      if (canvasRef.current) prepareCanvas(canvasRef.current);
      setValues([]);
      setTimestamp(0);
    }
    const observer = new ResizeObserver(() => {
      if (displayEnabledRef.current && latestRef.current)
        render(latestRef.current);
    });
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => {
      jpegDecoderRef.current?.reset();
      unsubscribe();
      observer.disconnect();
      renderRef.current = null;
    };
  }, [device.id, device.kind, device.mode, rawImu, replaySnapshot, liveMjpeg]);

  useEffect(() => {
    if (!liveMjpeg || !enabled || paused || !connected || !visible || !documentVisible) return;
    const unsubscribe = subscribeCameraPreview(device.id, frame => {
      if (!displayEnabledRef.current) return;
      const preview: Preview = { timestamp_s: frame.timestamp_s, camera: frame };
      latestRef.current = preview;
      shownRef.current = preview;
      jpegDecoderRef.current?.offer(frame);
    }, retrying => {
      setCameraPreviewError(retrying ? "实时画面连接中断，正在重试。" : "实时画面连接中断，请暂停后恢复预览。");
    });
    return () => {
      unsubscribe();
      jpegDecoderRef.current?.reset();
    };
  }, [device.id, liveMjpeg, enabled, paused, connected, visible, documentVisible]);

  // Switching display modes also works for a stationary replay or paused frame.
  useEffect(() => {
    if (pressureMode === "heatmap" && shownRef.current) renderRef.current?.(shownRef.current);
  }, [pressureMode, pressureRange]);

  function changePressureRange(next: PressureRangeSettings) {
    setPressureRange(next);
    savePressureRange(device.id, next);
    setRangeError("");
  }

  const rate = deviceSampleRate(device);
  const cameraQualityText = cameraQuality ? [
    cameraQuality.source_sequence_status === "unknown" ? "源序号未提供" : `源序号缺口 ${cameraQuality.source_missing_frames ?? "未知"}${cameraQuality.source_sequence_status === "partial" ? "（部分帧有序号）" : ""}`,
    cameraQuality.source_duplicates ? `重复 ${cameraQuality.source_duplicates}` : "",
    cameraQuality.source_reversals ? `倒序 ${cameraQuality.source_reversals}` : "",
    `JPEG 结构异常 ${cameraQuality.invalid_jpeg_frames}`,
    cameraQuality.jpeg_warning_frames ? `JPEG 警告 ${cameraQuality.jpeg_warning_frames}` : "",
  ].filter(Boolean).join(" · ") : "";
  const cameraQualityWarning = !!(cameraQuality?.source_missing_frames && cameraQuality.source_missing_frames !== "0") ||
    !!cameraQuality?.source_duplicates || !!cameraQuality?.source_reversals || !!cameraQuality?.invalid_jpeg_frames || jpegDecodeFailures > 0;
  const colorRange = resolvePressureRange(pressureRange, pressureFrame ? pressureValues(pressureFrame) : [], defaultMaximum);
  const pressureUnit = device.unit || "a.u.";
  const pressureSummary = pressureFrame ? pressureDescription(pressureFrame) : `${device.rows ?? 16} × ${device.cols ?? 16} 阵列`;
  const pressurePeak = <span className="preview-pressure-peak" title="当前预览帧的峰值；预览暂停时保留已显示的值。">
    峰值 {pressureFrame && connected ? (values[0] ?? 0).toFixed(1) : "—"} <span className="unit">{pressureUnit}</span>
  </span>;
  const pressureSettings = device.kind === "pressure" ? (
    <div ref={displaySettingsRef} id={displaySettingsId} className={`preview-display-settings ${externalSettings ? "preview-settings-embedded" : ""}`} hidden={!externalSettings && cardContentFullscreen && !displaySettingsOpen}>
      {externalSummary && <p className="pressure-data-summary mono">{pressureSummary}</p>}
      <div className="pressure-display-toolbar" role="group" aria-label={`${displayName}渲染方式`}>
        <span>显示方式</span>
        {([['heatmap', '热力图'], ['numbers', '2D 数字']] as const).map(([mode, label]) => <button
          type="button" key={mode} aria-pressed={pressureMode === mode}
          onClick={() => { setPressureMode(mode); savePressureDisplay(device.id, mode); }}
        >{label}</button>)}
        {pressureMode === "heatmap" && <form className="pressure-range-controls" noValidate onSubmit={event => {
          event.preventDefault();
          const maximum = maximumDraft.trim() ? Number(maximumDraft) : NaN;
          if (!isPressureMaximum(maximum)) {
            setRangeError("请输入大于 0 的有限数值，且不超过 9007199254740991。");
            return;
          }
          changePressureRange({ mode: "fixed", maximum });
        }}>
          <label><span>热图量程</span><select aria-label={`${displayName}热图量程`} value={pressureRange.mode}
            onChange={event => changePressureRange({ mode: event.target.value as PressureRangeSettings["mode"],
              maximum: pressureRange.maximum ?? defaultMaximum })}>
            <option value="auto">自动（逐帧）</option>
            <option value="fixed">固定</option>
          </select></label>
          {pressureRange.mode === "fixed" && <>
            <label className="pressure-range-maximum"><span>上限（{pressureUnit}）</span><input type="number" step="any" min="0"
              aria-label={`${displayName}热图量程上限`} value={maximumDraft} aria-invalid={!!rangeError}
              aria-describedby={rangeError ? rangeErrorId : undefined}
              onChange={event => setMaximumDraft(event.target.value)} /></label>
            <button type="submit">应用</button>
          </>}
        </form>}
      </div>
      {pressureMode === "heatmap" && <>
        {rangeError && <p id={rangeErrorId} className="pressure-range-error" role="alert">{rangeError}</p>}
      </>}
      </div>
  ) : null;

  return (
    <section
      className={`preview-card ${embedded ? "workspace-preview" : ""} ${cardContentFullscreen ? "card-content-preview" : ""} ${externalSummary ? "preview-summary-merged" : ""} ${expanded ? "preview-expanded" : ""} ${!enabled ? "preview-unselected" : ""}`}
    >
      <div className="preview-heading">
        <span className={`modality-icon modality-${device.kind}`}>
          <info.Icon size={17} strokeWidth={1.8} />
        </span>
        <div className="preview-title">
          <h3>
            {info.title}
            <span>{info.subtitle}</span>
          </h3>
          <p>{displayName}</p>
        </div>
        <span className="rate-label mono">{rate}</span>
        <button
          className="icon-button quiet"
          onClick={() => setExpanded(!expanded)}
          aria-label={
            expanded ? `缩小${info.title}预览` : `放大${info.title}预览`
          }
          title={expanded ? "缩小预览" : "放大预览"}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
      {device.kind === "pressure" && cardContentFullscreen && !externalSettings && <button ref={displaySettingsButton} type="button" className="button secondary small preview-display-toggle"
        aria-expanded={displaySettingsOpen} aria-controls={displaySettingsId} aria-label={`${displayName}显示设置`}
        onClick={() => setDisplaySettingsOpen(value => !value)}><Settings2 size={14} /><span>显示设置</span></button>}
      {externalSettings ? settingsContainer && createPortal(pressureSettings, settingsContainer) : pressureSettings}
      {externalSummary && summaryContainer && createPortal(pressurePeak, summaryContainer)}
      {device.kind === "pressure" && pressureMode === "heatmap" && <>
        <div className="pressure-color-scale">
          <span className="pressure-color-gradient" aria-hidden="true" />
          <span>{pressureRange.mode === "auto" ? "自动逐帧" : "固定量程"} · {pressureFrame || pressureRange.mode === "fixed"
            ? `0–${formatPressureMaximum(colorRange.maximum)} ${pressureUnit}` : "等待数据"}</span>
          <span className="pressure-range-help">{pressureRange.mode === "auto" ? "颜色逐帧变化；对比请用固定量程" : "范围外颜色饱和；原始值保留"}</span>
        </div>
        {(colorRange.above > 0 || colorRange.below > 0) && <p className="pressure-range-warning" role="status">
          {[colorRange.above > 0 ? `${colorRange.above} 个点高于上限` : "", colorRange.below > 0 ? `${colorRange.below} 个点低于 0` : ""].filter(Boolean).join("，")}，颜色已饱和，原始值保留。
        </p>}
      </>}
      <div className={`preview-canvas-wrap canvas-${device.kind} ${device.kind === "pressure" && device.metadata?.product === "body" ? "pressure-regions" : ""} ${device.kind === "pressure" && device.metadata?.product === "glove" ? "pressure-glove" : ""}`}>
        <canvas
          ref={canvasRef}
          style={device.kind === "pressure" && pressureMode === "numbers" ? { display: "none" } : undefined}
          aria-label={`${displayName} ${deviceModeLabel(device)}${replaySnapshot === undefined ? "实时预览" : "录制回放"}`}
          role="img"
        />
        {device.kind === "pressure" && pressureMode === "numbers" && <NumericPressureView pressure={pressureFrame} name={displayName} unit={device.unit} controlsContainer={settingsContainer} />}
        {device.kind === "camera" && (
          <>
            <span className="camera-label mono">
              {isSimulatedDevice(device) ? "SIMULATED INPUT" : "SDK INPUT"}
            </span>
            <span className="camera-time mono">
              T + {timestamp.toFixed(2)} s
            </span>
            {(cameraQualityText || jpegDecodeFailures > 0) && <div className={`camera-quality${cameraQualityWarning ? " camera-quality-warning" : ""}`}
              title="源序号缺口统计 SDK 输出中缺少的设备帧号，与录制队列丢弃数和预览抽帧不同。预览解码异常不会停止原始 MJPEG 保存。JPEG 结构检查通过不代表图像解码已验证。">
              {cameraQualityText}{jpegDecodeFailures > 0 ? ` · 预览解码异常 ${jpegDecodeFailures}` : ""}
            </div>}
            {cameraPreviewError && connected && enabled && !paused && <div className="preview-overlay camera-decode-error" role="status"><span>{cameraPreviewError}</span></div>}
          </>
        )}
        {(!connected || paused || !enabled || !latestRef.current) && (
          <div
            className={`preview-overlay ${!connected ? "offline-overlay" : ""}`}
          >
            <span>
              {!connected
                ? "采集服务未连接"
                : paused
                  ? "预览已暂停 · 录制不受影响"
                  : !enabled
                    ? "未加入采集组合"
                    : replaySnapshot === undefined ? "等待预览数据" : "此时刻尚无已保存数据"}
            </span>
          </div>
        )}
      </div>
      {!externalSummary && <div className="preview-footer mono">
        {device.kind === "camera" && (
          <>
            <span>
              {device.width ?? 160} × {device.height ?? 90} · {device.metadata?.pixel_format === "mjpeg" ? "原始 MJPEG" : "RGB8"}
            </span>
            <span>帧 #{Math.floor(values[0] ?? 0).toLocaleString()}</span>
          </>
        )}
        {device.kind === "pressure" && (
          <>
            <span>
              {pressureSummary}
            </span>
            <span>
              峰值 {(values[0] ?? 0).toFixed(1)}{" "}
              <span className="unit">{device.unit || "a.u."}</span>
            </span>
          </>
        )}
        {device.kind === "audio" && (
          <>
            <span>单声道 · FLOAT32</span>
            <span>RMS {(values[0] ?? 0).toFixed(3)}</span>
          </>
        )}
        {rawImu && (
          <>
            <span>{values.length || device.shape?.[0] || 16} 字节 · UINT8</span>
            <span>协议待解码</span>
          </>
        )}
        {device.kind === "imu" && !rawImu && (
          <>
            <div className="axis-legend">
              <span className="axis-x">X {(values[0] ?? 0).toFixed(2)}</span>
              <span className="axis-y">Y {(values[1] ?? 0).toFixed(2)}</span>
              <span className="axis-z">Z {(values[2] ?? 0).toFixed(2)}</span>
            </div>
            <span>m/s²</span>
          </>
        )}
      </div>}
    </section>
  );
});

export function getDeviceLabel(kind: DeviceKind) {
  return metadata[kind]?.title ?? kind;
}
