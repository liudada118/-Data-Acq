import test from "node:test";
import assert from "node:assert/strict";
import { planSensorGrid } from "../src/sensor-grid-layout";
import type { SensorCardPosition } from "../src/sensor-grid-layout";

const layout = { columns: 3, rows: 2, pageSize: 6 };
const cards = (heights: number[]) => heights.map((height, index) => ({ id: `sensor-${index}`, height }));

function verify(plan: ReturnType<typeof planSensorGrid>, source: Array<{ id: string; height: number }>, columns: number, rows: number) {
  assert.deepEqual(plan.pages.flatMap(page => page.ids), source.map(card => card.id), "each card remains in source order exactly once");
  const used = new Set<string>();
  let previousEnd = 0;
  plan.pages.forEach((page, index) => {
    assert.equal(page.start, previousEnd);
    assert.equal(page.end, page.start + page.ids.length);
    assert.deepEqual(page.ids, source.slice(page.start, page.end).map(card => card.id));
    previousEnd = page.end;
    for (const id of page.ids) {
      const placement = plan.placements[id];
      assert.equal(placement.page, index);
      assert.ok(placement.column >= 1 && placement.column + placement.columnSpan - 1 <= columns);
      assert.ok(placement.row >= 1 && placement.row + placement.rowSpan - 1 <= rows);
      for (let offset = 0; offset < placement.rowSpan; offset++) for (let column = 0; column < placement.columnSpan; column++) {
        const key = `${index}:${placement.row + offset}:${placement.column + column}`;
        assert.ok(!used.has(key), `${id} overlaps another sensor at ${key}`);
        used.add(key);
      }
    }
  });
  assert.equal(previousEnd, source.length);
}

