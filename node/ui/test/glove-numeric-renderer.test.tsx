import test from "node:test";
import assert from "node:assert/strict";
import { createGlovePressureFrame } from "../../node_modules/shroom-sdk/runtime/core/glove.js";
import { drawNumericPressure, findNumericCell, getNumericLayout } from "../src/numeric-pressure-renderer";
import type { PressurePreview } from "../src/types";

function fixture(side: "left" | "right"): PressurePreview {
  const frame = createGlovePressureFrame(Uint8Array.from({ length: 256 }, (_, i) => i), { side });
  const fingers = Object.fromEntries(Object.entries(frame.fingers).map(([id, part]: [string, any]) => [id, {
    values: Array.from(part.raw), source_indices: Array.from(part.sourceIndices),
    pulp: part.pulp.raw[0], pulp_source_index: part.pulp.sourceIndices[0],
  }]));
  return { rows: 13, cols: 15, values: Array(195).fill(999), glove: {
    side, fingers: fingers as NonNullable<PressurePreview["glove"]>["fingers"],
    palm: { values: Array.from(frame.palm.raw), row_lengths: frame.palm.rowLengths,
      source_indices: Array.from(frame.palm.sourceIndices) },
  } };
}

test("glove displays the official 137 physical points rather than the unrelated legacy 195-cell matrix", () => {
  const layout = getNumericLayout(fixture("left"));
  assert.equal(layout.kind, "glove");
  assert.equal(layout.cells.length, 137);
  assert.equal(new Set(layout.cells.map(cell => cell.sourceIndex)).size, 137);
  assert.equal(layout.maximum, 254, "unused channels and the old matrix never affect the physical scale");
  assert.deepEqual(layout.cells.filter(cell => cell.regionId === "little" && !cell.pulp).map(cell => cell.sourceIndex! + 1),
    [31, 30, 29, 15, 14, 13, 255, 254, 253, 239, 238, 237]);
  const pulp = layout.cells.find(cell => cell.regionId === "little" && cell.pulp)!;
  assert.equal(pulp.sourceIndex, 221);
  assert.equal(pulp.value, 221);
  assert.equal(pulp.label, "小拇指 · 指腹 · ADC 通道 222");
  const adcOne = layout.cells.find(cell => cell.sourceIndex === 0)!;
  assert.equal(adcOne.regionId, "thumb");
  assert.equal(adcOne.text, "0", "a measured zero remains visible");
  assert.equal(layout.labels.filter(label => label.role === "sum").length, 6);
  assert.equal(layout.labels.find(label => label.role === "sum")!.text, "Σ 1596", "finger sum excludes the separate pulp point");
  assert.equal(layout.cells.filter(cell => cell.regionId === "palm").length, 72);
});

test("left and right preserve SDK row order while mirroring finger placement and aligning the palm to the little finger", () => {
  const left = getNumericLayout(fixture("left")), right = getNumericLayout(fixture("right"));
  assert.deepEqual(left.labels.filter(label => label.role === "title").map(label => label.text),
    ["小拇指", "无名指", "中指", "食指", "大拇指", "手掌"]);
  assert.deepEqual(right.labels.filter(label => label.role === "title").map(label => label.text),
    ["大拇指", "食指", "中指", "无名指", "小拇指", "手掌"]);
  assert.deepEqual(right.cells.filter(cell => cell.regionId === "thumb" && !cell.pulp).map(cell => cell.sourceIndex! + 1),
    [240, 239, 238, 256, 255, 254, 16, 15, 14, 32, 31, 30]);
  const starts = (layout: typeof left, id: string) => layout.cells.find(cell => cell.regionId === id && !cell.pulp)!;
  const cellSize = starts(left, "middle").height;
  for (const layout of [left, right]) {
    const middle = starts(layout, "middle");
    assert.equal(starts(layout, "ring").y - middle.y, cellSize);
    assert.equal(starts(layout, "index").y - middle.y, cellSize);
    assert.equal(starts(layout, "little").y - middle.y, 2 * cellSize);
    assert.equal(starts(layout, "thumb").y - middle.y, 2.5 * cellSize);
  }
  assert.ok(starts(left, "little").x < starts(left, "thumb").x);
  assert.ok(starts(right, "thumb").x < starts(right, "little").x);
  const leftPalm = left.cells.filter(cell => cell.regionId === "palm");
  const rightPalm = right.cells.filter(cell => cell.regionId === "palm");
  assert.deepEqual(leftPalm.filter(cell => cell.row === 0).map(cell => cell.sourceIndex! + 1),
    [207, 206, 205, 204, 203, 202, 201, 200, 199, 198, 197, 196]);
  assert.deepEqual(rightPalm.filter(cell => cell.row === 0).map(cell => cell.sourceIndex! + 1),
    [61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50]);
  assert.equal(leftPalm[0].x, leftPalm[12].x);
  assert.equal(rightPalm[0].x, rightPalm[12].x + 3 * cellSize);
  assert.equal(leftPalm[0].x, starts(left, "little").x);
  assert.equal(rightPalm.at(-1)!.x, starts(right, "little").x + 2 * cellSize);
  assert.equal(right.cells.find(cell => cell.sourceIndex === 255)!.text, "255");
});

