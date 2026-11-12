export interface SensorGridLayout {
  columns: number;
  rows: number;
  pageSize: number;
}

export interface SensorGridPlacement {
  page: number;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
}

export interface SensorGridPage {
  ids: string[];
  /** Zero-based source indexes, with an exclusive end. */
  start: number;
  end: number;
}

export interface SensorCardPosition {
  column: number;
  row: number;
  columnsAtSave: number;
  priority: number;
}

type SensorCard = { id: string; height: number; width?: number };
interface SensorGridOptions {
  positions?: Readonly<Record<string, SensorCardPosition>>;
  activeDrop?: { id: string; column: number; row: number };
  viewportWidth?: number;
}

/** Keep consecutive source pages while allowing cards to occupy rectangular grid areas. */
export function planSensorGrid(
  layout: SensorGridLayout,
  cards: SensorCard[],
  viewportHeight: number,
  gap = 10,
  options: SensorGridOptions = {},
): { pages: SensorGridPage[]; placements: Record<string, SensorGridPlacement>; cellHeight: number } {
  const columns = Number.isFinite(layout.columns) ? Math.max(1, Math.floor(layout.columns)) : 1;
  const rows = Number.isFinite(layout.rows) ? Math.max(1, Math.floor(layout.rows)) : 1;
  const safeHeight = Number.isFinite(viewportHeight) ? Math.max(1, viewportHeight) : 1;
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 10;
  const cellHeight = Math.max(1, (safeHeight - (rows - 1) * safeGap) / rows);
  const cellWidth = typeof options.viewportWidth === "number" && Number.isFinite(options.viewportWidth) && options.viewportWidth > 0
    ? Math.max(1, (options.viewportWidth - (columns - 1) * safeGap) / columns) : undefined;
  const columnSpans = new Map<string, number>();
  for (const card of cards) {
    if (columnSpans.has(card.id)) throw new Error(`Duplicate sensor card id: ${card.id}`);
    const span = cellWidth !== undefined && typeof card.width === "number" && Number.isFinite(card.width) && card.width > 0
      ? Math.max(1, Math.min(columns, Math.ceil((card.width + safeGap - 1) / (cellWidth + safeGap)))) : 1;
    columnSpans.set(card.id, span);
  }
  if ([...columnSpans.values()].some(span => span > 1)) {
    return planRectangularGrid(columns, rows, cards, cellHeight, columnSpans, options);
  }
  // Preserve the established single-column placement and saved-position behavior.
  const pages: SensorGridPage[] = [{ ids: [], start: 0, end: 0 }];
  const placements: Record<string, SensorGridPlacement> = Object.create(null);
  const rowSpans = new Map<string, number>();
  let usedCells = 0;
  cards.forEach((card, index) => {
    if (rowSpans.has(card.id)) throw new Error(`Duplicate sensor card id: ${card.id}`);
    const rowSpan = Number.isFinite(card.height) && card.height > cellHeight + 1 ? rows : 1;
    rowSpans.set(card.id, rowSpan);
    if (usedCells + rowSpan > columns * rows) {
      pages.push({ ids: [], start: index, end: index });
      usedCells = 0;
    }
    usedCells += rowSpan;
    pages[pages.length - 1].ids.push(card.id);
    pages[pages.length - 1].end = index + 1;
  });

  pages.forEach((page, pageIndex) => {
    const occupied = Array<boolean>(columns * rows).fill(false);
    let remainingFullCards = page.ids.filter(id => rowSpans.get(id)! > 1).length;
    const columnAvailable = (column: number) => Array.from({ length: rows }, (_, row) => !occupied[row * columns + column]).every(Boolean);
    const clampIndex = (value: number, limit: number) => Math.max(1, Math.min(limit, Math.floor(value)));
    const preferred = page.ids.flatMap((id, index) => {
      const active = options.activeDrop;
      if (active?.id === id && Number.isFinite(active.column) && Number.isFinite(active.row)) {
        return [{ id, index, active: true, priority: 0, column: clampIndex(active.column, columns), row: clampIndex(active.row, rows) }];
      }
      const saved = options.positions && Object.hasOwn(options.positions, id) ? options.positions[id] : undefined;
      if (!saved || !Number.isFinite(saved.column) || !Number.isFinite(saved.row) || !Number.isFinite(saved.columnsAtSave) ||
        saved.columnsAtSave < 1 || !Number.isFinite(saved.priority)) return [];
      const oldColumns = Math.max(1, Math.floor(saved.columnsAtSave));
      const fraction = oldColumns > 1 ? (clampIndex(saved.column, oldColumns) - 1) / (oldColumns - 1) : 0;
      return [{ id, index, active: false, priority: saved.priority, column: Math.round(fraction * (columns - 1)) + 1, row: clampIndex(saved.row, rows) }];
    }).sort((a, b) => Number(b.active) - Number(a.active) || b.priority - a.priority || a.index - b.index);

    for (const preference of preferred) {
      const rowSpan = rowSpans.get(preference.id)!;
      const row = rowSpan > 1 ? 0 : preference.row - 1, column = preference.column - 1;
      const cells = Array.from({ length: rowSpan }, (_, offset) => (row + offset) * columns + column);
      if (cells.some(cell => occupied[cell])) continue;
      for (const cell of cells) occupied[cell] = true;
      const fullAfter = remainingFullCards - Number(rowSpan > 1);
      // A short-card preference may not fragment every free column needed by tall cards.
      if (Array.from({ length: columns }, (_, candidate) => columnAvailable(candidate)).filter(Boolean).length < fullAfter) {
        for (const cell of cells) occupied[cell] = false;
        continue;
      }
      placements[preference.id] = { page: pageIndex, row: row + 1, column: column + 1, rowSpan, columnSpan: 1 };
      remainingFullCards = fullAfter;
    }

    page.ids.forEach((id, index) => {
      if (rowSpans.get(id) === 1 || Object.hasOwn(placements, id)) return;
      // Preserve the original column when possible, even for a card from the second row.
      let column = index % columns;
      if (!columnAvailable(column)) column = Array.from({ length: columns }, (_, candidate) => candidate).find(candidate => columnAvailable(candidate))!;
      for (let row = 0; row < rows; row++) occupied[row * columns + column] = true;
      placements[id] = { page: pageIndex, row: 1, column: column + 1, rowSpan: rows, columnSpan: 1 };
    });
    let cell = 0;
    for (const id of page.ids) {
      if (rowSpans.get(id) !== 1 || Object.hasOwn(placements, id)) continue;
      while (occupied[cell]) cell++;
      occupied[cell] = true;
      placements[id] = { page: pageIndex, row: Math.floor(cell / columns) + 1, column: cell % columns + 1, rowSpan: 1, columnSpan: 1 };
    }
  });
  return { pages, placements, cellHeight };
}

