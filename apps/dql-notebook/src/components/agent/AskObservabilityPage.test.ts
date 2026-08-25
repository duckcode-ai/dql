import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AskTraceListEntryV1 } from '../../api/client';
import type * as AskObservabilityModule from './AskObservabilityPage';

let askObservabilityQuery: typeof AskObservabilityModule.askObservabilityQuery;
let traceCatalogTitle: typeof AskObservabilityModule.traceCatalogTitle;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/ask/traces' } });
  ({ askObservabilityQuery, traceCatalogTitle } = await import('./AskObservabilityPage'));
});

const trace = (overrides: Partial<AskTraceListEntryV1> = {}): AskTraceListEntryV1 => ({
  version: 1,
  traceId: 'a'.repeat(32),
  rootSpanId: 'b'.repeat(16),
  runId: 'run-local',
  surface: 'browser',
  mode: 'ask',
  questionFingerprint: 'sha256:question',
  status: 'completed',
  recordingStatus: 'complete',
  startedAt: '2026-08-23T12:00:00.000Z',
  spanCount: 4,
  candidateDecisionCount: 2,
  droppedRecordCount: 0,
  detailAvailable: true,
  ...overrides,
});

describe('AskObservabilityPage catalog model (OBS-013)', () => {
  it('filters only receipt-bound fields and preserves a cursor for bounded pagination', () => {
    expect(askObservabilityQuery({
      status: 'blocked',
      mode: 'research',
      selectedTier: 'exploratory_sql',
      trustState: 'review_required',
    }, 'cursor-2')).toEqual({
      limit: 25,
      cursor: 'cursor-2',
      status: 'blocked',
      mode: 'research',
      selectedTier: 'exploratory_sql',
      trustState: 'review_required',
    });
  });

  it('shows only the runtime-joined redacted preview and never manufactures a question from trace evidence', () => {
    expect(traceCatalogTitle(trace({ questionPreview: 'Revenue by customer [REDACTED]' }))).toBe('Revenue by customer [REDACTED]');
    expect(traceCatalogTitle(trace({ scenarioLabel: 'Review-required SQL', questionPreview: undefined }))).toBe('Review-required SQL');
    expect(traceCatalogTitle(trace({ scenarioLabel: undefined, questionPreview: undefined }))).toBe('Ask run run-local');
  });
});
