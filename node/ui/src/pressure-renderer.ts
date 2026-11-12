import type { PressurePreview } from "./types";
import { getNumericLayout } from "./numeric-pressure-renderer";
import { formatPressureMaximum, resolvePressureRange } from "./pressure-range";
import type { PressureRangeSettings } from "./pressure-range";

const regionLabels: Record<string, string> = {
  back: "背部", chest: "胸部", rightArm: "右臂", rightShoulder: "右肩",
  leftArm: "左臂", leftShoulder: "左肩", backPantsRight: "右后裤片",
  backPantsLeft: "左后裤片", frontPantsLeft: "左前裤片", frontPantsRight: "右前裤片",
};

export function pressureValues(pressure: PressurePreview): number[] {
  if (pressure.glove) return [
    ...Object.values(pressure.glove.fingers).flatMap(finger => [...finger.values, finger.pulp]),
    ...pressure.glove.palm.values,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (pressure.points?.length) return pressure.points.map(point => point.value);
  if (pressure.regions?.length) return pressure.regions.flatMap(region => region.values);
  return pressure.values;
}

export function pressureDescription(pressure: PressurePreview): string {
  if (pressure.glove)
    return `${pressure.glove.side === "left" ? "左手" : "右手"} · ${pressureValues(pressure).length} 个物理点`;
  if (pressure.points?.length)
    return `${pressure.points.length} 个真实点 · ${pressure.full_scale === 4095 ? "12" : "8"} bit ADC`;
  if (pressure.regions?.length)
    return `${pressure.regions.length} 个物理分区 · ${pressureValues(pressure).length} 个映射点`;
  return `${pressure.rows} × ${pressure.cols} 阵列`;
}

function heatColor(value: number): string {
  if (!Number.isFinite(value)) return "#dce2d8";
  const stops = [[16,49,45],[35,108,81],[108,171,98],[221,213,111],[249,163,94],[211,76,64]];
  const position = Math.max(0, Math.min(0.999, value)) * (stops.length - 1);
  const index = Math.floor(position), fraction = position - index;
  return `rgb(${stops[index].map((component, channel) => Math.round(component + (stops[index + 1][channel] - component) * fraction)).join(",")})`;
}

function legend(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, maximum: number) {
  for (let i = 0; i < height; i++) {
    ctx.fillStyle = heatColor(1 - i / height);
    ctx.fillRect(x, y + i, 6, 1.4);
  }
  ctx.fillStyle = "#52634f";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText(formatPressureMaximum(maximum), x + 10, y + 9);
  ctx.fillText("0", x + 10, y + height);
}

function matrix(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number,
  rows: number, cols: number, values: number[], maximum: number) {
  const cell = Math.max(0.5, Math.min(width / cols, height / rows));
  const left = x + (width - cell * cols) / 2, top = y + (height - cell * rows) / 2;
  values.forEach((value, index) => {
    ctx.fillStyle = heatColor(value / maximum);
    ctx.fillRect(left + (index % cols) * cell, top + Math.floor(index / cols) * cell,
      Math.max(0.5, cell - 0.7), Math.max(0.5, cell - 0.7));
  });
}

/** Physical coordinates and per-region source order are preserved; no interpolation or anatomical mirroring. */
export function drawPressure(ctx: CanvasRenderingContext2D, width: number, height: number, pressure: PressurePreview,
  range?: PressureRangeSettings) {
  ctx.fillStyle = "#f3f5ef";
  ctx.fillRect(0, 0, width, height);
  const displayed = pressureValues(pressure);
  const { maximum } = resolvePressureRange(range, displayed, pressure.full_scale);
  if (pressure.glove) {
    const layout = getNumericLayout(pressure);
    const scale = Math.max(0.001, Math.min((width - 24) / layout.width, (height - 24) / layout.height));
    const x = (width - layout.width * scale) / 2, y = (height - layout.height * scale) / 2;
    for (const cell of layout.cells) {
      ctx.fillStyle = cell.value === null ? "#dce2d8" : heatColor(cell.value / maximum);
      ctx.fillRect(x + cell.x * scale, y + cell.y * scale,
        Math.max(0.5, cell.width * scale - 1), Math.max(0.5, cell.height * scale - 1));
    }
    ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#425a4d"; ctx.font = `${Math.max(10, 12 * scale)}px sans-serif`;
    for (const label of layout.labels) {
      if (label.role !== "title") continue;
      ctx.fillText(label.text, x + (label.x + label.width / 2) * scale,
        y + (label.y + label.height / 2) * scale, Math.max(1, label.width * scale));
    }
    ctx.restore();
  } else if (pressure.regions?.length) {
    const regions = pressure.regions;
    const gap = 8, padding = 10, bottom = 26;
    // Fit both dimensions: a narrow but short tile cannot afford five rows of titles.
    // Preserve source order and choose the grid with the largest smallest physical cell.
    const maxColumns = Math.min(regions.length, Math.max(1, Math.floor((width - padding * 2 + gap) / (64 + gap))));
    let columns = 1, largestCell = -Infinity;
    for (let candidate = 1; candidate <= maxColumns; candidate++) {
      const candidateRows = Math.ceil(regions.length / candidate);
      const regionWidth = (width - padding * 2 - gap * (candidate - 1)) / candidate;
      const regionHeight = (height - padding * 2 - bottom - gap * (candidateRows - 1)) / candidateRows;
      const cell = Math.min(...regions.map(region => Math.min((regionWidth - 10) / region.cols, (regionHeight - 28) / region.rows)));
      if (cell > largestCell) { columns = candidate; largestCell = cell; }
    }
    const rows = Math.ceil(regions.length / columns);
    const w = (width - padding * 2 - gap * (columns - 1)) / columns;
    const h = (height - padding * 2 - bottom - gap * (rows - 1)) / rows;
    regions.forEach((region, i) => {
      const x = padding + (i % columns) * (w + gap), y = padding + Math.floor(i / columns) * (h + gap);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#425a4d";
      ctx.font = "12px sans-serif";
      ctx.fillText(regionLabels[region.id] ?? region.name, x + 7, y + 16, Math.max(1, w - 12));
      matrix(ctx, x + 5, y + 23, Math.max(1, w - 10), Math.max(1, h - 28), region.rows, region.cols, region.values, maximum);
    });
    ctx.fillStyle = "#52634f";
    ctx.font = "11px sans-serif";
    ctx.fillText(`各区共用量程 0–${formatPressureMaximum(maximum)} · 原始线序`, padding, height - 9, width - 20);
  } else if (pressure.points?.length) {
    const points = pressure.points;
    const minX = Math.min(...points.map(p => p.x_mm)), maxX = Math.max(...points.map(p => p.x_mm));
    const minY = Math.min(...points.map(p => p.y_mm)), maxY = Math.max(...points.map(p => p.y_mm));
    const scale = Math.max(0.01, Math.min(Math.max(1, width - 100) / Math.max(1, maxX - minX),
      Math.max(1, height - 68) / Math.max(1, maxY - minY)));
    const plottedWidth = (maxX - minX) * scale, plottedHeight = (maxY - minY) * scale;
    const x = (width - 48 - plottedWidth) / 2, y = (height - 24 - plottedHeight) / 2;
    const radius = Math.max(1, Math.min(6, 1.6 * scale));
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(x + (point.x_mm - minX) * scale, y + (maxY - point.y_mm) * scale, radius, 0, Math.PI * 2);
      ctx.fillStyle = heatColor(point.value / maximum);
      ctx.fill();
      ctx.strokeStyle = "#617568";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    legend(ctx, x + plottedWidth + 22, y, Math.max(1, plottedHeight), maximum);
    ctx.fillStyle = "#52634f";
    ctx.font = "11px sans-serif";
    ctx.fillText("物理点位 · 等比例毫米坐标 · 未插值", 12, height - 10, width - 24);
  } else {
    const gridSize = Math.max(1, Math.min(height - 14, width - 62));
    const x = (width - gridSize) / 2 - 18, y = (height - gridSize) / 2;
    matrix(ctx, x, y, gridSize, gridSize, pressure.rows, pressure.cols, pressure.values, maximum);
    legend(ctx, x + gridSize + 12, y, gridSize, maximum);
  }
}
