import test from "node:test";
import assert from "node:assert/strict";
import { drawPressure, pressureDescription, pressureValues } from "../src/pressure-renderer";
import { getNumericLayout } from "../src/numeric-pressure-renderer";
import type { GloveFingerId, PressurePreview } from "../src/types";

function canvas() {
  const circles: number[][] = [], texts: string[] = [], rectangles: number[][] = [], colors: string[] = [];
  const ctx = {
    fillStyle: "",
    beginPath() {}, fill() {}, stroke() {}, save() {}, restore() {},
    arc(...values: number[]) { circles.push(values); },
    fillRect(...values: number[]) { rectangles.push(values); colors.push(this.fillStyle); },
    fillText(text: string) { texts.push(text); },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, circles, texts, rectangles, colors };
}

test("insole preview keeps 12-bit values and renders exactly the measured points at equal physical scale", () => {
  const points = Array.from({ length: 112 }, (_, i) => ({ row: Math.floor(i / 8), col: i % 8,
    x_mm: (i % 8) * 5, y_mm: -Math.floor(i / 8) * 15, value: i === 111 ? 4095 : i * 16 }));
  const pressure: PressurePreview = { rows: 16, cols: 16, values: Array(256).fill(0), full_scale: 4095, points };
  assert.equal(Math.max(...pressureValues(pressure)), 4095);
  assert.equal(pressureDescription(pressure), "112 个真实点 · 12 bit ADC");
  const result = canvas(); drawPressure(result.ctx, 360, 420, pressure);
  assert.equal(result.circles.length, 112, "no synthetic/interpolated sensor points");
  const origin = result.circles[0], nextCol = result.circles[1], nextRow = result.circles[8];
  assert.ok(nextCol[0] > origin[0]); assert.ok(nextRow[1] > origin[1]);
  assert.ok(Math.abs((nextCol[0] - origin[0]) / 5 - (nextRow[1] - origin[1]) / 15) < 1e-9);
  assert.ok(result.texts.includes("4095"));
});

test("fixed range gives an unchanged value the same color across frames while auto follows the frame peak", () => {
  const first: PressurePreview = { rows: 1, cols: 2, full_scale: 255, values: [50, 100] };
  const second: PressurePreview = { rows: 1, cols: 2, full_scale: 255, values: [50, 200] };
  const saved = JSON.stringify([first, second]);
  Object.freeze(first.values); Object.freeze(first); Object.freeze(second.values); Object.freeze(second);
  const fixedFirst = canvas(), fixedSecond = canvas(), autoFirst = canvas(), autoSecond = canvas();
  drawPressure(fixedFirst.ctx, 360, 240, first, { mode: "fixed", maximum: 255 });
  drawPressure(fixedSecond.ctx, 360, 240, second, { mode: "fixed", maximum: 255 });
  drawPressure(autoFirst.ctx, 360, 240, first);
  drawPressure(autoSecond.ctx, 360, 240, second, { mode: "auto", maximum: 255 });
  assert.equal(fixedFirst.colors[1], fixedSecond.colors[1]);
  assert.notEqual(autoFirst.colors[1], autoSecond.colors[1]);
  assert.ok(fixedFirst.texts.includes("255"));
  assert.ok(autoFirst.texts.includes("100")); assert.ok(autoSecond.texts.includes("200"));
  assert.equal(JSON.stringify([first, second]), saved, "display range must not modify any source samples");
});

test("range saturation preserves raw out-of-range values and invalid samples cannot poison the color scale", () => {
  const pressure: PressurePreview = { rows: 1, cols: 6, values: [-5, 0, 255, 1000, NaN, Infinity] };
  const result = canvas();
  drawPressure(result.ctx, 500, 240, pressure, { mode: "fixed", maximum: 255 });
  assert.equal(result.colors[1], result.colors[2], "negative samples clip to the low color");
  assert.equal(result.colors[3], result.colors[4], "over-range samples clip to the high color");
  assert.equal(result.colors[5], "#dce2d8"); assert.equal(result.colors[6], "#dce2d8");
  assert.deepEqual(pressure.values, [-5, 0, 255, 1000, NaN, Infinity]);
  const automatic = canvas(); drawPressure(automatic.ctx, 500, 240, pressure);
  assert.ok(automatic.texts.includes("1000"));
});

