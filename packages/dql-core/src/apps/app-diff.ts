/**
 * Reviewing an App change (RFC 0008 step 10): what a pull request does to
 * each page, tile by tile, and a before/after picture of the layout.
 *
 * Apps are files in git, so a reviewer should not have to read JSON to see
 * that a KPI moved, a chart changed its query, or a story lost a figure.
 * This compares two versions of a page without running anything: it names
 * the changes and flags the ones that change numbers (a tile's query, source
 * or filters), which a reviewer should check against a run.
 *
 * Pure: no I/O.
 */
import type { DashboardDocument, DashboardGridItem } from './dashboard-document.js';
import type { AppDocument } from './app-document.js';

export type TileChangeKind = 'added' | 'removed' | 'changed';

/** What changed on a tile, in reviewer words. */
export type TileAspect =
  | 'query'
  | 'source'
  | 'filters'
  | 'driver'
  | 'chart type'
  | 'chart style'
  | 'title'
  | 'description'
  | 'owner'
  | 'text'
  | 'position'
  | 'size';

/** Aspects that can change the numbers a tile shows. */
export const NUMBER_ASPECTS: ReadonlySet<TileAspect> = new Set(['query', 'source', 'filters', 'driver']);

export interface TileBox { x: number; y: number; w: number; h: number }

export interface TileChange {
  tileId: string;
  title: string;
  kind: TileChangeKind;
  aspects: TileAspect[];
  /** True when the change can move the tile's numbers. */
  changesNumbers: boolean;
  before?: TileBox;
  after?: TileBox;
}

export type PageAspect = 'title' | 'filters' | 'interactions' | 'story' | 'HTML page' | 'presentation' | 'description';

export interface PageDiff {
  pageId: string;
  title: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  tiles: TileChange[];
  page: PageAspect[];
  cols: number;
  /** Every tile in each version, for drawing the layout. */
  beforeTiles: Array<TileBox & { tileId: string; title: string }>;
  afterTiles: Array<TileBox & { tileId: string; title: string }>;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const titleOf = (item: DashboardGridItem) => item.title?.trim() || item.text?.markdown?.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 60) || item.i;
const box = (item: DashboardGridItem): TileBox => ({ x: item.x, y: item.y, w: item.w, h: item.h });

function tileAspects(before: DashboardGridItem, after: DashboardGridItem): TileAspect[] {
  const aspects: TileAspect[] = [];
  if (!same(before.query, after.query) || !same(before.block, after.block) || !same(before.semantic, after.semantic) || !same(before.aiPin, after.aiPin)) aspects.push('query');
  if (before.sourceId !== after.sourceId || before.sourceRevision !== after.sourceRevision) aspects.push('source');
  if (!same(before.filterBindings, after.filterBindings) || !same(before.parameterBindings, after.parameterBindings)) aspects.push('filters');
  if (!same(before.driver, after.driver)) aspects.push('driver');
  if (before.viz?.type !== after.viz?.type) aspects.push('chart type');
  if (!same({ ...before.viz, type: undefined }, { ...after.viz, type: undefined })) aspects.push('chart style');
  if ((before.title ?? '') !== (after.title ?? '')) aspects.push('title');
  if ((before.description ?? '') !== (after.description ?? '')) aspects.push('description');
  if ((before.owner ?? '') !== (after.owner ?? '')) aspects.push('owner');
  if (!same(before.text, after.text)) aspects.push('text');
  if (before.x !== after.x || before.y !== after.y) aspects.push('position');
  if (before.w !== after.w || before.h !== after.h) aspects.push('size');
  return aspects;
}