/** The live grid is at most 3×2. Backtracking keeps preferred anchors when the
 * remaining rectangles fit, instead of leaving holes or overlapping a wide card. */
function planRectangularGrid(
  columns: number, rows: number, cards: SensorCard[], cellHeight: number,
  columnSpans: Map<string, number>, options: SensorGridOptions,
): { pages: SensorGridPage[]; placements: Record<string, SensorGridPlacement>; cellHeight: number } {
  const rowSpans = new Map(cards.map(card => [card.id, Number.isFinite(card.height) && card.height > cellHeight + 1 ? rows : 1]));
  const clampIndex = (value: number, limit: number) => Math.max(1, Math.min(limit, Math.floor(value)));

  const pack = (ids: string[]): Record<string, Omit<SensorGridPlacement, "page">> | null => {
    if (ids.reduce((sum, id) => sum + rowSpans.get(id)! * columnSpans.get(id)!, 0) > columns * rows) return null;
    const specifications = ids.map((id, index) => {
      const columnSpan = columnSpans.get(id)!, rowSpan = rowSpans.get(id)!;
      const maxColumn = columns - columnSpan + 1, maxRow = rows - rowSpan + 1;
      const active = options.activeDrop;
      let preferred: { column: number; row: number; active: boolean; priority: number } | undefined;
      if (active?.id === id && Number.isFinite(active.column) && Number.isFinite(active.row)) {
        preferred = { column: clampIndex(active.column, maxColumn), row: clampIndex(active.row, maxRow), active: true, priority: 0 };
      } else {
        const saved = options.positions && Object.hasOwn(options.positions, id) ? options.positions[id] : undefined;
        if (saved && [saved.column, saved.row, saved.columnsAtSave, saved.priority].every(Number.isFinite) && saved.columnsAtSave >= 1) {
          const oldColumns = Math.max(1, Math.floor(saved.columnsAtSave));
          const fraction = oldColumns > 1 ? (clampIndex(saved.column, oldColumns) - 1) / (oldColumns - 1) : 0;
          preferred = { column: clampIndex(Math.round(fraction * (columns - 1)) + 1, maxColumn), row: clampIndex(saved.row, maxRow), active: false, priority: saved.priority };
        }
      }
      return { id, index, rowSpan, columnSpan, maxColumn, maxRow, preferred };
    }).sort((a, b) => Number(!!b.preferred) - Number(!!a.preferred) ||
      Number(b.preferred?.active ?? false) - Number(a.preferred?.active ?? false) ||
      (b.preferred?.priority ?? 0) - (a.preferred?.priority ?? 0) ||
      (a.preferred && b.preferred ? 0 : b.rowSpan * b.columnSpan - a.rowSpan * a.columnSpan) || a.index - b.index);
    const occupied = Array<boolean>(columns * rows).fill(false);
    const placed: Record<string, Omit<SensorGridPlacement, "page">> = Object.create(null);

    const fit = (index: number): boolean => {
      if (index === specifications.length) return true;
      const spec = specifications[index];
      const candidates: Array<{ column: number; row: number }> = [];
      if (spec.preferred) candidates.push(spec.preferred);
      // Tall and wide cards retain their original source column where possible.
      if (!spec.preferred && (spec.rowSpan > 1 || spec.columnSpan > 1)) {
        candidates.push({ column: clampIndex(spec.index % columns + 1, spec.maxColumn), row: 1 });
      }
      for (let row = 1; row <= spec.maxRow; row++) for (let column = 1; column <= spec.maxColumn; column++) {
        if (!candidates.some(candidate => candidate.column === column && candidate.row === row)) candidates.push({ column, row });
      }
      for (const candidate of candidates) {
        const cells: number[] = [];
        for (let row = 0; row < spec.rowSpan; row++) for (let column = 0; column < spec.columnSpan; column++) {
          cells.push((candidate.row - 1 + row) * columns + candidate.column - 1 + column);
        }
        if (cells.some(cell => occupied[cell])) continue;
        for (const cell of cells) occupied[cell] = true;
        placed[spec.id] = { column: candidate.column, row: candidate.row, rowSpan: spec.rowSpan, columnSpan: spec.columnSpan };
        if (fit(index + 1)) return true;
        for (const cell of cells) occupied[cell] = false;
        delete placed[spec.id];
      }
      return false;
    };
    return fit(0) ? placed : null;
  };

  const pages: SensorGridPage[] = [];
  const placements: Record<string, SensorGridPlacement> = Object.create(null);
  let start = 0;
  while (start < cards.length) {
    let ids: string[] = [], best: ReturnType<typeof pack> = null, end = start;
    while (end < cards.length) {
      const candidateIds = [...ids, cards[end].id], candidate = pack(candidateIds);
      // Area alone is not enough: a full-width row and a full-height column
      // cannot share a page even when their total area is below its capacity.
      if (!candidate) break;
      ids = candidateIds; best = candidate; end++;
    }
    if (!best) throw new Error(`Sensor card cannot fit viewport: ${cards[start].id}`);
    const page = pages.length;
    pages.push({ ids, start, end });
    for (const id of ids) placements[id] = { ...best[id], page };
    start = end;
  }
  return { pages, placements, cellHeight };
}
