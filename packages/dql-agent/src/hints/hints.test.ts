import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordCorrectionTrace,
  reviewHint,
  listHintsFromGit,
  getHintFromGit,
  reindexHints,
  ensureHintIndexFresh,
  writeHintFile,
  hintsDir,
  tracesDir,
  reviewsDir,
  defaultHintIndexPath,
} from './git-store.js';
import { HintStore } from './store.js';
import { hintAppliesToScope, hintsConflict, type Hint, type QuestionScope } from './types.js';
import { retrieveScopedHints } from './retrieval.js';
import { buildHintGraphEdges } from './graph.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-hints-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function indexPath(): string {
  return defaultHintIndexPath(projectRoot);
}

async function searchApproved(scope: QuestionScope, alpha = 0) {
  const store = new HintStore(indexPath());
  try {
    return await store.searchApprovedHints({ questionScope: scope, alpha });
  } finally {
    store.close();
  }
}

describe('scoped correction memory — lifecycle', () => {
  it('records a correction as a Git trace + candidate hint, then approval makes it retrievable in scope', async () => {
    const { trace, hint } = recordCorrectionTrace(projectRoot, {
      question: 'What is revenue for the growth team last quarter?',
      scope: { metric: 'revenue', domain: 'growth', dbtModel: 'fct_orders' },
      wrongAnswer: 'SELECT SUM(amount) FROM orders',
      correction: 'Use net_amount and exclude refunds: SELECT SUM(net_amount) FROM fct_orders WHERE is_refund = false',
      rationale: 'gross vs net revenue',
      author: 'analyst@acme.test',
    });

    // Git files written.
    expect(existsSync(join(tracesDir(projectRoot), `${trace.id}.trace.json`))).toBe(true);
    expect(existsSync(join(hintsDir(projectRoot), `${hint.id}.hint.yaml`))).toBe(true);

    // Candidate is NOT used in normal retrieval.
    const beforeApproval = await searchApproved({ metric: 'revenue', domain: 'growth', text: 'revenue growth' });
    expect(beforeApproval).toHaveLength(0);

    // Approve it.
    const reviewed = reviewHint(projectRoot, {
      hintId: hint.id,
      decision: 'approved',
      reviewer: 'lead@acme.test',
    });
    expect(reviewed?.hint.status).toBe('approved');
    expect(existsSync(join(reviewsDir(projectRoot), `${reviewed!.review.id}.review.yaml`))).toBe(true);

    // Now it is retrievable for a matching scope, and cited.
    const matches = await searchApproved({
      metric: 'revenue',
      domain: 'growth',
      dbtModel: 'fct_orders',
      text: 'revenue for the growth team',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].hint.id).toBe(hint.id);
    expect(matches[0].hint.guidance).toContain('net_amount');
    expect(matches[0].hint.lesson).toMatchObject({
      category: 'semantic_rule',
      rule: expect.stringContaining('net_amount'),
      intentExamples: ['What is revenue for the growth team last quarter?'],
    });
    expect(matches[0].scopeReason).toContain('metric=revenue');
    expect(matches[0].matchSignals.lexicalScore).toBeGreaterThan(0);
  });

  it('approved hints do not apply outside their scope', async () => {
    const { hint } = recordCorrectionTrace(projectRoot, {
      question: 'revenue question',
      scope: { metric: 'revenue', domain: 'growth' },
      wrongAnswer: 'wrong',
      correction: 'right',
    });
    reviewHint(projectRoot, { hintId: hint.id, decision: 'approved', reviewer: 'lead' });

    // Different metric → not applied.
    expect(await searchApproved({ metric: 'churn', domain: 'growth', text: 'churn rate' })).toHaveLength(0);
    // Different domain → not applied.
    expect(await searchApproved({ metric: 'revenue', domain: 'finance', text: 'revenue finance' })).toHaveLength(0);
    // Unknown scope where the hint constrains it → not applied (no over-broad use).
    expect(await searchApproved({ text: 'revenue' })).toHaveLength(0);
    // Matching scope → applied.
    expect(await searchApproved({ metric: 'revenue', domain: 'growth', text: 'revenue' })).toHaveLength(1);
  });

  it('rejected hints are never used', async () => {
    const { hint } = recordCorrectionTrace(projectRoot, {
      question: 'q',
      scope: { metric: 'revenue' },
      wrongAnswer: 'w',
      correction: 'c',
    });
    reviewHint(projectRoot, { hintId: hint.id, decision: 'rejected', reviewer: 'lead' });
    expect(await searchApproved({ metric: 'revenue', text: 'revenue' })).toHaveLength(0);
    expect(getHintFromGit(projectRoot, hint.id)?.status).toBe('rejected');
  });

  it('reindex rebuilds the SQLite view from Git (Git is authoritative)', async () => {
    const { hint } = recordCorrectionTrace(projectRoot, {
      question: 'q',
      scope: { domain: 'growth' },
      wrongAnswer: 'w',
      correction: 'c',
    });
    reviewHint(projectRoot, { hintId: hint.id, decision: 'approved', reviewer: 'lead' });

    // Wipe the SQLite index, then rebuild purely from the Git files.
    rmSync(indexPath(), { force: true });
    const count = reindexHints(projectRoot);
    expect(count).toBe(1);
    expect(await searchApproved({ domain: 'growth', text: 'anything growth' })).toHaveLength(1);
  });

  it('bootstraps a cloned Git hint set once and refreshes only after Git changes', () => {
    const hint: Hint = {
      id: 'hint-from-clone',
      title: 'Use governed net revenue',
      guidance: 'Use net amount and exclude refunds.',
      status: 'approved',
      scope: { metric: 'revenue', domain: 'commerce', dbtModel: 'fct_orders' },
      correctedSql: 'SELECT SUM(o.net_amount) FROM analytics.fct_orders AS o',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeHintFile(projectRoot, hint);

    expect(existsSync(indexPath())).toBe(false);
    expect(ensureHintIndexFresh(projectRoot)).toMatchObject({
      hintCount: 1,
      rebuilt: true,
    });

    const store = new HintStore(indexPath());
    try {
      expect(store.get(hint.id)?.title).toBe(hint.title);
      expect(store.get(hint.id)?.lesson).toMatchObject({
        version: 1,
        category: 'semantic_rule',
        rule: hint.guidance,
      });
      expect(store.edgesForHint(hint.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'belongs_to_domain', targetId: 'domain:commerce' }),
        expect.objectContaining({ kind: 'uses_relation', targetId: 'relation:analytics.fct_orders' }),
        expect.objectContaining({ kind: 'uses_column', targetId: 'column:analytics.fct_orders.net_amount' }),
      ]));
    } finally {
      store.close();
    }

    expect(ensureHintIndexFresh(projectRoot)).toMatchObject({
      hintCount: 1,
      rebuilt: false,
    });

    writeHintFile(projectRoot, {
      ...hint,
      guidance: 'Use recognized net amount and exclude refunds.',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(ensureHintIndexFresh(projectRoot)).toMatchObject({
      hintCount: 1,
      rebuilt: true,
    });
  });

  it('indexes reviewer-authored intent examples and exposes explainable lexical ranking', async () => {
    const broad = recordCorrectionTrace(projectRoot, {
      question: 'Revenue overview',
      scope: { metric: 'revenue', domain: 'commerce' },
      wrongAnswer: 'SELECT SUM(gross_amount) FROM orders',
      correction: 'Use governed revenue.',
      lesson: {
        category: 'semantic_rule',
        rule: 'Use governed revenue.',
        intentExamples: ['General revenue report'],
      },
    }).hint;
    const specific = recordCorrectionTrace(projectRoot, {
      question: 'Which customers have the most revenue?',
      scope: { metric: 'revenue', domain: 'commerce' },
      wrongAnswer: 'SELECT customer_name, SUM(gross_amount) FROM orders GROUP BY customer_name',
      correction: 'Use recognized net revenue when ranking customers.',
      lesson: {
        category: 'aggregation_rule',
        rule: 'Use recognized net revenue when ranking customers.',
        intentExamples: ['Top customers by recognized revenue', 'Customer revenue leaderboard'],
        avoid: ['Do not rank customers by gross order amount.'],
        expectedOutcome: 'One row per customer ordered by recognized revenue.',
      },
    }).hint;
    reviewHint(projectRoot, { hintId: broad.id, decision: 'approved', reviewer: 'lead' });
    reviewHint(projectRoot, { hintId: specific.id, decision: 'approved', reviewer: 'lead' });

    const matches = await searchApproved({
      metric: 'revenue',
      domain: 'commerce',
      text: 'top customers by recognized revenue',
    });

    expect(matches[0].hint.id).toBe(specific.id);
    expect(matches[0].hint.lesson?.intentExamples).toContain('Top customers by recognized revenue');
    expect(matches[0].matchSignals).toMatchObject({
      lexicalRank: 0,
      lexicalScore: 0.55,
    });
  });

  it('materializes reviewable domain, model, relation, and column graph edges', () => {
    const { hint } = recordCorrectionTrace(projectRoot, {
      question: 'How should net revenue be calculated?',
      scope: { metric: 'revenue', domain: 'growth', dbtModel: 'fct_orders' },
      wrongAnswer: 'SELECT SUM(gross_amount) FROM analytics.fct_orders',
      correction: 'Use net amount and exclude refunds.',
      correctedSql: `
        SELECT SUM(o.net_amount)
        FROM analytics.fct_orders AS o
        WHERE o.is_refund = false
      `,
    });

    const store = new HintStore(indexPath());
    try {
      expect(store.edgesForHint(hint.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'belongs_to_domain',
          targetId: 'domain:growth',
          source: 'scope',
        }),
        expect.objectContaining({
          kind: 'refines_metric',
          targetId: 'metric:revenue',
          source: 'scope',
        }),
        expect.objectContaining({
          kind: 'uses_dbt_model',
          targetId: 'dbt_model:fct_orders',
          source: 'scope',
        }),
        expect.objectContaining({
          kind: 'uses_relation',
          targetId: 'relation:analytics.fct_orders',
          source: 'corrected_sql',
        }),
        expect.objectContaining({
          kind: 'uses_column',
          targetId: 'column:analytics.fct_orders.net_amount',
          source: 'corrected_sql',
        }),
        expect.objectContaining({
          kind: 'derived_from',
          targetId: `trace:${hint.traceId}`,
          source: 'lifecycle',
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it('recalls differently worded approved hints through explicit graph scope and ranks structural overlap', async () => {
    const { hint } = recordCorrectionTrace(projectRoot, {
      question: 'How should refunds affect the recognized amount?',
      scope: { metric: 'revenue', domain: 'growth', dbtModel: 'fct_orders' },
      wrongAnswer: 'SELECT SUM(gross_amount) FROM analytics.fct_orders',
      correction: 'Use net amount and exclude refunds.',
      correctedSql: `
        SELECT SUM(o.net_amount)
        FROM analytics.fct_orders AS o
        WHERE o.is_refund = false
      `,
    });
    reviewHint(projectRoot, { hintId: hint.id, decision: 'approved', reviewer: 'lead' });

    const matches = await searchApproved({
      metric: 'revenue',
      domain: 'growth',
      dbtModel: 'fct_orders',
      dbtModels: ['fct_orders'],
      relations: ['analytics.fct_orders'],
      columns: ['analytics.fct_orders.net_amount'],
      text: 'quarterly sales overview',
    });

    expect(matches.map((match) => match.hint.id)).toEqual([hint.id]);
    expect(matches[0].scopeReason).toContain('metric=revenue');
    expect(matches[0].graphReason).toContain('domain=growth');
    expect(matches[0].graphReason).toContain('relation=analytics.fct_orders');
    expect(matches[0].graphReason).toContain('column=analytics.fct_orders.net_amount');

    expect(await searchApproved({
      metric: 'headcount',
      domain: 'people',
      dbtModel: 'fct_orders',
      dbtModels: ['fct_orders'],
      relations: ['analytics.fct_orders'],
      columns: ['analytics.fct_orders.net_amount'],
      text: 'quarterly staffing overview',
    })).toHaveLength(0);
  });
});

describe('scope matching', () => {
  const scoped: Hint = {
    id: 'h1', title: 't', guidance: 'g', status: 'approved',
    scope: { metric: 'Revenue', domain: 'Growth' },
    createdAt: 'now', updatedAt: 'now',
  };

  it('matches case-insensitively when all declared fields agree', () => {
    expect(hintAppliesToScope(scoped.scope, { metric: 'revenue', domain: 'growth', text: '' }).applies).toBe(true);
  });

  it('does not match when a declared field disagrees', () => {
    expect(hintAppliesToScope(scoped.scope, { metric: 'revenue', domain: 'finance', text: '' }).applies).toBe(false);
  });

  it('does not match when the question lacks a field the hint constrains', () => {
    expect(hintAppliesToScope(scoped.scope, { metric: 'revenue', text: '' }).applies).toBe(false);
  });

  it('a project-wide hint (no constraints) always applies', () => {
    expect(hintAppliesToScope({}, { text: 'anything' }).applies).toBe(true);
  });

  it('tolerates unknown question dialect for a dialect-scoped hint', () => {
    const dialectHint = { dialect: 'duckdb' };
    expect(hintAppliesToScope(dialectHint, { text: '' }).applies).toBe(true);
    expect(hintAppliesToScope(dialectHint, { dialect: 'snowflake', text: '' }).applies).toBe(false);
    expect(hintAppliesToScope(dialectHint, { dialect: 'duckdb', text: '' }).applies).toBe(true);
  });
});

describe('conflicting hints', () => {
  it('surfaces overlapping approved hints among the applied set', async () => {
    const a = recordCorrectionTrace(projectRoot, {
      question: 'revenue A', scope: { metric: 'revenue', domain: 'growth' },
      wrongAnswer: 'w', correction: 'use net_amount',
    }).hint;
    const b = recordCorrectionTrace(projectRoot, {
      question: 'revenue B', scope: { metric: 'revenue', domain: 'growth' },
      wrongAnswer: 'w', correction: 'use gross_amount',
    }).hint;
    reviewHint(projectRoot, { hintId: a.id, decision: 'approved', reviewer: 'lead' });
    reviewHint(projectRoot, { hintId: b.id, decision: 'approved', reviewer: 'lead' });

    const store = new HintStore(indexPath());
    try {
      const conflicts = store.conflictingApprovedHints();
      expect(conflicts).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('hintsConflict respects explicit supersede resolution', () => {
    const a: Hint = { id: 'a', title: 't', guidance: 'g', status: 'approved', scope: { metric: 'revenue' }, createdAt: 'n', updatedAt: 'n' };
    const b: Hint = { id: 'b', title: 't', guidance: 'g', status: 'approved', scope: { metric: 'revenue' }, supersedes: 'a', createdAt: 'n', updatedAt: 'n' };
    expect(hintsConflict(a, b)).toBe(false);
    const c: Hint = { ...b, supersedes: undefined, id: 'c' };
    expect(hintsConflict(a, c)).toBe(true);
    const d: Hint = { ...c, id: 'd', scope: { metric: 'churn' } };
    expect(hintsConflict(a, d)).toBe(false);
  });
});

describe('Git hint file format', () => {
  it('writes human-reviewable YAML hints and JSON traces', () => {
    const { hint } = recordCorrectionTrace(projectRoot, {
      question: 'q', scope: { metric: 'revenue' }, wrongAnswer: 'w', correction: 'c',
    });
    const hintFile = readdirSync(hintsDir(projectRoot)).find((f) => f.endsWith('.hint.yaml'));
    expect(hintFile).toBeDefined();
    const body = readFileSync(join(hintsDir(projectRoot), hintFile!), 'utf-8');
    expect(body).toContain('status: candidate');
    expect(body).toContain('metric: revenue');
    expect(body).toContain('lesson:');
    expect(body).toContain('intentExamples:');
    expect(listHintsFromGit(projectRoot).map((h) => h.id)).toContain(hint.id);
  });
});

describe('hint graph SQL projection', () => {
  it('does not materialize query-internal CTEs as governed relation targets', () => {
    const edges = buildHintGraphEdges({
      id: 'hint-cte',
      title: 'Use net revenue',
      guidance: 'Use the governed order amount.',
      status: 'approved',
      scope: { metric: 'revenue' },
      correctedSql: `
        WITH order_totals AS (
          SELECT o.customer_id, SUM(o.net_amount) AS revenue
          FROM analytics.fct_orders AS o
          GROUP BY o.customer_id
        )
        SELECT customer_id, revenue
        FROM order_totals
      `,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'uses_relation', targetId: 'relation:analytics.fct_orders' }),
      expect.objectContaining({ kind: 'uses_column', targetId: 'column:analytics.fct_orders.net_amount' }),
    ]));
    expect(edges.some((edge) => edge.targetId.includes('order_totals'))).toBe(false);
  });
});

describe('hint recall does not depend on which model ranked first', () => {
  const scopedHint = { dbtModel: 'fct_orders' };

  it('applies when the scoped model is anywhere in the retrieved set', () => {
    // At 4000 models a hint used to fire only when its model happened to be the
    // single top-ranked pick — so recall degraded as the catalog grew.
    expect(hintAppliesToScope(scopedHint, {
      dbtModel: 'dim_customers',
      dbtModels: ['dim_customers', 'fct_orders', 'dim_dates'],
      text: 'orders by customer',
    }).applies).toBe(true);
  });

  it('still rejects a model the question never retrieved', () => {
    expect(hintAppliesToScope(scopedHint, {
      dbtModel: 'dim_customers',
      dbtModels: ['dim_customers', 'dim_dates'],
      text: 'customers',
    }).applies).toBe(false);
  });
});

describe('retrieval governance gates', () => {
  function approvedHint(id: string, overrides: Partial<Hint> = {}): Hint {
    return {
      id,
      title: 'Revenue correction',
      guidance: 'Use governed net revenue',
      status: 'approved',
      scope: { metric: 'revenue' },
      dependencies: [{
        id: 'relation:analytics.fct_orders',
        kind: 'relation',
        name: 'analytics.fct_orders',
        fingerprint: 'current-fingerprint',
      }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  async function retrieve() {
    return retrieveScopedHints(projectRoot, {
      questionScope: { metric: 'revenue', text: 'revenue correction governed' },
      currentDependencies: new Map([['relation:analytics.fct_orders', 'current-fingerprint']]),
      currentSnapshotId: 'snapshot-current',
      limit: 10,
    });
  }

  it('withholds approved hints whose dependency fingerprint drifted', async () => {
    writeHintFile(projectRoot, approvedHint('stale', {
      dependencies: [{
        id: 'relation:analytics.fct_orders',
        kind: 'relation',
        name: 'analytics.fct_orders',
        fingerprint: 'old-fingerprint',
      }],
    }));
    reindexHints(projectRoot);

    const result = await retrieve();
    expect(result.applied).toHaveLength(0);
    expect(result.excluded).toEqual([
      expect.objectContaining({ hintId: 'stale', reason: 'stale' }),
    ]);
  });

  it('does not stale a scoped hint for an unrelated project snapshot change', async () => {
    writeHintFile(projectRoot, approvedHint('scoped', { snapshotId: 'snapshot-before-unrelated-change' }));
    reindexHints(projectRoot);

    const result = await retrieve();
    expect(result.applied.map((item) => item.hintId)).toEqual(['scoped']);
    expect(result.excluded).toHaveLength(0);
  });

  it('returns only the explicit superseder', async () => {
    writeHintFile(projectRoot, approvedHint('old'));
    writeHintFile(projectRoot, approvedHint('new', {
      title: 'Revenue correction v2',
      guidance: 'Use governed net revenue after refunds',
      supersedes: 'old',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }));
    reindexHints(projectRoot);

    const result = await retrieve();
    expect(result.applied.map((hint) => hint.hintId)).toEqual(['new']);
    expect(result.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ hintId: 'old', reason: 'superseded' }),
    ]));
  });

  it('withholds both sides of an unresolved conflict', async () => {
    writeHintFile(projectRoot, approvedHint('net', { guidance: 'Use net revenue.' }));
    writeHintFile(projectRoot, approvedHint('gross', { guidance: 'Use gross revenue.' }));
    reindexHints(projectRoot);

    const result = await retrieve();
    expect(result.applied).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.excluded.filter((item) => item.reason === 'conflict')).toHaveLength(2);
  });
});
