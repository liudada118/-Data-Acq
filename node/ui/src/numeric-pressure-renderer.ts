import type { PressurePreview } from "./types";

export interface NumericTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface NumericCell {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number | null;
  text: string;
  label: string;
  row: number;
  col: number;
  regionId?: string;
  sourceIndex?: number;
  pulp?: boolean;
}

export interface NumericLabel {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  role: "row" | "column" | "title" | "sum" | "note";
}

export interface NumericLayout {
  width: number;
  height: number;
  cells: NumericCell[];
  labels: NumericLabel[];
  kind: "matrix" | "regions" | "points" | "glove";
  maximum: number;
}

const CELL_WIDTH = 44;
const CELL_HEIGHT = 32;
const AXIS_WIDTH = 28;
const AXIS_HEIGHT = 24;
const PADDING = 12;
const REGION_GAP = 20;
const TITLE_HEIGHT = 28;
const regionLabels: Record<string, string> = {
  back: "背部", chest: "胸部", rightArm: "右臂", rightShoulder: "右肩",
  leftArm: "左臂", leftShoulder: "左肩", backPantsRight: "右后裤片",
  backPantsLeft: "左后裤片", frontPantsLeft: "左前裤片", frontPantsRight: "右前裤片",
};

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Color normalization never changes the number displayed or retained for inspection. */
export function formatNumericValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  if (Number.isInteger(value)) return String(value);
  // Do not turn a small, nonzero measurement into a misleading zero.
  return Math.abs(value) < 0.01
    ? String(Number(value.toPrecision(2)))
    : String(Number(value.toFixed(2)));
}

function validShape(rows: number, cols: number): boolean {
  return Number.isSafeInteger(rows) && Number.isSafeInteger(cols)
    && rows > 0 && cols > 0 && rows * cols <= 65_536;
}

function addAxes(layout: NumericLayout, x: number, y: number, rows: number, cols: number) {
  for (let row = 0; row < rows; row++) {
    layout.labels.push({ x, y: y + row * CELL_HEIGHT, width: AXIS_WIDTH, height: CELL_HEIGHT,
      text: String(row + 1), role: "row" });
  }
  for (let col = 0; col < cols; col++) {
    layout.labels.push({ x: x + AXIS_WIDTH + col * CELL_WIDTH, y: y + rows * CELL_HEIGHT,
      width: CELL_WIDTH, height: AXIS_HEIGHT, text: String(col + 1), role: "column" });
  }
}

function addMatrix(layout: NumericLayout, x: number, y: number, rows: number, cols: number,
  values: number[], regionId?: string, name?: string) {
  if (!validShape(rows, cols)) return;
  addAxes(layout, x, y, rows, cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const value = numericValue(values[row * cols + col]);
      layout.cells.push({
        x: x + AXIS_WIDTH + col * CELL_WIDTH, y: y + row * CELL_HEIGHT,
        width: CELL_WIDTH, height: CELL_HEIGHT, value, text: formatNumericValue(value), row, col,
        label: `${name ? `${name} · ` : ""}行 ${row + 1} · 列 ${col + 1}`,
        ...(regionId === undefined ? {} : { regionId }),
      });
    }
  }
}

/**
 * Physical glove regions follow the SDK's 137-point mapping. Its legacy 13×15
 * pressureMatrix has a different channel map and must never be cut into fingers.
 * Screen geometry matches shroom1.0's gloveHandLayout; values stay in SDK order.
 */
