export interface WorkspaceViewportLayout {
  columns: number;
  rows: number;
  pageSize: number;
}

/** Maximize simultaneous views without shrinking cards below readable dimensions. */
export function workspaceViewportLayout(width: number, height: number, count: number, stacked = false, minimumCardHeight?: number): WorkspaceViewportLayout {
  const safeCount = Math.max(1, Math.floor(count) || 1);
  const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(1, height) : 1;
  const maxColumns = stacked ? 1 : Math.max(1, Math.min(3, Math.floor((safeWidth + 10) / 310)));
  const minHeight = minimumCardHeight !== undefined && Number.isFinite(minimumCardHeight)
    ? Math.max(140, minimumCardHeight) : safeWidth < 620 ? 270 : 238;
  const maxRows = Math.max(1, Math.min(2, Math.floor((safeHeight + 10) / (minHeight + 10))));
  let best = { columns: 1, rows: 1, pageSize: 1 }, bestScore = -Infinity;
  for (let columns = 1; columns <= maxColumns; columns++) {
    for (let rows = 1; rows <= maxRows; rows++) {
      const slots = columns * rows;
      const visible = Math.min(safeCount, slots);
      const cellWidth = (safeWidth - (columns - 1) * 10) / columns;
      const cellHeight = (safeHeight - (rows - 1) * 10) / rows;
      const score = visible * 100 - (slots - visible) * 2 - Math.abs(Math.log(cellWidth / cellHeight / 1.5));
      if (score > bestScore) {
        bestScore = score;
        best = { columns, rows, pageSize: slots };
      }
    }
  }
  return best;
}

export function workspacePageRange(count: number, pageSize: number, requestedPage: number) {
  const pages = Math.max(1, Math.ceil(count / Math.max(1, pageSize)));
  const page = Math.max(0, Math.min(pages - 1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0));
  return { page, pages, start: page * pageSize, end: Math.min(count, (page + 1) * pageSize) };
}
