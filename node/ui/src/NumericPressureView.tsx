import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, Scan } from "lucide-react";
import { drawNumericPressure, findNumericCell, getNumericLayout } from "./numeric-pressure-renderer";
import type { NumericLayout, NumericTransform } from "./numeric-pressure-renderer";
import type { PressurePreview } from "./types";

type Viewport = { width: number; height: number };

/** Place a small, pointer-adjacent tooltip entirely inside the canvas in CSS pixels. */
export function positionNumericTooltip(pointer: { x: number; y: number }, viewport: Viewport, size: Viewport) {
  const padding = Math.max(0, Math.min(8, viewport.width / 2, viewport.height / 2));
  const width = Math.min(size.width, Math.max(0, viewport.width - padding * 2));
  const height = Math.min(size.height, Math.max(0, viewport.height - padding * 2));
  const left = pointer.x + 12 + width <= viewport.width - padding ? pointer.x + 12 : pointer.x - 12 - width;
  const top = pointer.y + 12 + height <= viewport.height - padding ? pointer.y + 12 : pointer.y - 12 - height;
  return {
    left: Math.max(padding, Math.min(viewport.width - padding - width, left)),
    top: Math.max(padding, Math.min(viewport.height - padding - height, top)),
  };
}

export function fitNumericView(layout: Pick<NumericLayout, "width" | "height">, viewport: Viewport): NumericTransform {
  const scale = Math.max(0.001, Math.min(1, (viewport.width - 24) / layout.width, (viewport.height - 24) / layout.height));
  return { scale, offsetX: (viewport.width - layout.width * scale) / 2, offsetY: (viewport.height - layout.height * scale) / 2 };
}

// Keep part of the data reachable even after a long drag.
export function boundNumericView(view: NumericTransform, layout: Pick<NumericLayout, "width" | "height">, viewport: Viewport): NumericTransform {
  const margin = 32;
  return { ...view,
    offsetX: Math.min(viewport.width - margin, Math.max(margin - layout.width * view.scale, view.offsetX)),
    offsetY: Math.min(viewport.height - margin, Math.max(margin - layout.height * view.scale, view.offsetY)),
  };
}

export function zoomNumericView(view: NumericTransform, scale: number, x: number, y: number): NumericTransform {
  const ratio = scale / view.scale;
  return { scale, offsetX: x - (x - view.offsetX) * ratio, offsetY: y - (y - view.offsetY) * ratio };
}

