import { useId, useState } from 'react';
import {
  AreaChart,
  BarChart2,
  BarChart3,
  BarChartHorizontal,
  ChartBarStacked,
  Donut,
  Filter,
  Gauge,
  Grid3x3,
  LineChart,
  PieChart,
  ScatterChart,
  Table2,
} from 'lucide-react';
import type { DatasetDescriptor } from '@duckcodeailabs/dql-core/datasets/descriptor';
import type { TileQuery } from '@duckcodeailabs/dql-core/apps/tile-query';
import { chartFromEncoding, outputAlias, type DashboardVizEncoding } from '@duckcodeailabs/dql-core/apps/viz-encoding';
import {
  SHOW_ME_CHARTS,
  showMe,
  showMeFactsFromDescriptor,
  showMeInputFromEncoding,
  type ShowMeChart,
  type ShowMeSuggestion,
} from '@duckcodeailabs/dql-core/apps/show-me';
import type { QueryResult } from '../../../store/types';
import { humanize } from './studio-ui';

const ICONS: Record<ShowMeChart, typeof Gauge> = {
  kpi: Gauge,
  line: LineChart,
  area: AreaChart,
  bar: BarChartHorizontal,
  column: BarChart3,
  grouped_bar: BarChart2,
  stacked_bar: ChartBarStacked,
  donut: Donut,
  pie: PieChart,
  funnel: Filter,
  scatter: ScatterChart,
  heatmap: Grid3x3,
  table: Table2,
};

/**
 * Show Me for a Dataset tile: every chart ranked for the fields on its
 * shelves. The Dataset contract says which dimensions are dates, which
 * measures add up and their units; the tile's last result, when there is
 * one, says how many values each dimension has and whether a measure goes
 * negative.
 */
export function tileShowMe(
  descriptor: DatasetDescriptor,
  encoding: DashboardVizEncoding,
  query: TileQuery,
  result?: QueryResult,
): ShowMeSuggestion[] {
  const column = (ref: { dimension: string } | { measure: string }) => {
    const name = outputAlias(query, ref);
    return name && result?.columns.includes(name) ? name : undefined;
  };
  const facts = showMeFactsFromDescriptor(descriptor, {
    cardinality: (dimension) => {
      const name = column({ dimension });
      return name && result ? new Set(result.rows.map((row) => String(row[name] ?? ''))).size : undefined;
    },
    nonNegative: (measure) => {
      const name = column({ measure });
      if (!name || !result) return undefined;
      const values = result.rows.map((row) => Number(row[name])).filter((value) => Number.isFinite(value));
      return values.length ? values.every((value) => value >= 0) : undefined;
    },
  });
  const input = showMeInputFromEncoding(encoding, facts);
  const label = (kind: 'dimension' | 'measure', name: string) => encoding.fields?.[`${kind}:${name}`]?.label ?? humanize(name);
  return showMe({
    dimensions: input.dimensions.map((field) => ({ ...field, label: label('dimension', field.name) })),
    measures: input.measures.map((field) => ({ ...field, label: label('measure', field.name) })),
    ...(query.detail ? { rowDetail: true } : {}),
    ...(query.comparison ? { comparison: true } : {}),
  });
}

/** The Show Me chart a tile draws as now: its chart type, read with its shelves. */
export function currentShowMeChart(visualization: string | undefined, encoding: DashboardVizEncoding, isTime: (field: string) => boolean): ShowMeChart | undefined {
  const type = (visualization ?? '').toLowerCase().replace(/-/g, '_');
  const drawn = chartFromEncoding(encoding, isTime);
  if (type === 'single_value' || type === 'kpi') return 'kpi';
  if (type === 'table' || type === 'pivot' || drawn.kind === 'table') return 'table';
  if (type === 'bar') return drawn.kind === 'cartesian' && drawn.orientation === 'vertical' ? 'column' : 'bar';
  return (SHOW_ME_CHARTS as readonly string[]).includes(type) ? type as ShowMeChart : undefined;
}

/**
 * The ranked charts as a picker. The best one is marked; charts that do not
 * fit stay visible, greyed out, and say why when hovered or focused.
 */
export function ShowMePanel({
  suggestions,
  current,
  disabled,
  onPick,
}: {
  suggestions: ShowMeSuggestion[];
  current?: ShowMeChart;
  disabled: boolean;
  onPick: (suggestion: ShowMeSuggestion) => void;
}): JSX.Element {
  const [pointed, setPointed] = useState<ShowMeChart | null>(null);
  const reasonId = useId();
  const shown = suggestions.find((entry) => entry.chart === pointed)
    ?? suggestions.find((entry) => entry.chart === current)
    ?? suggestions.find((entry) => entry.recommended);
  return (
    <section className="show-me" aria-label="Show Me">
      <span className="show-me-title">Show Me</span>
      <div className="show-me-grid" role="radiogroup" aria-label="Chart type" onMouseLeave={() => setPointed(null)}>
        {suggestions.map((suggestion) => {
          const Icon = ICONS[suggestion.chart];
          const on = suggestion.chart === current;
          return (
            <button
              key={suggestion.chart}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={!suggestion.available || disabled}
              aria-describedby={reasonId}
              className={[on && 'on', !suggestion.available && 'unfit', suggestion.recommended && 'best'].filter(Boolean).join(' ') || undefined}
              title={suggestion.reason}
              onMouseEnter={() => setPointed(suggestion.chart)}
              onFocus={() => setPointed(suggestion.chart)}
              onBlur={() => setPointed(null)}
              onClick={() => { if (suggestion.available && !disabled && !on) onPick(suggestion); }}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{suggestion.label}</span>
              {suggestion.recommended ? <b className="show-me-best">Best</b> : null}
            </button>
          );
        })}
      </div>
      {shown ? (
        <p id={reasonId} className={`show-me-reason ${shown.available ? '' : 'unfit'}`.trim()} aria-live="polite">
          <strong>{shown.label}{shown.available ? '' : ' does not fit'}</strong>
          {' '}{shown.reason}
        </p>
      ) : null}
    </section>
  );
}
