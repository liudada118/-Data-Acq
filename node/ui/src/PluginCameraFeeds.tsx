import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { RotateCcw, Video } from "lucide-react";
import { LivePreview } from "./LivePreview";
import type { Device, DeviceKind } from "./types";

type CameraLayout = "auto" | "horizontal" | "vertical";
type CameraLayoutPatch = { cameraLayout?: CameraLayout; cameraSplit?: number };

export interface PluginCameraFeedsProps {
  cardId: string;
  streams: { id: string; name: string; kind: DeviceKind }[];
  devices: Device[];
  active: boolean;
  online: boolean;
  previewConnected: boolean;
  paused: boolean;
  visible?: boolean;
  cardContentFullscreen?: boolean;
  layout?: CameraLayout;
  split?: number;
  onLayoutChange: (patch: CameraLayoutPatch) => void;
}

interface SplitDrag {
  pointerId: number;
  handle: HTMLDivElement;
  direction: "horizontal" | "vertical";
  start: number;
  startSplit: number;
  available: number;
  width: number;
  height: number;
}

function clampSplit(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(0.8, Math.max(0.2, value)) : 0.5;
}

/** The layout only affects presentation: feed keys and preview subscriptions stay stable. */
export function PluginCameraFeeds({
  cardId, streams, devices, active, online, previewConnected, paused, visible = true,
  cardContentFullscreen, layout = "auto", split = 0.5, onLayoutChange,
}: PluginCameraFeedsProps) {
  const pair = streams.length === 2;
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<SplitDrag | null>(null);
  const commitRef = useRef(onLayoutChange);
  commitRef.current = onLayoutChange;
  const savedSplit = clampSplit(split);
  const savedSplitRef = useRef(savedSplit);
  savedSplitRef.current = savedSplit;
  const [localSplit, setLocalSplit] = useState(savedSplit);
  const localSplitRef = useRef(localSplit);
  const [dragging, setDragging] = useState(false);
  const [autoDirection, setAutoDirection] = useState<"horizontal" | "vertical">("horizontal");
  const direction = layout === "auto" ? autoDirection : layout;
  const streamKey = streams.map(stream => stream.id).join("\n");

  const updateLocalSplit = useCallback((value: number) => {
    localSplitRef.current = clampSplit(value);
    setLocalSplit(localSplitRef.current);
  }, []);

  const releaseDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
    return drag;
  }, []);

  const cancelDrag = useCallback(() => {
    if (!releaseDrag()) return;
    setDragging(false);
    updateLocalSplit(savedSplitRef.current);
  }, [releaseDrag, updateLocalSplit]);

  useEffect(() => {
    cancelDrag();
    updateLocalSplit(savedSplit);
  }, [savedSplit, layout, direction, streamKey, cancelDrag, updateLocalSplit]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const { width, height } = grid.getBoundingClientRect();
      const drag = dragRef.current;
      if (drag && (Math.abs(drag.width - width) > 1 || Math.abs(drag.height - height) > 1)) {
        cancelDrag();
      }
      // A short tile stays side by side; tall/narrow cards give each eye a useful width.
      setAutoDirection(height >= 340 && height > width * 0.85 ? "vertical" : "horizontal");
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [pair, cancelDrag]);

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    };
    window.addEventListener("keydown", onEscape, true);
    window.addEventListener("blur", cancelDrag);
    return () => {
      window.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("blur", cancelDrag);
      releaseDrag();
    };
  }, [cancelDrag, releaseDrag]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !pair || !gridRef.current || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = gridRef.current.getBoundingClientRect();
    const handleRect = event.currentTarget.getBoundingClientRect();
    const available = direction === "horizontal"
      ? rect.width - handleRect.width : rect.height - handleRect.height;
    if (available <= 0) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      handle: event.currentTarget,
      direction,
      start: direction === "horizontal" ? event.clientX : event.clientY,
      startSplit: localSplitRef.current,
      available,
      width: rect.width,
      height: rect.height,
    };
    setDragging(true);
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const position = drag.direction === "horizontal" ? event.clientX : event.clientY;
    updateLocalSplit(drag.startSplit + (position - drag.start) / drag.available);
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    moveDrag(event);
    releaseDrag();
    setDragging(false);
    commitRef.current({ cameraSplit: localSplitRef.current });
  };

  const keyboardResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      cancelDrag();
      return;
    }
    if (dragRef.current) return;
    const previousKey = direction === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const nextKey = direction === "horizontal" ? "ArrowRight" : "ArrowDown";
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: number;
    if (event.key === "Home") next = 0.5;
    else if (event.key === previousKey) next = localSplitRef.current - step;
    else if (event.key === nextKey) next = localSplitRef.current + step;
    else return;
    event.preventDefault();
    event.stopPropagation();
    updateLocalSplit(next);
    commitRef.current({ cameraSplit: localSplitRef.current });
  };

  const selectLayout = (next: CameraLayout) => {
    cancelDrag();
    commitRef.current({ cameraLayout: next });
  };

  const gridStyle: CSSProperties | undefined = pair ? {
    gridTemplateColumns: direction === "horizontal"
      ? `minmax(0, ${localSplit}fr) 14px minmax(0, ${1 - localSplit}fr)` : "minmax(0, 1fr)",
    gridTemplateRows: direction === "vertical"
      ? `minmax(0, ${localSplit}fr) 14px minmax(0, ${1 - localSplit}fr)` : "minmax(0, 1fr)",
  } : undefined;

  return <div className={`workspace-camera-layout ${dragging ? "camera-layout-dragging" : ""}`}>
    {pair && <div className="workspace-camera-layout-toolbar" onPointerDown={event => event.stopPropagation()}>
      <div className="workspace-camera-layout-options" role="group" aria-label="双目画面排列">
        <button type="button" aria-pressed={layout === "horizontal"} onClick={() => selectLayout("horizontal")} title="左右排列，左右拖动分隔线">左右排列</button>
        <button type="button" aria-pressed={layout === "vertical"} onClick={() => selectLayout("vertical")} title="上下排列，上下拖动分隔线">上下排列</button>
        <button type="button" aria-pressed={layout === "auto"} onClick={() => selectLayout("auto")} title="按卡片宽高自动选择排列">自动</button>
      </div>
      <span className="workspace-camera-layout-hint">拖动中间分隔线</span>
      <button type="button" className="workspace-camera-split-reset" title="恢复两路画面均分" aria-label="恢复均分" onClick={() => {
        cancelDrag();
        updateLocalSplit(0.5);
        commitRef.current({ cameraSplit: 0.5 });
      }}><RotateCcw size={12} /><span>均分</span></button>
    </div>}
    <div ref={gridRef} className={`workspace-camera-feeds ${streams.length > 1 ? "camera-feeds-multiple" : ""} ${pair ? `camera-feeds-pair camera-feeds-${direction}` : ""}`} style={gridStyle}>
      {streams.map((stream, index) => {
        const cameraId = `plugin-${cardId}-${stream.id}`;
        const cameraDevice = devices.find(device => device.id === cameraId);
        const placement: CSSProperties | undefined = pair ? {
          gridColumn: direction === "horizontal" ? index * 2 + 1 : 1,
          gridRow: direction === "vertical" ? index * 2 + 1 : 1,
        } : undefined;
        return <section key={cameraId} id={`camera-feed-${encodeURIComponent(cameraId)}`} className="workspace-camera-feed" data-stream-id={cameraId} aria-label={stream.name} style={placement}>
          <h4 className="workspace-camera-feed-name" title={stream.name}>{stream.name}</h4>
          {active && cameraDevice ? <LivePreview device={cameraDevice} enabled embedded paused={paused} visible={visible}
            connected={online && previewConnected && cameraDevice.connected} cardContentFullscreen={cardContentFullscreen} />
            : <div className="workspace-camera-feed-placeholder"><Video size={28} strokeWidth={1.3} />
              <span>{!online ? "等待采集服务" : active ? "等待该路画面" : "等待相机连接"}</span>
            </div>}
        </section>;
      })}
      {pair && <div className="workspace-camera-splitter" role="separator" tabIndex={0}
        aria-label={direction === "horizontal" ? "调整双目左右宽度" : "调整双目上下高度"}
        aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
        aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(localSplit * 100)}
        aria-valuetext={`${streams[0].name} ${Math.round(localSplit * 100)}%，${streams[1].name} ${Math.round((1 - localSplit) * 100)}%`}
        aria-controls={streams.map(stream => `camera-feed-${encodeURIComponent(`plugin-${cardId}-${stream.id}`)}`).join(" ")}
        title={direction === "horizontal" ? "左右拖动调整宽度；方向键微调，Home 均分，Esc 取消拖动" : "上下拖动调整高度；方向键微调，Home 均分，Esc 取消拖动"}
        style={{ gridColumn: direction === "horizontal" ? 2 : 1, gridRow: direction === "vertical" ? 2 : 1 }}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag}
        onPointerCancel={event => { if (dragRef.current?.pointerId === event.pointerId) cancelDrag(); }}
        onLostPointerCapture={event => { if (dragRef.current?.pointerId === event.pointerId) cancelDrag(); }}
        onKeyDown={keyboardResize}><span aria-hidden="true" /></div>}
    </div>
  </div>;
}