export function NumericPressureView({ pressure, name, unit, controlsContainer }: {
  pressure: PressurePreview | null; name: string; unit: string; controlsContainer?: HTMLElement | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; view: NumericTransform } | null>(null);
  const hintId = useId();
  const tooltipId = useId();
  const layout = useMemo(() => getNumericLayout(pressure ?? { rows: 0, cols: 0, values: [] }), [pressure]);
  const [viewport, setViewport] = useState<Viewport>({ width: 1, height: 1 });
  const [view, setView] = useState<NumericTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tooltipSize, setTooltipSize] = useState<Viewport>({ width: 220, height: 64 });
  const autoFitRef = useRef(true);
  const previousSize = useRef({ width: 1, height: 1, layout: "" });
  const fit = useMemo(() => fitNumericView(layout, viewport), [layout.width, layout.height, viewport]);
  const hovered = pointer && !dragging && pointer.x >= 0 && pointer.y >= 0 && pointer.x < viewport.width && pointer.y < viewport.height
    ? findNumericCell(layout, pointer.x, pointer.y, view) : null;
  const tooltipPosition = pointer ? positionNumericTooltip(pointer, viewport, tooltipSize) : null;

  useLayoutEffect(() => {
    const bounds = tooltipRef.current?.getBoundingClientRect();
    if (bounds && bounds.width > 0 && bounds.height > 0)
      setTooltipSize(previous => previous.width === bounds.width && previous.height === bounds.height
        ? previous : { width: bounds.width, height: bounds.height });
  }, [hovered?.label, hovered?.value, viewport.width, viewport.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (width > 0 && height > 0) setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const geometry = `${layout.kind}:${layout.width}:${layout.height}`;
    const previous = previousSize.current;
    if (geometry !== previous.layout) autoFitRef.current = true;
    // Layout resizing must not undo a user's requested zoom or pan.
    setView(current => autoFitRef.current ? fit : boundNumericView({ ...current,
      offsetX: current.offsetX + (viewport.width - previous.width) / 2,
      offsetY: current.offsetY + (viewport.height - previous.height) / 2,
    }, layout, viewport));
    previousSize.current = { ...viewport, layout: geometry };
    setPointer(null);
  }, [fit, layout.kind, layout.width, layout.height, viewport]);

  const resetView = () => { autoFitRef.current = true; setView(fit); setPointer(null); };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(viewport.width * ratio));
      const height = Math.max(1, Math.round(viewport.height * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawNumericPressure(ctx, viewport.width, viewport.height, layout, view);
      if (hovered) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(hovered.x * view.scale + view.offsetX, hovered.y * view.scale + view.offsetY, hovered.width * view.scale, hovered.height * view.scale);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layout, viewport, view, hovered]);

  const zoom = useCallback((factor: number, x = viewport.width / 2, y = viewport.height / 2) => {
    autoFitRef.current = false;
    setPointer(null);
    setView(previous => boundNumericView(zoomNumericView(previous, Math.min(8, Math.max(fit.scale / 2, previous.scale * factor)), x, y), layout, viewport));
  }, [fit.scale, layout, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - bounds.left, event.clientY - bounds.top);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [zoom]);

  const toolbar = <div className="numeric-toolbar" role="group" aria-label={`${name}数字视图控制`}>
      <span className="numeric-view-hint">{pressure?.glove ? `${pressure.glove.side === "left" ? "左手" : "右手"} · 分区 ADC` : "原始采样值"}</span>
      <div className="numeric-zoom-controls">
        <button type="button" aria-label="缩小数字视图" title="缩小" onClick={() => zoom(1 / 1.25)} disabled={view.scale <= fit.scale / 2}><Minus size={14} /></button>
        <output aria-label="数字视图缩放比例">{Math.round(view.scale * 100)}%</output>
        <button type="button" aria-label="放大数字视图" title="放大" onClick={() => zoom(1.25)} disabled={view.scale >= 8}><Plus size={14} /></button>
        <button type="button" onClick={resetView} title="完整显示所有点位"><Scan size={14} />适应</button>
        <button type="button" onClick={() => { autoFitRef.current = false; setView(previous => boundNumericView(zoomNumericView(previous, 1, viewport.width / 2, viewport.height / 2), layout, viewport)); }} title="以可读字号查看数字">1:1</button>
      </div>
    </div>;

  return <div className="numeric-pressure-view">
    {controlsContainer ? createPortal(toolbar, controlsContainer) : toolbar}
    <div className={`numeric-canvas-area ${dragging ? "is-dragging" : ""}`}>
      <canvas ref={canvasRef} className="numeric-pressure-canvas" tabIndex={0} role="img" aria-label={`${name} 2D 数字，${layout.cells.length} 个采样点${pressure?.glove ? "，五指、指腹与手掌分区" : ""}`} aria-describedby={hovered ? `${hintId} ${tooltipId}` : hintId}
        data-numeric-scale={view.scale} data-numeric-offset-x={view.offsetX} data-numeric-offset-y={view.offsetY}
        data-numeric-layout-width={layout.width} data-numeric-layout-height={layout.height}
        data-numeric-viewport-width={viewport.width} data-numeric-viewport-height={viewport.height}
        onPointerDown={event => {
          if (event.button !== 0) return;
          autoFitRef.current = false;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view };
          const bounds = event.currentTarget.getBoundingClientRect();
          setPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
          setDragging(true);
        }}
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
          const drag = dragRef.current;
          if (drag && drag.id === event.pointerId) setView(boundNumericView({ ...drag.view, offsetX: drag.view.offsetX + event.clientX - drag.x, offsetY: drag.view.offsetY + event.clientY - drag.y }, layout, viewport));
        }}
        onPointerUp={event => {
          if (dragRef.current?.id !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null; setDragging(false); setPointer(null);
        }}
        onLostPointerCapture={() => { dragRef.current = null; setDragging(false); setPointer(null); }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); setPointer(null); }}
        onPointerLeave={() => setPointer(null)}
        onBlur={() => setPointer(null)}
        onKeyDown={event => {
          if (event.key === "Escape" && pointer) { event.preventDefault(); event.stopPropagation(); setPointer(null); return; }
          if (["+", "=", "-", "_", "Home", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); setPointer(null);
            if (event.key === "+" || event.key === "=") zoom(1.25);
            else if (event.key === "-" || event.key === "_") zoom(1 / 1.25);
            else if (event.key === "Home") resetView();
            else { autoFitRef.current = false; setView(previous => boundNumericView({ ...previous, offsetX: previous.offsetX + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), offsetY: previous.offsetY + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) }, layout, viewport)); }
          }
        }} />
      {hovered && tooltipPosition && <div ref={tooltipRef} id={tooltipId} className="numeric-point-tooltip" role="tooltip" style={tooltipPosition}>
        <span>{hovered.label}</span>
        <strong>{hovered.value === null ? "--" : String(hovered.value)} <small>{unit || "a.u."}</small></strong>
      </div>}
    </div>
    <span className="sr-only" id={hintId}>悬停采样点查看单点提示；滚轮缩放、拖动平移；方向键移动，+/− 缩放，Home 适应，Escape 收起提示。</span>
  </div>;
}