test("the third sensor spans both rows in its original column while five sensors still fit on one page", () => {
  const source = cards([294, 294, 600, 294, 294]);
  const before = JSON.stringify(source);
  const plan = planSensorGrid(layout, source, 600);
  assert.equal(plan.cellHeight, 295);
  assert.equal(plan.pages.length, 1);
  assert.deepEqual(plan.placements["sensor-2"], { page: 0, row: 1, column: 3, rowSpan: 2, columnSpan: 1 });
  assert.deepEqual(plan.placements["sensor-3"], { page: 0, row: 2, column: 1, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(plan.placements["sensor-4"], { page: 0, row: 2, column: 2, rowSpan: 1, columnSpan: 1 });
  verify(plan, source, 3, 2);
  assert.equal(JSON.stringify(source), before, "planning must not mutate saved sensor dimensions");
});

test("a wider camera reserves adjacent columns and other sensors fill the remaining cells", () => {
  const source = cards([294, 294, 294, 294, 294]).map((card, index) => ({ ...card, width: index === 0 ? 610 : 300 }));
  const plan = planSensorGrid(layout, source, 600, 10, { viewportWidth: 920 });
  assert.equal(plan.pages.length, 1);
  assert.deepEqual(plan.placements["sensor-0"], { page: 0, row: 1, column: 1, rowSpan: 1, columnSpan: 2 });
  assert.equal(plan.placements["sensor-1"].column, 3);
  verify(plan, source, 3, 2);
});

test("a camera can span two columns and both rows with the remaining sensors beside it", () => {
  const source = [{ id: "camera", width: 610, height: 600 }, { id: "left", width: 300, height: 294 }, { id: "right", width: 300, height: 294 }];
  const plan = planSensorGrid(layout, source, 600, 10, { viewportWidth: 920 });
  assert.equal(plan.pages.length, 1);
  assert.deepEqual(plan.placements.camera, { page: 0, row: 1, column: 1, rowSpan: 2, columnSpan: 2 });
  assert.deepEqual([plan.placements.left.column, plan.placements.right.column], [3, 3]);
  verify(plan, source, 3, 2);
});

test("page capacity accounts for rectangular geometry instead of only total occupied area", () => {
  const source = [{ id: "full-width", width: 920, height: 294 }, { id: "full-height", width: 300, height: 600 }, { id: "small", width: 300, height: 294 }];
  const plan = planSensorGrid(layout, source, 600, 10, { viewportWidth: 920 });
  assert.deepEqual(plan.pages.map(page => page.ids), [["full-width"], ["full-height", "small"]], "a full row and full column intersect despite having total area five out of six");
  verify(plan, source, 3, 2);
});

test("wide-card preferences clamp at the right edge and displace peers without adding pages", () => {
  const source = [{ id: "camera", width: 610, height: 294 }, { id: "other-camera", width: 610, height: 294 }, { id: "body", width: 300, height: 600 }];
  const positions = Object.freeze({
    camera: Object.freeze({ column: 1, row: 1, columnsAtSave: 3, priority: 1 }),
    body: Object.freeze({ column: 3, row: 1, columnsAtSave: 3, priority: 2 }),
  });
  const before = JSON.stringify({ source, positions });
  const plan = planSensorGrid(layout, source, 600, 10, { viewportWidth: 920, positions, activeDrop: { id: "camera", column: 3, row: 2 } });
  assert.equal(plan.pages.length, 1);
  assert.deepEqual(plan.placements.camera, { page: 0, row: 2, column: 2, rowSpan: 1, columnSpan: 2 });
  assert.equal(plan.placements.body.column, 1, "the older full-height placement yields to the wider active drop");
  assert.equal(JSON.stringify({ source, positions }), before);
  verify(plan, source, 3, 2);
});

test("width tolerance, custom gaps and narrow viewport restoration retain preferred sizes", () => {
  const source = [{ id: "before", width: 301, height: 294 }, { id: "after", width: 301.01, height: 294 }];
  const wide = planSensorGrid(layout, source, 600, 10, { viewportWidth: 920 });
  assert.equal(wide.placements.before.columnSpan, 1);
  assert.equal(wide.placements.after.columnSpan, 2);
  const custom = planSensorGrid(layout, [{ id: "wide", width: 620, height: 294 }], 600, 20, { viewportWidth: 940 });
  assert.equal(custom.placements.wide.columnSpan, 2);
  const narrow = planSensorGrid({ columns: 1, rows: 2, pageSize: 2 }, source, 600, 10, { viewportWidth: 280 });
  assert.ok(Object.values(narrow.placements).every(placement => placement.columnSpan === 1));
  assert.deepEqual(planSensorGrid(layout, source, 600, 10, { viewportWidth: 920 }), wide);
  const invalid = [{ id: "wide", width: Infinity, height: 294 }, { id: "negative", width: -1, height: 294 }];
  assert.ok(Object.values(planSensorGrid(layout, invalid, 600, 10, { viewportWidth: 920 }).placements).every(p => p.columnSpan === 1));
});

test("wide and tall combinations with conflicting positions always fit within unique rectangular cells", () => {
  for (const columns of [1, 2, 3]) for (const rows of [1, 2]) {
    for (let mask = 0; mask < 1296; mask++) {
      let encoded = mask;
      const source = Array.from({ length: 4 }, (_, index) => {
        const shape = encoded % 6; encoded = Math.floor(encoded / 6);
        return { id: `sensor-${index}`, width: 300 + (shape % 3) * 310, height: shape >= 3 ? 600 : 100 };
      });
      const positions: Record<string, SensorCardPosition> = Object.fromEntries(source.map((card, index) => [card.id,
        { column: index % 3 + 1, row: index % 2 + 1, columnsAtSave: 3, priority: index + 1 }]));
      const config = { columns, rows, pageSize: columns * rows }, viewportWidth = columns * 300 + (columns - 1) * 10;
      const ordinary = planSensorGrid(config, source, 600, 10, { viewportWidth });
      const moved = planSensorGrid(config, source, 600, 10, { viewportWidth, positions, activeDrop: { id: `sensor-${mask % 4}`, column: columns, row: rows } });
      assert.deepEqual(moved.pages, ordinary.pages, "saved positions do not change feasible source page ranges");
      verify(moved, source, columns, rows);
    }
  }
});

test("multiple tall sensors consume columns and overflow onto consecutive pages without overlap", () => {
  const source = cards([600, 600, 600, 600, 294, 294, 294, 294, 600]);
  const plan = planSensorGrid(layout, source, 600);
  assert.deepEqual(plan.pages.map(page => [page.start, page.end]), [[0, 3], [3, 8], [8, 9]]);
  assert.deepEqual(plan.pages[0].ids.map(id => plan.placements[id].column), [1, 2, 3]);
  verify(plan, source, 3, 2);
});

test("a fourth or fifth full-height sensor rearranges short cards and keeps all five on one page", () => {
  for (const fullIndex of [3, 4]) {
    const source = cards(Array.from({ length: 5 }, (_, index) => index === fullIndex ? 600 : 294));
    const plan = planSensorGrid(layout, source, 600);
    assert.equal(plan.pages.length, 1);
    assert.deepEqual(plan.placements[`sensor-${fullIndex}`], { page: 0, row: 1, column: fullIndex % 3 + 1, rowSpan: 2, columnSpan: 1 });
    assert.deepEqual(plan.pages[0].ids, source.map(card => card.id));
    verify(plan, source, 3, 2);
  }
});

test("a full-height card exceeding remaining capacity starts a new page without backfilling earlier gaps", () => {
  const source = cards([294, 294, 294, 294, 294, 600, 294]);
  const plan = planSensorGrid(layout, source, 600);
  assert.deepEqual(plan.pages.map(page => page.ids), [["sensor-0", "sensor-1", "sensor-2", "sensor-3", "sensor-4"], ["sensor-5", "sensor-6"]]);
  assert.deepEqual(plan.placements["sensor-5"], { page: 1, row: 1, column: 1, rowSpan: 2, columnSpan: 1 });
  assert.deepEqual(plan.placements["sensor-6"], { page: 1, row: 1, column: 2, rowSpan: 1, columnSpan: 1 });
  verify(plan, source, 3, 2);
});

test("the one-pixel tolerance and custom gap match the real grid cell height", () => {
  const source = cards([296, 296.01, 295]);
  const plan = planSensorGrid(layout, source, 600);
  assert.equal(plan.placements["sensor-0"].rowSpan, 1);
  assert.equal(plan.placements["sensor-1"].rowSpan, 2);
  const custom = planSensorGrid(layout, cards([290, 291, 291.01]), 600, 20);
  assert.equal(custom.cellHeight, 290);
  assert.equal(custom.placements["sensor-1"].rowSpan, 1);
  assert.equal(custom.placements["sensor-2"].rowSpan, 2);
});

test("one-row layouts retain normal pagination even when all saved cards are tall", () => {
  const source = cards([600, 700, 800, 900]);
  const plan = planSensorGrid({ columns: 3, rows: 1, pageSize: 3 }, source, 300);
  assert.deepEqual(plan.pages.map(page => [page.start, page.end]), [[0, 3], [3, 4]]);
  assert.ok(Object.values(plan.placements).every(placement => placement.rowSpan === 1));
  verify(plan, source, 3, 1);
});

test("empty inputs, narrow layouts and prototype-like IDs remain well-defined", () => {
  const empty = planSensorGrid(layout, [], 600);
  assert.deepEqual(empty.pages, [{ ids: [], start: 0, end: 0 }]);
  assert.equal(Object.keys(empty.placements).length, 0);
  const source = [{ id: "__proto__", height: 600 }, { id: "constructor", height: 100 }, { id: "toString", height: 100 }];
  const plan = planSensorGrid({ columns: 1, rows: 2, pageSize: 2 }, source, 600);
  assert.equal(Object.getPrototypeOf(plan.placements), null);
  verify(plan, source, 1, 2);
  assert.throws(() => planSensorGrid(layout, [{ id: "same", height: 100 }, { id: "same", height: 100 }], 600), /Duplicate sensor card id/);
});

test("all small/tall combinations preserve page bounds and unique cell occupancy", () => {
  for (const columns of [1, 2, 3]) for (const rows of [1, 2]) {
    for (let mask = 0; mask < 256; mask++) {
      const source = cards(Array.from({ length: 8 }, (_, index) => mask & (1 << index) ? 600 : 100));
      const plan = planSensorGrid({ columns, rows, pageSize: columns * rows }, source, 600);
      verify(plan, source, columns, rows);
    }
  }
});

test("an explicit right-side drop wins over a tall card's automatic column without changing page order", () => {
  const source = cards([294, 294, 600, 294, 294]);
  const original = planSensorGrid(layout, source, 600);
  const plan = planSensorGrid(layout, source, 600, 10, { activeDrop: { id: "sensor-0", column: 3, row: 2 } });
  assert.deepEqual(plan.placements["sensor-0"], { page: 0, row: 2, column: 3, rowSpan: 1, columnSpan: 1 });
  assert.equal(plan.placements["sensor-2"].column, 1, "full-height placement must inspect both rows, not only its top cell");
  assert.deepEqual(plan.pages, original.pages);
  verify(plan, source, 3, 2);
});

test("dragging a full-height card to the bottom-right keeps it in the right column and starts it in row one", () => {
  const source = cards([600, 294, 294, 294, 294]);
  const plan = planSensorGrid(layout, source, 600, 10, { activeDrop: { id: "sensor-0", column: 3, row: 2 } });
  assert.deepEqual(plan.placements["sensor-0"], { page: 0, row: 1, column: 3, rowSpan: 2, columnSpan: 1 });
  assert.equal(plan.pages.length, 1);
  verify(plan, source, 3, 2);
});

test("the newest saved position wins a collision, and an active drop overrides even that saved priority", () => {
  const source = cards([294, 294, 294, 294, 294]);
  const positions = {
    "sensor-0": { column: 3, row: 1, columnsAtSave: 3, priority: 1 },
    "sensor-1": { column: 3, row: 1, columnsAtSave: 3, priority: 5 },
  };
  const saved = planSensorGrid(layout, source, 600, 10, { positions });
  assert.deepEqual(saved.placements["sensor-1"], { page: 0, row: 1, column: 3, rowSpan: 1, columnSpan: 1 });
  assert.equal(saved.placements["sensor-0"].column, 1);
  const dragging = planSensorGrid(layout, source, 600, 10, { positions, activeDrop: { id: "sensor-0", column: 3, row: 1 } });
  assert.deepEqual(dragging.placements["sensor-0"], { page: 0, row: 1, column: 3, rowSpan: 1, columnSpan: 1 });
  assert.equal(dragging.placements["sensor-1"].column, 1);
  assert.deepEqual(planSensorGrid(layout, source, 600, 10, { positions }), saved, "cancelling a preview restores the saved layout exactly");
  verify(saved, source, 3, 2); verify(dragging, source, 3, 2);
});

test("older short-card positions yield when they would block columns required by full-height cards", () => {
  const source = cards([294, 294, 600, 600]);
  const positions = {
    "sensor-0": { column: 1, row: 1, columnsAtSave: 3, priority: 5 },
    "sensor-1": { column: 2, row: 1, columnsAtSave: 3, priority: 4 },
  };
  const plan = planSensorGrid(layout, source, 600, 10, { positions });
  assert.deepEqual(plan.placements["sensor-0"], { page: 0, row: 1, column: 1, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(plan.placements["sensor-1"], { page: 0, row: 2, column: 1, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual([plan.placements["sensor-2"].column, plan.placements["sensor-3"].column], [3, 2]);
  assert.equal(plan.pages.length, 1, "saved preferences must not introduce an unnecessary page");
  verify(plan, source, 3, 2);
});

test("full-height saved positions resolve collisions before placing ordinary cards", () => {
  const source = cards([600, 600, 294, 294]);
  const positions = {
    "sensor-0": { column: 3, row: 2, columnsAtSave: 3, priority: 10 },
    "sensor-1": { column: 3, row: 1, columnsAtSave: 3, priority: 9 },
  };
  const plan = planSensorGrid(layout, source, 600, 10, { positions });
  assert.deepEqual(plan.placements["sensor-0"], { page: 0, row: 1, column: 3, rowSpan: 2, columnSpan: 1 });
  assert.deepEqual(plan.placements["sensor-1"], { page: 0, row: 1, column: 2, rowSpan: 2, columnSpan: 1 });
  verify(plan, source, 3, 2);
});

test("saved relative columns survive narrow layouts and restore on expansion without mutating preferences", () => {
  const source = cards([100, 100, 100]);
  const positions = Object.freeze({ "sensor-0": Object.freeze({ column: 3, row: 2, columnsAtSave: 3, priority: 2 }) });
  const before = JSON.stringify({ source, positions });
  const original = planSensorGrid(layout, source, 600, 10, { positions });
  const narrow = planSensorGrid({ columns: 2, rows: 2, pageSize: 4 }, source, 600, 10, { positions });
  assert.deepEqual(narrow.placements["sensor-0"], { page: 0, row: 2, column: 2, rowSpan: 1, columnSpan: 1 });
  const small = planSensorGrid({ columns: 1, rows: 1, pageSize: 1 }, source, 200, 10, { positions });
  assert.deepEqual(small.placements["sensor-0"], { page: 0, row: 1, column: 1, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(planSensorGrid(layout, source, 600, 10, { positions }), original);
  assert.equal(JSON.stringify({ source, positions }), before);
  verify(narrow, source, 2, 2); verify(small, source, 1, 1);
});

test("position lookup uses own stable IDs, ignores malformed entries and never treats inherited keys as preferences", () => {
  const source = [{ id: "__proto__", height: 100 }, { id: "constructor", height: 100 }, { id: "same-name-device-2", height: 100 }];
  const positions = Object.assign(Object.create({ constructor: { column: 3, row: 2, columnsAtSave: 3, priority: 20 } }), {
    "same-name-device-2": { column: Number.NaN, row: 1, columnsAtSave: 3, priority: 2 },
  });
  Object.defineProperty(positions, "__proto__", { value: { column: 3, row: 2, columnsAtSave: 3, priority: 1 }, enumerable: true });
  const plan = planSensorGrid(layout, source, 600, 10, { positions });
  assert.deepEqual(plan.placements.__proto__, { page: 0, row: 2, column: 3, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(plan.placements.constructor, { page: 0, row: 1, column: 1, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(plan.placements["same-name-device-2"], { page: 0, row: 1, column: 2, rowSpan: 1, columnSpan: 1 });
  verify(plan, source, 3, 2);
});

test("position collisions and active drops preserve capacity, source ordering and unique occupancy across all small grids", () => {
  for (const columns of [1, 2, 3]) for (const rows of [1, 2]) for (let mask = 0; mask < 64; mask++) {
    const source = cards(Array.from({ length: 6 }, (_, index) => mask & (1 << index) ? 600 : 100));
    const positions: Record<string, SensorCardPosition> = Object.fromEntries(source.map((card, index) => [card.id,
      { column: index % 3 + 1, row: index % 2 + 1, columnsAtSave: 3, priority: index % 3 }]));
    const config = { columns, rows, pageSize: columns * rows };
    const original = planSensorGrid(config, source, 600);
    const plan = planSensorGrid(config, source, 600, 10, { positions, activeDrop: { id: `sensor-${mask % 6}`, column: columns, row: rows } });
    assert.deepEqual(plan.pages, original.pages, "manual positions must preserve source page ranges and never add a page");
    verify(plan, source, columns, rows);
    const active = plan.placements[`sensor-${mask % 6}`];
    assert.equal(active.column, columns, "the active drop retains its requested column");
    assert.equal(active.row, active.rowSpan > 1 ? 1 : rows);
  }
});
