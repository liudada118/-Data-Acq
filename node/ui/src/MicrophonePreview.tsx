import { useEffect, useRef, useState } from "react";
import { Info, Pause } from "lucide-react";
import type { MicrophoneConnection } from "./microphone-types";

interface MicrophonePreviewProps {
  connection: MicrophoneConnection;
  paused: boolean;
  visible?: boolean;
  recording: boolean;
  recordingError?: string;
}

/** Draw a read-only audio monitor; capture and audio graph lifetime belong to the hook. */
export function MicrophonePreview({ connection, paused, visible = true, recording, recordingError }: MicrophonePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const levelRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const [inputNotice, setInputNotice] = useState("");
  const noticeRef = useRef("");
  const interrupted = connection.error || recordingError;

  useEffect(() => {
    const updateNotice = (message: string) => {
      if (noticeRef.current === message) return;
      noticeRef.current = message;
      setInputNotice(message);
    };
    updateNotice("");
    const canvas = canvasRef.current;
    if (!canvas || paused || !visible) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const analyser = connection.analyser;
    const samples = new Float32Array(analyser.fftSize);
    let width = 1, height = 1, frame = 0, lastFrame = -Infinity, lastMeter = -Infinity;
    let disposed = false;
    let quietSince: number | null = null;
    const resetObservation = () => { quietSince = null; lastMeter = -Infinity; updateNotice(""); };

    /** Resize the bitmap only when layout changes, not for every audio sample. */
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", resetObservation);
    resize();

    /** Read and draw at 15 Hz; the text/meter update at most four times a second. */
    const draw = (now: number) => {
      if (disposed) return;
      frame = window.requestAnimationFrame(draw);
      if (document.visibilityState === "hidden") { quietSince = null; return; }
      if (now - lastFrame < 1000 / 15) return;
      lastFrame = now;
      analyser.getFloatTimeDomainData(samples);
      context.fillStyle = "#f5f8f2";
      context.fillRect(0, 0, width, height);
      context.strokeStyle = "#dde6d6";
      context.lineWidth = 1;
      context.beginPath();
      for (let column = 1; column < 8; column++) {
        const x = width * column / 8;
        context.moveTo(x, 0); context.lineTo(x, height);
      }
      for (let row = 1; row < 4; row++) {
        const y = height * row / 4;
        context.moveTo(0, y); context.lineTo(width, y);
      }
      context.stroke();
      context.beginPath();
      context.strokeStyle = "#287955";
      context.lineWidth = 1.5;
      const points = Math.min(samples.length, Math.max(2, Math.floor(width)));
      for (let point = 0; point < points; point++) {
        const sample = samples[Math.floor(point * (samples.length - 1) / (points - 1))];
        const y = height * (0.5 - Math.max(-1, Math.min(1, sample)) * 0.4);
        const x = point * width / (points - 1);
        if (point === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
      if (now - lastMeter < 250) return;
      // A hidden/throttled preview cannot establish a continuous quiet interval.
      if (now - lastMeter > 1000) quietSince = null;
      lastMeter = now;
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / Math.max(1, samples.length));
      const decibels = Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(rms, 0.001))));
      if (levelRef.current) levelRef.current.style.transform = `scaleX(${(decibels + 60) / 60})`;
      meterRef.current?.setAttribute("aria-valuenow", decibels.toFixed(1));
      if (valueRef.current) valueRef.current.textContent = rms <= 0.001 ? "≤ −60 dBFS" : `${decibels.toFixed(1)} dBFS`;
      const engineState = analyser.context?.state as string | undefined;
      const tracks = connection.stream.getAudioTracks?.() ?? [];
      let notice = "";
      if (!interrupted) {
        if (engineState === "suspended") notice = "音频引擎已暂停（suspended），请检查麦克风连接。";
        else if (engineState === "interrupted") notice = "音频引擎被系统中断（interrupted），请检查设备或其它音频应用。";
        else if (engineState === "closed") notice = "音频引擎已关闭（closed），请重新连接麦克风。";
        else if (tracks.some(track => track.enabled === false)) notice = "麦克风音频轨道已禁用，请检查设备静音设置。";
        else if (tracks.some(track => track.muted === true)) notice = "麦克风音频轨道当前静音，暂时没有收到设备音频。";
      }
      if (interrupted || notice) quietSince = null;
      else if (rms < 0.001) {
        quietSince ??= now;
        if (now - quietSince >= 5000)
          notice = "暂未检测到明显声音，请对麦克风说话；手机声音请在 DroidCam Client 中开启 Enable Audio。";
      } else quietSince = null;
      updateNotice(notice);
    };
    frame = window.requestAnimationFrame(draw);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", resetObservation);
    };
  }, [connection.analyser, connection.stream, interrupted, paused, visible]);

  const notice = interrupted || (!paused && visible ? inputNotice : "");

  return (
    <div className="workspace-microphone-preview">
      <div className="workspace-microphone-stage">
        <canvas ref={canvasRef} aria-label={`${connection.label}实时声音波形`} />
        <span className={`workspace-microphone-badge ${interrupted ? "is-interrupted" : ""}`}>
          <span className={`status-dot ${interrupted || recording ? "red" : "green"}`} />
          {interrupted ? "音频录制中断" : recording ? "正在录制音频" : "实时声音波形"}
        </span>
        {paused && <div className="workspace-microphone-paused" role="status">
          <Pause size={18} /><span>预览已暂停{interrupted ? "" : recording ? " · 录制继续" : " · 麦克风仍连接"}</span>
        </div>}
      </div>
      <div className="workspace-microphone-level">
        <span>电平</span>
        <div ref={meterRef} className="workspace-microphone-meter" role="meter" aria-label="麦克风电平"
          aria-valuemin={-60} aria-valuemax={0} aria-valuenow={-60}>
          <span ref={levelRef} />
        </div>
        <span ref={valueRef} className="mono">≤ −60 dBFS</span>
      </div>
      {notice && <div className={`workspace-microphone-notice ${interrupted ? "is-interrupted" : ""}`} role="status" aria-atomic="true">
        <Info size={14} aria-hidden="true" /><span>{notice}</span>
      </div>}
      <footer className="workspace-microphone-footer">
        <span title={connection.label}>{connection.label}</span>
        <span className="mono">{connection.sampleRate > 0 ? `${connection.sampleRate.toLocaleString()} Hz` : "采样率未知"} · 单声道 · PCM16 WAV</span>
      </footer>
    </div>
  );
}
