import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getHintFromGit,
  listHintEvaluationsFromGit,
  retireHint,
  reviewsDir,
  supersedeHint,
} from './git-store.js';
import {
  deriveCorrectionGuidance,
  editGovernedHintCandidate,
  inspectGovernedHint,
  recordGovernedCorrection,
  reopenGovernedHint,
  reviewGovernedHint,
  type GovernedHintContext,
} from './lifecycle.js';
import type { HintDependency } from './types.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-governed-hints-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
    project: 'governed_hints',
    manifestVersion: 3,
    modeling: { mode: 'dbt-first' },
  }));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const dependency: HintDependency = {
  id: 'relation:analytics.fct_orders',
  kind: 'relation',
  name: 'analytics.fct_orders',
  fingerprint: 'relation-fingerprint-v1',
};

function context(overrides: Partial<GovernedHintContext> = {}) {
  return async (): Promise<GovernedHintContext> => ({
    snapshotId: 'snapshot-v1',
    dependencies: [dependency],
    checks: [
      { name: 'corrected-sql-present', passed: true, evidence: 'SQL present.' },
      { name: 'read-only-sql', passed: true, evidence: 'SELECT only.' },
      { name: 'relations-authorized', passed: true, evidence: 'analytics.fct_orders is authorized.' },
    ],
    evidence: ['snapshot: snapshot-v1'],
    ...overrides,
  });
}

async function recordCandidate() {
  return recordGovernedCorrection(projectRoot, {
    question: 'What is net revenue?',
    scope: { metric: 'revenue', dbtModel: 'fct_orders' },
    wrongAnswer: 'SELECT SUM(amount) FROM analytics.fct_orders',
    correction: 'SELECT SUM(net_amount) FROM analytics.fct_orders',
    correctedSql: 'SELECT SUM(net_amount) FROM analytics.fct_orders',
    author: 'analyst',
  }, context());
}

