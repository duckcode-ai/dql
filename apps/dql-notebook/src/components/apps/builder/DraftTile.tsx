import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { DatasetDescriptor } from '@duckcodeailabs/dql-core/datasets/descriptor';
import {
  datasetMeasureField,
  datasetPhysicalField,
} from '@duckcodeailabs/dql-core/datasets/descriptor';
import {
  datasetTileVisualizationCompatibility,
  tileQueryValidationRuns,
  validateTileQuery,
  type TileQuery,
} from '@duckcodeailabs/dql-core/apps/tile-query';
import { api, type DatasetTileQueryPreview } from '../../../api/client';
import type { CellChartConfig, QueryResult, ResultColumnMeta } from '../../../store/types';
import type { ThemeMode } from '../../../themes/notebook-theme';
import { ChartOutput } from '../../output/ChartOutput';
import { TableOutput } from '../../output/TableOutput';
import { TileQueryEditor } from './TileQueryEditor';
import { defaultTileTitle, tileVisualization, toggleFieldInQuery, type TileView } from './field-query';
import { humanize } from './studio-ui';

export type DraftTileState = {
  /** Catalog item id of the Dataset the tile is built from. */
  sourceKey: string;
  query: TileQuery;
  view: TileView;
  /** True once the author picks a view; field picks stop changing it. */
  viewChosen: boolean;
  title: string;
};

type PreviewState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ready'; result: QueryResult; ms: number }
  | { state: 'failed'; message: string };

/**
 * Units for the preview columns, from the Dataset contract: the added tile
 * formats a ratio as a percent and revenue as money, so the draft must too.
 */
export function draftColumnsMeta(descriptor: DatasetDescriptor, query: TileQuery, columns: string[]): ResultColumnMeta[] {
  const meta: ResultColumnMeta[] = [];
  for (const measure of query.measures) {
    const name = measure.alias ?? measure.measure;
    const field = datasetMeasureField(descriptor, measure.measure);
    if (!field || !columns.includes(name)) continue;
    const kind = field.format?.kind ?? (field.aggregation === 'ratio' ? 'percent' : field.aggregation.startsWith('count') ? 'count' : 'number');
    meta.push({ name, kind, ...(field.format?.currency ? { unit: field.format.currency } : {}), ...(field.format?.decimals !== undefined ? { decimals: field.format.decimals } : {}) });
  }
  for (const dimension of query.dimensions) {
    if (!dimension.timeGrain) continue;
    const name = dimension.alias ?? columns.find((column) => column === `${dimension.field}_${dimension.timeGrain}`) ?? dimension.field;
    if (columns.includes(name)) meta.push({ name, kind: 'date', grain: dimension.timeGrain });
  }
  return meta;
}

/** Why the draft cannot be added yet, or undefined when it can. */
export function draftTileBlocker(descriptor: DatasetDescriptor, draft: DraftTileState): string | undefined {
  if (!draft.query.measures.length && !draft.query.detail) return 'Pick at least one measure.';
  const validation = validateTileQuery(descriptor, draft.query);
  if (!tileQueryValidationRuns(validation)) return validation.diagnostics[0]?.message ?? 'This field combination is not covered by the Dataset.';
  const compatibility = datasetTileVisualizationCompatibility(draft.query, tileVisualization(draft.query, draft.view));
  return compatibility.compatible ? undefined : compatibility.message;
}

/**
 * Runs one Dataset field query through the governed Dataset runtime (the
 * ephemeral /api/app-datasets/run path) and draws it as the tile will look.
 * Edits are debounced and a newer query cancels the older request. Nothing
 * here is App evidence — applying or adding a tile runs a real page preview.
 */
