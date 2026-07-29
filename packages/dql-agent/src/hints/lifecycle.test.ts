import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getHintFromGit,
  listHintEvaluationsFromGit,
  reviewsDir,
} from './git-store.js';
import {
  recordGovernedCorrection,
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
  it('persists snapshot, dependencies, required evaluation, and keeps capture candidate-only', async () => {
    const { trace, hint } = await recordCandidate();

    expect(hint.status).toBe('candidate');
    expect(hint.snapshotId).toBe('snapshot-v1');
    expect(hint.dependencies).toEqual([dependency]);
    expect(hint.requiredEvaluation).toContain('What is net revenue?');
    expect(trace.dependencies).toEqual([dependency]);
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
});
