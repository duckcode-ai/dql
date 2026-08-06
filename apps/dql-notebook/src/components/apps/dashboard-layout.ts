import type { DashboardDocumentResponse } from '../../api/client';
import { getDqlGenUi, normalizeViz } from './dashboard-tile-model';
import { autoTileSizeForItem, clamp } from './dashboard-tile-sizing';

/**
 * Grid packing and auto-layout ranking for dashboard tiles.
 *
 * Extracted from `DashboardRenderer.tsx`; pure geometry over layout items.
 */
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];

export function packDashboardItems(items: DashboardLayoutItem[], cols: number): DashboardLayoutItem[] {
  const safeCols = Math.max(1, cols);
  const occupied: boolean[][] = [];
  const fits = (x: number, y: number, w: number, h: number): boolean => {
    for (let dy = 0; dy < h; dy++) {
      const row = occupied[y + dy];
      if (!row) continue;
      for (let dx = 0; dx < w; dx++) {
        if (row[x + dx]) return false;
      }
    }
    return true;
  };
  const mark = (x: number, y: number, w: number, h: number): void => {
    for (let dy = 0; dy < h; dy++) {
      const yy = y + dy;
      if (!occupied[yy]) occupied[yy] = new Array(safeCols).fill(false);
      for (let dx = 0; dx < w; dx++) occupied[yy][x + dx] = true;
    }
  };
  return items.map((item) => {
    const w = clamp(Math.round(item.w || 1), 1, safeCols);
    const h = Math.max(1, Math.round(item.h || 1));
    let px = 0;
    let py = 0;
    outer: for (let y = 0; ; y++) {
      for (let x = 0; x + w <= safeCols; x++) {
        if (fits(x, y, w, h)) {
          px = x;
          py = y;
          break outer;
        }
      }
    }
    mark(px, py, w, h);
    return { ...item, x: px, y: py, w, h };
  });
}

export function autoLayoutDashboardItems(items: DashboardLayoutItem[], cols: number): DashboardLayoutItem[] {
  const ordered = [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rank = autoLayoutRank(a.item) - autoLayoutRank(b.item);
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map(({ item }) => {
      const size = autoTileSizeForItem(item, cols);
      return { ...item, w: size.w, h: size.h };
    });
  return packDashboardItems(ordered, cols);
}

export function reorderTileForDrop(items: DashboardLayoutItem[], moved: DashboardLayoutItem, cols: number): DashboardLayoutItem[] {
  const others = items
    .filter((item) => item.i !== moved.i)
    .sort((a, b) => layoutScore(a, cols) - layoutScore(b, cols));
  const targetScore = layoutScore(moved, cols);
  const insertAt = others.findIndex((item) => layoutScore(item, cols) > targetScore);
  if (insertAt === -1) return [...others, moved];
  return [
    ...others.slice(0, insertAt),
    moved,
    ...others.slice(insertAt),
  ];
}

export function layoutScore(item: DashboardLayoutItem, cols: number): number {
  return item.y * cols + item.x;
}

// Clean enterprise reading order for Auto layout:
// headings → KPIs → charts → tables/pivots → text.
export function autoLayoutRank(item: DashboardLayoutItem): number {
  const genUi = getDqlGenUi(item);
  if (genUi?.role === 'business_summary') return 0;
  if (genUi?.role === 'kpi') return 1;
  if (genUi?.component === 'RankingPanel' || genUi?.component === 'TrendPanel') return 2;
  if (genUi?.component === 'EvidenceTable' || genUi?.component === 'PivotTable') return 3;
  if (genUi?.component === 'TrustCallout' || genUi?.component === 'ResearchActions') return 4;
  if (genUi?.role === 'narrative') return 5;
  const viz = normalizeViz(String(item.viz.type ?? 'table'));
  if (viz === 'heading') return 0;
  if (viz === 'single_value' || viz === 'kpi' || viz === 'gauge') return 1;
  if (viz === 'line' || viz === 'area' || viz === 'bar' || viz === 'pie' || viz === 'funnel' || viz === 'map') return 2;
  if (viz === 'table' || viz === 'pivot') return 3;
  if (viz === 'text') return 4;
  return 2;
}
