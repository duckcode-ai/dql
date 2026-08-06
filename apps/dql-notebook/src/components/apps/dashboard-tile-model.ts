import type { CellChartConfig } from '../../store/types';
import type { ChartType } from '../output/ChartOutput';
import type { DashboardDocumentResponse } from '../../api/client';
import { normalizeDashboardChartType } from './dashboard-chart-config';

/**
 * The shape of a dashboard tile: its block reference, chart config, generated-UI
 * metadata, and the display contract written alongside it.
 *
 * Extracted from `DashboardRenderer.tsx` so the presentation rules and the
 * renderer can share one definition instead of reaching into the component.
 */
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];

export interface DqlGenUiMetadata {
  version?: number;
  component?: 'BusinessBrief' | 'KpiMetric' | 'TrendPanel' | 'RankingPanel' | 'EvidenceTable' | 'PivotTable' | 'TrustCallout' | 'ResearchActions' | 'NarrativePanel' | string;
  role?: string;
  layoutIntent?: string;
  defaultVisualization?: string;
  allowedVisualizations?: string[];
  fieldHints?: Record<string, string>;
  insightTitle?: string;
  trustState?: 'certified' | 'review_required' | 'draft_ready' | string;
  reviewStatus?: string;
  sourceNodeId?: string;
  followUpActions?: string[];
  rationale?: string;
}

export function getDashboardItemBlockId(item: DashboardLayoutItem): string | null {
  if (!item.block) return null;
  return 'blockId' in item.block ? item.block.blockId ?? null : item.block.ref ?? null;
}

/** Single client vocabulary; see `normalizeDashboardChartType`. */
export function normalizeChartType(value: unknown): ChartType {
  return normalizeDashboardChartType(value) as ChartType;
}

export function chartToDashboardViz(value: unknown): string {
  const chart = normalizeChartType(value);
  if (chart === 'table') return 'table';
  return chart.replace(/-/g, '_');
}

