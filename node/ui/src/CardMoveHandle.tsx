import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, GripVertical, RotateCcw } from "lucide-react";
import type { CardPositionsController } from "./useCardPositions";

export function CardMoveHandle({ positions, cardId, label }: {
  positions: CardPositionsController;
  cardId: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const placement = positions.plan.placements[cardId];
  const enabled = positions.enabled && Boolean(placement);
  const moving = positions.draggingId === cardId;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function choose(action: () => void) {
    action();
    close(true);
  }

  useEffect(() => { if (!enabled || moving) setOpen(false); }, [enabled, moving]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return <div ref={root} className="card-move-control" onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}>
    <button {...positions.handleProps(cardId)} ref={trigger} type="button"
      className={`card-move-handle${moving ? " is-dragging" : ""}`} disabled={!enabled}
      aria-label={`移动${label}`} aria-expanded={open} aria-controls={menuId}
      title={enabled ? "拖到另一张卡片上交换位置，拖到空位移动；点击选择位置；方向键移动，Home / End 移到两侧" : "当前布局无需移动"}
      onClick={() => {
        if (positions.consumeClick()) { close(); return; }
        setOpen(current => !current);
      }}>
      <GripVertical size={15} aria-hidden="true" /><span>移动</span>
    </button>
    {open && enabled && placement && <div ref={menu} id={menuId} className="card-position-menu" role="group" aria-label={`移动${label}的位置`}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <div className="card-position-caption"><span>移动 / 交换位置</span><span>第 {placement.column} 列 · 第 {placement.row} 行</span></div>
      <div className="card-position-directions">
        <button type="button" aria-label={`将${label}向左移动`} title="向左" disabled={placement.column <= 1} onClick={() => choose(() => positions.moveBy(cardId, -1, 0))}><ArrowLeft size={15} aria-hidden="true" /><span>左</span></button>
        <button type="button" aria-label={`将${label}向上移动`} title="向上" disabled={placement.row <= 1 || placement.rowSpan > 1} onClick={() => choose(() => positions.moveBy(cardId, 0, -1))}><ArrowUp size={15} aria-hidden="true" /><span>上</span></button>
        <button type="button" aria-label={`将${label}向下移动`} title="向下" disabled={placement.row + placement.rowSpan - 1 >= positions.rows || placement.rowSpan > 1} onClick={() => choose(() => positions.moveBy(cardId, 0, 1))}><ArrowDown size={15} aria-hidden="true" /><span>下</span></button>
        <button type="button" aria-label={`将${label}向右移动`} title="向右" disabled={placement.column + placement.columnSpan - 1 >= positions.columns} onClick={() => choose(() => positions.moveBy(cardId, 1, 0))}><ArrowRight size={15} aria-hidden="true" /><span>右</span></button>
      </div>
      <div className="card-position-edges">
        <button type="button" aria-label={`将${label}移到最左`} disabled={placement.column <= 1} onClick={() => choose(() => positions.moveToEdge(cardId, "left"))}>最左</button>
        <button type="button" aria-label={`将${label}移到最右`} disabled={placement.column + placement.columnSpan - 1 >= positions.columns} onClick={() => choose(() => positions.moveToEdge(cardId, "right"))}>最右</button>
        <button type="button" aria-label={`恢复${label}自动位置`} onClick={() => choose(() => positions.reset(cardId))}><RotateCcw size={12} aria-hidden="true" />恢复</button>
      </div>
    </div>}
  </div>;
}