function gloveLayout(glove: NonNullable<PressurePreview["glove"]>): NumericLayout {
  const step = 32, handWidth = 17, palmLabelY = 10.4, palmRowsY = 12.1;
  const layout: NumericLayout = {
    width: PADDING * 2 + handWidth * step,
    height: PADDING * 2 + 17.1 * step,
    cells: [], labels: [], kind: "glove", maximum: 1,
  };
  const names = { little: "小拇指", ring: "无名指", middle: "中指", index: "食指", thumb: "大拇指" };
  const drops = { middle: 0, ring: 1, index: 1, little: 2, thumb: 2.5 };
  const order: (keyof typeof names)[] = glove.side === "left"
    ? ["little", "ring", "middle", "index", "thumb"]
    : ["thumb", "index", "middle", "ring", "little"];
  const label = (text: string, x: number, y: number, width: number, height: number, role: NumericLabel["role"]) => {
    layout.labels.push({ text, x: PADDING + x * step, y: PADDING + y * step,
      width: width * step, height: height * step, role });
  };
  const sumText = (values: (number | null)[]) => values.every(value => value !== null)
    ? `Σ ${formatNumericValue(values.reduce<number>((sum, value) => sum + (value ?? 0), 0))}` : "Σ --";
  const cell = (value: unknown, source: unknown, x: number, y: number,
    row: number, col: number, regionId: string, name: string, pulp = false) => {
    const numeric = numericValue(value);
    const sourceIndex = typeof source === "number" && Number.isInteger(source) && source >= 0 && source < 256 ? source : undefined;
    layout.cells.push({ x: PADDING + x * step, y: PADDING + y * step, width: step, height: step,
      value: numeric, text: formatNumericValue(numeric), row, col, regionId, pulp,
      ...(sourceIndex === undefined ? {} : { sourceIndex }),
      label: `${name} · ${pulp ? "指腹" : `行 ${row + 1} · 列 ${col + 1}`}${sourceIndex === undefined ? "" : ` · ADC 通道 ${sourceIndex + 1}`}`,
    });
    layout.maximum = Math.max(layout.maximum, numeric ?? 0);
  };
  order.forEach((id, index) => {
    const finger = glove.fingers?.[id];
    const x = index * 3.5, y = drops[id], gridY = y + 1.7;
    label(names[id], x, y, 3, 0.8, "title");
    const values = Array.from({ length: 12 }, (_, offset) => numericValue(finger?.values?.[offset]));
    label(sumText(values), x, y + 0.8, 3, 0.75, "sum");
    values.forEach((value, offset) => cell(value, finger?.source_indices?.[offset],
      x + offset % 3, gridY + Math.floor(offset / 3), Math.floor(offset / 3), offset % 3, id, names[id]));
    label("指腹", x, gridY + 4, 3, 0.6, "note");
    cell(finger?.pulp, finger?.pulp_source_index, x + 1, gridY + 4.6, 0, 0, id, names[id], true);
  });
  // Palm and its short first row align to the little-finger side. The data
  // within a row already has the correct side-specific order from the SDK.
  const palmX = glove.side === "left" ? 0 : handWidth - 15;
  const rowLengths = [12, 15, 15, 15, 15];
  const palmValues = Array.from({ length: 72 }, (_, offset) => numericValue(glove.palm?.values?.[offset]));
  label("手掌", palmX, palmLabelY, 15, 0.8, "title");
  label(sumText(palmValues), palmX, palmLabelY + 0.8, 15, 0.75, "sum");
  let offset = 0;
  rowLengths.forEach((length, row) => {
    const rowOffset = glove.side === "left" ? 0 : 15 - length;
    for (let col = 0; col < length; col++, offset++) {
      cell(palmValues[offset], glove.palm?.source_indices?.[offset],
        palmX + rowOffset + col, palmRowsY + row, row, col, "palm", "手掌");
    }
  });
  return layout;
}

/** SDK rows/columns retain their order; sparse points leave unmeasured grid positions empty. */
export function getNumericLayout(pressure: PressurePreview): NumericLayout {
  if (pressure.glove && ["left", "right"].includes(pressure.glove.side)) return gloveLayout(pressure.glove);
  const layout: NumericLayout = {
    width: PADDING * 2, height: PADDING * 2, cells: [], labels: [], kind: "matrix", maximum: 1,
  };
  if (pressure.points?.length) {
    layout.kind = "points";
    const points = pressure.points.filter(point => Number.isSafeInteger(point.row) && point.row >= 0
      && Number.isSafeInteger(point.col) && point.col >= 0);
    if (!points.length) return layout;
    const hasShape = validShape(pressure.rows, pressure.cols);
    const rows = hasShape ? pressure.rows : Math.max(...points.map(point => point.row)) + 1;
    const cols = hasShape ? pressure.cols : Math.max(...points.map(point => point.col)) + 1;
    if (!validShape(rows, cols)) return layout;
    addAxes(layout, PADDING, PADDING, rows, cols);
    layout.cells = points.filter(point => point.row < rows && point.col < cols).map(point => {
      const value = numericValue(point.value);
      const xMm = Number.isFinite(point.x_mm) ? String(point.x_mm) : "--";
      const yMm = Number.isFinite(point.y_mm) ? String(point.y_mm) : "--";
      return {
        x: PADDING + AXIS_WIDTH + point.col * CELL_WIDTH, y: PADDING + point.row * CELL_HEIGHT,
        width: CELL_WIDTH, height: CELL_HEIGHT, value, text: formatNumericValue(value),
        row: point.row, col: point.col,
        label: `行 ${point.row + 1} · 列 ${point.col + 1} · (${xMm}, ${yMm}) mm`,
      };
    });
    layout.width = PADDING * 2 + AXIS_WIDTH + cols * CELL_WIDTH;
    layout.height = PADDING * 2 + rows * CELL_HEIGHT + AXIS_HEIGHT;
  } else if (pressure.regions?.length) {
    layout.kind = "regions";
    let x = PADDING, y = PADDING, rowHeight = 0;
    pressure.regions.filter(region => validShape(region.rows, region.cols)).forEach((region, index) => {
      if (index > 0 && index % 5 === 0) {
        x = PADDING;
        y += rowHeight + REGION_GAP;
        rowHeight = 0;
      }
      const width = AXIS_WIDTH + region.cols * CELL_WIDTH;
      const height = TITLE_HEIGHT + region.rows * CELL_HEIGHT + AXIS_HEIGHT;
      const name = regionLabels[region.id] ?? region.name;
      layout.labels.push({ x, y, width, height: TITLE_HEIGHT, text: name, role: "title" });
      addMatrix(layout, x, y + TITLE_HEIGHT, region.rows, region.cols, region.values, region.id, name);
      rowHeight = Math.max(rowHeight, height);
      layout.width = Math.max(layout.width, x + width + PADDING);
      layout.height = Math.max(layout.height, y + height + PADDING);
      x += width + REGION_GAP;
    });
  } else if (validShape(pressure.rows, pressure.cols)) {
    addMatrix(layout, PADDING, PADDING, pressure.rows, pressure.cols, pressure.values);
    layout.width = PADDING * 2 + AXIS_WIDTH + pressure.cols * CELL_WIDTH;
    layout.height = PADDING * 2 + pressure.rows * CELL_HEIGHT + AXIS_HEIGHT;
  }
  for (const cell of layout.cells) layout.maximum = Math.max(layout.maximum, cell.value ?? 0);
  return layout;
}

