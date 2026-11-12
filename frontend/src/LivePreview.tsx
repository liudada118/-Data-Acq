import { memo, useEffect, useRef, useState } from "react";
import {
  Activity,
  Camera,
  Maximize2,
  Mic,
  Minimize2,
  ScanLine,
} from "lucide-react";
import { subscribePreview } from "./preview";
import type { Device, DeviceKind, Preview } from "./types";

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

function heatColor(value: number): string {
  const stops = [
    [16, 49, 45],
    [35, 108, 81],
    [108, 171, 98],
    [221, 213, 111],
    [249, 163, 94],
    [211, 76, 64],
  ];
  const position = Math.max(0, Math.min(0.999, value)) * (stops.length - 1);
  const index = Math.floor(position);
  const fraction = position - index;
  const color = stops[index].map((component, channel) =>
    Math.round(component + (stops[index + 1][channel] - component) * fraction),
  );
  return `rgb(${color.join(",")})`;
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
}: {
  device: Device;
  enabled: boolean;
  paused: boolean;
  connected: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestRef = useRef<Preview | null>(null);
  const historyRef = useRef<number[][]>([]);
  const imageRef = useRef<HTMLCanvasElement | null>(null);
  const lastSequenceRef = useRef(-1);
  const displayEnabledRef = useRef(enabled && !paused && connected);
  displayEnabledRef.current = enabled && !paused && connected;
  const [values, setValues] = useState<number[]>([]);
  const [timestamp, setTimestamp] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const info = metadata[device.kind];

  useEffect(() => {
    function render(preview: Preview) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = prepareCanvas(canvas);
      if (!ctx) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (device.kind === "camera" && preview.camera) {
        const frame = preview.camera;
        if (frame.sequence !== lastSequenceRef.current && frame.rgb_base64) {
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
          const scale = Math.min(width / frame.width, height / frame.height);
          const w = frame.width * scale;
          const h = frame.height * scale;
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(
            imageRef.current,
            (width - w) / 2,
            (height - h) / 2,
            w,
            h,
          );
        }
        // A subtle sensor reticle helps distinguish the generated calibration view.
        ctx.strokeStyle = "rgba(255,255,255,.5)";
        ctx.lineWidth = 1;
        const cx = width / 2;
        const cy = height / 2;
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy);
        ctx.lineTo(cx + 9, cy);
        ctx.moveTo(cx, cy - 9);
        ctx.lineTo(cx, cy + 9);
        ctx.stroke();
      } else if (device.kind === "pressure" && preview.pressure) {
        const pressure = preview.pressure;
        ctx.fillStyle = "#f3f5ef";
        ctx.fillRect(0, 0, width, height);
        const gridSize = Math.min(height - 14, width - 52);
        const x = (width - gridSize) / 2 - 12;
        const y = (height - gridSize) / 2;
        const maximum = Math.max(1, ...pressure.values);
        const cellWidth = gridSize / pressure.cols;
        const cellHeight = gridSize / pressure.rows;
        pressure.values.forEach((value, index) => {
          ctx.fillStyle = heatColor(value / maximum);
          ctx.fillRect(
            x + (index % pressure.cols) * cellWidth,
            y + Math.floor(index / pressure.cols) * cellHeight,
            cellWidth - 0.7,
            cellHeight - 0.7,
          );
        });
        const legendX = x + gridSize + 16;
        for (let i = 0; i < gridSize; i++) {
          ctx.fillStyle = heatColor(1 - i / gridSize);
          ctx.fillRect(legendX, y + i, 6, 1.4);
        }
        ctx.fillStyle = "#6b766f";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(maximum.toFixed(0), legendX + 10, y + 8);
        ctx.fillText("0", legendX + 10, y + gridSize);
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
    const unsubscribe = subscribePreview((preview) => {
      latestRef.current = preview;
      if (!displayEnabledRef.current) return;
      if (device.kind === "imu" && preview.imu) {
        historyRef.current.push(preview.imu.values);
        if (historyRef.current.length > 100) historyRef.current.shift();
      }
      if (device.kind === "pressure" && preview.pressure) {
        const data = preview.pressure.values;
        setValues([
          Math.max(0, ...data),
          data.reduce((sum, v) => sum + v, 0) / Math.max(data.length, 1),
        ]);
      } else if (device.kind === "imu" && preview.imu)
        setValues(preview.imu.values);
      else if (device.kind === "audio" && preview.audio)
        setValues([preview.audio.rms]);
      else if (device.kind === "camera" && preview.camera)
        setValues([preview.camera.sequence]);
      setTimestamp(preview.timestamp_s ?? 0);
      render(preview);
    });
    const observer = new ResizeObserver(() => {
      if (displayEnabledRef.current && latestRef.current)
        render(latestRef.current);
    });
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, [device.kind]);

  const rate =
    device.kind === "audio"
      ? `${device.sample_rate / 1000} kHz`
      : `${device.sample_rate} ${device.kind === "camera" ? "fps" : "Hz"}`;
  return (
    <section
      className={`preview-card ${expanded ? "preview-expanded" : ""} ${!enabled ? "preview-unselected" : ""}`}
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
          <p>{device.name}</p>
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
      <div className={`preview-canvas-wrap canvas-${device.kind}`}>
        <canvas
          ref={canvasRef}
          aria-label={`${info.title}模拟数据实时预览`}
          role="img"
        />
        {device.kind === "camera" && (
          <>
            <span className="camera-label mono">SIMULATED INPUT</span>
            <span className="camera-time mono">
              T + {timestamp.toFixed(2)} s
            </span>
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
                    : "等待预览数据"}
            </span>
          </div>
        )}
      </div>
      <div className="preview-footer mono">
        {device.kind === "camera" && (
          <>
            <span>
              {device.width ?? 160} × {device.height ?? 90} · RGB8
            </span>
            <span>帧 #{Math.floor(values[0] ?? 0).toLocaleString()}</span>
          </>
        )}
        {device.kind === "pressure" && (
          <>
            <span>
              {device.rows ?? 16} × {device.cols ?? 16} 阵列
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
        {device.kind === "imu" && (
          <>
            <div className="axis-legend">
              <span className="axis-x">X {(values[0] ?? 0).toFixed(2)}</span>
              <span className="axis-y">Y {(values[1] ?? 0).toFixed(2)}</span>
              <span className="axis-z">Z {(values[2] ?? 0).toFixed(2)}</span>
            </div>
            <span>m/s²</span>
          </>
        )}
      </div>
    </section>
  );
});

export function getDeviceLabel(kind: DeviceKind) {
  return metadata[kind]?.title ?? kind;
}
