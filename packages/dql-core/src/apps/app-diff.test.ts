import { describe, expect, it } from 'vitest';
import { diffAppDeliveries, diffDashboardPages, renderLayoutDiffSvg } from './app-diff.js';
import type { AppDocument } from './app-document.js';
import type { DashboardDocument, DashboardGridItem } from './dashboard-document.js';

const tile = (i: string, extra: Partial<DashboardGridItem> = {}): DashboardGridItem => ({
  i, x: 0, y: 0, w: 6, h: 4, title: i, viz: { type: 'bar' }, sourceId: 'ds:orders', sourceRevision: 'r1',
  query: { measures: [{ measure: 'revenue' }] }, ...extra,
} as DashboardGridItem);

const page = (items: DashboardGridItem[], extra: Partial<DashboardDocument> = {}): DashboardDocument => ({
  version: 3, id: 'overview', metadata: { title: 'Overview' }, layout: { kind: 'grid', cols: 12, rowHeight: 80, items }, ...extra,
} as DashboardDocument);

describe('App review diff (RFC 0008 step 10)', () => {
  it('names each tile change and flags the ones that can move numbers', () => {
    const before = page([
      tile('revenue', { viz: { type: 'kpi' } }),
      tile('by_region', { x: 6 }),
      tile('old_table', { y: 4, viz: { type: 'table' } }),
      tile('note', { y: 8, text: { markdown: 'Hello' }, query: undefined, sourceId: undefined, sourceRevision: undefined, viz: { type: 'text' } } as Partial<DashboardGridItem>),
    ]);
    const after = page([
      tile('revenue', { viz: { type: 'kpi' }, title: 'Revenue (net)', w: 4 }),
      tile('by_region', { x: 6, query: { measures: [{ measure: 'revenue' }], filters: [{ field: 'region', op: 'in', values: ['US'] }] } as DashboardGridItem['query'], viz: { type: 'line' } }),
      tile('margin', { y: 4 }),
      tile('note', { y: 8, text: { markdown: 'Hello again' }, query: undefined, sourceId: undefined, sourceRevision: undefined, viz: { type: 'text' } } as Partial<DashboardGridItem>),
    ], { filters: [{ id: 'region', type: 'select', label: 'Region' }] as DashboardDocument['filters'] });
    const diff = diffDashboardPages(before, after);
    expect(diff.status).toBe('changed');
    expect(diff.page).toEqual(['filters']);
    const byId = Object.fromEntries(diff.tiles.map((change) => [change.tileId, change]));
    expect(byId.by_region).toMatchObject({ kind: 'changed', aspects: ['query', 'chart type'], changesNumbers: true });
    expect(byId.revenue).toMatchObject({ kind: 'changed', aspects: ['title', 'size'], changesNumbers: false, title: 'Revenue (net)' });
    expect(byId.note).toMatchObject({ kind: 'changed', aspects: ['text'], changesNumbers: false });
    expect(byId.margin).toMatchObject({ kind: 'added', changesNumbers: true, after: { x: 0, y: 4, w: 6, h: 4 } });
    expect(byId.old_table).toMatchObject({ kind: 'removed', changesNumbers: true });
    // Changes that move numbers are listed first.
    expect(diff.tiles[0]!.tileId).toBe('by_region');
    expect(diffDashboardPages(before, before)).toMatchObject({ status: 'unchanged', tiles: [], page: [] });
  });

  it('covers story, HTML page and presentation changes, and new or removed pages', () => {
    const before = page([tile('a')]);
    const story = page([tile('a')], { narrative: { version: 1, presentation: 'story', blocks: [{ id: 'b', kind: 'text', markdown: 'Up {{a.revenue}}' }] } as DashboardDocument['narrative'] });
    expect(diffDashboardPages(before, story).page).toEqual(['story', 'presentation']);
    expect(diffDashboardPages(null, before)).toMatchObject({ status: 'added', tiles: [{ tileId: 'a', kind: 'added' }] });
    expect(diffDashboardPages(before, null)).toMatchObject({ status: 'removed', tiles: [{ tileId: 'a', kind: 'removed' }] });
  });

  it('describes schedule and alert changes', () => {
    const app = (schedules: AppDocument['schedules']) => ({ id: 'sales', name: 'Sales', schedules } as AppDocument);
    const before = app([{ id: 'daily', cron: '0 8 * * *', dashboard: 'overview', deliver: [], monitors: [{ id: 'low', binding: 'k.revenue', when: { kind: 'threshold', op: '<', value: 100 }, label: 'Low revenue' }] }]);
    const after = app([
      { id: 'daily', cron: '0 9 * * *', dashboard: 'overview', deliver: [{ kind: 'webhook', url: 'https://x.test' }], monitors: [{ id: 'swing', binding: 'k.revenue', when: { kind: 'change', direction: 'down', percent: 20 } }] },
      { id: 'weekly', cron: '0 8 * * 1', dashboard: 'overview', deliver: [] },
    ]);
    expect(diffAppDeliveries(before, after)).toEqual([
      'Schedule "daily" now runs on 0 9 * * * (was 0 8 * * *).',
      'Schedule "daily" delivers to different targets.',
      'Alert "swing" added on k.revenue.',
      'Alert "Low revenue" removed.',
      'Schedule "weekly" added for page overview (0 8 * * 1).',
    ]);
  });

  it('draws the layout before and after with escaped titles', () => {
    const diff = diffDashboardPages(page([tile('a', { title: 'Old <b>' })]), page([tile('a', { title: 'Old <b>', w: 12 }), tile('n', { y: 4, title: 'New tile' })]));
    const svg = renderLayoutDiffSvg(diff, 880);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Old &lt;b&gt;');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('stroke="#0b7a75"'); // the added tile
    expect(svg).toContain('stroke="#b26b1f"'); // the resized tile
  });
});
