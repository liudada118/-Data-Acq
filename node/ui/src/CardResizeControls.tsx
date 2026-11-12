import { useId } from "react";
import { ArrowUpDown, RotateCcw } from "lucide-react";
import type { CardSizesController } from "./useCardSizes";

export function CardResizeControls({ sizes, cardId, label = "卡片", allowFullHeight = false }: { sizes: CardSizesController; cardId: string; label?: string; allowFullHeight?: boolean }) {
  const id = useId(), size = sizes.getSize(cardId);
  return <div className="card-size-controls">
    <div className="card-resize-right" {...sizes.handleProps(cardId, "width", label)} aria-describedby={`${id}-size`} />
    <div className="card-resize-bottom" {...sizes.handleProps(cardId, "height", label)} aria-describedby={`${id}-size`} />
    <div className="card-size-footer">
      <output id={`${id}-size`} className="card-size-value" aria-label={`${label}当前尺寸`}>{Math.round(size.width)} × {Math.round(size.height)}<span> px</span></output>
      {allowFullHeight && <button type="button" className="card-size-fill-height" aria-pressed={size.fullHeight}
        aria-label={`${label}${size.fullHeight ? "恢复默认高度" : "纵向铺满展示区"}`}
        title={size.fullHeight ? "恢复默认高度，保留宽度" : "保持本列宽度，纵向占满展示区"}
        onClick={() => size.fullHeight ? sizes.resetHeight(cardId) : sizes.setSize(cardId, { height: size.maxHeight })}>
        <ArrowUpDown size={12} aria-hidden="true" /><span>{size.fullHeight ? "恢复高度" : "纵向铺满"}</span>
      </button>}
      <button type="button" className="card-size-reset" disabled={!size.customized} aria-label={`还原${label}大小`} title="还原本卡大小" onClick={() => sizes.reset(cardId)}><RotateCcw size={12} aria-hidden="true" /><span>还原</span></button>
      <div className="card-resize-corner" {...sizes.handleProps(cardId, "both", label)} aria-describedby={`${id}-size`}>
        <span>拖动调大小</span><svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true"><path d="M4 14 14 4M9 14l5-5M13 14l1-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </div>
    </div>
  </div>;
}
