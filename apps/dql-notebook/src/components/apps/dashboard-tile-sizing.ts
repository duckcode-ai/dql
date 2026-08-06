import type { DashboardDocumentResponse } from '../../api/client';
import { getDqlGenUi, normalizeViz, type DqlGenUiMetadata } from './dashboard-tile-model';

/**
 * Tile size presets and the auto-fit rules mapping a visualization to a
 * sensible width and height on the grid.
 *
 * Extracted from `DashboardRenderer.tsx`; pure geometry.
 */
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
export type TileSizePresetId = 'auto' | 'compact' | 'standard' | 'wide' | 'tall' | 'full';

export const TILE_SIZE_PRESETS: Array<{ id: TileSizePresetId; label: string; description: string }> = [
  { id: 'auto', label: 'Auto fit', description: 'Choose a practical size from the tile content' },
  { id: 'compact', label: 'Compact', description: 'Small KPI or short summary' },
  { id: 'standard', label: 'Standard', description: 'Default chart or table card' },
  { id: 'wide', label: 'Wide', description: 'Full-row trend or comparison' },
  { id: 'tall', label: 'Tall', description: 'More vertical room for tables and dense charts' },
  { id: 'full', label: 'Full page', description: 'Large focused view across the page' },
];

export function autoTileSizeForViz(vizType: string, cols: number): { w: number; h: number } {
  const normalized = normalizeViz(vizType);
  if (normalized === 'heading') return tileSizeForPreset('wide', cols, 'heading');
  if (normalized === 'text') return tileSizeForPreset('standard', cols, 'text');
  if (normalized === 'single_value' || normalized === 'kpi' || normalized === 'gauge') {
    return tileSizeForPreset('compact', cols, normalized);
  }
  if (normalized === 'table' || normalized === 'pivot') return tileSizeForPreset('tall', cols, normalized);
  if (normalized === 'line' || normalized === 'area') return tileSizeForPreset('wide', cols, normalized);
  return tileSizeForPreset('standard', cols, normalized);
}

export function autoTileSizeForItem(item: DashboardLayoutItem, cols: number): { w: number; h: number } {
  const genUi = getDqlGenUi(item);
  const preset = normalizeSizePreset(genUi?.layoutIntent);
  if (preset && preset !== 'auto') return tileSizeForPreset(preset, cols, String(item.viz.type ?? 'table'));
  return autoTileSizeForViz(normalizeViz(String(item.viz.type ?? 'table')), cols);
}

export function narrowTileMinHeight(item: DashboardLayoutItem, genUi?: DqlGenUiMetadata | null): number {
  if (item.viz.type === 'heading') return 90;
  if (genUi?.component === 'BusinessBrief' || genUi?.component === 'NarrativePanel' || item.viz.type === 'text') return 180;
  if (genUi?.component === 'TrustCallout' || genUi?.component === 'ResearchActions') return 210;
  if (genUi?.component === 'EvidenceTable' || genUi?.component === 'PivotTable') return 330;
  if (genUi?.component === 'KpiMetric') return 150;
  return Math.max(280, Math.min(420, item.h * 76));
}

export function tileSizeForPreset(preset: TileSizePresetId, cols: number, vizType = 'table'): { w: number; h: number } {
  const safeCols = Math.max(1, cols);
  const half = Math.max(1, Math.ceil(safeCols / 2));
  const third = Math.max(1, Math.ceil(safeCols / 3));
  if (preset === 'auto') return autoTileSizeForViz(vizType, safeCols);
  if (preset === 'compact') return { w: third, h: 2 };
  if (preset === 'wide') return { w: safeCols, h: vizType === 'heading' ? 1 : 4 };
  if (preset === 'tall') return { w: half, h: 6 };
  if (preset === 'full') return { w: safeCols, h: 7 };
  return { w: half, h: vizType === 'text' ? 2 : 4 };
}

export function tileSizePatch(item: DashboardLayoutItem, cols: number, preset: TileSizePresetId): Partial<DashboardLayoutItem> {
  const vizType = String(item.viz.type ?? 'table');
  const size = preset === 'auto'
    ? autoTileSizeForItem(item, cols)
    : tileSizeForPreset(preset, cols, vizType);
  return {
    w: size.w,
    h: size.h,
    x: clamp(item.x, 0, Math.max(0, cols - size.w)),
  };
}

export function presetMatches(item: DashboardLayoutItem, cols: number, preset: TileSizePresetId): boolean {
  const size = preset === 'auto'
    ? autoTileSizeForItem(item, cols)
    : tileSizeForPreset(preset, cols, String(item.viz.type ?? 'table'));
  return item.w === size.w && item.h === size.h;
}

export function normalizeSizePreset(value?: string): TileSizePresetId | null {
  if (value === 'auto' || value === 'compact' || value === 'standard' || value === 'wide' || value === 'tall' || value === 'full') return value;
  return null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
