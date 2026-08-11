import { describe, expect, it } from 'vitest';
import { applyAppBuildDraftOperations, createAppBuildDraft, packDashboardLayoutItems } from './app-build-draft.js';

describe('AppBuildDraft', () => {
  it('uses one revisioned contract for manual and AI authoring', () => {
    const draft = createAppBuildDraft({
      id: 'build-1', appId: 'revenue-app', authoringMode: 'manual', now: '2026-08-08T00:00:00.000Z',
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
    });
    const next = applyAppBuildDraftOperations(draft, 1, [{ type: 'set_source_policy', sourcePolicy: 'include_review_required' }], '2026-08-08T00:01:00.000Z');
    expect(next.version).toBe(3);
    expect(next.state).toBe('local_draft');
    expect(next.revision).toBe(2);
    expect(next.sourcePolicy).toBe('include_review_required');
    expect(next.proposalHash).not.toBe(draft.proposalHash);
  });

  it('rejects stale mutations', () => {
    const draft = createAppBuildDraft({
      id: 'build-1', appId: 'revenue-app', authoringMode: 'ai',
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
    });
    expect(() => applyAppBuildDraftOperations(draft, 0, [])).toThrow(/APP_BUILD_REVISION_CONFLICT/);
  });

  it('requires explicit review-required source policy for exploratory SQL', () => {
    expect(() => createAppBuildDraft({
      id: 'build-1', appId: 'revenue-app', authoringMode: 'manual',
      frame: { goal: 'Investigate revenue', metrics: ['revenue'], dimensions: [], filters: [] },
      sources: [{
        id: 'draft-1', kind: 'exploratory_sql', sourceRef: 'drafts/revenue.dql',
        trustState: 'review_required', reviewStatus: 'required',
      }],
    })).toThrow(/include_review_required/);
  });

  it('invalidates preview and preflight receipts after a content edit', () => {
    const draft = createAppBuildDraft({
      id: 'build-4', appId: 'revenue-app', authoringMode: 'manual',
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
    });
    const withReceipt = {
      ...draft,
      previewReceipt: {
        id: 'run-1', pageId: 'overview', revision: 1, snapshotId: 'snapshot-1', filterFingerprint: 'filter-1',
        resultFingerprint: 'result-1', createdAt: '2026-08-08T00:00:00.000Z',
      },
      preflightReceipt: {
        id: 'preflight-1', revision: 1, proposalHash: draft.proposalHash,
        sourceFingerprint: 'sources-1', createdAt: '2026-08-08T00:00:00.000Z',
      },
    };
    const next = applyAppBuildDraftOperations(withReceipt, 1, [{ type: 'set_name', name: 'Revenue health' }]);
    expect(next.name).toBe('Revenue health');
    expect(next.previewReceipt).toBeUndefined();
    expect(next.preflightReceipt).toBeUndefined();
  });

  it('records page-specific settled runs without changing the content revision', () => {
    const draft = createAppBuildDraft({
      id: 'build-5', appId: 'operations-app', authoringMode: 'manual',
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: [] },
    });
    const first = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-overview', pageId: 'overview', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f1', resultFingerprint: 'r1', createdAt: '2026-08-08T00:00:00.000Z' },
    }]);
    const second = applyAppBuildDraftOperations(first, first.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-detail', pageId: 'detail', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f2', resultFingerprint: 'r2', createdAt: '2026-08-08T00:01:00.000Z' },
    }]);
    expect(second.revision).toBe(draft.revision);
    expect(second.proposalHash).toBe(draft.proposalHash);
    expect(second.previewReceipts?.map((receipt) => receipt.pageId)).toEqual(['overview', 'detail']);
  });

  it('preserves a settled page result when only layout geometry changes (API-013, UI-022)', () => {
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid' as const,
        cols: 12,
        rowHeight: 80,
        items: [
          { i: 'revenue', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' as const } },
          { i: 'orders', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'monthly_orders' }, viz: { type: 'bar' as const } },
        ],
      },
    };
    const draft = createAppBuildDraft({
      id: 'build-layout-receipt', appId: 'operations-app', authoringMode: 'manual', pages: [page],
      frame: { goal: 'Monitor operations', metrics: ['revenue'], dimensions: ['month'], filters: [] },
    });
    const withReceipt = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f1', resultFingerprint: 'r1', createdAt: '2026-08-08T00:00:00.000Z' },
    }]);
    const arranged = applyAppBuildDraftOperations(withReceipt, withReceipt.revision, [{
      type: 'set_layout',
      pageId: 'overview',
      layout: {
        ...page.layout,
        items: [
          { ...page.layout.items[1], x: 0, y: 0 },
          { ...page.layout.items[0], x: 6, y: 0 },
        ],
      },
    }]);

    expect(arranged.revision).toBe(withReceipt.revision + 1);
    expect(arranged.previewReceipts?.[0]).toMatchObject({ id: 'run-1', pageId: 'overview', revision: arranged.revision });
    expect(arranged.previewReceipt).toMatchObject({ id: 'run-1', revision: arranged.revision });
    expect(arranged.preflightReceipt).toBeUndefined();
  });

  it('invalidates settled results when a filter contract changes (API-013)', () => {
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: { kind: 'grid' as const, cols: 12, rowHeight: 80, items: [] },
    };
    const draft = createAppBuildDraft({
      id: 'build-filter-receipt', appId: 'operations-app', authoringMode: 'manual', pages: [page],
      frame: { goal: 'Monitor operations', metrics: [], dimensions: [], filters: [] },
    });
    const withReceipt = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'set_preview_receipt',
      receipt: { id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 's1', filterFingerprint: 'f1', resultFingerprint: 'r1', createdAt: '2026-08-08T00:00:00.000Z' },
    }]);
    const filtered = applyAppBuildDraftOperations(withReceipt, withReceipt.revision, [{
      type: 'set_filter', pageId: 'overview', filter: { id: 'order_date', type: 'daterange', bindsTo: 'order_date' },
    }]);

    expect(filtered.previewReceipts).toBeUndefined();
    expect(filtered.previewReceipt).toBeUndefined();
  });

  it('keeps AI drafts in clarification state until required choices are answered', () => {
    const draft = createAppBuildDraft({
      id: 'build-5', appId: 'revenue-app', authoringMode: 'ai',
      frame: {
        goal: 'Build a revenue app', metrics: [], dimensions: [], filters: [],
        clarificationQuestions: [{
          id: 'metric', question: 'Which metric?', required: true,
          choices: [{ id: 'gross-revenue', label: 'Gross revenue' }],
        }],
      },
    });
    expect(draft.state).toBe('clarification_required');
    const next = applyAppBuildDraftOperations(draft, 1, [{
      type: 'set_frame',
      frame: {
        ...draft.frame,
        metrics: ['gross_revenue'],
        clarificationQuestions: [{
          ...draft.frame.clarificationQuestions![0],
          answerId: 'gross-revenue',
        }],
      },
    }]);
    expect(next.state).toBe('local_draft');
  });

  it('reconciles coverage when a source-bound tile is removed', () => {
    const source = {
      id: 'app:block:sales:revenue',
      kind: 'block' as const,
      sourceRef: 'blocks/sales/revenue.dql',
      sourceRevision: 'sha256:revenue',
      sourceFingerprint: 'sha256:revenue',
      lifecycle: 'certified' as const,
      trustState: 'certified' as const,
      reviewStatus: 'not_required' as const,
    };
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid' as const,
        cols: 12,
        rowHeight: 80,
        items: [{
          i: 'revenue-trend', x: 0, y: 0, w: 6, h: 4,
          sourceId: source.id, sourceRevision: source.sourceRevision,
          block: { ref: source.sourceRef }, viz: { type: 'line' as const },
        }],
      },
    };
    const draft = createAppBuildDraft({
      id: 'build-coverage', appId: 'sales-app', authoringMode: 'ai', sources: [source], pages: [page],
      frame: { goal: 'Monitor revenue', metrics: ['revenue'], dimensions: [], filters: [] },
      requirements: [{ id: 'revenue', question: 'Revenue trend', role: 'trend', required: true, measures: ['revenue'], dimensions: [], filters: [] }],
      coverage: [{ requirementId: 'revenue', status: 'covered', sourceIds: [source.id], componentIds: ['revenue-trend'], reasons: ['Covered.'] }],
    });

    const withoutTile = applyAppBuildDraftOperations(draft, draft.revision, [
      { type: 'remove_tile', pageId: 'overview', tileId: 'revenue-trend' },
    ]);
    expect(withoutTile.coverage).toEqual([
      expect.objectContaining({ requirementId: 'revenue', status: 'gap', sourceIds: [source.id], componentIds: [] }),
    ]);
    const withoutSource = applyAppBuildDraftOperations(withoutTile, withoutTile.revision, [
      { type: 'remove_source', sourceId: source.id },
    ]);
    expect(withoutSource.coverage).toEqual([
      expect.objectContaining({ requirementId: 'revenue', status: 'gap', sourceIds: [], componentIds: [] }),
    ]);
  });

  it('packs invalid and overlapping App Studio geometry into a stable reading order', () => {
    const packed = packDashboardLayoutItems([
      { i: 'kpi', x: 0, y: 0, w: 3, h: 2, viz: { type: 'single_value' } },
      { i: 'chart', x: 6, y: 0, w: 12, h: 4, viz: { type: 'bar' } },
      { i: 'detail', x: 0, y: 20, w: 6, h: 3, viz: { type: 'table' } },
    ], 12);

    expect(packed.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))).toEqual([
      { i: 'kpi', x: 0, y: 0, w: 3, h: 2 },
      { i: 'chart', x: 0, y: 2, w: 12, h: 4 },
      { i: 'detail', x: 0, y: 6, w: 6, h: 3 },
    ]);
  });

  it('normalizes wide, medium, and narrow layouts on the next explicit edit', () => {
    const page = {
      version: 2 as const,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid' as const,
        cols: 12,
        rowHeight: 80,
        items: [
          { i: 'kpi', x: 0, y: 0, w: 3, h: 2, viz: { type: 'single_value' as const } },
          { i: 'chart', x: 6, y: 0, w: 12, h: 4, viz: { type: 'bar' as const } },
        ],
      },
    };
    const draft = createAppBuildDraft({
      id: 'build-layout', appId: 'layout-app', authoringMode: 'manual', pages: [page],
      frame: { goal: 'Arrange the app', metrics: [], dimensions: [], filters: [] },
    });
    const next = applyAppBuildDraftOperations(draft, draft.revision, [{
      type: 'update_tile', pageId: 'overview', tileId: 'chart', patch: { title: 'Revenue trend' },
    }]);

    expect(next.pages[0].layout.items[1]).toMatchObject({ i: 'chart', x: 0, y: 2, w: 12 });
    expect(next.pages[0].layout.responsive?.medium.items[1]).toMatchObject({ i: 'chart', x: 0, y: 2, w: 6 });
    expect(next.pages[0].layout.responsive?.narrow.items[1]).toMatchObject({ i: 'chart', x: 0, y: 2, w: 1 });
  });
});
