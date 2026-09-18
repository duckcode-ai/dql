import { describe, expect, it } from 'vitest';
import type { AppStudioBuildDraft, DashboardRunResponse } from '../../api/client';
import { mergeStudioPartialPreview, settleStudioPreviewRun, withoutPagePreviewReceipt } from './app-studio-preview-settlement';

function draftWithPageReceipts(): AppStudioBuildDraft {
  return {
    version: 3,
    id: 'build-mixed-preview',
    appId: 'commerce',
    name: 'Commerce safety',
    revision: 7,
    proposalHash: 'sha256:draft',
    authoringMode: 'manual',
    template: 'operational_dashboard',
    sourcePolicy: 'governed_only',
    state: 'local_draft',
    frame: { goal: 'Check aggregate safety', audience: 'Finance', metrics: [], dimensions: [], filters: [], desiredOutput: 'Operational App' },
    requirements: [],
    coverage: [],
    sources: [],
    pages: [],
    reviewTasks: [],
    previewReceipt: { id: 'run-overview-old', pageId: 'overview', revision: 7, snapshotId: 'snapshot-a', filterFingerprint: 'filter-a', resultFingerprint: 'result-a', createdAt: '2026-09-11T00:00:00.000Z' },
    previewReceipts: [
      { id: 'run-overview-old', pageId: 'overview', revision: 7, snapshotId: 'snapshot-a', filterFingerprint: 'filter-a', resultFingerprint: 'result-a', createdAt: '2026-09-11T00:00:00.000Z' },
      { id: 'run-detail-current', pageId: 'detail', revision: 7, snapshotId: 'snapshot-a', filterFingerprint: 'filter-a', resultFingerprint: 'result-b', createdAt: '2026-09-11T00:00:01.000Z' },
    ],
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  };
}

function mixedAggregateResponse(): DashboardRunResponse {
  return {
    appId: 'build-mixed-preview',
    dashboardId: 'overview',
    persona: null,
    runId: 'app_run_mixed',
    snapshotId: 'snapshot-a',
    filterFingerprint: 'filter-current',
    resultFingerprint: 'result-current',
    personaFingerprint: 'global',
    facts: [],
    story: {
      headline: 'Dashboard preview incomplete',
      paragraphs: ['Two components could not complete.'],
      claims: [],
      evidenceRefs: [],
      trustState: 'draft_ready',
      generatedBy: 'deterministic',
    },
    incomplete: {
      failedTileIds: ['orders', 'average-order-value'],
      message: 'Preview is incomplete: 2 components failed. Safe component results are current, but this page has no current story or Project publication evidence until every component succeeds.',
      priorPreviewReceiptInvalidated: true,
    },
    tiles: [
      { tileId: 'revenue', tileType: 'dataset', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 130 }], rowCount: 1, executionTime: 1 } },
      { tileId: 'margin', tileType: 'dataset', status: 'ok', result: { columns: ['margin'], rows: [{ margin: 67 }], rowCount: 1, executionTime: 1 } },
      { tileId: 'margin-rate', tileType: 'dataset', status: 'ok', result: { columns: ['margin_rate'], rows: [{ margin_rate: 67 / 130 }], rowCount: 1, executionTime: 1 } },
      { tileId: 'orders', tileType: 'dataset', status: 'error', error: 'DATASET_AGGREGATE_COMPONENT_OVERLAP: raw key in more than one native source bucket' },
      { tileId: 'average-order-value', tileType: 'dataset', status: 'error', error: 'DATASET_AGGREGATE_COMPONENT_OVERLAP: raw key in more than one native source bucket' },
    ],
  };
}

describe('Studio mixed Dataset preview settlement', () => {
  it('keeps current safe results and withholds receipt attachment for the actual mixed runtime envelope', () => {
    const response = mixedAggregateResponse();
    expect(settleStudioPreviewRun(response)).toEqual({
      kind: 'incomplete',
      readyCount: 3,
      totalCount: 5,
      message: response.incomplete!.message,
      clearStoredReceipt: true,
    });
    expect(response.tiles.filter((tile) => tile.status === 'ok').map((tile) => tile.result?.rows[0])).toEqual([
      { revenue: 130 }, { margin: 67 }, { margin_rate: 67 / 130 },
    ]);
  });

  it('clears only the server-invalidated page receipt and preserves a different page receipt', () => {
    const next = withoutPagePreviewReceipt(draftWithPageReceipts(), 'overview');
    expect(next.revision).toBe(7);
    expect(next.previewReceipts).toEqual([expect.objectContaining({ id: 'run-detail-current', pageId: 'detail' })]);
    expect(next.previewReceipt).toEqual(expect.objectContaining({ id: 'run-detail-current', pageId: 'detail' }));
  });

  it('does not clear a newer local receipt when the runtime did not confirm the expected receipt clear', () => {
    const response = mixedAggregateResponse();
    response.incomplete = { ...response.incomplete!, priorPreviewReceiptInvalidated: false };
    expect(settleStudioPreviewRun(response)).toMatchObject({ kind: 'incomplete', clearStoredReceipt: false });
    const draft = draftWithPageReceipts();
    expect(withoutPagePreviewReceipt(draft, 'missing-page')).toBe(draft);
  });

  it('keeps unrelated preview rows while an unsaved hierarchy interaction replaces only its bounded tile', () => {
    const previous = {
      appId: 'build-mixed-preview', dashboardId: 'overview', persona: null,
      runId: 'full', snapshotId: 'snapshot-a', filterFingerprint: 'filter-a', resultFingerprint: 'result-a', personaFingerprint: 'global',
      facts: [{ id: 'old-fact', tileId: 'customer-revenue', kind: 'value', label: 'Customer revenue', value: 70, evidenceRef: 'full', trustState: 'certified' }],
      story: { headline: 'Full', paragraphs: [], claims: [], evidenceRefs: [], trustState: 'certified', generatedBy: 'deterministic' },
      filterOptions: [{ filterId: 'region', values: ['CA'], sourceTileIds: ['customer-revenue'] }],
      tiles: [
        { tileId: 'customer-revenue', status: 'ok', tileType: 'dataset', result: { columns: ['customer_id', 'revenue'], rows: [{ customer_id: 'C-001', revenue: 70 }], rowCount: 1, executionTime: 1 } },
        { tileId: 'margin-rate', status: 'ok', tileType: 'dataset', result: { columns: ['margin_rate'], rows: [{ margin_rate: 67 / 130 }], rowCount: 1, executionTime: 1 } },
      ],
    } as any;
    const partial = {
      ...previous,
      runId: 'drill', partial: true, executedTileIds: ['customer-revenue'], facts: [],
      tiles: [{ tileId: 'customer-revenue', status: 'ok', tileType: 'dataset', result: { columns: ['order_id', 'revenue'], rows: [{ order_id: 'O-100', revenue: 60 }], rowCount: 1, executionTime: 1 } }],
    } as any;

    const merged = mergeStudioPartialPreview(previous, partial, [
      { i: 'customer-revenue', x: 0, y: 0, w: 6, h: 4, viz: { type: 'table' } },
      { i: 'margin-rate', x: 6, y: 0, w: 3, h: 2, viz: { type: 'single_value' } },
    ] as any);
    expect(merged.tiles.map((tile) => [tile.tileId, tile.result?.rows[0]])).toEqual([
      ['customer-revenue', { order_id: 'O-100', revenue: 60 }],
      ['margin-rate', { margin_rate: 67 / 130 }],
    ]);
    expect(merged.partial).toBe(true);
    expect(merged.facts).toEqual([]);
    expect(merged.filterOptions).toBeUndefined();
  });
});
