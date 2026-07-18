import { describe, it, expect } from 'vitest';
import {
  parseDashboardDocument,
  extractDashboardBlockRefs,
  isBlockIdRef,
  type DashboardDocument,
} from './dashboard-document.js';

const minimal: DashboardDocument = {
  version: 1,
  id: 'weekly-overview',
  metadata: { title: 'Weekly Overview' },
  layout: {
    kind: 'grid',
    cols: 12,
    rowHeight: 80,
    items: [
      {
        i: 'kpi',
        x: 0, y: 0, w: 3, h: 2,
        block: { blockId: 'revenue_total' },
        viz: { type: 'single_value' },
      },
      {
        i: 'trend',
        x: 3, y: 0, w: 9, h: 4,
        block: { ref: 'blocks/revenue_trend.dql' },
        viz: { type: 'line' },
      },
    ],
  },
};

describe('parseDashboardDocument', () => {
  it('parses both blockId and ref forms', () => {
    const { document, errors } = parseDashboardDocument(JSON.stringify(minimal));
    expect(errors).toEqual([]);
    expect(document?.layout.items).toHaveLength(2);
    // Docs without sections stay section-free (old dashboards unaffected).
    expect(document?.sections).toBeUndefined();
    expect(document?.layout.items.every((item) => item.sectionId === undefined)).toBe(true);
  });

  it('round-trips story sections and tile section membership', () => {
    const story: DashboardDocument = {
      ...minimal,
      sections: [
        { id: 'exec_summary', title: 'Executive summary', kind: 'exec_summary', narrative: 'Revenue is up 12%.', order: 0 },
        { id: 'kpi_band', title: 'Key metrics', kind: 'kpi_band', order: 1 },
        { id: 'appendix', title: 'AI-generated analysis — needs review', kind: 'appendix', order: 2 },
      ],
      layout: {
        ...minimal.layout,
        items: minimal.layout.items.map((item, index) => ({
          ...item,
          sectionId: index === 0 ? 'kpi_band' : 'appendix',
        })),
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(story));
    expect(errors).toEqual([]);
    expect(document?.sections).toHaveLength(3);
    expect(document?.sections?.[0]).toMatchObject({ id: 'exec_summary', kind: 'exec_summary', narrative: 'Revenue is up 12%.', order: 0 });
    expect(document?.layout.items[0]?.sectionId).toBe('kpi_band');
    expect(document?.layout.items[1]?.sectionId).toBe('appendix');
    // Full round-trip: serialize the parsed doc and parse again.
    const again = parseDashboardDocument(JSON.stringify(document));
    expect(again.errors).toEqual([]);
    expect(again.document?.sections).toEqual(document?.sections);
  });

  it('skips malformed sections instead of failing the dashboard', () => {
    const messy = {
      ...minimal,
      sections: [
        { id: 'ok', title: 'Fine', kind: 'insight', order: 0 },
        { id: '', title: 'missing id', kind: 'insight' },
        { id: 'bad-kind', title: 'nope', kind: 'hero' },
        'not-an-object',
      ],
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(messy));
    expect(errors).toEqual([]);
    expect(document?.sections).toHaveLength(1);
    expect(document?.sections?.[0]?.id).toBe('ok');
  });

  it('parses OSS metadata and notebook-style chart options', () => {
    const doc = {
      ...minimal,
      metadata: {
        title: 'Weekly Overview',
        domain: 'cards',
        subdomain: 'fraud',
        groups: ['daily-ops'],
        audience: 'ops',
        visibility: 'shared',
        lifecycle: 'review',
      },
      layout: {
        ...minimal.layout,
        items: [
          {
            i: 'scatter',
            x: 0, y: 0, w: 6, h: 3,
            block: { blockId: 'fraud_points' },
            viz: { type: 'scatter', options: { chart: 'scatter', x: 'risk_score', y: 'amount', color: 'merchant' } },
          },
        ],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));
    expect(errors).toEqual([]);
    expect(document?.metadata.subdomain).toBe('fraud');
    expect(document?.metadata.groups).toEqual(['daily-ops']);
    expect(document?.layout.items[0].viz.options?.chart).toBe('scatter');
  });

  it('preserves Sankey source, target, and value bindings', () => {
    const doc = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'supply-flow',
          x: 0, y: 0, w: 8, h: 4,
          block: { blockId: 'supply_flow' },
          viz: { type: 'sankey', options: { chart: 'sankey', x: 'source', color: 'target', y: 'amount' } },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));
    expect(errors).toEqual([]);
    expect(document?.layout.items[0].viz).toMatchObject({
      type: 'sankey',
      options: { chart: 'sankey', x: 'source', color: 'target', y: 'amount' },
    });
  });

  it('parses governed display metadata on dashboard tiles', () => {
    const doc = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [
          {
            i: 'ranking',
            x: 0, y: 0, w: 8, h: 4,
            block: { blockId: 'top_scorers' },
            viz: { type: 'bar' },
            display: {
              mode: 'block_hint',
              component: 'RankingPanel',
              defaultVisualization: 'bar',
              allowedVisualizations: ['bar', 'table'],
              fieldHints: { label: 'player_name', value: 'total_points' },
              layoutIntent: 'wide',
              rationale: 'Consumer surface uses ranking view for NBA analysis.',
              trustState: 'certified',
              reviewStatus: 'certified',
            },
          },
        ],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));
    expect(errors).toEqual([]);
    expect(document?.layout.items[0].display).toMatchObject({
      component: 'RankingPanel',
      allowedVisualizations: ['bar', 'table'],
      fieldHints: { label: 'player_name', value: 'total_points' },
    });
  });

  it('preserves app filter, parameter, evidence, and trust metadata on tiles', () => {
    const doc = {
      ...minimal,
      filters: [{ id: 'season', type: 'select', options: ['2016', '2017'], bindsTo: 'game_date_est' }],
      layout: {
        ...minimal.layout,
        items: [
          {
            i: 'scorers',
            x: 0, y: 0, w: 8, h: 4,
            block: { blockId: 'top_scorers' },
            viz: { type: 'bar' },
            filterBindings: [
              { filter: 'season', binding: 'game_date_est', mode: 'parameter', paramNames: ['season_year'], required: true },
            ],
            parameterBindings: [
              { param: 'season_year', source: 'dashboard_filter', filter: 'season', parameterType: 'number', required: true, default: 2017, policy: 'dynamic' },
            ],
            sourceEvidence: [
              { source: 'block:top_scorers', reason: 'Certified scorer ranking block.', kind: 'block', trustState: 'certified' },
            ],
            trustState: 'certified',
            reviewStatus: 'certified',
          },
        ],
      },
    };

    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));

    expect(errors).toEqual([]);
    expect(document?.layout.items[0]).toMatchObject({
      filterBindings: [{ filter: 'season', binding: 'game_date_est', mode: 'parameter', paramNames: ['season_year'], required: true }],
      parameterBindings: [{ param: 'season_year', source: 'dashboard_filter', filter: 'season', parameterType: 'number', required: true, default: 2017, policy: 'dynamic' }],
      sourceEvidence: [{ source: 'block:top_scorers', reason: 'Certified scorer ranking block.', kind: 'block', trustState: 'certified' }],
      trustState: 'certified',
      reviewStatus: 'certified',
    });
  });

  it('round-trips governed semantic queries and a runtime story evidence plan', () => {
    const doc = {
      ...minimal,
      story: {
        version: 1,
        goal: 'Explain beverage revenue and its customer drivers.',
        audience: 'Revenue leadership',
        eligibleTileIds: ['beverage-revenue'],
        driverTileIds: ['beverage-revenue'],
      },
      layout: {
        ...minimal.layout,
        items: [{
          i: 'beverage-revenue', x: 0, y: 0, w: 8, h: 4,
          semantic: {
            id: 'beverage-revenue',
            provider: 'metricflow',
            metrics: ['revenue'],
            dimensions: ['customer_name', 'product_category'],
            filters: [{ field: 'product_category', operator: '=', value: 'Beverage' }],
            orderBy: [{ field: 'revenue', direction: 'desc' }],
            limit: 10,
            semanticModelRefs: ['orders'],
            definitionFingerprint: 'sha256:semantic-v1',
            snapshotId: 'snapshot-1',
          },
          viz: { type: 'bar' },
          trustState: 'review_required',
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(doc));
    expect(errors).toEqual([]);
    expect(document?.story).toMatchObject({ goal: 'Explain beverage revenue and its customer drivers.' });
    expect(document?.layout.items[0]?.semantic).toMatchObject({ metrics: ['revenue'], provider: 'metricflow' });
  });

  it('rejects semantic sources without reviewed model references or fingerprints', () => {
    const bad = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'semantic', x: 0, y: 0, w: 8, h: 4,
          semantic: { id: 'semantic', provider: 'native', metrics: ['revenue'], semanticModelRefs: [] },
          viz: { type: 'bar' },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors.map((error) => error.message).join('\n')).toMatch(/semanticModelRefs|definitionFingerprint/);
  });

  it('errors on unknown viz type', () => {
    const bad = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'x', x: 0, y: 0, w: 1, h: 1,
          block: { blockId: 'z' },
          viz: { type: 'spaghetti' },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/viz\.type must be in/);
  });

  it('errors when block ref is missing', () => {
    const bad = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'x', x: 0, y: 0, w: 1, h: 1,
          block: {},
          viz: { type: 'line' },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/must have a block, semantic, text, or aiPin source/);
  });

  it('rejects non-grid layouts (single supported kind today)', () => {
    const bad = {
      ...minimal,
      layout: { ...minimal.layout, kind: 'flex' },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/layout\.kind must be "grid"/);
  });
});

describe('extractDashboardBlockRefs', () => {
  it('separates id refs from path refs', () => {
    const refs = extractDashboardBlockRefs(minimal);
    expect(refs.byId).toEqual(['revenue_total']);
    expect(refs.byPath).toEqual(['blocks/revenue_trend.dql']);
  });
});

describe('isBlockIdRef', () => {
  it('recognises by-id refs', () => {
    expect(isBlockIdRef({ blockId: 'foo' })).toBe(true);
    expect(isBlockIdRef({ ref: 'blocks/foo.dql' })).toBe(false);
  });
});
