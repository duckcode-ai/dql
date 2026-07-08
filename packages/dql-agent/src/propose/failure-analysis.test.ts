import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeFailureClusters, improvementProposalsFromKg, type FailureSignal } from './failure-analysis.js';
import { KGStore } from '../kg/sqlite-fts.js';
import type { KGNode } from '../kg/types.js';

describe('analyzeFailureClusters (W4.2)', () => {
  it('drafts a review-block proposal from clustered downvotes', () => {
    const signals: FailureSignal[] = [
      { kind: 'downvote', question: 'revenue last week', blockId: 'revenue_total' },
      { kind: 'downvote', question: 'revenue this month', blockId: 'revenue_total' },
      { kind: 'downvote', question: 'churn', blockId: 'churn_logo' },
    ];
    const proposals = analyzeFailureClusters(signals, 2);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'review_block', scopeKey: 'block:revenue_total', signalCount: 2 });
    expect(proposals[0].evidence).toEqual(expect.arrayContaining(['revenue last week', 'revenue this month']));
  });

  it('drafts a consolidate-corrections proposal from corrections sharing a metric scope', () => {
    const signals: FailureSignal[] = [
      { kind: 'correction', question: 'q1', scope: { metric: 'net_revenue' } },
      { kind: 'correction', question: 'q2', scope: { metric: 'net_revenue' } },
    ];
    const proposals = analyzeFailureClusters(signals, 2);
    expect(proposals[0]).toMatchObject({ kind: 'consolidate_corrections', scopeKey: 'metric:net_revenue' });
  });

  it('honors aggregated counts and the minCluster threshold', () => {
    const signals: FailureSignal[] = [
      { kind: 'downvote', question: 'x', blockId: 'b1', count: 5 },
      { kind: 'refusal', question: 'y', scope: { domain: 'growth' } }, // below threshold
    ];
    const proposals = analyzeFailureClusters(signals, 2);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].scopeKey).toBe('block:b1');
    expect(proposals[0].signalCount).toBe(5);
  });

  it('ranks the biggest cluster first', () => {
    const signals: FailureSignal[] = [
      { kind: 'downvote', question: 'a', blockId: 'small', count: 2 },
      { kind: 'downvote', question: 'b', blockId: 'big', count: 9 },
    ];
    const proposals = analyzeFailureClusters(signals, 2);
    expect(proposals.map((p) => p.scopeKey)).toEqual(['block:big', 'block:small']);
  });
});

describe('improvementProposalsFromKg (W4.2)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  it('turns clustered KG downvotes into a review-block proposal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-kg-')); dirs.push(dir);
    const kg = new KGStore(join(dir, 'kg.sqlite'));
    kg.rebuild([{ nodeId: 'block:shaky', kind: 'block', name: 'shaky', domain: 'sales' } as KGNode], []);
    for (let i = 0; i < 3; i++) {
      kg.recordFeedback({ id: `d${i}`, ts: '2026-07-01T00:00:00Z', user: 'u', question: 'bad answer', answerKind: 'uncertified', blockId: 'shaky', rating: 'down' });
    }
    const proposals = improvementProposalsFromKg(kg, { minCluster: 2 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'review_block', scopeKey: 'block:shaky', signalCount: 3 });
    kg.close();
  });
});
