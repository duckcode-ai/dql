import { describe, expect, it } from 'vitest';
import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../api/client';
import { defaultStudioFilterType, discoverAppFilterCandidates, discoverPageFilterCandidates, filterTileMappingsForField } from './app-studio-filter-candidates';

describe('App Studio filter discovery (UI-022)', () => {
  it('infers warehouse timestamp columns as date range controls', () => {
    expect(defaultStudioFilterType('first_ordered_at')).toBe('daterange');
    expect(defaultStudioFilterType('created_on')).toBe('daterange');
    expect(defaultStudioFilterType('customer_name')).toBe('select');
  });

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
      { id: 'customer_segment', sourceNames: ['Monthly revenue'], affectedTileCount: 2, pageCount: 1 },
      { id: 'order_date', sourceNames: ['Monthly revenue', 'Orders'], affectedTileCount: 3, pageCount: 1 },
      { id: 'status', sourceNames: ['Orders'], affectedTileCount: 1, pageCount: 1 },
    ]);
  });

  it('discovers governed semantic dimensions and explains incompatible components across pages', () => {
    const pages = [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          { i: 'revenue', title: 'Revenue', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
          {
            i: 'segments', title: 'Segments', x: 6, y: 0, w: 6, h: 4,
            semantic: {
              id: 'segment_metrics', provider: 'metricflow', metrics: ['revenue'], dimensions: ['customer_segment'],
              semanticModelRefs: ['orders'], definitionFingerprint: 'sha256:semantic',
            },
            viz: { type: 'bar' },
          },
        ],
      },
    }, {
      version: 2,
      id: 'detail',
      metadata: { title: 'Detail' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{ i: 'orders', title: 'Orders', x: 0, y: 0, w: 12, h: 4, block: { blockId: 'orders' }, viz: { type: 'table' } }],
      },
    }] as AppStudioBuildDraft['pages'];
    const catalog = [
      { id: 'monthly_revenue', name: 'Monthly revenue', filterIds: ['order_date', 'customer_segment'] },
      { id: 'orders', name: 'Orders', filterIds: ['order_date'] },
    ] as AppBlockRecommendation[];

    expect(discoverAppFilterCandidates(pages, catalog)).toContainEqual({
      id: 'customer_segment',
      sourceNames: ['Monthly revenue', 'segment_metrics'],
      affectedTileCount: 2,
      pageCount: 1,
    });
    expect(discoverAppFilterCandidates(pages, catalog)).toContainEqual({
      id: 'order_date',
      sourceNames: ['Monthly revenue', 'Orders'],
      affectedTileCount: 2,
      pageCount: 2,
    });

    expect(filterTileMappingsForField(pages, catalog, 'customer_segment')).toEqual([
      expect.objectContaining({ key: 'overview:revenue', supported: true, mode: 'predicate' }),
      expect.objectContaining({ key: 'overview:segments', supported: true, mode: 'semantic' }),
      expect.objectContaining({ key: 'detail:orders', supported: false, reason: expect.stringContaining('not exposed') }),
    ]);
  });

  it('offers only server-approved settled result columns as filter bindings', () => {
    const pages = [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{ i: 'trend', title: 'Revenue trend', x: 0, y: 0, w: 12, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } }],
      },
    }] as AppStudioBuildDraft['pages'];
    const catalog = [{ id: 'monthly_revenue', name: 'Monthly revenue', filterIds: [] }] as unknown as AppBlockRecommendation[];
    const runtimeFields = {
      overview: {
        trend: [{ column: 'month', predicateTarget: 'orders.order_date' }],
      },
    };

    expect(discoverAppFilterCandidates(pages, catalog, runtimeFields)).toEqual([{
      id: 'month',
      sourceNames: ['Monthly revenue'],
      affectedTileCount: 1,
      pageCount: 1,
    }]);
    expect(filterTileMappingsForField(pages, catalog, 'month', runtimeFields)).toEqual([
      expect.objectContaining({ supported: true, binding: 'month', mode: 'predicate' }),
    ]);
  });

  it('offers certified block dimensions even when the block has no parameter filters', () => {
    const pages = [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          { i: 'trend', title: 'Revenue trend', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
          { i: 'table', title: 'Revenue table', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'table' } },
        ],
      },
    }] as AppStudioBuildDraft['pages'];
    const catalog = [{
      id: 'monthly_revenue', name: 'Monthly revenue', filterIds: [], dimensionIds: ['month'],
    }] as unknown as AppBlockRecommendation[];

    expect(discoverAppFilterCandidates(pages, catalog)).toEqual([{
      id: 'month',
      sourceNames: ['Monthly revenue'],
      affectedTileCount: 2,
      pageCount: 1,
    }]);
  });

  it('restores filter capabilities from canonical draft bindings when the source is off-page', () => {
    const pages = [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'orders', title: 'Orders by region', x: 0, y: 0, w: 6, h: 4,
          sourceId: 'app:block:sales:orders', sourceRevision: 'sha256:orders',
          block: { ref: 'blocks/sales/orders.dql' }, viz: { type: 'bar' },
        }],
      },
    }] as AppStudioBuildDraft['pages'];
    const boundSources = [{
      id: 'app:block:sales:orders', kind: 'block', sourceRef: 'blocks/sales/orders.dql',
      sourceRevision: 'sha256:orders', sourceFingerprint: 'sha256:orders', lifecycle: 'draft',
      qualifiedIdentity: 'sales::block::Orders by Region', trustState: 'review_required', reviewStatus: 'required',
      capabilities: {
        measures: ['orders'], dimensions: ['region'], outputs: ['orders', 'region'],
        filters: ['order_date'], allowedVisualizations: ['bar'], parameters: [],
      },
    }] as AppStudioBuildDraft['sources'];

    expect(discoverAppFilterCandidates(pages, [], {}, boundSources)).toEqual([
      { id: 'order_date', sourceNames: ['sales::block::Orders by Region'], affectedTileCount: 1, pageCount: 1 },
      { id: 'region', sourceNames: ['sales::block::Orders by Region'], affectedTileCount: 1, pageCount: 1 },
    ]);
  });
});