function validTransform(transform: NumericTransform): boolean {
  return Number.isFinite(transform.scale) && transform.scale > 0
    && Number.isFinite(transform.offsetX) && Number.isFinite(transform.offsetY);
}

function intersects(x: number, y: number, width: number, height: number,
  left: number, top: number, right: number, bottom: number): boolean {
  return x + width > left && y + height > top && x < right && y < bottom;
}

function cellColor(value: number | null, maximum: number): string {
  if (value === null) return "#1b2639";
  const intensity = Math.max(0, Math.min(1, value / maximum));
  return `rgb(${Math.round(4 + intensity * 9)},${Math.round(18 + intensity * 48)},${Math.round(55 + intensity * 40)})`;
}

/** Draw in CSS pixels, preserving the caller's DPR transform and reusing its canvas. */
export function drawNumericPressure(ctx: CanvasRenderingContext2D, viewportW: number, viewportH: number,
  layout: NumericLayout, transform: NumericTransform): number {
  if (!Number.isFinite(viewportW) || !Number.isFinite(viewportH) || viewportW <= 0 || viewportH <= 0) return 0;
  ctx.save();
  ctx.fillStyle = "#081427";
  ctx.fillRect(0, 0, viewportW, viewportH);
  if (!validTransform(transform)) {
    ctx.restore();
    return 0;
  }
  const { scale, offsetX, offsetY } = transform;
  const left = -offsetX / scale, top = -offsetY / scale;
  const right = (viewportW - offsetX) / scale, bottom = (viewportH - offsetY) / scale;
  ctx.beginPath();
  ctx.rect(0, 0, viewportW, viewportH);
  ctx.clip();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  let drawn = 0;
  for (const cell of layout.cells) {
    if (!intersects(cell.x, cell.y, cell.width, cell.height, left, top, right, bottom)) continue;
    const x = offsetX + cell.x * scale, y = offsetY + cell.y * scale;
    const width = cell.width * scale, height = cell.height * scale;
    ctx.fillStyle = cellColor(cell.value, layout.maximum);
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = cell.pulp ? "#915d30" : layout.kind === "glove" ? "#174357" : "rgba(0,0,40,0.6)";
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = cell.value === null ? "#9aacbf" : layout.kind === "glove" ? "#d0e4ed" : "#4ec7ff";
    ctx.font = `bold ${Math.max(10, 14 * scale)}px ui-monospace, Consolas, monospace`;
    ctx.fillText(cell.text, x + width / 2, y + height / 2, (cell.width - (layout.kind === "glove" ? 2 : 6)) * scale);
    drawn++;
  }
  for (const label of layout.labels) {
    if (!intersects(label.x, label.y, label.width, label.height, left, top, right, bottom)) continue;
    const x = offsetX + label.x * scale, y = offsetY + label.y * scale;
    const width = label.width * scale, height = label.height * scale;
    if (label.role === "row" || label.role === "column" || label.role === "sum") {
      ctx.fillStyle = label.role === "sum" ? "#102338" : "rgba(30,60,200,0.85)";
      ctx.fillRect(x, y, width, height);
    }
    ctx.fillStyle = label.role === "note" ? "#e1a86f"
      : layout.kind === "glove" && label.role === "title" ? "#65dce6"
        : label.role === "title" ? "#e0ebff" : "#c1ddff";
    ctx.font = `${label.role === "title" ? "600" : "bold"} ${Math.max(label.role === "title" ? 10 : 8, 12 * scale)}px ui-monospace, Consolas, sans-serif`;
    ctx.fillText(label.text, x + width / 2, y + height / 2, Math.max(1, width - 4 * scale));
  }
  ctx.restore();
  return drawn;
}

/** Canvas-local CSS coordinates; half-open cell bounds avoid ambiguous shared borders. */
export function findNumericCell(layout: NumericLayout, canvasX: number, canvasY: number,
  transform: NumericTransform): NumericCell | null {
  if (!validTransform(transform) || !Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null;
  const x = (canvasX - transform.offsetX) / transform.scale;
  const y = (canvasY - transform.offsetY) / transform.scale;
  for (let index = layout.cells.length - 1; index >= 0; index--) {
    const cell = layout.cells[index];
    if (x >= cell.x && x < cell.x + cell.width && y >= cell.y && y < cell.y + cell.height) return cell;
  }
  return null;
}
