import { useId, useRef } from "react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import type { MediaLayoutController } from "./useMediaLayout";

export function MediaLayoutControls({ layout }: { layout: MediaLayoutController }) {
  const id = useId(), { metrics, setRatio, reset, commit } = layout;
  const dirty = useRef({ width: false, camera: false });
  const change = (axis: "width" | "camera", value: number) => {
    if (Math.abs(value - (axis === "width" ? metrics.widthRatio : metrics.cameraRatio)) < 1e-9) return;
    dirty.current[axis] = true; setRatio(axis, value, false);
  };
  const save = (axis: "width" | "camera") => {
    if (!dirty.current[axis]) return;
    dirty.current[axis] = false; commit();
  };
  return <details className="media-layout-controls" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); dirty.current = { width: false, camera: false }; event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }}>
    <summary className="button secondary small" aria-label="布局大小"><SlidersHorizontal size={14} aria-hidden="true" />布局大小</summary>
    <div className="media-layout-popover">
      <label htmlFor={`${id}-width`}>摄像头栏宽度 <output>{Math.round(metrics.widthRatio * 100)}%</output></label>
      <input id={`${id}-width`} aria-label="摄像头栏宽度比例" type="range" min={metrics.widthMin * 100} max={metrics.widthMax * 100} step="1"
        value={metrics.widthRatio * 100} disabled={!metrics.canResizeWidth} onChange={event => change("width", Number(event.target.value) / 100)}
        onPointerUp={() => save("width")} onKeyUp={() => save("width")} onBlur={() => save("width")} />
      {!metrics.canResizeWidth && <p>单栏、窄屏或单卡放大时，宽度自动适应。</p>}
      <label htmlFor={`${id}-camera`}>摄像头高度 <output>{Math.round(metrics.cameraRatio * 100)}%</output></label>
      <input id={`${id}-camera`} aria-label="摄像头高度比例" type="range" min={metrics.cameraMin * 100} max={metrics.cameraMax * 100} step="1"
        value={metrics.cameraRatio * 100} disabled={!metrics.canResizeCamera} onChange={event => change("camera", Number(event.target.value) / 100)}
        onPointerUp={() => save("camera")} onKeyUp={() => save("camera")} onBlur={() => save("camera")} />
      <p>{metrics.canResizeCamera ? "占音视频内容高度；提高比例可缩小麦克风区域。" : "同时展示摄像头与麦克风且高度足够时可调整。"}</p>
      <button className="button secondary small" type="button" onClick={reset}><RotateCcw size={13} aria-hidden="true" />恢复默认大小</button>
      <p className="media-layout-saved">布局会记住，采集与回放共用。</p>
    </div>
  </details>;
}

/** A permanent handle in card chrome, separate from the video and its native controls. */
export function MediaCardResizeGrip({ layout }: { layout: MediaLayoutController }) {
  return <div className="media-card-resize-footer">
    <div className="media-card-resize-grip" {...layout.cornerProps()}>
      <span>拖动调大小</span>
      <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true"><path d="M4 14 14 4M9 14l5-5M13 14l1-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    </div>
  </div>;
}