/** Compare two versions of one page; either side may be missing. */
export function diffDashboardPages(before: DashboardDocument | null, after: DashboardDocument | null): PageDiff {
  const page = after ?? before!;
  const beforeItems = before?.layout.items ?? [];
  const afterItems = after?.layout.items ?? [];
  const beforeById = new Map(beforeItems.map((item) => [item.i, item]));
  const afterById = new Map(afterItems.map((item) => [item.i, item]));
  const tiles: TileChange[] = [];
  for (const item of afterItems) {
    const prior = beforeById.get(item.i);
    if (!prior) {
      tiles.push({ tileId: item.i, title: titleOf(item), kind: 'added', aspects: [], changesNumbers: !item.text, after: box(item) });
      continue;
    }
    const aspects = tileAspects(prior, item);
    if (aspects.length) {
      tiles.push({ tileId: item.i, title: titleOf(item), kind: 'changed', aspects, changesNumbers: aspects.some((aspect) => NUMBER_ASPECTS.has(aspect)), before: box(prior), after: box(item) });
    }
  }
  for (const item of beforeItems) {
    if (!afterById.has(item.i)) tiles.push({ tileId: item.i, title: titleOf(item), kind: 'removed', aspects: [], changesNumbers: !item.text, before: box(item) });
  }
  const pageAspects: PageAspect[] = [];
  if (before && after) {
    if (before.metadata.title !== after.metadata.title) pageAspects.push('title');
    if ((before.metadata.description ?? '') !== (after.metadata.description ?? '')) pageAspects.push('description');
    if (!same(before.filters, after.filters) || !same(before.params, after.params)) pageAspects.push('filters');
    if (!same(before.interactions, after.interactions)) pageAspects.push('interactions');
    if (!same(before.narrative?.blocks, after.narrative?.blocks)) pageAspects.push('story');
    if (!same(before.canvas?.html, after.canvas?.html)) pageAspects.push('HTML page');
    if ((before.narrative?.presentation ?? 'dashboard') !== (after.narrative?.presentation ?? 'dashboard')) pageAspects.push('presentation');
  }
  const status = !before ? 'added' : !after ? 'removed' : tiles.length || pageAspects.length ? 'changed' : 'unchanged';
  const order = { changed: 0, added: 1, removed: 2 } as const;
  tiles.sort((left, right) => order[left.kind] - order[right.kind] || Number(right.changesNumbers) - Number(left.changesNumbers));
  return {
    pageId: page.id,
    title: page.metadata.title,
    status,
    tiles,
    page: pageAspects,
    cols: (after ?? before)!.layout.cols || 12,
    beforeTiles: beforeItems.map((item) => ({ tileId: item.i, title: titleOf(item), ...box(item) })),
    afterTiles: afterItems.map((item) => ({ tileId: item.i, title: titleOf(item), ...box(item) })),
  };
}

