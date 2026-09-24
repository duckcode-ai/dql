import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { checkCanvasHtml, escapeHtml, fillCanvasHtml } from '@duckcodeailabs/dql-core/apps/canvas-page';
import type { StoryBindingCatalog } from '@duckcodeailabs/dql-core/apps/story-bindings';
import type { DashboardCanvasV1, DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import type { CellChartConfig, QueryResult } from '../../store/types';
import type { ThemeMode } from '../../themes/notebook-theme';
import { renderOptionToSvg } from '../output/echarts/EChartsChart';
import { buildVizOption, ECHARTS_CHART_TYPES } from '../output/echarts/viz-option';
import type { ChartType } from '../output/chart-helpers';
import { mergeDashboardTileChartConfig, normalizeDashboardChartType } from './dashboard-chart-config';
import { formatDriverNumber } from './driver-probe';

type LayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];

/**
 * A governed HTML page (RFC 0008 step 9). The page's own markup runs in a
 * sandboxed frame with no scripts and a CSP that allows no network, so it
 * can only lay out what DQL filled in: escaped values for <dql-value> and
 * DQL-drawn tiles for <dql-tile>. The trust frame is drawn here, outside the
 * frame, where the page's markup cannot reach it.
 */
export function CanvasPageFrame({
  canvas,
  catalog,
  items,
  tiles,
  themeMode,
  trust,
  loading = false,
}: {
  canvas: DashboardCanvasV1;
  catalog: StoryBindingCatalog;
  items: LayoutItem[];
  tiles: RunTile[];
  themeMode: ThemeMode;
  /** e.g. "all 7 tiles certified". */
  trust?: string | null;
  loading?: boolean;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(960);
  const [height, setHeight] = useState(480);
  useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.floor(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Re-check on every render: a page file is trusted only after the checker says so.
  const checked = useMemo(() => checkCanvasHtml(canvas.html), [canvas.html]);
  const srcDoc = useMemo(() => {
    if (checked.issues.length) return '';
    // Charts are drawn at a panel-friendly width and only ever shrink to
    // fit: a page lays tiles out in columns the host cannot measure.
    const chartWidth = Math.min(Math.max(360, width - 40), 640);
    const filled = fillCanvasHtml(checked.html, catalog, (tileId, tileHeight) => drawCanvasTile(items.find((item) => item.i === tileId), tiles.find((tile) => tile.tileId === tileId), catalog, themeMode, chartWidth, tileHeight));
    return canvasDocument(filled, themeVariables(hostRef.current));
  }, [catalog, checked, items, themeMode, tiles, width]);
  const measure = () => {
    const doc = frameRef.current?.contentDocument;
    if (doc?.documentElement) setHeight(Math.max(200, Math.ceil(doc.documentElement.scrollHeight) + 2));
  };
  const values = checked.bindings.length;
  const tileCount = checked.tiles.length;
  return (
    <div className="dql-canvas-page" ref={hostRef}>
      <style>{CANVAS_FRAME_STYLES}</style>
      <header className="dql-canvas-trust" aria-label="About this page">
        <span className="dql-canvas-badge"><ShieldCheck size={13} aria-hidden="true" /> Governed page</span>
        <span>{values} {values === 1 ? 'value' : 'values'} and {tileCount} {tileCount === 1 ? 'tile' : 'tiles'} from this page’s governed results{trust ? ` · ${trust}` : ''}</span>
        <span className="dql-canvas-note">{canvas.generatedBy === 'ai' ? `Designed by ${canvas.model ?? 'AI'} · ` : ''}checked: no scripts, no network, every figure bound</span>
      </header>
      {checked.issues.length ? (
        <p className="dql-canvas-error" role="alert">This page's markup did not pass the governed check, so it is not shown: {checked.issues[0]!.message}</p>
      ) : loading && tiles.length === 0 ? (
        <div className="dql-canvas-loading" role="status" aria-busy="true"><span className="visually-hidden">Loading the page's data…</span></div>
      ) : (
        <iframe
          ref={frameRef}
          title="Governed page"
          // No scripts, no forms, no popups, no top navigation. Same origin
          // only so the host can read the height; with scripts off nothing in
          // the frame can use it.
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          onLoad={measure}
          style={{ width: '100%', height, border: 0, display: 'block', background: 'transparent' }}
        />
      )}
    </div>
  );
}

/** The frame's document: a CSP that allows only inline styles and data images, and the host's theme. */
function canvasDocument(body: string, variables: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'"><style>:root{${variables}}html,body{margin:0;background:transparent}body{padding:4px;font:400 15px/1.55 var(--dql-font);color:var(--dql-ink);font-variant-numeric:tabular-nums}.dql-value{font-weight:600}.dql-value.missing{color:var(--dql-muted)}.dql-tile{margin:8px 0;padding:12px;border:1px solid var(--dql-line);border-radius:12px;background:var(--dql-surface);overflow:hidden}.dql-tile svg{display:block;width:100%;max-width:640px;height:auto}.dql-tile-title{margin:0 0 8px;font-size:13px;font-weight:600}.dql-tile-kpi{font:600 32px/1.2 var(--dql-font-display)}.dql-tile table{width:100%;border-collapse:collapse;font-size:13px}.dql-tile th,.dql-tile td{padding:4px 8px;border-bottom:1px solid var(--dql-line);text-align:left}.dql-tile td.num{text-align:right}.dql-tile .muted{color:var(--dql-muted);font-size:12px}.dql-tile ol{margin:6px 0 0;padding-left:18px}</style></head><body>${body}</body></html>`;
}

function themeVariables(node: HTMLElement | null): string {
  const read = (name: string, fallback: string) => {
    if (!node || typeof getComputedStyle === 'undefined') return fallback;
    const value = getComputedStyle(node).getPropertyValue(name).trim();
    return value || fallback;
  };
  const vars: Array<[string, string]> = [
    ['--dql-ink', read('--dql-app-ink', read('--text-primary', '#1a1a1a'))],
    ['--dql-muted', read('--dql-app-muted', read('--text-secondary', '#4a4a52'))],
    ['--dql-line', read('--dql-app-line', read('--border-subtle', '#e9e6e0'))],
    ['--dql-surface', read('--dql-app-surface', read('--bg-2', '#ffffff'))],
    ['--dql-accent', read('--dql-app-accent', read('--accent', '#0b7a75'))],
    ['--dql-accent-soft', read('--dql-app-accent-soft', read('--accent-dim', 'rgba(11,122,117,0.1)'))],
    ['--dql-font', read('--font-ui', "Inter, system-ui, sans-serif")],
    ['--dql-font-display', "ui-serif, Georgia, 'Times New Roman', serif"],
  ];
  // Values come from the host's own stylesheet; strip anything that could end the declaration.
  return vars.map(([name, value]) => `${name}:${value.replace(/[;{}<>]/g, '')}`).join(';');
}

/** A tile drawn by DQL as static markup: a chart as SVG, a KPI, a table or a driver summary. */
export function drawCanvasTile(item: LayoutItem | undefined, tile: RunTile | undefined, catalog: StoryBindingCatalog, themeMode: ThemeMode, width: number, height?: number): string {
  const title = item?.title ? `<p class="dql-tile-title">${escapeHtml(item.title)}</p>` : '';
  if (!item || !tile) return `${title}<p class="muted">This tile has no result in this run.</p>`;
  if (tile.status !== 'ok') return `${title}<p class="muted">${escapeHtml(tile.error ?? 'This tile could not run.')}</p>`;
  if (tile.driver) {
    const top = tile.driver.dimensions[0];
    return `${title}<p>${escapeHtml(tile.driver.summary)}</p>${top ? `<ol>${top.members.slice(0, 5).map((member) => `<li>${escapeHtml(member.label)}: ${escapeHtml(formatDriverNumber(member.delta, true))}</li>`).join('')}</ol>` : ''}`;
  }
  const result = tile.result as QueryResult | undefined;
  if (!result || result.rows.length === 0) return `${title}<p class="muted">No rows.</p>`;
  const chartType = normalizeDashboardChartType(item.viz.type) as ChartType;
  if (chartType === 'kpi' || (result.rows.length === 1 && result.columns.length <= 2)) {
    const binding = Object.values(catalog).find((entry) => entry.tileId === item.i && entry.kind === 'number');
    return `${title}<div class="dql-tile-kpi">${escapeHtml(binding?.display ?? '—')}</div>`;
  }
  if (ECHARTS_CHART_TYPES.has(chartType)) {
    const config = mergeDashboardTileChartConfig(item as never, tile.chartConfig as CellChartConfig | undefined);
    const built = buildVizOption({ chartType, result, themeMode, config: { ...config, ...(item.viz.style ? { style: item.viz.style } : {}) } as CellChartConfig, animate: false });
    if (built) return `${title}${renderOptionToSvg(built, Math.max(280, width), height ?? 280)}`;
  }
  const columns = result.columns.slice(0, 8);
  const numeric = new Set(columns.filter((column) => result.rows.every((row) => row[column] === null || typeof row[column] === 'number')));
  return `${title}<table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column.replace(/_/g, ' '))}</th>`).join('')}</tr></thead><tbody>${result.rows.slice(0, 15).map((row) => `<tr>${columns.map((column) => `<td${numeric.has(column) ? ' class="num"' : ''}>${escapeHtml(row[column] === null || row[column] === undefined ? '—' : String(row[column]))}</td>`).join('')}</tr>`).join('')}</tbody></table>${result.rows.length > 15 ? `<p class="muted">${escapeHtml(`First ${15} of ${result.rows.length} rows`)}</p>` : ''}`;
}

const CANVAS_FRAME_STYLES = `
.dql-canvas-page { display: grid; gap: 10px; }
.dql-canvas-trust { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 12px; border: 1px solid var(--dql-app-line, var(--border-subtle)); border-radius: 8px; background: var(--dql-app-surface, var(--bg-2)); color: var(--dql-app-muted, var(--text-secondary)); font: 400 12px/1.4 var(--font-ui, inherit); }
.dql-canvas-badge { display: inline-flex; align-items: center; gap: 5px; color: var(--dql-app-ink, var(--text-primary)); font-weight: 600; }
.dql-canvas-badge svg { color: var(--trust-certified, #0b7a75); }
.dql-canvas-note { margin-left: auto; }
.dql-canvas-error { margin: 0; padding: 12px; border: 1px solid var(--status-error-border, rgba(193,69,69,.3)); border-radius: 8px; color: var(--status-error, #c14545); font-size: 13px; }
.dql-canvas-loading { height: 320px; border-radius: 12px; background: var(--dql-app-control, var(--bg-0)); }
`;
