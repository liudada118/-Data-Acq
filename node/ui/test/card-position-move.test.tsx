import test from "node:test";
import assert from "node:assert/strict";
import { findCardAtCell, moveCardPosition } from "../src/card-position-move";
import { planSensorGrid, type SensorCardPosition } from "../src/sensor-grid-layout";

const layout = { columns: 3, rows: 2, pageSize: 6 };
const cards = (heights: number[]) => heights.map((height, index) => ({ id: `sensor-${index}`, height }));
const coordinate = (plan: ReturnType<typeof planSensorGrid>, id: string) => {
  const { column, row } = plan.placements[id]; return { column, row };
};

function verify(plan: ReturnType<typeof planSensorGrid>, original: ReturnType<typeof planSensorGrid>, columns = 3, rows = 2) {
  assert.deepEqual(plan.pages, original.pages, "swapping positions must not reorder source IDs or change page membership");
  const occupied = new Set<string>();
  for (const [id, placement] of Object.entries(plan.placements)) {
    assert.equal(placement.rowSpan, original.placements[id].rowSpan, "positions never change the sensor's saved size");
    assert.equal(placement.columnSpan, original.placements[id].columnSpan);
    assert.ok(placement.column >= 1 && placement.column + placement.columnSpan - 1 <= columns);
    assert.ok(placement.row >= 1 && placement.row + placement.rowSpan - 1 <= rows);
    for (let offset = 0; offset < placement.rowSpan; offset++) for (let across = 0; across < placement.columnSpan; across++) {
      const cell = `${placement.page}:${placement.column + across}:${placement.row + offset}`;
      assert.ok(!occupied.has(cell), `${id} overlaps another card at ${cell}`);
      occupied.add(cell);
    }
  }
}

test("equal-height cards exchange both starting cells without moving the other cards", () => {
  const source = cards([294, 294, 294, 294, 294, 294]);
  const original = planSensorGrid(layout, source, 600);
  const moved = moveCardPosition(original, {}, "sensor-0", 3, 2, 3)!;
  assert.equal(moved.swappedId, "sensor-5");
  const restored = planSensorGrid(layout, source, 600, 10, { positions: JSON.parse(JSON.stringify(moved.positions)) });
  assert.deepEqual(coordinate(restored, "sensor-0"), coordinate(original, "sensor-5"));
  assert.deepEqual(coordinate(restored, "sensor-5"), coordinate(original, "sensor-0"));
  for (const id of ["sensor-1", "sensor-2", "sensor-3", "sensor-4"]) assert.deepEqual(restored.placements[id], original.placements[id]);
  assert.ok(moved.positions["sensor-0"].priority > moved.positions["sensor-5"].priority);
  assert.ok(moved.positions["sensor-5"].priority > moved.positions["sensor-4"].priority);
  verify(restored, original);
});

test("wide cards are found across their footprint and swaps remain inside the right boundary", () => {
  const source = [
    { id: "camera", width: 610, height: 294 },
    { id: "pressure", width: 300, height: 294 },
    { id: "other-camera", width: 610, height: 294 },
    { id: "imu", width: 300, height: 294 },
  ];
  const original = planSensorGrid(layout, source, 600, 10, { viewportWidth: 920 });
  const camera = original.placements.camera;
  assert.equal(camera.columnSpan, 2);
  assert.equal(findCardAtCell(original, "pressure", camera.column + 1, camera.row), "camera");
  assert.equal(moveCardPosition(original, {}, "camera", camera.column + 1, camera.row, 3), null);
  const moved = moveCardPosition(original, {}, "camera", 3, camera.row, 3)!;
  assert.ok(moved);
  assert.equal(moved.positions.camera.column, 2, "wide-card origin must leave room for its second column");
  const restored = planSensorGrid(layout, source, 600, 10, { viewportWidth: 920, positions: moved.positions });
  assert.equal(restored.placements.camera.column, 2);
  verify(restored, original);

  const target = restored.placements["other-camera"];
  const exchanged = moveCardPosition(restored, moved.positions, "camera", target.column + 1, target.row, 3)!;
  assert.equal(exchanged.swappedId, "other-camera");
  const swapped = planSensorGrid(layout, source, 600, 10, { viewportWidth: 920, positions: JSON.parse(JSON.stringify(exchanged.positions)) });
  assert.deepEqual(coordinate(swapped, "camera"), coordinate(restored, "other-camera"));
  assert.deepEqual(coordinate(swapped, "other-camera"), coordinate(restored, "camera"));
  verify(swapped, original);
});

