import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";
import { boundCardSize, cardSizeLimits, normalizeCardSizes, resolveCardSize, type CardSize, type CardSizeDescriptor, type SavedCardSize, type SavedCardSizes } from "./card-size-layout";

export const cardSizesStorageKey = (scope: string) => `shroom:card-sizes:v1:${encodeURIComponent(scope)}`;
const changedEvent = "shroom-card-sizes-change";
type Axis = "width" | "height";
export type CardResizeAxis = Axis | "both";
type ResizeDrag = { id: string; pointerId: number; target: HTMLElement; axes: Axis[]; x: number; y: number; width: number; height: number;
  before?: SavedCardSize; limits: ReturnType<typeof cardSizeLimits> };
const read = (scope: string) => {
  try { return normalizeCardSizes(JSON.parse(window.localStorage.getItem(cardSizesStorageKey(scope)) ?? "null")); }
  catch { return Object.create(null) as SavedCardSizes; }
};
const equalSize = (a?: SavedCardSize, b?: SavedCardSize) => a?.width === b?.width && a?.height === b?.height && a?.fullHeight === b?.fullHeight;

export function useCardSizes({ scope, cards, onResize }: { scope: string; cards: CardSizeDescriptor[]; onResize?: (id: string) => void }) {
  const [state, setState] = useState(() => ({ scope, cards: read(scope) }));
  const current = useRef(state), specs = useRef(cards), drag = useRef<ResizeDrag | null>(null);
  const frame = useRef<number | null>(null), pending = useRef<SavedCardSize | null>(null);
  specs.current = cards;
  const preferences = state.scope === scope ? state.cards : {};
  const descriptor = (id: string) => specs.current.find(card => card.id === id);
  const getSize = (id: string) => {
    const card = descriptor(id);
    if (!card) throw new Error(`Unknown resize card: ${id}`);
    return resolveCardSize(card, preferences[id]);
  };
  const update = (id: string, entry?: SavedCardSize) => {
    const next: SavedCardSizes = Object.assign(Object.create(null), current.current.scope === scope ? current.current.cards : {});
    if (entry && (entry.width !== undefined || entry.height !== undefined || entry.fullHeight)) next[id] = entry; else delete next[id];
    current.current = { scope, cards: next }; setState(current.current);
  };
  const persist = () => {
    const envelope = { version: 1, cards: current.current.cards };
    try { window.localStorage.setItem(cardSizesStorageKey(scope), JSON.stringify(envelope)); } catch { /* Resizing still works without storage access. */ }
    window.dispatchEvent(new window.CustomEvent(changedEvent, { detail: { scope, ...envelope } }));
  };
  const cancelFrame = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; pending.current = null; };
  const finish = (commit: boolean) => {
    const active = drag.current; if (!active) return;
    if (commit && pending.current) update(active.id, pending.current);
    cancelFrame(); drag.current = null;
    if (commit) { if (!equalSize(active.before, current.current.cards[active.id])) persist(); }
    else update(active.id, active.before);
    if (active.target.hasPointerCapture?.(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
  };
  useEffect(() => {
    const next = { scope, cards: read(scope) }; current.current = next; setState(next);
    const sync = (event: Event) => {
      if (drag.current) return;
      if (event.type === "storage" && (event as StorageEvent).key !== cardSizesStorageKey(scope)) return;
      const detail = event.type === changedEvent ? (event as CustomEvent).detail : null;
      if (detail && detail.scope !== scope) return;
      const next = { scope, cards: detail ? normalizeCardSizes(detail) : read(scope) };
      current.current = next; setState(next);
    };
    window.addEventListener("storage", sync); window.addEventListener(changedEvent, sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener(changedEvent, sync); cancelFrame(); drag.current = null; };
  }, [scope]);
  useEffect(() => {
    const active = drag.current; if (!active) return;
    const card = descriptor(active.id), limits = card && cardSizeLimits(card);
    if (!limits || Object.keys(active.limits).some(key => active.limits[key as keyof typeof limits] !== limits[key as keyof typeof limits])) finish(false);
  }, [cards]);

  const setSize = (id: string, requested: Partial<CardSize>, commit = true) => {
    const card = descriptor(id); if (!card) return;
    const limits = cardSizeLimits(card), visible = resolveCardSize(card, current.current.cards[id]), next = { ...current.current.cards[id] };
    for (const axis of ["width", "height"] as const) {
      const value = requested[axis];
      if (typeof value === "number" && Number.isFinite(value)) {
        const bounded = boundCardSize(value, axis === "width" ? limits.minWidth : limits.minHeight, axis === "width" ? limits.maxWidth : limits.maxHeight);
        if (Math.abs(bounded - visible[axis]) >= .01) next[axis] = bounded;
        if (axis === "height") {
          if (bounded >= limits.maxHeight - .01) next.fullHeight = true;
          else delete next.fullHeight;
        }
      }
    }
    if (equalSize(next, current.current.cards[id])) return;
    onResize?.(id); update(id, next); if (commit) persist();
  };
  const reset = (id: string) => {
    if (drag.current?.id === id) finish(false);
    if (!current.current.cards[id]) return;
    onResize?.(id); update(id); persist();
  };
  const resetHeight = (id: string) => {
    if (drag.current?.id === id) finish(false);
    const next = { ...current.current.cards[id] };
    delete next.height; delete next.fullHeight;
    onResize?.(id); update(id, next); persist();
  };
  const begin = (id: string, axis: CardResizeAxis, event: ReactPointerEvent<HTMLDivElement>) => {
    const card = descriptor(id);
    if (!card || drag.current || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
    onResize?.(id);
    const size = resolveCardSize(card, current.current.cards[id]);
    drag.current = { id, axes: axis === "both" ? ["width", "height"] : [axis], pointerId: event.pointerId, target: event.currentTarget,
      x: event.clientX, y: event.clientY, width: size.width, height: size.height, before: current.current.cards[id] && { ...current.current.cards[id] }, limits: cardSizeLimits(card) };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handleProps = (id: string, axis: CardResizeAxis, label = "卡片"): HTMLAttributes<HTMLDivElement> => {
    const size = getSize(id);
    return {
      role: axis === "both" ? "group" : "separator", tabIndex: 0,
      "aria-roledescription": axis === "both" ? "尺寸调整把手" : undefined,
      "aria-orientation": axis === "both" ? undefined : axis === "width" ? "vertical" : "horizontal",
      "aria-label": axis === "both" ? `拖动调整${label}大小` : `调整${label}${axis === "width" ? "宽度" : "高度"}`,
      "aria-valuemin": axis === "both" ? undefined : axis === "width" ? size.minWidth : size.minHeight,
      "aria-valuemax": axis === "both" ? undefined : axis === "width" ? size.maxWidth : size.maxHeight,
      "aria-valuenow": axis === "both" ? undefined : Math.round(size[axis]),
      title: "拖动本卡边缘调整大小；方向键微调，Shift 加快，Home 还原本卡，Escape 取消拖动",
      onPointerDown: event => begin(id, axis, event),
      onPointerMove: event => {
        const active = drag.current;
        if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        const next = { ...active.before };
        for (const dimension of active.axes) {
          const value = boundCardSize(active[dimension] + (dimension === "width" ? event.clientX - active.x : event.clientY - active.y),
            dimension === "width" ? active.limits.minWidth : active.limits.minHeight, dimension === "width" ? active.limits.maxWidth : active.limits.maxHeight);
          if (Math.abs(value - active[dimension]) < .01) {
            if (active.before?.[dimension] === undefined) delete next[dimension];
          } else {
            next[dimension] = value;
            if (dimension === "height") {
              if (value >= active.limits.maxHeight - .01) next.fullHeight = true;
              else delete next.fullHeight;
            }
          }
        }
        pending.current = next;
        if (frame.current === null) frame.current = requestAnimationFrame(() => {
          frame.current = null; if (drag.current && pending.current) { update(drag.current.id, pending.current); pending.current = null; }
        });
      },
      onPointerUp: event => { if (drag.current?.pointerId === event.pointerId && drag.current.id === id) { event.preventDefault(); event.stopPropagation(); finish(true); } },
      onPointerCancel: event => { if (drag.current?.pointerId === event.pointerId && drag.current.id === id) finish(false); },
      onLostPointerCapture: event => { if (drag.current?.pointerId === event.pointerId && drag.current.id === id) finish(false); },
      onKeyDown: event => {
        event.stopPropagation();
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Escape") { finish(false); return; }
        if (event.key === "Home") { reset(id); return; }
        const dimension = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "width" : event.key === "End" ? (axis === "both" ? "height" : axis) : "height";
        if (axis !== "both" && dimension !== axis) return;
        setSize(id, { [dimension]: event.key === "End" ? (dimension === "width" ? size.maxWidth : size.maxHeight)
          : size[dimension] + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) * (event.shiftKey ? 50 : 10) });
      },
    };
  };
  return { getSize, setSize, reset, resetHeight, handleProps,
    style: (id: string) => { const size = getSize(id); return { "--card-width": `${size.width}px`, "--card-height": `${size.height}px`, width: `${size.width}px`, height: `${size.height}px` } as CSSProperties; } };
}
export type CardSizesController = ReturnType<typeof useCardSizes>;
