/**
 * Placement and viz helpers for appending a tile to an existing dashboard.
 *
 * These lived inside `AgentAnswerCard.tsx` alongside an Add-to-App
 * implementation that was never reachable. They are pure and shared, so they
 * live here instead of inside a component file.
 */

export function nextTilePosition(
  dashboard: { layout: { items: Array<{ y: number; h: number }> } },
): { x: number; y: number; w: number; h: number } {
  const y = dashboard.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return { x: 0, y, w: 6, h: 3 };
}

export function nextTileId(dashboard: { layout: { items: Array<{ i: string }> } }, raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tile';
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Dashboard `viz.type` vocabulary. Unknown values fall back to `table`. */
export function normalizeVizTypeForDashboard(value: unknown): string {
  const chart = String(value ?? 'table').toLowerCase().replace(/-/g, '_');
  if (chart === 'single_value' || chart === 'kpi' || chart === 'line' || chart === 'bar' || chart === 'area'
    || chart === 'pie' || chart === 'donut' || chart === 'grouped_bar' || chart === 'stacked_bar' || chart === 'scatter'
    || chart === 'heatmap' || chart === 'histogram' || chart === 'waterfall' || chart === 'pivot' || chart === 'map'
    || chart === 'funnel' || chart === 'sankey') {
    return chart;
  }
  return 'table';
}
