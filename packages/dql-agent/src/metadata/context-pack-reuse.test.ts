import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalContextPack, isFilterOnlyRefinement } from './catalog.js';
import { buildAnalysisQuestionPlan } from './analysis-planner.js';

describe('isFilterOnlyRefinement — route-commitment truth table', () => {
  const plan = (question: string) => buildAnalysisQuestionPlan(question);

  it('same shape, different top-N → refinement', () => {
    expect(isFilterOnlyRefinement(
      plan('top 10 customers by revenue'),
      plan('top 5 customers by revenue'),
    )).toBe(true);
  });

  it('added measure → NOT a refinement', () => {
    expect(isFilterOnlyRefinement(
      plan('top customers by revenue'),
      plan('top customers by orders'),
    )).toBe(false);
  });

  it('changed dimension → NOT a refinement', () => {
    expect(isFilterOnlyRefinement(
      plan('revenue by category'),
      plan('revenue by product'),
    )).toBe(false);
  });

  it('changed entity/topic → NOT a refinement', () => {
    expect(isFilterOnlyRefinement(
      plan('top customers by revenue'),
      plan('how many signups last quarter'),
    )).toBe(false);
  });
});

describe('buildLocalContextPack — conversation-aware reuse', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-pack-reuse-'));
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'reuse_test' }), 'utf-8');
    writeFileSync(
      join(projectRoot, 'blocks', 'top_customers.dql'),
      `block "top_customers" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top customers by lifetime spend."
  tags = ["customers", "revenue", "ranking"]
  grain = "customer"
  entities = ["Customer"]
  outputs = ["customer_name", "lifetime_spend"]
  dimensions = ["customer"]
  query = """
    SELECT customer_name, lifetime_spend FROM dim_customers ORDER BY lifetime_spend DESC LIMIT 10
  """
}`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('re-stamps the prior pack for a filter-only refinement (route commitment)', async () => {
    const first = await buildLocalContextPack(projectRoot, {
      question: 'top 10 customers by revenue',
      limit: 40,
    });
    expect(first.retrievalDiagnostics.strategy).toBe('sqlite_fts');

    const second = await buildLocalContextPack(projectRoot, {
      question: 'top 5 customers by revenue',
      limit: 40,
      priorContextPackId: first.id,
      conversationTopicRelation: 'refinement',
    });
    expect(second.retrievalDiagnostics.strategy).toBe('reused_pack_refinement');
    // A fresh id is stamped — reuse is auditable, never aliased.
    expect(second.id).not.toBe(first.id);
    // The committed route decision is the prior (already fit-validated) one.
    expect(second.routeDecision.route).toBe(first.routeDecision.route);
    // The question plan is the NEW one (top-N 5, not 10).
    expect(second.questionPlan.requestedShape.topN?.n).toBe(5);
  });

  it('does NOT reuse across a topic shift', async () => {
    const first = await buildLocalContextPack(projectRoot, {
      question: 'top 10 customers by revenue',
      limit: 40,
    });
    const second = await buildLocalContextPack(projectRoot, {
      question: 'how many signups last quarter',
      limit: 40,
      priorContextPackId: first.id,
      conversationTopicRelation: 'shift',
    });
    expect(second.retrievalDiagnostics.strategy).toBe('sqlite_fts');
  });

  it('does NOT re-stamp when the shape changed even if flagged refinement', async () => {
    const first = await buildLocalContextPack(projectRoot, {
      question: 'top 10 customers by revenue',
      limit: 40,
    });
    const second = await buildLocalContextPack(projectRoot, {
      question: 'revenue by category',
      limit: 40,
      priorContextPackId: first.id,
      conversationTopicRelation: 'refinement',
    });
    expect(second.retrievalDiagnostics.strategy).toBe('sqlite_fts');
  });

  it('reusePolicy off ignores the prior pack entirely', async () => {
    const first = await buildLocalContextPack(projectRoot, {
      question: 'top 10 customers by revenue',
      limit: 40,
    });
    const second = await buildLocalContextPack(projectRoot, {
      question: 'top 5 customers by revenue',
      limit: 40,
      priorContextPackId: first.id,
      conversationTopicRelation: 'refinement',
      reusePolicy: 'off',
    });
    expect(second.retrievalDiagnostics.strategy).toBe('sqlite_fts');
  });
});