test("missing glove samples are distinct from zero and cannot become a partial misleading sum", () => {
  const pressure = fixture("left");
  pressure.glove!.fingers.little.values[0] = NaN;
  pressure.glove!.fingers.little.values[1] = 0;
  pressure.glove!.fingers.little.pulp = null;
  pressure.glove!.palm.values.length = 0;
  const layout = getNumericLayout(pressure);
  assert.equal(layout.cells.length, 137);
  assert.deepEqual(layout.cells.slice(0, 2).map(cell => cell.text), ["--", "0"]);
  assert.equal(layout.cells.find(cell => cell.regionId === "little" && cell.pulp)!.text, "--");
  assert.ok(layout.cells.filter(cell => cell.regionId === "palm").every(cell => cell.value === null && cell.text === "--"));
  assert.equal(layout.labels.find(label => label.role === "sum")!.text, "Σ --");
  assert.equal(layout.labels.filter(label => label.role === "sum").at(-1)!.text, "Σ --");
});

test("glove hit testing follows pan and zoom, leaves physical gaps empty, and summaries are not sample points", () => {
  const layout = getNumericLayout(fixture("right"));
  const view = { scale: 1.8, offsetX: 33, offsetY: -42 };
  const hit = (x: number, y: number) => findNumericCell(layout, x * view.scale + view.offsetX, y * view.scale + view.offsetY, view);
  const point = layout.cells.find(cell => cell.regionId === "thumb" && cell.pulp)!;
  assert.equal(hit(point.x + point.width / 2, point.y + point.height / 2), point);
  assert.equal(hit(point.x - point.width / 2, point.y + point.height / 2), null, "pulp has empty space on either side");
  const palmStart = layout.cells.find(cell => cell.regionId === "palm")!;
  assert.equal(hit(palmStart.x - palmStart.width / 2, palmStart.y + palmStart.height / 2), null, "right palm's short row has a blank leading edge");
  for (const summary of layout.labels.filter(label => label.role === "sum"))
    assert.equal(hit(summary.x + summary.width / 2, summary.y + summary.height / 2), null);
});

test("glove canvas clips offscreen points while keeping the true ADC text and a separate summary label", () => {
  const layout = getNumericLayout(fixture("left"));
  const cell = layout.cells.find(cell => cell.regionId === "palm" && cell.row === 3 && cell.col === 7)!;
  const texts: string[] = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {}, strokeRect() {},
    fillText(value: string) { texts.push(value); } } as unknown as CanvasRenderingContext2D;
  assert.equal(drawNumericPressure(ctx, cell.width, cell.height, layout,
    { scale: 1, offsetX: -cell.x, offsetY: -cell.y }), 1);
  assert.deepEqual(texts, [String(cell.value)]);
  const sum = layout.labels.find(label => label.role === "sum")!;
  texts.length = 0;
  assert.equal(drawNumericPressure(ctx, sum.width, sum.height, layout,
    { scale: 1, offsetX: -sum.x, offsetY: -sum.y }), 0);
  assert.deepEqual(texts, ["Σ 1596"]);
});

test("an ordinary matrix never acquires a glove mapping from shape alone", () => {
  const preview = fixture("left");
  delete preview.glove;
  const layout = getNumericLayout(preview);
  assert.equal(layout.kind, "matrix");
  assert.equal(layout.cells.length, 195);
  assert.equal(layout.maximum, 999);
});