export function DatasetQueryPreview({
  sourceId,
  descriptor,
  query,
  visualization,
  themeMode,
  runnable = true,
  height = 260,
  onStatus,
}: {
  sourceId?: string;
  descriptor?: DatasetDescriptor;
  query: TileQuery;
  visualization: string;
  themeMode: ThemeMode;
  runnable?: boolean;
  height?: number;
  onStatus?: (status: string, tone: 'ok' | 'error' | 'idle') => void;
}): JSX.Element {
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const latest = useRef(0);
  const key = JSON.stringify(query);
  useEffect(() => {
    if (!sourceId || !runnable) {
      setPreview({ state: 'idle' });
      return;
    }
    const ticket = ++latest.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPreview({ state: 'running' });
      const started = performance.now();
      void api.previewDatasetTileQuery({ sourceId, query }, controller.signal).then((response: DatasetTileQueryPreview) => {
        if (ticket !== latest.current) return;
        if (!response.ok) {
          setPreview({ state: 'failed', message: response.error || 'This field query did not return a result.' });
          return;
        }
        const rows = response.result?.rows ?? [];
        const named = (response.result?.columns ?? []).map((column) => typeof column === 'string' ? column : String((column as { name?: string }).name ?? column));
        const columns = named.length ? named : Object.keys(rows[0] ?? {});
        setPreview({
          state: 'ready',
          ms: Math.round(performance.now() - started),
          result: { columns, rows, rowCount: response.result?.rowCount ?? rows.length, ...(descriptor ? { columnsMeta: draftColumnsMeta(descriptor, query, columns) } : {}) },
        });
      }).catch(() => {
        // Superseded by a newer edit.
      });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sourceId, key, runnable]);
  useEffect(() => {
    if (!onStatus) return;
    if (preview.state === 'ready') {
      const count = preview.result.rowCount ?? preview.result.rows.length;
      onStatus(`Live · ${count} ${count === 1 ? 'row' : 'rows'} · ${preview.ms} ms`, 'ok');
    } else if (preview.state === 'running') onStatus('Running…', 'idle');
    else if (preview.state === 'failed') onStatus('Run failed', 'error');
  }, [preview]);
  if (preview.state === 'failed') return <div className="draft-empty warn"><strong>This query did not run</strong><span>{preview.message}</span></div>;
  if (preview.state !== 'ready') return <div className="draft-empty loading"><span>{sourceId ? 'Running against live data…' : 'Runs when applied'}</span></div>;
  if (visualization === 'table' || visualization === 'pivot') return <TableOutput result={preview.result} themeMode={themeMode} maxHeight={height + 20} initialPageSize={10} />;
  return <ChartOutput result={preview.result} themeMode={themeMode} chartConfig={{ chart: visualization === 'single_value' || visualization === 'kpi' ? 'kpi' : visualization } as CellChartConfig} availableHeight={height} />;
}

/** The new tile on the canvas, drawn live as fields are picked. */
export function DraftTileCard({
  sourceId,
  descriptor,
  draft,
  themeMode,
}: {
  sourceId?: string;
  descriptor: DatasetDescriptor;
  draft: DraftTileState;
  themeMode: ThemeMode;
}): JSX.Element {
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'error' | 'idle' }>({ text: 'Starting…', tone: 'idle' });
  const blocker = draftTileBlocker(descriptor, draft);
  const visualization = tileVisualization(draft.query, draft.view);
  const title = draft.title.trim() || defaultTileTitle(draft.query, humanize);
  const shownStatus = blocker ? (draft.query.measures.length ? 'Not runnable yet' : 'Waiting for a value') : status.text;
  return <article className="studio-component-card draft-tile" aria-label={`New tile: ${title}`} style={{ '--studio-tile-width': 12 } as React.CSSProperties}>
    <header>
      <span className="draft-badge">NEW TILE</span>
      <strong>{title}</strong>
      <span className={`draft-status ${!blocker ? status.tone : ''}`} aria-live="polite">{shownStatus}</span>
    </header>
    <div className="draft-body">
      {!draft.query.measures.length && !draft.query.detail
        ? <div className="draft-empty"><Plus size={20} /><strong>Pick a measure to start</strong><span>Click a measure in the Data panel. The tile runs as soon as it has one value.</span></div>
        : blocker
          ? <div className="draft-empty warn"><strong>Not runnable yet</strong><span>{blocker}</span></div>
          : <DatasetQueryPreview sourceId={sourceId} descriptor={descriptor} query={draft.query} visualization={visualization} themeMode={themeMode} onStatus={(text, tone) => setStatus({ text, tone })} />}
    </div>
  </article>;
}