describe('governed v3 hint lifecycle', () => {
  it('derives reviewable guidance instead of using raw corrected SQL as the lesson', () => {
    const correctedSql = 'SELECT SUM(net_amount) FROM analytics.fct_orders';
    expect(deriveCorrectionGuidance({
      question: 'What is net revenue?',
      scope: { domain: 'commerce', metric: 'revenue' },
      correction: correctedSql,
      correctedSql,
    })).toBe(
      'For domain commerce, metric revenue, follow the reviewed corrected SQL pattern captured for "What is net revenue?". Confirm the pattern against current certified, dbt, and semantic context.',
    );
  });

  it('preserves explicit human guidance when correction text is separate from SQL', () => {
    expect(deriveCorrectionGuidance({
      question: 'What is net revenue?',
      scope: { metric: 'revenue' },
      correction: 'Use net amount and exclude refunds.',
      correctedSql: 'SELECT SUM(net_amount) FROM analytics.fct_orders',
    })).toBe('Use net amount and exclude refunds.');
  });

  it('persists snapshot, dependencies, required evaluation, and keeps capture candidate-only', async () => {
    const { trace, hint } = await recordCandidate();

    expect(hint.status).toBe('candidate');
    expect(hint.snapshotId).toBe('snapshot-v1');
    expect(hint.dependencies).toEqual([dependency]);
    expect(hint.requiredEvaluation).toContain('What is net revenue?');
    expect(trace.dependencies).toEqual([dependency]);
    expect(hint.lesson).toMatchObject({
      version: 1,
      rule: hint.guidance,
      intentExamples: ['What is net revenue?'],
    });
    expect(trace.lesson).toEqual(hint.lesson);
  });

  it('persists a failed evaluation and allows a later approval retry', async () => {
    const { hint } = await recordCandidate();

    await expect(reviewGovernedHint(projectRoot, {
      hintId: hint.id,
      decision: 'approved',
      reviewer: 'lead',
      snapshotId: 'snapshot-v1',
      resolveContext: context(),
      executeSql: async () => ({ columns: [], rows: [], rowCount: 0 }),
    })).rejects.toMatchObject({ code: 'HINT_EVALUATION_FAILED' });

    expect(getHintFromGit(projectRoot, hint.id)).toMatchObject({
      status: 'candidate',
      evaluationStatus: 'failed',
    });
    expect(listHintEvaluationsFromGit(projectRoot, hint.id)).toHaveLength(1);

    const approved = await reviewGovernedHint(projectRoot, {
      hintId: hint.id,
      decision: 'approved',
      reviewer: 'lead',
      snapshotId: 'snapshot-v1',
      resolveContext: context(),
      executeSql: async () => ({
        columns: [{ name: 'net_revenue' }],
        rows: [{ net_revenue: 42 }],
        rowCount: 1,
        executionReceipt: { id: 'receipt-1' },
      }),
    });

    expect(approved?.hint).toMatchObject({ status: 'approved', evaluationStatus: 'passed' });
    expect(listHintEvaluationsFromGit(projectRoot, hint.id).map((item) => item.status)).toEqual(['failed', 'passed']);
  });

  it('allows review across unrelated snapshot drift when scoped dependencies still match', async () => {
    const { hint } = await recordCandidate();
    const approved = await reviewGovernedHint(projectRoot, {
      hintId: hint.id,
      decision: 'approved',
      reviewer: 'lead',
      snapshotId: 'snapshot-v2',
      resolveContext: context({ snapshotId: 'snapshot-v2' }),
      executeSql: async () => ({
        columns: [{ name: 'net_revenue' }],
        rows: [{ net_revenue: 42 }],
        rowCount: 1,
      }),
    });

    expect(approved?.hint.status).toBe('approved');
    expect(approved?.evaluation.checks).toContainEqual(expect.objectContaining({
      name: 'snapshot-current',
      passed: true,
      evidence: expect.stringContaining('every scoped dependency still matches'),
    }));
  });

  it('refuses unsafe or unauthorized correction evidence without creating a review', async () => {
    const { hint } = await recordCandidate();
    const unsafeContext = context({
      dependencies: [],
      checks: [
        { name: 'read-only-sql', passed: false, evidence: 'DELETE is unsafe.' },
        { name: 'relations-authorized', passed: false, evidence: 'secret.payroll is not authorized.' },
      ],
    });

    await expect(reviewGovernedHint(projectRoot, {
      hintId: hint.id,
      decision: 'approved',
      reviewer: 'lead',
      snapshotId: 'snapshot-v1',
      resolveContext: unsafeContext,
      executeSql: async () => ({ columns: ['ok'], rows: [{ ok: true }], rowCount: 1 }),
    })).rejects.toMatchObject({ code: 'HINT_EVALUATION_FAILED' });

    expect(getHintFromGit(projectRoot, hint.id)?.status).toBe('candidate');
    expect(listHintEvaluationsFromGit(projectRoot, hint.id)[0].checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'read-only-sql', passed: false }),
      expect.objectContaining({ name: 'relations-authorized', passed: false }),
      expect.objectContaining({ name: 'dependencies-current', passed: false }),
    ]));
    expect(() => reviewsDir(projectRoot)).not.toThrow();
  });

  it('rejects unbounded or malformed result evidence', async () => {
    const { hint } = await recordCandidate();

    await expect(reviewGovernedHint(projectRoot, {
      hintId: hint.id,
      decision: 'approved',
      reviewer: 'lead',
      snapshotId: 'snapshot-v1',
      rowLimit: 10,
      resolveContext: context(),
      executeSql: async () => ({
        columns: ['net_revenue'],
        rows: Array.from({ length: 11 }, (_, index) => ({ index })),
        rowCount: 11,
      }),
    })).rejects.toMatchObject({ code: 'HINT_EVALUATION_FAILED' });

    expect(getHintFromGit(projectRoot, hint.id)).toMatchObject({
      status: 'candidate',
      evaluationStatus: 'failed',
    });
  });

  it('requires an explicit evidence assertion when the surface has no SQL executor', async () => {
    const missingNote = await recordCandidate();
    await expect(reviewGovernedHint(projectRoot, {
      hintId: missingNote.hint.id,
      decision: 'approved',
      reviewer: 'lead',
      snapshotId: 'snapshot-v1',
      resolveContext: context(),
    })).rejects.toMatchObject({ code: 'HINT_EVALUATION_FAILED' });

    const withNote = await recordCandidate();
    const approved = await reviewGovernedHint(projectRoot, {
      hintId: withNote.hint.id,
      decision: 'approved',
      reviewer: 'lead',
      note: 'Compared the corrected result to the governed finance report.',
      snapshotId: 'snapshot-v1',
      resolveContext: context(),
    });
    expect(approved?.hint.status).toBe('approved');
  });

  it('edits a candidate against current context and clears failed evaluation state', async () => {
    const { hint } = await recordCandidate();
    await expect(reviewGovernedHint(projectRoot, {
      hintId: hint.id,
      decision: 'approved',
      reviewer: 'lead',
      snapshotId: 'snapshot-v1',
      resolveContext: context(),
      executeSql: async () => ({ columns: [], rows: [], rowCount: 0 }),
    })).rejects.toMatchObject({ code: 'HINT_EVALUATION_FAILED' });

    const dependencyV2 = { ...dependency, fingerprint: 'relation-fingerprint-v2' };
    const edited = await editGovernedHintCandidate(projectRoot, {
      hintId: hint.id,
      title: 'Use governed net revenue',
      correctedSql: 'SELECT SUM(governed_net_amount) FROM analytics.fct_orders',
      lesson: {
        category: 'semantic_rule',
        rule: 'Use governed net revenue from the modeled amount.',
        intentExamples: ['Net revenue', 'Recognized revenue'],
        avoid: ['Do not use the raw amount.'],
        expectedOutcome: 'A single governed revenue value.',
      },
      snapshotId: 'snapshot-v2',
      resolveContext: context({ snapshotId: 'snapshot-v2', dependencies: [dependencyV2] }),
    });

    expect(edited).toMatchObject({
      title: 'Use governed net revenue',
      snapshotId: 'snapshot-v2',
      dependencies: [dependencyV2],
      evaluationId: undefined,
      evaluationStatus: undefined,
      status: 'candidate',
      guidance: 'Use governed net revenue from the modeled amount.',
      lesson: {
        category: 'semantic_rule',
        rule: 'Use governed net revenue from the modeled amount.',
        intentExamples: ['Net revenue', 'Recognized revenue'],
        avoid: ['Do not use the raw amount.'],
        expectedOutcome: 'A single governed revenue value.',
      },
    });
  });

  it('reports live drift and reopens or retires hints without making them retrievable', async () => {
    const { hint } = await recordCandidate();
    const approved = await reviewGovernedHint(projectRoot, {
      hintId: hint.id,
      decision: 'approved',
      reviewer: 'lead',
      note: 'Matched the finance report.',
      snapshotId: 'snapshot-v1',
      resolveContext: context(),
    });
    expect(approved?.hint.status).toBe('approved');

    const inspection = await inspectGovernedHint(projectRoot, {
      hintId: hint.id,
      snapshotId: 'snapshot-v2',
      resolveContext: context({
        snapshotId: 'snapshot-v2',
        dependencies: [{ ...dependency, fingerprint: 'changed' }],
      }),
    });
    expect(inspection).toMatchObject({
      state: 'stale',
      snapshotCurrent: false,
      dependenciesCurrent: false,
    });

    const reopened = await reopenGovernedHint(projectRoot, {
      hintId: hint.id,
      reviewer: 'lead',
      snapshotId: 'snapshot-v2',
      resolveContext: context({ snapshotId: 'snapshot-v2' }),
    });
    expect(reopened?.hint).toMatchObject({ status: 'candidate', snapshotId: 'snapshot-v2' });

    const retired = retireHint(projectRoot, { hintId: hint.id, reviewer: 'lead', note: 'No longer applicable.' });
    expect(retired.hint.status).toBe('retired');
  });

  it('records an explicit supersede resolution between two approved conflicts', async () => {
    const first = await recordCandidate();
    const second = await recordCandidate();
    for (const candidate of [first, second]) {
      await reviewGovernedHint(projectRoot, {
        hintId: candidate.hint.id,
        decision: 'approved',
        reviewer: 'lead',
        note: 'Matched governed report results.',
        snapshotId: 'snapshot-v1',
        resolveContext: context(),
      });
    }

    const resolved = supersedeHint(projectRoot, {
      hintId: second.hint.id,
      targetHintId: first.hint.id,
      reviewer: 'lead',
      note: 'The later correction is authoritative.',
    });

    expect(resolved.hint).toMatchObject({
      id: second.hint.id,
      status: 'approved',
      supersedes: first.hint.id,
    });
    expect(resolved.review).toMatchObject({
      decision: 'superseded',
      targetHintId: first.hint.id,
    });
  });
});
