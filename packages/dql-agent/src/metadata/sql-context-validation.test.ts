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

  it('accepts inspected source columns and output aliases selected from a joined CTE', () => {
    const result = validateSqlAgainstLocalContext(`
      WITH enterprise AS (
        SELECT o.amount AS revenue, c.segment
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
      )
      SELECT revenue, segment FROM enterprise
    `, pack());

    expect(result.ok).toBe(true);
  });

  it('accepts implicit output aliases selected from CTEs', () => {
    const result = validateSqlAgainstLocalContext(`
      WITH enterprise AS (
        SELECT c.segment, SUM(o.amount) revenue
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
        GROUP BY c.segment
      )
      SELECT segment, revenue FROM enterprise
    `, pack());

    expect(result.ok).toBe(true);
  });

  it('rejects unknown unqualified columns selected from joined CTEs', () => {
    const result = validateSqlAgainstLocalContext(`
      WITH enterprise AS (
        SELECT o.amount AS revenue, c.segment
        FROM analytics.fct_orders o
        JOIN analytics.dim_customers c ON o.customer_id = c.customer_id
      )
      SELECT fake_column FROM enterprise
    `, pack());

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
    });
  });

  it('rejects an unqualified column shared by multiple joined relations', () => {
    const context = pack();
    context.allowedSqlContext.relations = [
      {
        relation: 'jaffle_shop.dev.order_items',
        name: 'order_items',
        source: 'runtime schema context',
        columns: [
          { name: 'product_id' },
          { name: 'product_price' },
          { name: 'is_drink_item' },
        ],
      },
      {
        relation: 'jaffle_shop.dev.products',
        name: 'products',
        source: 'runtime schema context',
        columns: [
          { name: 'product_id' },
          { name: 'product_price' },
          { name: 'is_drink_item' },
        ],
      },
    ];

    const result = validateSqlAgainstLocalContext(`
      SELECT SUM(CASE WHEN is_drink_item THEN product_price ELSE 0 END) AS beverage_revenue
      FROM jaffle_shop.dev.order_items AS oi
      JOIN jaffle_shop.dev.products AS p ON oi.product_id = p.product_id
    `, context);

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
      offending: { column: 'is_drink_item' },
    });
    if (!result.ok) {
      expect(result.error).toContain('oi (jaffle_shop.dev.order_items)');
      expect(result.error).toContain('p (jaffle_shop.dev.products)');
      expect(result.error).toContain('Qualify it with the intended relation alias');
    }
  });

  it('accepts shared columns when the intended relation alias is explicit', () => {
    const context = pack();
    context.allowedSqlContext.relations[1]!.columns.push({ name: 'amount' });

    const result = validateSqlAgainstLocalContext(`
      SELECT SUM(o.amount) AS revenue
      FROM analytics.fct_orders AS o
      JOIN analytics.dim_customers AS c ON o.customer_id = c.customer_id
    `, context);

    expect(result.ok).toBe(true);
  });

  it('prefers complete live schema over a partial fully-qualified context card', () => {
    const context = pack();
    context.allowedSqlContext.relations = [
      {
        relation: 'jaffle_shop.dev.order_items',
        name: 'order_items',
        source: 'certified source SQL shape',
        columnCompleteness: 'partial',
        columns: [{ name: 'product_id' }, { name: 'product_price' }],
      },
      {
        relation: 'jaffle_shop.dev.products',
        name: 'products',
        source: 'dbt catalog',
        columns: [{ name: 'product_id' }, { name: 'product_price' }, { name: 'is_drink_item' }],
      },
    ];

    const result = validateSqlAgainstLocalContext(`
      SELECT SUM(CASE WHEN is_drink_item THEN product_price ELSE 0 END) AS beverage_revenue
      FROM jaffle_shop.dev.order_items AS oi
      JOIN jaffle_shop.dev.products AS p ON oi.product_id = p.product_id
    `, context, {
      runtimeSchema: [{
        relation: 'dev.order_items',
        name: 'order_items',
        source: 'runtime information_schema',
        columns: [
          { name: 'product_id' },
          { name: 'product_price' },
          { name: 'is_drink_item' },
        ],
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_column',
      offending: { column: 'is_drink_item' },
    });
    if (!result.ok) expect(result.error).toContain('multiple joined relations');
  });

  it('rejects relations outside the context pack', () => {
    const result = validateSqlAgainstLocalContext(
      'SELECT order_id FROM analytics.secret_orders',
      pack(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_relation',
      offending: { relation: 'analytics.secret_orders' },
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
      offending: { relation: 'analytics.fct_orders', column: 'fake_column' },
    });
  });

  it('validates against the union of metadata context and runtime schema context', () => {
    const context = pack();
    context.allowedSqlContext.relations = [context.allowedSqlContext.relations[0]!];

    const result = validateSqlAgainstLocalContext(`
      SELECT o.order_id, s.supply_name, s.supply_cost
      FROM analytics.fct_orders o
      JOIN analytics.supplies s ON o.order_id = s.order_id
    `, context, {
      runtimeSchema: [{
        relation: 'analytics.supplies',
        name: 'supplies',
        source: 'runtime schema context',
        columns: [
          { name: 'order_id' },
          { name: 'supply_name' },
          { name: 'supply_cost' },
        ],
      }],
    });

    expect(result.ok).toBe(true);
  });

  it('uses certified source SQL shape columns when relation metadata is sparse', () => {
    const context = pack();
    context.allowedSqlContext = {
      relations: [{
        relation: 'analytics.player_stats',
        name: 'player_stats',
        source: 'certified block dependency',
        columns: [],
      }],
      sourceBlockSql: [{
        objectKey: 'dql:block:Top Players',
        name: 'Top Players',
        status: 'certified',
        sql: 'SELECT player_name, season, total_points FROM analytics.player_stats ORDER BY total_points DESC LIMIT 10',
      }],
    };

    expect(validateSqlAgainstLocalContext(
      'SELECT player_name, SUM(total_points) AS total_points FROM analytics.player_stats GROUP BY player_name',
      context,
    ).ok).toBe(true);

    const advisory = validateSqlAgainstLocalContext(
      'SELECT player_name, fake_metric FROM analytics.player_stats',
      context,
    );
    expect(advisory.ok).toBe(true);
    expect(advisory.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('partial')]),
    );
  });

  it('treats explicitly partial relation columns as advisory', () => {
    const context = pack();
    context.allowedSqlContext.relations[0]!.columnCompleteness = 'partial';
    const result = validateSqlAgainstLocalContext(
      'SELECT o.fake_column FROM analytics.fct_orders o',
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('partial')]),
    );
  });

  it('rejects a constant-only / tableless SELECT that reads no relation', () => {
    // A data answer must read a relation; `SELECT NULL` / `SELECT 1` dodges the
    // question with a grounded-looking non-answer. Holds even without a pack.
    const withPack = validateSqlAgainstLocalContext('SELECT NULL', pack());
    expect(withPack.ok).toBe(false);
    expect(withPack.code).toBe('insufficient_context');
    const bare = validateSqlAgainstLocalContext('SELECT 1 AS x', undefined);
    expect(bare.ok).toBe(false);
    expect(bare.code).toBe('insufficient_context');
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

  it('accepts implicit output aliases used in ORDER BY', () => {
    const result = validateSqlAgainstLocalContext(
      `SELECT o.region, COUNT(*) order_count
       FROM analytics.fct_orders o
       GROUP BY o.region
       ORDER BY order_count DESC`,
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

  it('does not hard-fail a generic clarify route when allowed SQL context exists', () => {
    const context = pack();
    context.routeDecision = {
      route: 'clarify',
      intent: 'clarify',
      reason: 'DQL needs one more business or metadata detail before it can safely generate SQL.',
      trustLabel: 'mixed',
      reviewStatus: 'none',
      selectedEvidence: [],
      missingContext: [{
        kind: 'metadata',
        severity: 'blocking',
        message: 'No certified block, semantic metric, dbt model, or runtime schema matched strongly enough to answer safely.',
      }],
      followUps: [],
    };

    const result = validateSqlAgainstLocalContext(
      'SELECT region, SUM(amount) AS revenue FROM analytics.fct_orders GROUP BY region',
      context,
    );

    expect(result.ok).toBe(true);
  });

  it('keeps explicit blocking clarify gaps terminal', () => {
    const context = pack();
    context.routeDecision = {
      route: 'clarify',
      intent: 'diagnose_change',
      reason: 'Missing baseline context.',
      trustLabel: 'mixed',
      reviewStatus: 'none',
      selectedEvidence: [],
      missingContext: [{
        kind: 'baseline',
        severity: 'blocking',
        message: 'A baseline time period is required before explaining what changed.',
      }],
      followUps: [],
    };

    const result = validateSqlAgainstLocalContext(
      'SELECT region, SUM(amount) AS revenue FROM analytics.fct_orders GROUP BY region',
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'insufficient_context',
    });
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
      certifiedCandidateFits: [],
      candidateConflicts: [],
    },
    freshness: {
      catalogPath: '.dql/cache/metadata.sqlite',
      builtAt: null,
      fingerprint: null,
    },
  };
}
