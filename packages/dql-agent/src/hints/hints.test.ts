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
  hintsDir,
  tracesDir,
  reviewsDir,
  defaultHintIndexPath,
} from './git-store.js';
import { HintStore } from './store.js';
import { hintAppliesToScope, hintsConflict, type Hint, type QuestionScope } from './types.js';

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
    expect(matches[0].scopeReason).toContain('metric=revenue');
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
    expect(listHintsFromGit(projectRoot).map((h) => h.id)).toContain(hint.id);
  });
});