/** Schedule and alert changes on an App, in reviewer words. */
export function diffAppDeliveries(before: AppDocument | null, after: AppDocument | null): string[] {
  const out: string[] = [];
  const beforeSchedules = new Map((before?.schedules ?? []).map((schedule) => [schedule.id, schedule]));
  const afterSchedules = new Map((after?.schedules ?? []).map((schedule) => [schedule.id, schedule]));
  for (const [id, schedule] of afterSchedules) {
    const prior = beforeSchedules.get(id);
    if (!prior) {
      out.push(`Schedule "${id}" added for page ${schedule.dashboard} (${schedule.cron})${schedule.monitors?.length ? ` with ${schedule.monitors.length} alert${schedule.monitors.length === 1 ? '' : 's'}` : ''}.`);
      continue;
    }
    if (prior.cron !== schedule.cron) out.push(`Schedule "${id}" now runs on ${schedule.cron} (was ${prior.cron}).`);
    if (!same(prior.deliver, schedule.deliver)) out.push(`Schedule "${id}" delivers to different targets.`);
    if ((prior.enabled !== false) !== (schedule.enabled !== false)) out.push(`Schedule "${id}" is now ${schedule.enabled === false ? 'off' : 'on'}.`);
    if ((prior.digest !== false) !== (schedule.digest !== false)) out.push(`Schedule "${id}" now ${schedule.digest === false ? 'speaks only when an alert fires' : 'sends a digest every run'}.`);
    const priorMonitors = new Map((prior.monitors ?? []).map((monitor) => [monitor.id, monitor]));
    for (const monitor of schedule.monitors ?? []) {
      const was = priorMonitors.get(monitor.id);
      if (!was) out.push(`Alert "${monitor.label ?? monitor.id}" added on ${monitor.binding}.`);
      else if (!same(was, monitor)) out.push(`Alert "${monitor.label ?? monitor.id}" changed.`);
      priorMonitors.delete(monitor.id);
    }
    for (const monitor of priorMonitors.values()) out.push(`Alert "${monitor.label ?? monitor.id}" removed.`);
  }
  for (const id of beforeSchedules.keys()) if (!afterSchedules.has(id)) out.push(`Schedule "${id}" removed.`);
  return out;
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The page layout before and after, side by side: added tiles in teal,
 * changed tiles in amber (solid when their numbers can change), removed
 * tiles dashed in the "before" panel. Colours are fixed hexes because the
 * SVG is embedded in reports and PR comments outside any theme.
 */
export function renderLayoutDiffSvg(diff: PageDiff, width = 880): string {
  const gap = 24;
  const panel = (width - gap) / 2;
  const unit = panel / diff.cols;
  const rowHeight = Math.max(10, Math.min(18, unit * 0.9));
  const rows = Math.max(1, ...diff.beforeTiles.map((tile) => tile.y + tile.h), ...diff.afterTiles.map((tile) => tile.y + tile.h));
  const height = rows * rowHeight + 28;
  const byId = new Map(diff.tiles.map((tile) => [tile.tileId, tile]));
  const draw = (tiles: PageDiff['beforeTiles'], side: 'before' | 'after', offset: number) => tiles.map((tile) => {
    const change = byId.get(tile.tileId);
    const removed = side === 'before' && change?.kind === 'removed';
    const added = side === 'after' && change?.kind === 'added';
    const changed = change?.kind === 'changed';
    const stroke = removed ? '#c14545' : added ? '#0b7a75' : changed ? '#b26b1f' : '#c9c4ba';
    const fill = removed ? '#fbeeee' : added ? '#e6f2f1' : changed ? (change!.changesNumbers ? '#fbeedd' : '#fdf6ee') : '#f6f4f0';
    const x = offset + tile.x * unit + 2;
    const y = 24 + tile.y * rowHeight + 2;
    const w = Math.max(4, tile.w * unit - 4);
    const h = Math.max(4, tile.h * rowHeight - 4);
    const maxChars = Math.max(0, Math.floor((w - 12) / 6.4));
    const label = tile.title.length > maxChars ? `${tile.title.slice(0, Math.max(0, maxChars - 1))}…` : tile.title;
    return `<g><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="${change && !(side === 'before' && change.kind === 'changed') ? 1.5 : 1}"${removed ? ' stroke-dasharray="4 3"' : ''}></rect>${h >= 16 && maxChars >= 3 ? `<text x="${(x + 6).toFixed(1)}" y="${(y + 13).toFixed(1)}" font-size="11" fill="#1a1a1a" font-family="Inter, -apple-system, Segoe UI, Arial, sans-serif">${esc(label)}</text>` : ''}</g>`;
  }).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height.toFixed(0)}" viewBox="0 0 ${width} ${height.toFixed(0)}" role="img" aria-label="${esc(`${diff.title}: layout before and after`)}">`,
    `<text x="0" y="14" font-size="12" font-weight="600" fill="#4a4a52" font-family="Inter, -apple-system, Segoe UI, Arial, sans-serif">Before</text>`,
    `<text x="${panel + gap}" y="14" font-size="12" font-weight="600" fill="#4a4a52" font-family="Inter, -apple-system, Segoe UI, Arial, sans-serif">After</text>`,
    diff.status === 'added' ? `<text x="0" y="40" font-size="12" fill="#4a4a52" font-family="Inter, -apple-system, Segoe UI, Arial, sans-serif">New page</text>` : draw(diff.beforeTiles, 'before', 0),
    diff.status === 'removed' ? `<text x="${panel + gap}" y="40" font-size="12" fill="#4a4a52" font-family="Inter, -apple-system, Segoe UI, Arial, sans-serif">Page removed</text>` : draw(diff.afterTiles, 'after', panel + gap),
    '</svg>',
  ].join('');
}