test("two full-height cards exchange columns when dropped anywhere in the target's covered rows", () => {
  const source = cards([600, 600, 294, 294]);
  const original = planSensorGrid(layout, source, 600);
  assert.equal(findCardAtCell(original, "sensor-0", 2, 2), "sensor-1");
  const moved = moveCardPosition(original, {}, "sensor-0", 2, 2, 3)!;
  const restored = planSensorGrid(layout, source, 600, 10, { positions: moved.positions });
  assert.deepEqual(coordinate(restored, "sensor-0"), { column: 2, row: 1 });
  assert.deepEqual(coordinate(restored, "sensor-1"), { column: 1, row: 1 });
  for (const id of ["sensor-2", "sensor-3"]) assert.deepEqual(restored.placements[id], original.placements[id]);
  verify(restored, original);
});

test("a normal card dropped on the lower half of a tall card swaps to its starting row", () => {
  const source = cards([294, 294, 600, 294, 294]);
  const original = planSensorGrid(layout, source, 600);
  assert.equal(findCardAtCell(original, "sensor-3", 3, 2), "sensor-2");
  const moved = moveCardPosition(original, {}, "sensor-3", 3, 2, 3)!;
  assert.equal(moved.swappedId, "sensor-2");
  const restored = planSensorGrid(layout, source, 600, 10, { positions: moved.positions });
  assert.deepEqual(coordinate(restored, "sensor-3"), { column: 3, row: 1 });
  assert.deepEqual(coordinate(restored, "sensor-2"), { column: 1, row: 1 });
  assert.deepEqual(coordinate(restored, "sensor-0"), { column: 3, row: 2 }, "the third card only moves because the full-height swap now covers its old cell");
  for (const id of ["sensor-1", "sensor-4"]) assert.deepEqual(restored.placements[id], original.placements[id]);
  verify(restored, original);
});

test("a full-height card dropped on a row-two normal card keeps its span and moves the target to its old origin", () => {
  const source = cards([294, 294, 600, 294, 294]);
  const original = planSensorGrid(layout, source, 600);
  const moved = moveCardPosition(original, {}, "sensor-2", 1, 2, 3)!;
  assert.equal(moved.swappedId, "sensor-3");
  const restored = planSensorGrid(layout, source, 600, 10, { positions: moved.positions });
  assert.deepEqual(coordinate(restored, "sensor-2"), { column: 1, row: 1 });
  assert.deepEqual(coordinate(restored, "sensor-3"), { column: 3, row: 1 });
  assert.deepEqual(coordinate(restored, "sensor-0"), { column: 3, row: 2 });
  verify(restored, original);
});

test("own covered cells are no-ops while a genuinely empty cell still performs an ordinary move", () => {
  const source = cards([600, 294]);
  const original = planSensorGrid(layout, source, 600);
  assert.equal(findCardAtCell(original, "sensor-0", 1, 1), "sensor-0");
  assert.equal(findCardAtCell(original, "sensor-0", 1, 2), "sensor-0");
  assert.equal(moveCardPosition(original, {}, "sensor-0", 1, 2, 3), null);
  assert.equal(moveCardPosition(original, {}, "sensor-1", 2, 1, 3), null);
  assert.equal(findCardAtCell(original, "sensor-1", 3, 2), undefined);
  const moved = moveCardPosition(original, {}, "sensor-1", 3, 2, 3)!;
  assert.equal(moved.swappedId, undefined);
  const restored = planSensorGrid(layout, source, 600, 10, { positions: moved.positions });
  assert.deepEqual(coordinate(restored, "sensor-1"), { column: 3, row: 2 });
  assert.deepEqual(restored.placements["sensor-0"], original.placements["sensor-0"]);
  verify(restored, original);
});

test("existing preferences and other pages remain unchanged, and targets are found only on the source's own page", () => {
  const source = cards(Array(9).fill(294));
  const positions = Object.freeze({
    "sensor-0": Object.freeze({ column: 3, row: 2, columnsAtSave: 3, priority: 12 }),
    "sensor-7": Object.freeze({ column: 3, row: 2, columnsAtSave: 3, priority: 40 }),
    "removed-device": Object.freeze({ column: 1, row: 1, columnsAtSave: 2, priority: 41 }),
  });
  const original = planSensorGrid(layout, source, 600, 10, { positions });
  const before = JSON.stringify({ positions, original, source });
  assert.equal(findCardAtCell(original, "sensor-6", 3, 2), "sensor-7");
  const moved = moveCardPosition(original, positions, "sensor-6", 3, 2, 3)!;
  assert.equal(moved.swappedId, "sensor-7");
  assert.deepEqual(moved.positions["sensor-0"], positions["sensor-0"]);
  assert.deepEqual(moved.positions["removed-device"], positions["removed-device"]);
  assert.ok(!Object.hasOwn(moved.positions, "sensor-1"), "other-page defaults are not unnecessarily persisted");
  const restored = planSensorGrid(layout, source, 600, 10, { positions: moved.positions });
  for (const id of original.pages[0].ids) assert.deepEqual(restored.placements[id], original.placements[id]);
  assert.deepEqual(coordinate(restored, "sensor-6"), coordinate(original, "sensor-7"));
  assert.deepEqual(coordinate(restored, "sensor-7"), coordinate(original, "sensor-6"));
  assert.equal(JSON.stringify({ positions, original, source }), before);
  verify(restored, original);
});

