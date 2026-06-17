import { describe, expect, it } from 'vitest';
import type { LocalContextPack } from './catalog.js';
import { validateSqlAgainstLocalContext } from './sql-context-validation.js';

describe('validateSqlAgainstLocalContext', () => {
  it('accepts valid aliases, joins, CTEs, aggregates, and qualified columns', () => {
    const result = validateSqlAgainstLocalContext(`
      WITH enterprise AS (
        SELECT o.week, SUM(o.amount) AS revenue
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
        WHERE c.segment = 'Enterprise'
        GROUP BY 1
      )
      SELECT week, revenue FROM enterprise
    `, pack());

    expect(result.ok).toBe(true);
  });

  it('rejects relations outside the context pack', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT order_id FROM analytics.secret_orders',
      pack(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_relation',
    });
  });

  it('rejects columns outside the inspected relation columns', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT o.fake_column FROM analytics.fct_orders o',
      pack(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
    });
  });

  it('accepts output aliases used in ORDER BY when source columns are inspected', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT o.region, SUM(o.amount) AS revenue_total
       FROM analytics.fct_orders o
       GROUP BY o.region
       ORDER BY revenue_total DESC`,
      pack(),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects change analysis when no baseline column exists', () => {
    const noTime = pack();
    noTime.allowedSqlContext.relations[0]!.columns = noTime.allowedSqlContext.relations[0]!.columns
      .filter((column) => column.name !== 'week');
    const result = validateSqlAgainstLocalContext(
      'SELECT SUM(amount) AS revenue FROM analytics.fct_orders',
      noTime,
      { intent: 'diagnose_change', question: 'why did revenue change?' },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'missing_baseline',
    });
  });

  it('accepts entity drilldown filters on the inspected sample-value column', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT c.segment, SUM(o.amount) AS revenue
       FROM analytics.fct_orders o
       JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
       WHERE c.segment = 'Enterprise'
       GROUP BY 1`,
      pack(),
      { intent: 'entity_drilldown', question: 'Break down Enterprise', filterValues: ['Enterprise'] },
    );

    expect(result.ok).toBe(true);
  });

  it('rejects entity drilldown filters on the wrong inspected column', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT o.region, SUM(o.amount) AS revenue
       FROM analytics.fct_orders o
       WHERE o.region = 'Enterprise'
       GROUP BY 1`,
      pack(),
      { intent: 'entity_drilldown', question: 'Break down Enterprise', filterValues: ['Enterprise'] },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'ambiguous_filter',
    });
    if (!result.ok) {
      expect(result.error).toContain('analytics.dim_customers.segment');
    }
  });
});

function pack(): LocalContextPack {
  return {
    id: 'ctx_test',
    question: 'Drill into Enterprise last week',
    focusObjectKey: null,
    mode: 'question',
    trustLabel: 'mixed',
    objects: [],
    edges: [],
    queryRuns: [],
    citations: [],
    evidenceSummaries: [],
    warnings: [],
    routeDecision: {
      route: 'generated_sql',
      intent: 'entity_drilldown',
      reason: 'test',
      trustLabel: 'mixed',
      reviewStatus: 'draft_ready',
      selectedEvidence: [],
      missingContext: [],
      followUps: [],
    },
    evidenceRoles: [],
    allowedSqlContext: {
      relations: [
        {
          relation: 'analytics.fct_orders',
          name: 'fct_orders',
          source: 'test',
          columns: [
            { name: 'order_id' },
            { name: 'customer_id' },
            { name: 'amount' },
            { name: 'week' },
            { name: 'region', sampleValues: ['North'] },
          ],
        },
        {
          relation: 'analytics.dim_customers',
          name: 'dim_customers',
          source: 'test',
          columns: [
            { name: 'customer_id' },
            { name: 'segment', sampleValues: ['Enterprise'] },
          ],
        },
      ],
      sourceBlockSql: [],
    },
    missingContext: [],
    conflicts: [],
    retrievalDiagnostics: {
      strategy: 'sqlite_fts',
      selectedObjects: 0,
      selectedEvidence: [],
      topRejected: [],
      candidateConflicts: [],
    },
    freshness: {
      catalogPath: '.dql/cache/metadata.sqlite',
      builtAt: null,
      fingerprint: null,
    },
  };
}
