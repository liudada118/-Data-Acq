import type { planSensorGrid, SensorCardPosition } from "./sensor-grid-layout";

type SensorPlan = Pick<ReturnType<typeof planSensorGrid>, "placements" | "pages">;
type Positions = Record<string, SensorCardPosition>;

/** Find the card covering a cell on the source card's page, including the source itself. */
export function findCardAtCell(plan: SensorPlan, sourceId: string, column: number, row: number): string | undefined {
  if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row) || column < 1 || row < 1 ||
    !Object.hasOwn(plan.placements, sourceId)) return undefined;
  const source = plan.placements[sourceId];
  return plan.pages[source.page]?.ids.find(id => {
    const candidate = plan.placements[id];
    return candidate?.page === source.page && column >= candidate.column && column < candidate.column + candidate.columnSpan &&
      row >= candidate.row && row < candidate.row + candidate.rowSpan;
  });
}

/** Save a cell move or a two-card swap while retaining DOM/page order and each card's size. */
export function moveCardPosition(
  plan: SensorPlan,
  positions: Readonly<Record<string, SensorCardPosition>>,
  sourceId: string,
  column: number,
  row: number,
  columns: number,
): { positions: Positions; swappedId?: string } | null {
  if (!Number.isSafeInteger(columns) || columns < 1 || columns > 16 ||
    !Number.isSafeInteger(column) || column < 1 || column > columns ||
    !Number.isSafeInteger(row) || row < 1 || row > 16 || !Object.hasOwn(plan.placements, sourceId)) return null;
  const source = plan.placements[sourceId], page = plan.pages[source.page];
  if (!page?.ids.includes(sourceId)) return null;
  const swappedId = findCardAtCell(plan, sourceId, column, row);
  if (swappedId === sourceId) return null;
  const target = swappedId === undefined ? undefined : plan.placements[swappedId];
  const next: Positions = Object.create(null);
  for (const [id, position] of Object.entries(positions)) next[id] = { ...position };

  let priority = Object.values(next).reduce((max, entry) => Number.isSafeInteger(entry.priority) ? Math.max(max, entry.priority) : max, 0);
  // Leave room for every current-page snapshot plus the source and target, without mutating input objects.
  if (priority > Number.MAX_SAFE_INTEGER - page.ids.length - 2) {
    Object.values(next).sort((a, b) => a.priority - b.priority).forEach((entry, index) => { entry.priority = index + 1; });
    priority = Object.keys(next).length;
  }
  const save = (id: string, nextColumn: number, nextRow: number) => {
    const columnSpan = plan.placements[id]?.columnSpan ?? 1;
    next[id] = { column: Math.max(1, Math.min(columns - columnSpan + 1, nextColumn)), row: nextRow,
      columnsAtSave: columns, priority: ++priority };
  };
  // Pin uninvolved cards where they are now. The planner may displace them only when different spans require it.
  for (const id of page.ids) {
    if (id === sourceId || id === swappedId) continue;
    const peer = plan.placements[id];
    if (peer?.page === source.page) save(id, peer.column, peer.rowSpan > 1 ? 1 : peer.row);
  }
  if (swappedId !== undefined && target) save(swappedId, source.column, target.rowSpan > 1 ? 1 : source.row);
  save(sourceId, target?.column ?? column, source.rowSpan > 1 ? 1 : target?.row ?? row);
  return swappedId === undefined ? { positions: next } : { positions: next, swappedId };
}
