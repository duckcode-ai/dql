import { describe, expect, it } from 'vitest';
import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../api/client';
import { discoverPageFilterCandidates } from './app-studio-filter-candidates';

describe('App Studio filter discovery (UI-022)', () => {
  it('derives candidates from every governed source already used on the page', () => {
    const page = {
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          { i: 'revenue-chart', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
          { i: 'revenue-table', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'table' } },
          { i: 'orders', x: 0, y: 4, w: 6, h: 4, block: { blockId: 'orders' }, viz: { type: 'bar' } },
        ],
      },
    } as AppStudioBuildDraft['pages'][number];
    const catalog = [
      { id: 'monthly_revenue', name: 'Monthly revenue', filterIds: ['order_date', 'customer_segment'] },
      { id: 'orders', name: 'Orders', filterIds: ['order_date', 'status'] },
    ] as AppBlockRecommendation[];

    expect(discoverPageFilterCandidates(page, catalog)).toEqual([
      { id: 'customer_segment', sourceNames: ['Monthly revenue'], affectedTileCount: 2 },
      { id: 'order_date', sourceNames: ['Monthly revenue', 'Orders'], affectedTileCount: 3 },
      { id: 'status', sourceNames: ['Orders'], affectedTileCount: 1 },
    ]);
  });
});