test("priority rebasing is safe near the integer ceiling and never mutates saved objects", () => {
  const source = cards([294, 294, 294, 294, 294, 294, 294]);
  const positions = Object.freeze({
    "sensor-0": Object.freeze({ column: 1, row: 1, columnsAtSave: 3, priority: Number.MAX_SAFE_INTEGER - 2 }),
    "sensor-6": Object.freeze({ column: 2, row: 2, columnsAtSave: 3, priority: Number.MAX_SAFE_INTEGER - 1 }),
  });
  const original = planSensorGrid(layout, source, 600, 10, { positions });
  const before = JSON.stringify(positions);
  const moved = moveCardPosition(original, positions, "sensor-0", 3, 2, 3)!;
  assert.ok(Object.values(moved.positions).every(entry => Number.isSafeInteger(entry.priority) && entry.priority > 0));
  assert.deepEqual({ ...moved.positions["sensor-6"], priority: positions["sensor-6"].priority }, positions["sensor-6"]);
  assert.equal(JSON.stringify(positions), before);
  const restored = planSensorGrid(layout, source, 600, 10, { positions: JSON.parse(JSON.stringify(moved.positions)) });
  verify(restored, original);
  assert.deepEqual(restored.placements["sensor-6"], original.placements["sensor-6"]);
});

test("invalid cells and missing IDs do not save, and prototype-like IDs remain ordinary data", () => {
  const source = [{ id: "__proto__", height: 294 }, { id: "constructor", height: 294 }];
  const original = planSensorGrid(layout, source, 600);
  assert.equal(findCardAtCell(original, "__proto__", 2, 1), "constructor");
  for (const [column, row, columns] of [[0, 1, 3], [4, 1, 3], [1, 0, 3], [1.5, 1, 3], [1, Number.NaN, 3], [1, 1, 0]]) {
    assert.equal(moveCardPosition(original, {}, "__proto__", column, row, columns), null);
  }
  assert.equal(moveCardPosition(original, {}, "missing", 1, 1, 3), null);
  const moved = moveCardPosition(original, {}, "__proto__", 2, 1, 3)!;
  assert.equal(Object.getPrototypeOf(moved.positions), null);
  assert.equal(moved.swappedId, "constructor");
  const restored = planSensorGrid(layout, source, 600, 10, { positions: moved.positions });
  assert.deepEqual(coordinate(restored, "__proto__"), { column: 2, row: 1 });
  assert.deepEqual(coordinate(restored, "constructor"), { column: 1, row: 1 });
  verify(restored, original);
});

test("all small-grid mixed-span swaps survive JSON persistence and replan without changing sizes or overlapping", () => {
  for (const columns of [1, 2, 3]) for (const rows of [1, 2]) for (let mask = 0; mask < 32; mask++) {
    const source = cards(Array.from({ length: 5 }, (_, index) => mask & (1 << index) ? 600 : 100));
    const config = { columns, rows, pageSize: columns * rows };
    const original = planSensorGrid(config, source, 600);
    for (const card of source) for (let column = 1; column <= columns; column++) for (let row = 1; row <= rows; row++) {
      const moved = moveCardPosition(original, {}, card.id, column, row, columns);
      if (!moved) { assert.equal(findCardAtCell(original, card.id, column, row), card.id); continue; }
      const positions: Record<string, SensorCardPosition> = JSON.parse(JSON.stringify(moved.positions));
      const restored = planSensorGrid(config, source, 600, 10, { positions });
      verify(restored, original, columns, rows);
      const target = moved.swappedId ? original.placements[moved.swappedId] : { column, row };
      assert.deepEqual(coordinate(restored, card.id), { column: target.column, row: original.placements[card.id].rowSpan > 1 ? 1 : target.row });
      if (moved.swappedId) assert.deepEqual(coordinate(restored, moved.swappedId), {
        column: original.placements[card.id].column,
        row: original.placements[moved.swappedId].rowSpan > 1 ? 1 : original.placements[card.id].row,
      });
    }
  }
});
