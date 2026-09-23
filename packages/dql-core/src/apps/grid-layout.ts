/**
 * The App page grid (RFC 0008 step 5). A tile keeps the cell its author gave
 * it; the engine only moves tiles that would overlap, then slides tiles up
 * into empty rows so a page never has holes. Studio (while dragging and
 * resizing), the draft reducer (on every save) and the reader all use these
 * functions, so what the author places is what the reader sees.
 *
 * Browser-safe: no Node imports.
 */
export interface GridBox {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_TILE_ROWS = 24;

/** Keep a box inside the grid with whole-cell coordinates. */
export function clampGridBox<T extends GridBox>(item: T, cols: number): T {
  const columnCount = Math.max(1, Math.floor(cols));
  const w = Math.min(columnCount, Math.max(1, Math.round(item.w) || 1));
  const h = Math.min(MAX_TILE_ROWS, Math.max(1, Math.round(item.h) || 1));
  const x = Math.min(columnCount - w, Math.max(0, Math.round(item.x) || 0));
  const y = Math.max(0, Math.round(item.y) || 0);
  return item.x === x && item.y === y && item.w === w && item.h === h ? item : { ...item, x, y, w, h };
}

export function gridBoxesOverlap(a: GridBox, b: GridBox): boolean {
  return a.i !== b.i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Settle a layout: clamp every box, resolve overlaps by pushing the later box
 * down, then compact upward. `priorityId` is placed first, so the others move
 * out of its way rather than it out of theirs. The
 * result is ordered top to bottom, left to right, which keeps page files
 * stable in git.
 */
export function settleGridLayout<T extends GridBox>(items: T[], cols: number, priorityId?: string): T[] {
  const clamped = items.map((item, index) => ({ item: clampGridBox(item, cols), index }));
  const order = [...clamped].sort((a, b) => {
    if (priorityId) {
      if (a.item.i === priorityId) return -1;
      if (b.item.i === priorityId) return 1;
    }
    return a.item.y - b.item.y || a.item.x - b.item.x || a.index - b.index;
  });
  const placed: T[] = [];
  for (const { item } of order) {
    let next = item;
    // Push down past anything already placed until it fits.
    for (let guard = 0; guard < 10_000; guard += 1) {
      const collider = placed.find((other) => gridBoxesOverlap(next, other));
      if (!collider) break;
      next = { ...next, y: collider.y + collider.h };
    }
    placed.push(next);
  }
  return compactGridLayout(placed);
}

/**
 * Slide every box up while the cell above is free. Moving up only ever enters
 * free cells, so compaction cannot create an overlap; a dropped box also
 * rises into empty rows above it.
 */
export function compactGridLayout<T extends GridBox>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: T[] = [];
  for (const item of sorted) {
    let next = item;
    while (next.y > 0) {
      const up = { ...next, y: next.y - 1 };
      if (out.some((other) => gridBoxesOverlap(up, other))) break;
      next = up;
    }
    out.push(next);
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Move one box to a cell; the others make room. */
export function moveGridItem<T extends GridBox>(items: T[], id: string, x: number, y: number, cols: number): T[] {
  return settleGridLayout(items.map((item) => (item.i === id ? { ...item, x, y } : item)), cols, id);
}

/** Resize one box; the others make room. */
export function resizeGridItem<T extends GridBox>(items: T[], id: string, w: number, h: number, cols: number): T[] {
  return settleGridLayout(items.map((item) => (item.i === id ? { ...item, w, h } : item)), cols, id);
}

/** Where a copy of a box goes: to its right when it fits, otherwise below it. */
export function placeGridCopy<T extends GridBox>(items: T[], source: T, copy: T, cols: number): T[] {
  const right = { ...copy, x: source.x + source.w, y: source.y, w: source.w, h: source.h };
  const target = right.x + right.w <= cols && !items.some((other) => gridBoxesOverlap(right, other))
    ? right
    : { ...copy, x: source.x, y: source.y + source.h, w: source.w, h: source.h };
  return settleGridLayout([...items, target], cols, copy.i);
}

/**
 * Nudge one box by whole cells, as the arrow keys do. Compaction would float
 * a box straight back into free space above, so a downward nudge keeps
 * stepping until the box really lands lower (it swaps past the box below).
 */
export function nudgeGridItem<T extends GridBox>(items: T[], id: string, dx: number, dy: number, cols: number): T[] {
  const current = items.find((item) => item.i === id);
  if (!current) return items;
  if (dy <= 0) return moveGridItem(items, id, current.x + dx, current.y + dy, cols);
  const settledNow = settleGridLayout(items, cols).find((item) => item.i === id) ?? current;
  for (let step = dy; step <= MAX_TILE_ROWS * 4; step += 1) {
    const moved = moveGridItem(items, id, current.x + dx, current.y + step, cols);
    const landed = moved.find((item) => item.i === id)!;
    if (landed.y > settledNow.y || (dx !== 0 && landed.x !== settledNow.x)) return moved;
  }
  return settleGridLayout(items, cols);
}

/**
 * The first cell, top to bottom then left to right, where a `w` x `h` box
 * fits without overlapping `items`. A new tile fills a gap in the page
 * before it goes under everything.
 */
export function firstFreeGridCell(items: GridBox[], w: number, h: number, cols: number): { x: number; y: number } {
  const width = Math.min(Math.max(1, Math.round(w)), Math.max(1, Math.floor(cols)));
  const height = Math.min(Math.max(1, Math.round(h)), MAX_TILE_ROWS);
  const bottom = items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  for (let y = 0; y <= bottom; y += 1) {
    for (let x = 0; x + width <= cols; x += 1) {
      const candidate = { i: '\u0000candidate', x, y, w: width, h: height };
      if (!items.some((item) => gridBoxesOverlap(candidate, item))) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}