test("glove heatmap and numeric view share the same 137 physical points and no legacy blank cells", () => {
  for (const side of ["left", "right"] as const) {
    const pressure: PressurePreview = { rows: 13, cols: 15, values: Array(195).fill(255), glove: {
      side,
      fingers: Object.fromEntries((["little", "ring", "middle", "index", "thumb"] as GloveFingerId[]).map((id, i) => [id, {
        values: Array.from({ length: 12 }, (_, n) => n + i * 13), pulp: i * 13 + 12,
        source_indices: Array.from({ length: 12 }, (_, n) => n + i * 13), pulp_source_index: i * 13 + 12,
      }])) as NonNullable<PressurePreview["glove"]>["fingers"],
      palm: { values: Array.from({ length: 72 }, (_, n) => n + 65), source_indices: Array.from({ length: 72 }, (_, n) => n + 65),
        row_lengths: [12, 15, 15, 15, 15] },
    } };
    assert.equal(pressureValues(pressure).length, 137);
    assert.equal(Math.max(...pressureValues(pressure)), 136);
    assert.match(pressureDescription(pressure), /137 个物理点/);
    const layout = getNumericLayout(pressure);
    for (const [width, height] of [[280, 420], [750, 400]]) {
      const result = canvas(); drawPressure(result.ctx, width, height, pressure);
      assert.equal(result.rectangles.length, 138, "background and exactly 137 physical cells");
      assert.deepEqual(result.texts, layout.labels.filter(label => label.role === "title").map(label => label.text));
      for (const [x, y, w, h] of result.rectangles) {
        assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0);
        assert.ok(x + w <= width + 1 && y + h <= height + 1);
      }
    }
  }
});

test("body preview shows all ten physical matrices and computes peaks from mapped points", () => {
  const ids = ["back", "chest", "rightArm", "rightShoulder", "leftArm", "leftShoulder", "backPantsRight", "backPantsLeft", "frontPantsLeft", "frontPantsRight"];
  const dimensions = [[6,10],[6,10],[6,7],[6,3],[6,7],[6,3],[8,5],[8,5],[8,5],[8,5]];
  const pressure: PressurePreview = { rows: 32, cols: 32, values: Array(1024).fill(255), regions: ids.map((id, i) => ({ id, name: id,
    rows: dimensions[i][0], cols: dimensions[i][1], values: Array(dimensions[i][0] * dimensions[i][1]).fill(i + 1) })) };
  assert.equal(pressureValues(pressure).length, 400);
  assert.equal(Math.max(...pressureValues(pressure)), 10, "unused raw channels do not affect spatial color scale");
  const unchanged = JSON.stringify(pressure);
  for (const [width,height] of [[280,520],[850,420],[389,230],[399,230],[400,230]]) {
    const result = canvas(); drawPressure(result.ctx, width, height, pressure);
    assert.ok(result.texts.includes("背部") && result.texts.includes("右肩") && result.texts.includes("左前裤片"));
    assert.equal(result.rectangles.length, 411, "400 cells plus 10 region backgrounds and canvas background");
    for (const [x,y,w,h] of result.rectangles) {
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0);
      assert.ok(x + w <= width + 1 && y + h <= height + 1);
    }
    if (width >= 389 && width <= 400) {
      const cells = result.rectangles.filter((_, index) => result.colors[index].startsWith("rgb("));
      assert.equal(cells.length, 400);
      assert.ok(cells.every(([, , w, h]) => w >= 4 && h >= 4), "short overview tiles must not collapse physical regions into subpixel dots");
      assert.equal(new Set(result.rectangles.filter((_, index) => result.colors[index] === "#ffffff").map(rect => rect[1])).size, 2,
        "ten regions use the available width for two readable rows in a short card");
    }
  }
  assert.equal(JSON.stringify(pressure), unchanged, "responsive layout never changes source values or region order");
});
