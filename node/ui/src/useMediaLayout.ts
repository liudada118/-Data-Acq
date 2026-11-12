import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";
import { clampRatio, DEFAULT_MEDIA_LAYOUT, mediaLayoutStorageKey, mediaLayoutMetrics, normalizeMediaLayout, type MediaLayoutAxis, type MediaLayoutPreferences, type MediaLayoutViewport } from "./media-rail-layout";

const changeEvent = "shroom-media-layout-change";
const readPreferences = (scope: string) => {
  try { return normalizeMediaLayout(JSON.parse(window.localStorage.getItem(mediaLayoutStorageKey(scope)) ?? "null")); }
  catch { return { ...DEFAULT_MEDIA_LAYOUT }; }
};
const field = (axis: MediaLayoutAxis) => axis === "width" ? "widthRatio" : "cameraRatio";
type DragAxis = { axis: MediaLayoutAxis; start: number; value: number; dimension: number; min: number; max: number };
type Drag = { axes: DragAxis[]; pointerId: number; before: MediaLayoutPreferences; target: HTMLElement };

export function useMediaLayout(viewport: MediaLayoutViewport, scope = "live") {
  const [preferences, setPreferences] = useState(() => readPreferences(scope));
  const current = useRef(preferences), drag = useRef<Drag | null>(null), frame = useRef<number | null>(null), pending = useRef<Partial<MediaLayoutPreferences> | null>(null);
  const metrics = mediaLayoutMetrics(viewport, preferences);
  const update = (next: MediaLayoutPreferences) => { current.current = next; setPreferences(next); };
  const persist = (next: MediaLayoutPreferences) => {
    try { window.localStorage.setItem(mediaLayoutStorageKey(scope), JSON.stringify(next)); } catch { /* Layout remains usable when storage is unavailable. */ }
    window.dispatchEvent(new window.CustomEvent(changeEvent, { detail: { scope, preferences: next } }));
  };
  const clearFrame = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; pending.current = null; };
  const finish = (commit: boolean) => {
    const active = drag.current; if (!active) return;
    if (commit && pending.current !== null) update({ ...current.current, ...pending.current });
    clearFrame(); drag.current = null;
    if (commit) {
      if (current.current.widthRatio !== active.before.widthRatio || current.current.cameraRatio !== active.before.cameraRatio) persist(current.current);
    } else update(active.before);
    if (active.target.hasPointerCapture?.(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
  };
  useEffect(() => {
    const initial = readPreferences(scope); current.current = initial; setPreferences(initial);
    const sync = (event: Event) => {
      if (drag.current) return;
      if (event.type === "storage" && (event as StorageEvent).key !== mediaLayoutStorageKey(scope)) return;
      if (event.type === changeEvent && (event as CustomEvent).detail?.scope !== scope) return;
      const next = event.type === changeEvent ? normalizeMediaLayout((event as CustomEvent).detail.preferences) : readPreferences(scope);
      current.current = next; setPreferences(next);
    };
    window.addEventListener("storage", sync); window.addEventListener(changeEvent, sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener(changeEvent, sync); clearFrame(); drag.current = null; };
  }, [scope]);
  // A resize or focused card changes the coordinate system; end an in-progress drag safely.
  useEffect(() => { finish(false); }, [viewport.width, viewport.height, viewport.focused, viewport.cameraCount, viewport.audioCount, viewport.sensorCount]);

  const setRatio = (axis: MediaLayoutAxis, value: number, commit = true) => {
    if (!Number.isFinite(value)) return;
    const min = axis === "width" ? metrics.widthMin : metrics.cameraMin, max = axis === "width" ? metrics.widthMax : metrics.cameraMax;
    const next = normalizeMediaLayout({ ...current.current, [field(axis)]: clampRatio(value, min, max) });
    update(next); if (commit) persist(next);
  };
  const canResize = (axis: MediaLayoutAxis) => axis === "width" ? metrics.canResizeWidth : metrics.canResizeCamera;
  const startDrag = (requested: MediaLayoutAxis[], event: ReactPointerEvent<HTMLDivElement>) => {
    const axes = requested.filter(canResize);
    if (drag.current || event.button !== 0 || !axes.length) return;
    event.preventDefault(); event.stopPropagation(); finish(false); event.currentTarget.focus();
    drag.current = { axes: axes.map(axis => ({ axis, start: axis === "width" ? event.clientX : event.clientY,
      value: axis === "width" ? metrics.widthRatio : metrics.cameraRatio,
      dimension: axis === "width" ? metrics.width : metrics.availableHeight,
      min: axis === "width" ? metrics.widthMin : metrics.cameraMin, max: axis === "width" ? metrics.widthMax : metrics.cameraMax })), pointerId: event.pointerId,
      before: { ...current.current }, target: event.currentTarget };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const pointerProps = (axes: MediaLayoutAxis[]): HTMLAttributes<HTMLDivElement> => ({
    onPointerDown: event => startDrag(axes, event),
    onPointerMove: event => {
      const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const next: Partial<MediaLayoutPreferences> = {};
      for (const axis of active.axes) {
        const value = clampRatio(axis.value + ((axis.axis === "width" ? event.clientX : event.clientY) - axis.start) / axis.dimension, axis.min, axis.max);
        // Clicking a clamped card or returning to the drag start must keep its saved preference.
        next[field(axis.axis)] = Math.abs(value - axis.value) < 1e-9 ? active.before[field(axis.axis)] : value;
      }
      pending.current = next;
      if (frame.current === null) frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (drag.current && pending.current !== null) { update({ ...current.current, ...pending.current }); pending.current = null; }
      });
    },
    onPointerUp: event => { if (drag.current?.pointerId === event.pointerId) { event.preventDefault(); event.stopPropagation(); finish(true); } },
    onPointerCancel: event => { if (drag.current?.pointerId === event.pointerId) finish(false); },
    onLostPointerCapture: event => { if (drag.current?.pointerId === event.pointerId) finish(false); },
  });
  const separatorProps = (axis: MediaLayoutAxis): HTMLAttributes<HTMLDivElement> => ({
    role: "separator", tabIndex: canResize(axis) ? 0 : -1,
    "aria-disabled": !canResize(axis), "aria-orientation": axis === "width" ? "vertical" : "horizontal",
    "aria-label": axis === "width" ? "调整音视频栏宽度" : "调整摄像头与麦克风高度",
    "aria-valuemin": Math.round((axis === "width" ? metrics.widthMin : metrics.cameraMin) * 100),
    "aria-valuemax": Math.round((axis === "width" ? metrics.widthMax : metrics.cameraMax) * 100),
    "aria-valuenow": Math.round((axis === "width" ? metrics.widthRatio : metrics.cameraRatio) * 100),
    "aria-valuetext": `${Math.round((axis === "width" ? metrics.widthRatio : metrics.cameraRatio) * 100)}%`,
    title: axis === "width" ? "左右拖动，同时调整摄像头与麦克风宽度；不超出展示区" : "向上拖动增高麦克风，向下拖动缩小麦克风；总高度保持一屏",
    ...pointerProps([axis]),
    onKeyDown: event => {
      event.stopPropagation();
      if (!(axis === "width" ? metrics.canResizeWidth : metrics.canResizeCamera)) return;
      const increase = axis === "width" ? "ArrowRight" : "ArrowDown", decrease = axis === "width" ? "ArrowLeft" : "ArrowUp";
      if (![increase, decrease, "Home", "End", "Escape"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { finish(false); return; }
      if (event.key === "Home") {
        const next = { ...current.current, [field(axis)]: DEFAULT_MEDIA_LAYOUT[field(axis)] };
        update(next); persist(next); return;
      }
      const value = axis === "width" ? metrics.widthRatio : metrics.cameraRatio;
      setRatio(axis, event.key === "End" ? (axis === "width" ? metrics.widthMax : metrics.cameraMax) : value + (event.key === increase ? 1 : -1) * (event.shiftKey ? .1 : .02));
    },
  });
  const reset = () => { finish(false); const next = { ...DEFAULT_MEDIA_LAYOUT }; update(next); persist(next); };
  const cornerProps = (): HTMLAttributes<HTMLDivElement> => ({
    role: "group", "aria-roledescription": "尺寸调整把手", tabIndex: metrics.canResizeWidth || metrics.canResizeCamera ? 0 : -1,
    "aria-label": "拖动调整摄像头卡片大小", "aria-disabled": !metrics.canResizeWidth && !metrics.canResizeCamera,
    title: metrics.canResizeWidth || metrics.canResizeCamera ? "向右拖动加宽，向下拖动增高；方向键微调，Home 恢复默认" : "当前卡片已自动适应可用区域；返回全部卡片后可调整",
    ...pointerProps(["width", "camera"]),
    onKeyDown: event => {
      event.stopPropagation();
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "Escape"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") { finish(false); return; }
      if (!metrics.canResizeWidth && !metrics.canResizeCamera) return;
      if (event.key === "Home") { reset(); return; }
      const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "width" : "camera";
      if (!canResize(axis)) return;
      const value = axis === "width" ? metrics.widthRatio : metrics.cameraRatio;
      setRatio(axis, value + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) * (event.shiftKey ? .1 : .02));
    },
  });
  return { preferences, metrics, setRatio, reset, separatorProps, cornerProps, commit: () => persist(current.current),
    style: { "--media-rail-width": `${metrics.railWidth}px`, "--media-rail-height": `${metrics.railHeight}px`, "--sensor-region-height": `${metrics.sensorViewport.height}px`, "--media-card-gap": `${metrics.gap}px`, "--media-separator-height": `${metrics.separatorHeight}px`, "--media-camera-height": `${metrics.cameraHeight}px`, "--media-audio-height": `${metrics.audioHeight}px` } as CSSProperties };
}
export type MediaLayoutController = ReturnType<typeof useMediaLayout>;
