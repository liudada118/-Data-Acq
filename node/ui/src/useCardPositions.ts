import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { planSensorGrid, type SensorCardPosition, type SensorGridLayout } from "./sensor-grid-layout";
import { findCardAtCell, moveCardPosition } from "./card-position-move";

export const cardPositionsStorageKey = (scope: string) => `shroom:card-positions:v1:${encodeURIComponent(scope)}`;
const changeEvent = "shroom-card-positions-change";
type Positions = Record<string, SensorCardPosition>;
type Cell = { column: number; row: number };
type Bounds = { left: number; top: number; width: number; height: number };
type Drag = { id: string; pointerId: number; element: HTMLElement; x: number; y: number; moved: boolean;
  bounds: Bounds; columns: number; rows: number; rowSpan: number; columnSpan: number; target: Cell | null };

function targetAt(active: Drag, clientX: number, clientY: number): Cell | null {
  const x = clientX - active.bounds.left, y = clientY - active.bounds.top;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > active.bounds.width || y > active.bounds.height) return null;
  return {
    column: Math.min(active.columns, 1 + Math.floor(x / ((active.bounds.width + 10) / active.columns))),
    // Keep the actual pointed row so a tall card can target a short card in the second row.
    row: Math.min(active.rows, 1 + Math.floor(y / ((active.bounds.height + 10) / active.rows))),
  };
}

export function normalizeCardPositions(value: unknown): Positions {
  const result: Positions = Object.create(null);
  if (!value || typeof value !== "object") return result;
  const envelope = value as { version?: unknown; positions?: unknown };
  if (envelope.version !== 1 || !envelope.positions || typeof envelope.positions !== "object" || Array.isArray(envelope.positions)) return result;
  for (const [id, entry] of Object.entries(envelope.positions).slice(0, 512)) {
    if (!id || id.length > 300 || !entry || typeof entry !== "object") continue;
    const candidate = entry as SensorCardPosition;
    if (![candidate.column, candidate.row, candidate.columnsAtSave, candidate.priority].every(Number.isSafeInteger) ||
      candidate.column < 1 || candidate.row < 1 || candidate.column > 16 || candidate.row > 16 ||
      candidate.columnsAtSave < candidate.column || candidate.columnsAtSave > 16 || candidate.priority < 1) continue;
    result[id] = { column: candidate.column, row: candidate.row, columnsAtSave: candidate.columnsAtSave, priority: candidate.priority };
  }
  return result;
}
const read = (scope: string) => {
  try { return normalizeCardPositions(JSON.parse(window.localStorage.getItem(cardPositionsStorageKey(scope)) ?? "null")); }
  catch { return Object.create(null) as Positions; }
};

