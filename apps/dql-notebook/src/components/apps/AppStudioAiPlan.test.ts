import { describe, expect, it } from 'vitest';
import type { AppBlockRecommendation, AppStudioAiProposal } from '../../api/client';
import { availableAppStudioProposalSources, operationsForSelectedAppStudioSources, summarizeAppStudioAiPlan } from './app-studio-ai-plan';

describe('App Studio AI plan review (AGT-025, UI-022)', () => {
  it('shows the exact sources and components that typed proposal operations will apply', () => {
    const proposal = {
      id: 'proposal-1',
      draftId: 'draft-1',
      baseRevision: 0,
      baseProposalHash: 'sha256:base',
      clarifications: [],
      summary: { requirements: 2, covered: 2, gaps: 0, certifiedSources: 1, semanticSources: 1 },
      operations: [
        {
          type: 'set_frame',
          frame: {
            goal: 'Decide whether revenue growth is healthy', audience: 'Finance', metrics: ['revenue'], dimensions: ['month'], filters: [], desiredOutput: 'App',
          },
        },
        {
          type: 'upsert_source',
          source: {
            id: 'block:monthly-revenue',
            kind: 'certified_block',
            sourceRef: 'monthly_revenue',
            trustState: 'certified',
            reviewStatus: 'not_required',
          },
        },
        {
          type: 'upsert_source',
          source: {
            id: 'semantic:orders',
            kind: 'governed_semantic',
            sourceRef: 'orders',
            trustState: 'review_required',
            reviewStatus: 'required',
          },
        },
        {
          type: 'upsert_page',
          page: {
            version: 2,
            id: 'overview',
            metadata: { title: 'Revenue overview', visibility: 'private', lifecycle: 'draft' },
            layout: {
              kind: 'grid', cols: 12, rowHeight: 80,
              items: [
                { i: 'revenue-trend', x: 0, y: 0, w: 8, h: 4, title: 'Monthly revenue', viz: { type: 'line' }, block: { blockId: 'monthly-revenue' } },
                { i: 'order-detail', x: 8, y: 0, w: 4, h: 4, title: 'Order detail', viz: { type: 'table' }, semantic: { id: 'orders', metricId: 'order_count' } },
              ],
            },
          },
        },
      ],
    } as AppStudioAiProposal;

    expect(summarizeAppStudioAiPlan(proposal)).toEqual({
      frame: {
        goal: 'Decide whether revenue growth is healthy', audience: 'Finance', metrics: ['revenue'], dimensions: ['month'], filters: [], desiredOutput: 'App',
      },
      pages: [{ id: 'overview', title: 'Revenue overview' }],
      sources: [
        { id: 'block:monthly-revenue', label: 'Monthly Revenue', sourceRef: 'monthly_revenue', kind: 'certified_block', trustState: 'certified', reviewStatus: 'not_required', componentIds: ['revenue-trend'] },
        { id: 'semantic:orders', label: 'Orders', sourceRef: 'orders', kind: 'governed_semantic', trustState: 'review_required', reviewStatus: 'required', componentIds: ['order-detail'] },
      ],
      components: [
        { id: 'revenue-trend', title: 'Monthly revenue', visualization: 'Line', source: 'monthly-revenue', sourceId: 'block:monthly-revenue' },
        { id: 'order-detail', title: 'Order detail', visualization: 'Table', source: 'orders', sourceId: 'semantic:orders' },
      ],
    });
  });

  it('applies only the sources and components a user selected during review', () => {
    const proposal = {
      id: 'proposal-2', draftId: 'draft-1', baseRevision: 0, baseProposalHash: 'sha256:base', clarifications: [],
      summary: { requirements: 2, covered: 2, gaps: 0, certifiedSources: 1, semanticSources: 1 },
      operations: [
        { type: 'set_requirements', requirements: [], coverage: [
          { requirementId: 'trend', status: 'covered', sourceIds: ['block:monthly-revenue'], componentIds: ['revenue-trend'], reasons: [] },
          { requirementId: 'detail', status: 'covered', sourceIds: ['semantic:orders'], componentIds: ['order-detail'], reasons: [] },
        ] },
        { type: 'upsert_source', source: { id: 'block:monthly-revenue', kind: 'certified_block', sourceRef: 'monthly-revenue', trustState: 'certified', reviewStatus: 'not_required' } },
        { type: 'upsert_source', source: { id: 'semantic:orders', kind: 'governed_semantic', sourceRef: 'orders', trustState: 'review_required', reviewStatus: 'required' } },
        { type: 'upsert_page', page: {
          version: 2, id: 'overview', metadata: { title: 'Revenue overview', visibility: 'private', lifecycle: 'draft' },
          layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
            { i: 'intro', x: 0, y: 0, w: 12, h: 1, viz: { type: 'text' }, text: { markdown: 'Revenue health' } },
            { i: 'revenue-trend', x: 0, y: 1, w: 8, h: 4, viz: { type: 'line' }, block: { blockId: 'monthly-revenue' } },
            { i: 'order-detail', x: 8, y: 1, w: 4, h: 4, viz: { type: 'table' }, semantic: { id: 'orders', metricId: 'order_count' } },
          ], responsive: { narrow: { kind: 'grid', cols: 1, rowHeight: 80, items: [
            { i: 'intro', x: 0, y: 0, w: 1, h: 1, viz: { type: 'text' }, text: { markdown: 'Revenue health' } },
            { i: 'revenue-trend', x: 0, y: 1, w: 1, h: 4, viz: { type: 'line' }, block: { blockId: 'monthly-revenue' } },
            { i: 'order-detail', x: 0, y: 5, w: 1, h: 4, viz: { type: 'table' }, semantic: { id: 'orders', metricId: 'order_count' } },
          ] } } },
        } },
      ],
    } as AppStudioAiProposal;

    const operations = operationsForSelectedAppStudioSources(proposal, new Set(['block:monthly-revenue']));
    expect(operations.filter((operation) => operation.type === 'upsert_source')).toHaveLength(1);
    const page = operations.find((operation) => operation.type === 'upsert_page');
    expect(page?.type === 'upsert_page' ? page.page.layout.items.map((item) => item.i) : []).toEqual(['intro', 'revenue-trend']);
    expect(page?.type === 'upsert_page' ? page.page.layout.responsive?.narrow?.items.map((item) => item.i) : []).toEqual(['intro', 'revenue-trend']);
    const requirements = operations.find((operation) => operation.type === 'set_requirements');
    expect(requirements?.type === 'set_requirements' ? requirements.coverage?.[1] : undefined).toMatchObject({
      status: 'gap', sourceIds: [], componentIds: [], reasons: ['The proposed source was excluded during App review.'],
    });
  });

  it('keeps additional governed source discovery in the review and excludes duplicate proposals', () => {
    const summary = {
      pages: [], components: [], frame: undefined,
      sources: [{
        id: 'block:monthly-revenue', label: 'Monthly Revenue', sourceRef: 'monthly_revenue',
        kind: 'certified_block' as const, trustState: 'certified' as const, reviewStatus: 'not_required' as const, componentIds: [],
      }],
    };
    const catalog = [
      { id: 'monthly_revenue', name: 'Monthly Revenue', domain: 'commerce', tags: ['revenue'], path: 'blocks/monthly_revenue.dql', description: 'Revenue over time' },
      { id: 'customer_profile', name: 'Customer Profile', domain: 'commerce', tags: ['customer'], path: 'blocks/customer_profile.dql', description: 'Customer detail' },
    ].map((source) => ({ ...source, status: 'certified', owner: null, fingerprint: 'sha256:test', lastModified: '', score: 1, reasons: [] })) as AppBlockRecommendation[];

    expect(availableAppStudioProposalSources(summary, catalog, '')).toHaveLength(1);
    expect(availableAppStudioProposalSources(summary, catalog, 'customer').map((source) => source.id)).toEqual(['customer_profile']);
    expect(availableAppStudioProposalSources(summary, catalog, 'revenue')).toEqual([]);
  });

  it('keeps a selected review block bound to its canonical source id', () => {
    const proposal = {
      id: 'proposal-review', draftId: 'draft-1', baseRevision: 0, baseProposalHash: 'sha256:base', clarifications: [],
      summary: { requirements: 1, covered: 1, gaps: 0, certifiedSources: 0, semanticSources: 0 },
      operations: [
        { type: 'upsert_source', source: {
          id: 'review-block:orders-by-region', kind: 'review_block', sourceRef: 'orders-by-region',
          trustState: 'review_required', reviewStatus: 'required',
        } },
        { type: 'upsert_page', page: {
          version: 2, id: 'overview', metadata: { title: 'Orders', visibility: 'private', lifecycle: 'draft' },
          layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
            { i: 'orders', x: 0, y: 0, w: 6, h: 4, viz: { type: 'bar' }, block: { blockId: 'orders-by-region' } },
          ] },
        } },
      ],
    } as AppStudioAiProposal;

    expect(summarizeAppStudioAiPlan(proposal).components[0]?.sourceId).toBe('review-block:orders-by-region');
    const operations = operationsForSelectedAppStudioSources(proposal, new Set(['review-block:orders-by-region']));
    const page = operations.find((operation) => operation.type === 'upsert_page');
    expect(page?.type === 'upsert_page' ? page.page.layout.items.map((item) => item.i) : []).toEqual(['orders']);
  });
});
