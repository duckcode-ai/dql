import { describe, expect, it } from 'vitest';
import {
  splitAnalyticalTasks,
  assertCanonicalResult,
  buildAnalyticalTaskGraph,
  buildAnalyticalTurnPlan,
  buildCoverageGap,
  buildResearchEvidenceLedger,
  capResearchBranches,
  fuseContextCandidates,
  normalizeCanonicalQueryResult,
  retrieveContextLanes,
  summarizeTaskOutcomes,
} from './analytical-orchestration.js';

describe('conversational analytical orchestration contracts', () => {
  it('normalizes connector array rows and object rows into one result contract', () => {
    const result = normalizeCanonicalQueryResult({
      columns: [{ name: 'customer' }, { name: 'revenue' }],
      rows: [['Alice', 120], { customer: 'Bob', revenue: 90 }],
      rowCount: 2,
    });
    expect(result.columns).toEqual(['customer', 'revenue']);
    expect(result.rows).toEqual([
      { customer: 'Alice', revenue: 120 },
      { customer: 'Bob', revenue: 90 },
    ]);
    expect(result.resultFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertCanonicalResult(result)).not.toThrow();
  });

  it('preserves an execution receipt and never invents proof for an unexecuted branch', () => {
    const receipt = {
      sourceFingerprint: 'b'.repeat(64),
      compiledSqlFingerprint: 'c'.repeat(64),
      parameterFingerprint: 'd'.repeat(64),
      resultFingerprint: 'a'.repeat(64),
    };
    const result = normalizeCanonicalQueryResult({
      columns: ['region'],
      rows: [{ region: 'West' }],
      resultFingerprint: receipt.resultFingerprint,
      executionReceipt: receipt,
      trustState: 'review_required',
      answerTier: 'generated_sql',
    });
    expect(result).toMatchObject({
      resultFingerprint: receipt.resultFingerprint,
      executionReceipt: receipt,
      trustState: 'review_required',
      answerTier: 'generated_sql',
    });
    const ledger = buildResearchEvidenceLedger({
      rootQuestion: 'Explain revenue drivers',
      entries: [
        {
          id: 'branch-1', branchId: 'revenue', question: 'Revenue by region',
          status: 'observed', resultFingerprint: receipt.resultFingerprint,
          executionReceipt: receipt,
          facts: ['fact-1'], receipts: [receipt.resultFingerprint], rowCount: 1,
        },
        {
          id: 'branch-2', branchId: 'customers', question: 'Customers by region',
          status: 'observed', facts: ['fact-2'], receipts: [],
        },
        {
          id: 'branch-3', branchId: 'products', question: 'Products by region',
          status: 'failed', resultFingerprint: receipt.resultFingerprint,
          executionReceipt: receipt,
          facts: [], receipts: [receipt.resultFingerprint], error: 'cancelled by shared Research deadline',
        },
        {
          id: 'branch-4', branchId: 'malformed', question: 'Malformed child proof',
          status: 'observed',
          executionReceipt: { resultFingerprint: 'not-a-sha256-receipt', childRunId: 'child-4' } as any,
          facts: ['fact-4'], receipts: ['child-4'],
        },
      ],
    });
    expect(ledger.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'branch-1', status: 'observed', receipts: [receipt.resultFingerprint] }),
      expect.objectContaining({
        id: 'branch-2', status: 'failed', receipts: [],
        error: expect.stringContaining('no valid execution receipt'),
      }),
      expect.objectContaining({
        id: 'branch-3', status: 'failed', receipts: [],
        error: expect.stringContaining('cancelled'),
      }),
      expect.objectContaining({
        id: 'branch-4', status: 'failed', receipts: [],
        error: expect.stringContaining('no valid execution receipt'),
      }),
    ]));
    const failedCancelled = ledger.entries.find((entry) => entry.id === 'branch-3');
    expect(failedCancelled).not.toHaveProperty('executionReceipt');
    expect(failedCancelled).not.toHaveProperty('resultFingerprint');
    expect(ledger.entries.find((entry) => entry.id === 'branch-2')?.receipts).toEqual([]);
  });

  it('fuses lanes by reciprocal rank while retaining evidence from different lanes', () => {
    const fused = fuseContextCandidates({
      lexical: [
        { id: 'semantic:metric:revenue', lane: 'lexical', relevance: 0.8 },
        { id: 'dbt:model:orders', lane: 'lexical', relevance: 0.6 },
      ],
      vector: [
        { id: 'semantic:metric:revenue', lane: 'vector', relevance: 0.7 },
        { id: 'kg:relationship:orders-customers', lane: 'vector', relevance: 0.9 },
      ],
      graph: [{ id: 'kg:relationship:orders-customers', lane: 'graph', relevance: 0.9 }],
    });
    expect(fused.candidates.map((candidate) => candidate.id)).toContain('semantic:metric:revenue');
    expect(fused.candidates.map((candidate) => candidate.id)).toContain('kg:relationship:orders-customers');
    expect(fused.diagnostics.lanes.lexical.returned).toBe(2);
  });

  it('records lane errors without discarding successful retrieval', async () => {
    const result = await retrieveContextLanes({
      exact: async () => [{ id: 'block:revenue', lane: 'exact', relevance: 1, trust: 'certified' }],
      vector: async () => { throw new Error('embedding unavailable'); },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.diagnostics.lanes.vector.error).toBe('embedding unavailable');
  });

  it('bounds parallel lane work while retaining independent lane failures', async () => {
    let active = 0;
    let peak = 0;
    const lanes = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
      `lane-${index + 1}`,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (index === 4) throw new Error('lane 5 unavailable');
        return [{ id: `candidate-${index + 1}`, lane: 'lexical' as const, relevance: 1 }];
      },
    ]));
    const result = await retrieveContextLanes(lanes, 20, 2);
    expect(capResearchBranches(Array.from({ length: 8 }, (_, index) => index), 6)).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.candidates.map((candidate) => candidate.id)).toContain('candidate-1');
    expect(result.diagnostics.lanes['lane-5']).toMatchObject({ status: 'error', error: 'lane 5 unavailable' });
  });

  it('keeps typed gaps recoverable until a plan is frozen', () => {
    const gap = buildCoverageGap({
      code: 'MISSING_RELATIONSHIP',
      phase: 'retrieval',
      message: 'No proven customer to region relationship was found.',
      searchedSources: ['semantic', 'dbt_manifest', 'relationship_graph'],
      attemptedRoutes: ['certified', 'semantic', 'governed_relational', 'generated'],
      missing: ['customer.region'],
      recoverable: true,
      planFrozen: false,
      nextActions: ['search dbt relationships', 'ask which region field to use'],
    });
    expect(gap.version).toBe(1);
    expect(gap.planFrozen).toBe(false);
    const ledger = buildResearchEvidenceLedger({
      rootQuestion: 'Why did revenue change?',
      entries: [{
        id: 'entry-1',
        branchId: 'baseline',
        question: 'What is current revenue?',
        status: 'observed',
        resultFingerprint: 'abcd',
        rowCount: 1,
        facts: ['fact-1'],
        receipts: ['receipt-1'],
      }],
    });
    expect(ledger.factIds).toEqual(['fact-1']);
    expect(ledger.stoppingReason).toBe('completed');
  });

  it('builds a candidate-bound compound task graph with partial-success vocabulary', () => {
    const graph = buildAnalyticalTaskGraph({
      question: 'What region has top revenue? And which products are most common?',
      candidateIds: ['semantic:metric:revenue', 'semantic:dimension:region'],
      metrics: ['revenue'],
      dimensions: ['region', 'product'],
    });
    expect(graph.kind).toBe('compound');
    expect(graph.tasks).toHaveLength(2);
    expect(graph.tasks.every((task) => task.candidateIds.every((id) => id.startsWith('semantic:')))).toBe(true);
    const outcomes = summarizeTaskOutcomes(graph.tasks.map((task, index) => ({
      ...task,
      status: index === 0 ? 'completed' : 'gap',
    })));
    expect(outcomes).toMatchObject({ status: 'partial', completed: ['task-1'], gaps: ['task-2'] });
  });

  it('round-trips a compound plan and partial outcomes for reload-safe rendering', () => {
    const plan = buildAnalyticalTurnPlan({
      question: 'What region has top revenue, and which products drive it?',
      candidateIds: ['semantic:metric:revenue', 'semantic:dimension:region'],
      frozen: true,
      snapshotId: 'snapshot-1',
    });
    const persisted = JSON.parse(JSON.stringify({
      analyticalTurnPlan: plan,
      analyticalTaskOutcomes: [
        { version: 1, taskId: plan.taskIds[0], status: 'completed', resultFingerprint: 'a'.repeat(64) },
        {
          version: 1,
          taskId: plan.taskIds[1],
          status: 'gap',
          gap: buildCoverageGap({
            code: 'MISSING_RELATIONSHIP',
            phase: 'planning',
            message: 'No proven product driver relationship was found.',
            searchedSources: ['semantic', 'dbt_manifest'],
            attemptedRoutes: ['certified', 'semantic', 'governed_relational', 'generated'],
            missing: ['product.revenue'],
            recoverable: true,
            planFrozen: true,
            nextActions: ['Review the product relationship and retry this clause.'],
          }),
        },
      ],
    }));
    expect(persisted.analyticalTurnPlan.taskIds).toEqual(plan.taskIds);
    expect(persisted.analyticalTaskOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: plan.taskIds[0], status: 'completed' }),
      expect.objectContaining({ taskId: plan.taskIds[1], status: 'gap', gap: expect.objectContaining({ planFrozen: true }) }),
    ]));
  });

  it('makes the one-call interpretation budget explicit and reserves zero for bound turns', () => {
    expect(buildAnalyticalTurnPlan({ question: 'top customers by revenue' }).meaningCallBudget).toBe(1);
    expect(buildAnalyticalTurnPlan({
      question: 'what region is this customer in?',
      zeroCallReason: 'explicit_binding',
    })).toMatchObject({ meaningCallBudget: 0, meaningCallReason: 'explicit_binding' });
  });
});

describe('splitAnalyticalTasks separators', () => {
  it('does not carry the separator into the child clause', () => {
    // The reader pasted two questions joined by `" then "`. The clause split is
    // correct; the punctuation must not travel with it and become the task title.
    const parts = splitAnalyticalTasks(
      'Who are the top 10 customers by revenue?" then "What customer type is Wesley Jenkins?',
    );
    expect(parts).toEqual([
      'Who are the top 10 customers by revenue',
      'What customer type is Wesley Jenkins',
    ]);
  });

  it('keeps an ordinary single question untouched', () => {
    expect(splitAnalyticalTasks('What customer type is Wesley Jenkins?'))
      .toEqual(['What customer type is Wesley Jenkins']);
  });
});
