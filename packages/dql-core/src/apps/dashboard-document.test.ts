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
              { param: 'season_year', source: 'dashboard_filter', filter: 'season' },
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
      parameterBindings: [{ param: 'season_year', source: 'dashboard_filter', filter: 'season' }],
      sourceEvidence: [{ source: 'block:top_scorers', reason: 'Certified scorer ranking block.', kind: 'block', trustState: 'certified' }],
      trustState: 'certified',
      reviewStatus: 'certified',
    });
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
    expect(errors[0].message).toMatch(/block must be \{ blockId \} or \{ ref \}/);
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