export function useCardPositions({ scope, gridRef, layout, cards, viewportHeight, viewportWidth, disabled = false }: {
  scope: string;
  gridRef: RefObject<HTMLDivElement | null>;
  layout: SensorGridLayout;
  cards: Array<{ id: string; height: number; width?: number }>;
  viewportHeight: number;
  viewportWidth?: number;
  disabled?: boolean;
}) {
  const [state, setState] = useState(() => ({ scope, positions: read(scope) }));
  const current = useRef(state), drag = useRef<Drag | null>(null), suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ id: string; target: Cell | null; bounds: Bounds; rowSpan: number; columnSpan: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const positions = state.scope === scope ? state.positions : {};
  const plan = planSensorGrid(layout, cards, viewportHeight, 10, { positions, viewportWidth });
  const enabled = !disabled && cards.length > 1;
  const finish = () => {
    const active = drag.current; drag.current = null; setPreview(null);
    if (active?.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
  };
  const persist = (next: Positions) => {
    current.current = { scope, positions: next }; setState(current.current);
    const envelope = { version: 1, positions: next };
    try { window.localStorage.setItem(cardPositionsStorageKey(scope), JSON.stringify(envelope)); } catch { /* Keep the current layout usable if storage is unavailable. */ }
    window.dispatchEvent(new window.CustomEvent(changeEvent, { detail: { scope, ...envelope } }));
  };
  const move = (id: string, column: number, row: number) => {
    const placement = plan.placements[id]; if (!enabled || !placement) return;
    const result = moveCardPosition(plan, current.current.scope === scope ? current.current.positions : {}, id,
      Math.max(1, Math.min(layout.columns, column)), Math.max(1, Math.min(layout.rows, row)), layout.columns);
    if (!result) return;
    persist(result.positions);
    const next = result.positions[id];
    setAnnouncement(`${result.swappedId ? "两张卡片已交换位置；当前卡片在" : "卡片已移到"}第 ${next.column} 列${placement.rowSpan > 1 ? "，纵向铺满" : `、第 ${next.row} 行`}`);
  };
  const moveBy = (id: string, dx: number, dy: number) => {
    const placement = plan.placements[id];
    // The next cell to the right of a wide card is beyond its covered columns.
    // Pointing into its own footprint is intentionally a no-op for pointer drops.
    if (placement) move(id, placement.column + (dx > 0 ? placement.columnSpan - 1 + dx : dx), placement.row + dy);
  };
  const moveToEdge = (id: string, edge: "left" | "right") => {
    const placement = plan.placements[id]; if (placement) move(id, edge === "left" ? 1 : layout.columns, placement.row);
  };
  const reset = (id: string) => {
    finish(); const next = Object.assign(Object.create(null), current.current.positions) as Positions;
    delete next[id]; persist(next); setAnnouncement("已恢复此卡片的自动位置");
  };
  useEffect(() => {
    const next = { scope, positions: read(scope) }; current.current = next; setState(next); setPreview(null);
    const sync = (event: Event) => {
      if (drag.current) return;
      if (event.type === "storage" && (event as StorageEvent).key !== cardPositionsStorageKey(scope)) return;
      const detail = event.type === changeEvent ? (event as CustomEvent).detail : null;
      if (detail && detail.scope !== scope) return;
      const next = { scope, positions: detail ? normalizeCardPositions(detail) : read(scope) };
      current.current = next; setState(next);
    };
    window.addEventListener("storage", sync); window.addEventListener(changeEvent, sync);
    return () => {
      window.removeEventListener("storage", sync); window.removeEventListener(changeEvent, sync);
      const active = drag.current; drag.current = null;
      if (active?.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    };
  }, [scope]);
  useEffect(() => {
    if (!drag.current) return;
    const active = drag.current, bounds = gridRef.current?.getBoundingClientRect();
    if (!enabled || !plan.placements[active.id] || plan.placements[active.id].rowSpan !== active.rowSpan ||
      plan.placements[active.id].columnSpan !== active.columnSpan || active.columns !== layout.columns || active.rows !== layout.rows || !bounds ||
      Math.abs(bounds.width - active.bounds.width) > 1 || Math.abs(bounds.height - active.bounds.height) > 1) finish();
  });
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); finish(); setAnnouncement("已取消移动");
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, []);

  const begin = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || drag.current) return;
    const bounds = gridRef.current?.getBoundingClientRect(), placement = plan.placements[id];
    if (!bounds || !bounds.width || !bounds.height || !placement) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    suppressClick.current = false;
    drag.current = { id, pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY,
      moved: false, bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      columns: layout.columns, rows: layout.rows, rowSpan: placement.rowSpan, columnSpan: placement.columnSpan, target: null };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handleProps = (id: string): HTMLAttributes<HTMLElement> => ({
    onPointerDown: event => begin(id, event),
    onPointerMove: event => {
      const active = drag.current; if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 6) return;
      event.preventDefault(); event.stopPropagation(); active.moved = true;
      active.target = targetAt(active, event.clientX, event.clientY);
      const target = active.target;
      setPreview(previous => previous?.id === id && previous.target?.column === target?.column && previous.target?.row === target?.row
        ? previous : { id, target, bounds: active.bounds, rowSpan: active.rowSpan, columnSpan: active.columnSpan });
    },
    onPointerUp: event => {
      const active = drag.current; if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      event.stopPropagation(); finish();
      if (active.moved) {
        suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 0);
        const target = targetAt(active, event.clientX, event.clientY);
        if (target) move(id, target.column, target.row);
      }
    },
    onPointerCancel: event => { if (drag.current?.pointerId === event.pointerId) finish(); },
    onLostPointerCapture: event => { if (drag.current?.pointerId === event.pointerId) finish(); },
    onKeyDown: event => {
      event.stopPropagation();
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") { finish(); return; }
      if (event.key === "Home" || event.key === "End") moveToEdge(id, event.key === "Home" ? "left" : "right");
      else moveBy(id, event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0, event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
    },
  });
  const headerProps = (id: string): HTMLAttributes<HTMLElement> => ({ ...handleProps(id),
    onPointerDown: event => {
      if ((event.target as Element).closest("button,input,select,a,summary,[role=button],.card-position-menu")) return;
      begin(id, event);
    }, onKeyDown: undefined,
  });
  const cellWidth = preview ? (preview.bounds.width - (layout.columns - 1) * 10) / layout.columns : 0;
  const cellHeight = preview ? (preview.bounds.height - (layout.rows - 1) * 10) / layout.rows : 0;
  const occupant = preview?.target ? findCardAtCell(plan, preview.id, preview.target.column, preview.target.row) : undefined;
  const swapTargetId = occupant && occupant !== preview?.id ? occupant : null;
  const dropPlacement = swapTargetId ? plan.placements[swapTargetId] : preview?.target ? {
    column: Math.min(preview.target.column, layout.columns - preview.columnSpan + 1),
    row: preview.rowSpan > 1 ? 1 : preview.target.row, rowSpan: preview.rowSpan, columnSpan: preview.columnSpan,
  } : null;
  const indicatorStyle: CSSProperties | null = dropPlacement ? {
    left: (dropPlacement.column - 1) * (cellWidth + 10), top: (dropPlacement.row - 1) * (cellHeight + 10),
    width: cellWidth * dropPlacement.columnSpan + (dropPlacement.columnSpan - 1) * 10,
    height: cellHeight * dropPlacement.rowSpan + (dropPlacement.rowSpan - 1) * 10,
  } : null;
  return { enabled, plan, columns: layout.columns, rows: layout.rows, handleProps, headerProps, move, moveBy, moveToEdge, reset,
    draggingId: preview?.id ?? null, indicatorStyle, swapTargetId, indicatorLabel: swapTargetId ? "松开交换位置" : "松开放到这里", announcement,
    consumeClick: () => { const suppressed = suppressClick.current; suppressClick.current = false; return suppressed; } };
}
export type CardPositionsController = ReturnType<typeof useCardPositions>;