/** Right-column settings for the tile being built. */
export function DraftTileInspector({
  descriptor,
  datasetLabel,
  draft,
  disabled,
  onChange,
  onCancel,
  onAdd,
}: {
  descriptor: DatasetDescriptor;
  datasetLabel: string;
  draft: DraftTileState;
  disabled: boolean;
  onChange: (next: DraftTileState) => void;
  onCancel: () => void;
  onAdd: () => void;
}): JSX.Element {
  const blocker = draftTileBlocker(descriptor, draft);
  const removeField = (name: string) => {
    const field = datasetMeasureField(descriptor, name) ?? datasetPhysicalField(descriptor, name);
    if (field) onChange({ ...draft, query: toggleFieldInQuery(draft.query, field) });
  };
  const views: Array<[TileView, string]> = [['kpi', 'KPI'], ['chart', 'Chart'], ['table', 'Table']];
  return <div className="inspector-body draft-inspector">
    <section className="inspector-title"><label htmlFor="draft-tile-title">Title</label><input id="draft-tile-title" value={draft.title} placeholder={defaultTileTitle(draft.query, humanize)} onChange={(event) => onChange({ ...draft, title: event.target.value })} /></section>
    <section><label>Dataset</label><div className="static-field">{datasetLabel}</div></section>
    <section><label>Values</label><div className="pill-row">
      {draft.query.measures.map((measure) => <span key={measure.measure} className="field-pill measure">{humanize(measure.measure)}<button type="button" aria-label={`Remove ${humanize(measure.measure)}`} onClick={() => removeField(measure.measure)}><X size={12} /></button></span>)}
      {!draft.query.measures.length ? <small className="field-help">Click a measure in the Data panel.</small> : null}
    </div></section>
    <section><label>Group by</label><div className="pill-row">
      {draft.query.dimensions.map((dimension) => <span key={dimension.field} className="field-pill">{humanize(dimension.field)}{dimension.timeGrain ? ` · ${dimension.timeGrain}` : ''}<button type="button" aria-label={`Remove ${humanize(dimension.field)}`} onClick={() => removeField(dimension.field)}><X size={12} /></button></span>)}
      {!draft.query.dimensions.length ? <small className="field-help">None — shows one number. Click a date or category to group.</small> : null}
    </div></section>
    <section><label>Show as</label><div className="segmented" role="radiogroup" aria-label="Show as">
      {views.map(([view, label]) => {
        const compatible = datasetTileVisualizationCompatibility(draft.query, tileVisualization(draft.query, view)).compatible;
        return <button key={view} type="button" role="radio" aria-checked={draft.view === view} className={draft.view === view ? 'on' : ''} disabled={!compatible} title={compatible ? undefined : 'These fields cannot show this way'} onClick={() => onChange({ ...draft, view, viewChosen: true })}>{label}</button>;
      })}
    </div>{!draft.viewChosen ? <small className="field-help">Chosen from the fields. Pick one to keep it.</small> : null}</section>
    <details className="draft-more">
      <summary>Filters, sort and more</summary>
      <TileQueryEditor descriptor={descriptor} query={draft.query} disabled={disabled} onChange={(query) => onChange({ ...draft, query })} idPrefix="draft-tile" />
    </details>
    {blocker && draft.query.measures.length ? <small className="dataset-builder-error" role="alert">{blocker}</small> : null}
    <footer className="inspector-footer">
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      <button type="button" className="primary" disabled={disabled || Boolean(blocker)} onClick={onAdd}>Add to page</button>
    </footer>
  </div>;
}
