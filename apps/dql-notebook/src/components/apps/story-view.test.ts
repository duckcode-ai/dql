import { describe, expect, it } from 'vitest';
import { storyEditionSummary } from './StoryView';

const edition = (runId: string, createdAt: string, resultFingerprint: string, revenue: string, filterFingerprint = 'f') => ({
  runId, createdAt, resultFingerprint, filterFingerprint,
  values: { 'kpi.revenue': { display: revenue, value: Number(revenue.replace(/\D/g, '')), label: 'Revenue' } },
});
const catalog = { 'kpi.revenue': { key: 'kpi.revenue', tileId: 'kpi', label: 'Revenue', kind: 'number' as const, value: 130, display: '$130' } };
// edition() stores the number from its display text, as the server would.

describe('story editions (RFC 0008 step 8)', () => {
  it('shows what changed since the previous edition in the same filter scope', () => {
    const editions = [
      edition('r3', '2026-09-24T10:00:00Z', 'fp3', '$130'),
      edition('r2', '2026-09-20T10:00:00Z', 'fp2', '$118'),
      edition('rx', '2026-09-22T10:00:00Z', 'fpx', '$90', 'other-filters'),
    ];
    const summary = storyEditionSummary(editions, { runId: 'r3', resultFingerprint: 'fp3', filterFingerprint: 'f' }, catalog);
    expect(summary.current?.runId).toBe('r3');
    expect(summary.previous?.runId).toBe('r2');
    expect(summary.changes).toEqual([{ key: 'kpi.revenue', label: 'Revenue', before: '$118', after: '$130' }]);
    // Same value printed differently is not a change.
    const reformatted = storyEditionSummary(editions, { runId: 'r3', resultFingerprint: 'fp3', filterFingerprint: 'f' }, { 'kpi.revenue': { ...catalog['kpi.revenue'], value: 118, display: '$118.00' } });
    expect(reformatted.changes).toEqual([]);
  });

  it('treats an unchanged rerun as the same edition and a lone edition as the first', () => {
    const editions = [edition('r1', '2026-09-20T10:00:00Z', 'fp1', '$130')];
    // A different result fingerprint with the same values is still that edition.
    const summary = storyEditionSummary(editions, { runId: 'r9', resultFingerprint: 'fp-other', filterFingerprint: 'f' }, catalog);
    expect(summary.current?.runId).toBe('r1');
    expect(summary.previous).toBeUndefined();
    expect(summary.changes).toEqual([]);
    expect(storyEditionSummary([], null, catalog)).toEqual({ changes: [] });
  });
});