export function compactChartConfig(config: CellChartConfig): CellChartConfig {
  const out: CellChartConfig = {};
  for (const [key, value] of Object.entries(config) as Array<[keyof CellChartConfig, unknown]>) {
    if (value === undefined || value === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  if (!out.chart) out.chart = 'table';
  return out;
}

export function getDqlGenUi(item: DashboardLayoutItem): DqlGenUiMetadata | null {
  if (isRecord(item.display)) {
    const display = item.display;
    const component = typeof display.component === 'string' ? display.component : undefined;
    return {
      version: 1,
      component,
      role: roleForDisplayComponent(component),
      layoutIntent: typeof display.layoutIntent === 'string' ? display.layoutIntent : undefined,
      defaultVisualization: typeof display.defaultVisualization === 'string' ? display.defaultVisualization : undefined,
      allowedVisualizations: Array.isArray(display.allowedVisualizations) ? display.allowedVisualizations.filter((value): value is string => typeof value === 'string') : undefined,
      fieldHints: isRecord(display.fieldHints)
        ? Object.fromEntries(Object.entries(display.fieldHints).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : undefined,
      insightTitle: item.title,
      trustState: typeof display.trustState === 'string' ? display.trustState : undefined,
      reviewStatus: typeof display.reviewStatus === 'string' ? display.reviewStatus : undefined,
      rationale: typeof display.rationale === 'string' ? display.rationale : undefined,
    };
  }
  const raw = (item.viz.options as Record<string, unknown> | undefined)?.dqlGenUi;
  if (!isRecord(raw)) return null;
  return {
    version: typeof raw.version === 'number' ? raw.version : undefined,
    component: typeof raw.component === 'string' ? raw.component : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    layoutIntent: typeof raw.layoutIntent === 'string' ? raw.layoutIntent : undefined,
    defaultVisualization: typeof raw.defaultVisualization === 'string' ? raw.defaultVisualization : undefined,
    allowedVisualizations: Array.isArray(raw.allowedVisualizations) ? raw.allowedVisualizations.filter((value): value is string => typeof value === 'string') : undefined,
    fieldHints: isRecord(raw.fieldHints)
      ? Object.fromEntries(Object.entries(raw.fieldHints).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined,
    insightTitle: typeof raw.insightTitle === 'string' ? raw.insightTitle : undefined,
    trustState: typeof raw.trustState === 'string' ? raw.trustState : undefined,
    reviewStatus: typeof raw.reviewStatus === 'string' ? raw.reviewStatus : undefined,
    sourceNodeId: typeof raw.sourceNodeId === 'string' ? raw.sourceNodeId : undefined,
    followUpActions: Array.isArray(raw.followUpActions) ? raw.followUpActions.filter((value): value is string => typeof value === 'string') : undefined,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : undefined,
  };
}

export function textTileDisplay(
  viz: 'text' | 'heading',
  title: string,
): NonNullable<DashboardLayoutItem['display']> {
  return {
    mode: 'manual',
    component: viz === 'heading' ? 'NarrativePanel' : 'BusinessBrief',
    defaultVisualization: viz,
    allowedVisualizations: [viz],
    layoutIntent: viz === 'heading' ? 'wide' : 'standard',
    rationale: title ? `Manual narrative tile for "${title}" on this app surface.` : 'Manual narrative tile for this app surface.',
    trustState: 'review_required',
    reviewStatus: 'review_required',
  };
}

export function displayWithVisualization(
  item: DashboardLayoutItem,
  dashboardViz: string,
  genUi?: DqlGenUiMetadata | null,
): DashboardLayoutItem['display'] | undefined {
  const allowed = uniqueStrings([
    dashboardViz,
    ...(item.display?.allowedVisualizations ?? []),
    ...(genUi?.allowedVisualizations ?? []),
  ]);
  const component = item.display?.component ?? componentForDashboardViz(dashboardViz);
  return {
    mode: item.display?.mode ?? (genUi ? 'ai_generated' : item.block ? 'block_hint' : 'manual'),
    component,
    defaultVisualization: dashboardViz,
    allowedVisualizations: allowed.length ? allowed : [dashboardViz],
    ...(item.display?.fieldHints || genUi?.fieldHints ? { fieldHints: item.display?.fieldHints ?? genUi?.fieldHints } : {}),
    layoutIntent: coerceLayoutIntent(item.display?.layoutIntent ?? genUi?.layoutIntent),
    rationale: item.display?.rationale ?? genUi?.rationale ?? 'Visualization selected for this consumer surface.',
    trustState: coerceTrustState(item.display?.trustState ?? genUi?.trustState),
    reviewStatus: coerceReviewStatus(item.display?.reviewStatus ?? genUi?.reviewStatus),
  };
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())));
}

export function componentForDashboardViz(viz: string): NonNullable<DashboardLayoutItem['display']>['component'] {
  if (viz === 'single_value' || viz === 'kpi' || viz === 'gauge') return 'KpiMetric';
  if (viz === 'line' || viz === 'area') return 'TrendPanel';
  if (viz === 'bar' || viz === 'grouped_bar' || viz === 'stacked_bar' || viz === 'donut' || viz === 'pie') return 'RankingPanel';
  if (viz === 'pivot') return 'PivotTable';
  if (viz === 'text' || viz === 'heading') return 'NarrativePanel';
  return 'EvidenceTable';
}

export function roleForDisplayComponent(component?: string): string | undefined {
  if (component === 'BusinessBrief') return 'business_summary';
  if (component === 'KpiMetric') return 'kpi';
  if (component === 'TrendPanel') return 'trend';
  if (component === 'RankingPanel') return 'breakdown';
  if (component === 'TrustCallout') return 'trust';
  if (component === 'ResearchActions') return 'research';
  if (component === 'NarrativePanel') return 'narrative';
  return component ? 'evidence' : undefined;
}

export function coerceLayoutIntent(value?: string): NonNullable<DashboardLayoutItem['display']>['layoutIntent'] {
  return value === 'compact' || value === 'standard' || value === 'wide' || value === 'tall' || value === 'full' || value === 'auto'
    ? value
    : 'auto';
}

export function coerceTrustState(value?: string): NonNullable<DashboardLayoutItem['display']>['trustState'] {
  return value === 'certified' || value === 'draft_ready' || value === 'review_required' ? value : 'review_required';
}

export function coerceReviewStatus(value?: string): NonNullable<DashboardLayoutItem['display']>['reviewStatus'] {
  return value === 'certified' || value === 'draft_ready' || value === 'review_required' ? value : 'review_required';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Dashboard `viz.type` vocabulary including the non-chart tile kinds. */
export function normalizeViz(chartType?: string): string {
  const value = (chartType ?? 'table').toLowerCase().replace(/-/g, '_');
  if (value === 'single_value' || value === 'kpi' || value === 'gauge' || value === 'line' || value === 'bar' || value === 'area'
    || value === 'pie' || value === 'donut' || value === 'grouped_bar' || value === 'stacked_bar' || value === 'scatter'
    || value === 'heatmap' || value === 'histogram' || value === 'waterfall' || value === 'pivot' || value === 'map'
    || value === 'funnel' || value === 'sankey' || value === 'heading' || value === 'text') {
    return value;
  }
  return 'table';
}
