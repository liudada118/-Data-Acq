import test from "node:test";
import assert from "node:assert/strict";
import {
  drawNumericPressure, findNumericCell, formatNumericValue, getNumericLayout,
} from "../src/numeric-pressure-renderer";
import type { PressurePreview } from "../src/types";

function canvas() {
  const texts: { text: string; x: number; y: number }[] = [];
  const fills: number[][] = [], strokes: number[][] = [];
  const textFonts: string[] = [], textWidths: (number | undefined)[] = [];
  let clips = 0, saves = 0, restores = 0;
  const ctx = {
    font: "",
    save() { saves++; }, restore() { restores++; },
    beginPath() {}, rect() {}, clip() { clips++; },
    fillRect(...values: number[]) { fills.push(values); },
    strokeRect(...values: number[]) { strokes.push(values); },
    fillText(text: string, x: number, y: number, maxWidth?: number) {
      texts.push({ text, x, y }); textFonts.push(this.font); textWidths.push(maxWidth);
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts, fills, strokes, textFonts, textWidths, counts: () => ({ clips, saves, restores }) };
}

test("matrix numbers retain raw ADC values, zero, row order and missing channels", () => {
  const layout = getNumericLayout({ rows: 2, cols: 3, full_scale: 4095, values: [0, 4095, 255, NaN, 1.234] });
  assert.equal(layout.kind, "matrix");
  assert.deepEqual(layout.cells.map(cell => cell.text), ["0", "4095", "255", "--", "1.23", "--"]);
  assert.deepEqual(layout.cells.map(cell => cell.value), [0, 4095, 255, null, 1.234, null]);
  assert.equal(layout.maximum, 4095);
  const [first, right, , below] = layout.cells;
  assert.equal(right.x, first.x + first.width);
  assert.equal(right.y, first.y);
  assert.equal(below.x, first.x);
  assert.equal(below.y, first.y + first.height);
  assert.equal(layout.cells[5].label, "行 2 · 列 3");
  assert.deepEqual(layout.labels.filter(label => label.role === "row").map(label => label.text), ["1", "2"]);
  assert.deepEqual(layout.labels.filter(label => label.role === "column").map(label => label.text), ["1", "2", "3"]);
  assert.ok(layout.labels.filter(label => label.role === "row").every(label => label.x < first.x));
  assert.ok(layout.labels.filter(label => label.role === "column").every(label => label.y >= below.y + below.height));
  const result = canvas();
  assert.equal(drawNumericPressure(result.ctx, layout.width, layout.height, layout,
    { scale: 1, offsetX: 0, offsetY: 0 }), 6);
  assert.deepEqual(result.texts.slice(0, 6).map(item => item.text), ["0", "4095", "255", "--", "1.23", "--"]);
});

test("number formatting preserves integer precision and distinguishes tiny nonzero values from zero", () => {
  assert.equal(formatNumericValue(65535), "65535");
  assert.equal(formatNumericValue(-12.125), "-12.13");
  assert.equal(formatNumericValue(0.0012), "0.0012");
  assert.equal(formatNumericValue(-0), "0");
  assert.equal(formatNumericValue(Infinity), "--");
  assert.equal(formatNumericValue(NaN), "--");
  assert.equal(formatNumericValue(null), "--");
});

test("insole uses the 16 by 16 logical grid with exactly 112 points and blank unmeasured cells", () => {
  const points = Array.from({ length: 112 }, (_, i) => ({
    row: Math.floor(i / 7), col: i % 7 + Math.floor(i / 7) % 3, x_mm: (i % 7) * 5,
    y_mm: -Math.floor(i / 7) * 27, value: i === 111 ? 4095 : i,
  }));
  const layout = getNumericLayout({ rows: 16, cols: 16, values: Array(256).fill(1000), points });
  const dense = getNumericLayout({ rows: 16, cols: 16, values: [] });
  assert.equal(layout.kind, "points");
  assert.equal(layout.cells.length, 112, "no unused channels or interpolated points");
  assert.equal(layout.width, dense.width);
  assert.equal(layout.height, dense.height);
  assert.equal(layout.labels.filter(label => label.role === "row").length, 16);
  assert.equal(layout.labels.filter(label => label.role === "column").length, 16);
  assert.deepEqual(layout.cells.map(cell => cell.value), points.map(point => point.value));
  assert.equal(layout.cells[111].value, 4095);
  assert.ok(layout.cells[111].label.includes("(30, -405) mm"));
  for (let i = 0; i < layout.cells.length; i++) {
    const cell = layout.cells[i], point = points[i];
    const expected = dense.cells[point.row * 16 + point.col];
    assert.equal(cell.x, expected.x);
    assert.equal(cell.y, expected.y);
    assert.equal(cell.width, expected.width);
    assert.equal(cell.height, expected.height);
  }
  const empty = dense.cells[10];
  const transform = { scale: 0.8, offsetX: 5, offsetY: -3 };
  assert.equal(findNumericCell(layout, (empty.x + empty.width / 2) * transform.scale + transform.offsetX,
    (empty.y + empty.height / 2) * transform.scale + transform.offsetY, transform), null);
  const measured = layout.cells[111];
  assert.equal(findNumericCell(layout, (measured.x + measured.width / 2) * transform.scale + transform.offsetX,
    (measured.y + measured.height / 2) * transform.scale + transform.offsetY, transform), measured);
  const result = canvas();
  assert.equal(drawNumericPressure(result.ctx, layout.width, layout.height, layout,
    { scale: 1, offsetX: 0, offsetY: 0 }), 112);
  assert.equal(result.strokes.length, 112, "empty logical cells have neither a number nor a measured-cell box");
  const emptyViewport = canvas();
  assert.equal(drawNumericPressure(emptyViewport.ctx, empty.width, empty.height, layout,
    { scale: 1, offsetX: -empty.x, offsetY: -empty.y }), 0);
  assert.equal(emptyViewport.texts.length, 0);
  const measuredViewport = canvas();
  assert.equal(drawNumericPressure(measuredViewport.ctx, measured.width, measured.height, layout,
    { scale: 1, offsetX: -measured.x, offsetY: -measured.y }), 1);
  assert.equal(measuredViewport.texts[0].text, "4095");
});

test("point grid validates logical positions and preserves source order, missing values and millimeter details", () => {
  const points = [
    { row: 2, col: 1, x_mm: -4.123456, y_mm: 12, value: NaN },
    { row: 0, col: 1, x_mm: 2, y_mm: 12, value: 0 },
    { row: 1, col: 0, x_mm: -1, y_mm: 3, value: 1023 },
    { row: 2, col: 0, x_mm: Infinity, y_mm: 1, value: 20 },
    { row: -1, col: 0, x_mm: 0, y_mm: 0, value: 1 },
    { row: 0.5, col: 0, x_mm: 0, y_mm: 0, value: 2 },
    { row: 0, col: NaN, x_mm: 0, y_mm: 0, value: 3 },
    { row: Infinity, col: 0, x_mm: 0, y_mm: 0, value: 4 },
    { row: 0, col: 2, x_mm: 0, y_mm: 0, value: 5 },
    { row: 3, col: 0, x_mm: 0, y_mm: 0, value: 6 },
  ];
  const layout = getNumericLayout({ rows: 3, cols: 2, values: [], points });
  assert.equal(layout.cells.length, 4, "negative, fractional, nonfinite and out-of-shape grid positions are excluded");
  assert.deepEqual(layout.cells.map(cell => cell.text), ["--", "0", "1023", "20"]);
  const [a, b, c, d] = layout.cells;
  assert.equal(a.x, b.x);
  assert.equal(a.y - b.y, 2 * a.height);
  assert.equal(a.x - c.x, a.width);
  assert.equal(a.label, "行 3 · 列 2 · (-4.123456, 12) mm");
  assert.equal(d.label, "行 3 · 列 1 · (--, 1) mm");
});

test("point grid derives row and column bounds only when the supplied shape is invalid", () => {
  const points = [
    { row: 2, col: 4, x_mm: 1, y_mm: 1, value: 1023 },
    { row: 0, col: 0, x_mm: 0, y_mm: 0, value: 0 },
    { row: NaN, col: 100, x_mm: 0, y_mm: 0, value: 2 },
  ];
  const derived = getNumericLayout({ rows: 0, cols: 0, values: [], points });
  const expected = getNumericLayout({ rows: 3, cols: 5, values: [] });
  assert.equal(derived.width, expected.width);
  assert.equal(derived.height, expected.height);
  assert.deepEqual(derived.cells.map(cell => cell.value), [1023, 0]);
  assert.equal(derived.labels.filter(label => label.role === "row").length, 3);
  assert.equal(derived.labels.filter(label => label.role === "column").length, 5);
  const bounded = getNumericLayout({ rows: 2, cols: 2, values: [], points });
  assert.deepEqual(bounded.cells.map(cell => cell.value), [0]);
});

test("body uses all ten physical regions and exactly 400 mapped cells", () => {
  const ids = ["back", "chest", "rightArm", "rightShoulder", "leftArm", "leftShoulder",
    "backPantsRight", "backPantsLeft", "frontPantsLeft", "frontPantsRight"];
  const dimensions = [[6, 10], [6, 10], [6, 7], [6, 3], [6, 7], [6, 3], [8, 5], [8, 5], [8, 5], [8, 5]];
  const pressure: PressurePreview = { rows: 32, cols: 32, values: Array(1024).fill(255),
    regions: ids.map((id, i) => ({ id, name: id, rows: dimensions[i][0], cols: dimensions[i][1],
      values: Array.from({ length: dimensions[i][0] * dimensions[i][1] }, (_, index) => index) })) };
  const layout = getNumericLayout(pressure);
  assert.equal(layout.kind, "regions");
  assert.equal(layout.cells.length, 400);
  assert.equal(layout.maximum, 59, "unmapped raw channels never change the displayed scale");
  assert.deepEqual(layout.labels.filter(label => label.role === "title").map(label => label.text),
    ["背部", "胸部", "右臂", "右肩", "左臂", "左肩", "右后裤片", "左后裤片", "左前裤片", "右前裤片"]);
  for (const region of pressure.regions!) {
    const cells = layout.cells.filter(cell => cell.regionId === region.id);
    assert.equal(cells.length, region.rows * region.cols);
    assert.deepEqual(cells.map(cell => cell.value), region.values);
    assert.equal(cells[1].y, cells[0].y);
    assert.ok(cells[1].x > cells[0].x);
    assert.ok(cells[region.cols].y > cells[0].y);
  }
});

test("viewport clipping submits only intersecting cells and keeps the caller canvas transform", () => {
  const layout = getNumericLayout({ rows: 32, cols: 32, values: Array.from({ length: 1024 }, (_, i) => i) });
  const target = layout.cells[17 * 32 + 13];
  const transform = { scale: 2, offsetX: -target.x * 2, offsetY: -target.y * 2 };
  const result = canvas();
  assert.equal(drawNumericPressure(result.ctx, target.width * 2, target.height * 2, layout, transform), 1);
  assert.equal(result.strokes.length, 1, "offscreen cells produce no canvas draw commands");
  assert.deepEqual(result.texts, [{ text: "557", x: target.width, y: target.height }]);
  assert.deepEqual(result.counts(), { clips: 1, saves: 1, restores: 1 });
  const partial = canvas();
  assert.equal(drawNumericPressure(partial.ctx, target.width * 2, target.height * 2, layout,
    { ...transform, offsetX: transform.offsetX - target.width }), 2);
  const offscreen = canvas();
  assert.equal(drawNumericPressure(offscreen.ctx, 320, 240, layout,
    { scale: 1, offsetX: -layout.width - 100, offsetY: 0 }), 0);
  assert.equal(offscreen.texts.length, 0);
});

test("numeric text stays at least ten pixels when fitting and grows with zoom within the cell width", () => {
  const layout = getNumericLayout({ rows: 1, cols: 1, values: [4095] });
  for (const scale of [0.4, 1, 3]) {
    const result = canvas();
    drawNumericPressure(result.ctx, layout.width * scale, layout.height * scale, layout,
      { scale, offsetX: 0, offsetY: 0 });
    const fontSize = Number(result.textFonts[0].match(/([\d.]+)px/)![1]);
    assert.equal(fontSize, Math.max(10, 14 * scale));
    assert.equal(result.texts[0].text, "4095");
    assert.ok(result.textWidths[0]! < layout.cells[0].width * scale, "four-digit values are constrained inside the cell");
  }
});

test("hit testing follows pan and zoom, excludes axes and uses consistent shared edges", () => {
  const layout = getNumericLayout({ rows: 2, cols: 3, values: [0, 1, 2, 3, 4, 5] });
  const transform = { scale: 1.75, offsetX: -18, offsetY: 41 };
  const target = layout.cells[4];
  const canvasX = (target.x + target.width / 2) * transform.scale + transform.offsetX;
  const canvasY = (target.y + target.height / 2) * transform.scale + transform.offsetY;
  assert.equal(findNumericCell(layout, canvasX, canvasY, transform), target);
  assert.equal(findNumericCell(layout, (target.x + target.width) * transform.scale + transform.offsetX,
    canvasY, transform), layout.cells[5]);
  assert.equal(findNumericCell(layout, 0, 0, transform), null);
  assert.equal(findNumericCell(layout, canvasX, canvasY, { ...transform, scale: 0 }), null);
  assert.equal(findNumericCell(layout, NaN, canvasY, transform), null);
  const axis = layout.labels.find(label => label.role === "row")!;
  assert.equal(findNumericCell(layout, (axis.x + axis.width / 2) * transform.scale + transform.offsetX,
    (axis.y + axis.height / 2) * transform.scale + transform.offsetY, transform), null);
});

test("empty or invalid shapes retain finite nonzero fit dimensions", () => {
  for (const [rows, cols] of [[0, 0], [-1, 2], [Infinity, 1], [2.5, 2], [1e9, 1e9]]) {
    const layout = getNumericLayout({ rows, cols, values: [] });
    assert.equal(layout.cells.length, 0);
    assert.ok(Number.isFinite(layout.width) && layout.width > 0);
    assert.ok(Number.isFinite(layout.height) && layout.height > 0);
  }
  const layout = getNumericLayout({ rows: 1, cols: 1, values: [0] });
  const result = canvas();
  assert.equal(drawNumericPressure(result.ctx, 200, 100, layout, { scale: NaN, offsetX: 0, offsetY: 0 }), 0);
  assert.deepEqual(result.counts(), { clips: 0, saves: 1, restores: 1 });
});
