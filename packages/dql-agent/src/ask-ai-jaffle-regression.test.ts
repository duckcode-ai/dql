import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultKgPath,
  reindexProject,
} from './index.js';
import { answer as answerBase, type AgentResultPayload } from './answer-loop.js';
import { KGStore } from './kg/sqlite-fts.js';
import type { KGNode } from './kg/types.js';
import { buildLocalContextPack, openMetadataCatalog } from './metadata/catalog.js';
import { expandGroundingFromCatalog } from './grounding/regrounding.js';
import type { AgentMessage, AgentProvider } from './providers/types.js';
import type { ResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import { createHybridRouter } from './router.js';
import { SemanticLayer, type MetricCapabilityContract } from '@duckcodeailabs/dql-core';
import type { AgentEvidenceCandidate } from './meaning-resolution.js';

class ThrowingProvider implements AgentProvider {
  readonly name = 'openai' as const;
  readonly calls: AgentMessage[][] = [];

  async available(): Promise<boolean> {
    return true;
  }

  async generate(messages: AgentMessage[]): Promise<string> {
    this.calls.push(messages);
    throw new Error('Unexpected provider call in deterministic Ask AI regression');
  }
}

class SequencedProvider implements AgentProvider {
  readonly name = 'openai' as const;
  readonly calls: AgentMessage[][] = [];

  constructor(private readonly responses: string[]) {}

  async available(): Promise<boolean> {
    return true;
  }

  async generate(messages: AgentMessage[]): Promise<string> {
    this.calls.push(messages);
    return this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)] ?? '';
  }
}

describe('Ask AI jaffle-shop regression', () => {
  let projectRoot: string;
  let db: Database.Database;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-ask-ai-jaffle-'));
    seedJaffleProject(projectRoot);
    db = new Database(':memory:');
    seedJaffleDatabase(db);
    await reindexProject(projectRoot, { loadSkills: false });
  });

  afterEach(() => {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('demotes wrong certified blocks and carries category context into the customer follow-up', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new SequencedProvider([
        [
          '```json',
          JSON.stringify({
            summary: 'Product revenue by category generated from certified category context.',
            sql: [
              'SELECT',
              '  product_name AS product_name,',
              "  CASE WHEN product_type = 'jaffle' THEN 'Food' WHEN product_type = 'beverage' THEN 'Drink' ELSE product_type END AS category,",
              '  SUM(product_price) AS revenue',
              'FROM order_items',
              'GROUP BY 1, 2',
              'ORDER BY revenue DESC',
              'LIMIT 10',
            ].join('\n'),
            viz: 'bar',
            outputs: ['product_name', 'category', 'revenue'],
          }),
          '```',
        ].join('\n'),
        [
          '```json',
          JSON.stringify({
            summary: 'Top customers for the prior categories generated from order items and customer metadata.',
            sql: [
              'SELECT',
              '  c.customer_name AS customer_name,',
              '  f.product_type AS category,',
              '  SUM(f.product_price) AS revenue',
              'FROM order_items AS f',
              'JOIN fct_orders AS o ON f.order_id = o.order_id',
              'JOIN dim_customers AS c ON o.customer_id = c.customer_id',
              "WHERE f.product_type IN ('jaffle', 'beverage')",
              'GROUP BY c.customer_name, f.product_type',
              'ORDER BY revenue DESC',
              'LIMIT 5',
            ].join('\n'),
            viz: 'table',
            outputs: ['customer_name', 'category', 'revenue'],
          }),
          '```',
        ].join('\n'),
        [
          '```json',
          JSON.stringify({
            summary: 'Top customers for the carried-forward prior categories generated from order items and customer metadata.',
            sql: [
              'SELECT',
              '  c.customer_name AS customer_name,',
              '  f.product_type AS category,',
              '  SUM(f.product_price) AS revenue',
              'FROM order_items AS f',
              'JOIN fct_orders AS o ON f.order_id = o.order_id',
              'JOIN dim_customers AS c ON o.customer_id = c.customer_id',
              "WHERE f.product_type IN ('jaffle', 'beverage')",
              'GROUP BY c.customer_name, f.product_type',
              'ORDER BY revenue DESC',
              'LIMIT 5',
            ].join('\n'),
            viz: 'table',
            outputs: ['customer_name', 'category', 'revenue'],
          }),
          '```',
        ].join('\n'),
      ]);
      const firstQuestion =
        'Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue etc';
      const firstContextPack = await buildLocalContextPack(projectRoot, {
        question: firstQuestion,
        limit: 40,
      });

      const firstAnswer = await answerBase({
        question: firstQuestion,
        kg,
        provider,
        contextPack: firstContextPack,
        executeCertifiedBlock,
        executeGeneratedSql,
      });

      expect(firstAnswer.kind).toBe('uncertified');
      expect(firstAnswer.sourceCertifiedBlock).not.toBe('food_vs_drink_revenue');
      expect(firstAnswer.proposedSql).toMatch(/CASE\s+WHEN\s+product_type\s+=\s+'jaffle'\s+THEN\s+'Food'/i);
      expect(firstAnswer.proposedSql).toMatch(/WHEN\s+product_type\s+=\s+'beverage'\s+THEN\s+'Drink'/i);
      expect(firstAnswer.proposedSql).toMatch(/SUM\s*\(\s*product_price\s*\)\s+AS\s+revenue/i);
      expect(firstAnswer.result?.columns).toEqual(['product_name', 'category', 'revenue']);
      expect(firstAnswer.result?.rowCount).toBeGreaterThan(0);
      expect(firstContextPack.retrievalDiagnostics.certifiedCandidateFits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'food_vs_drink_revenue',
            action: expect.stringMatching(/context_only|rejected_for_fit/),
            fit: expect.objectContaining({
              missingOutputs: expect.arrayContaining(['product_name']),
              missingDimensions: expect.arrayContaining(['product']),
            }),
          }),
        ]),
      );

      const categories = uniqueStrings(
        (firstAnswer.result?.rows as Array<Record<string, unknown>>)
          .map((row) => String(row.category ?? ''))
          .filter(Boolean),
      );
      expect(categories).toEqual(expect.arrayContaining(['Food', 'Drink']));

      const followUp = {
        kind: 'drilldown' as const,
        sourceBlockName: 'food_vs_drink_revenue',
        sourceQuestion: firstQuestion,
        sourceAnswer: firstAnswer.text,
        filters: categories,
        dimensions: ['category'],
        priorResultColumns: ['product_name', 'category', 'revenue'],
        priorResultValues: { category: categories },
        priorMeasures: ['revenue'],
      };
      const followUpQuestion = 'who are the top 5 customers for these categories?';
      const followUpContextPack = await buildLocalContextPack(projectRoot, {
        question: followUpQuestion,
        limit: 40,
        followUp,
      });
      const followUpAnswer = await answerBase({
        question: followUpQuestion,
        kg,
        provider,
        contextPack: followUpContextPack,
        followUp,
        executeCertifiedBlock,
        executeGeneratedSql,
      });

      expect(followUpAnswer.kind).toBe('uncertified');
      expect(followUpAnswer.sourceCertifiedBlock).not.toBe('top_customers');
      expect(followUpAnswer.proposedSql).toMatch(/JOIN\s+fct_orders/i);
      expect(followUpAnswer.proposedSql).toMatch(/JOIN\s+dim_customers/i);
      expect(followUpAnswer.proposedSql).toMatch(/f\.product_type\s+IN\s+\('jaffle', 'beverage'\)/i);
      expect(followUpAnswer.proposedSql).toMatch(/LIMIT\s+5/i);
      expect(followUpAnswer.result?.columns).toEqual(['customer_name', 'category', 'revenue']);
      expect(followUpAnswer.result?.rowCount).toBe(5);
      expect(followUpAnswer.evidence?.route).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: 'check_certified_candidate_fit',
            label: expect.stringContaining('top_customers'),
            detail: expect.stringContaining('category'),
          }),
        ]),
      );

      const bareFollowUpQuestion = 'who are the top 5 customers for those?';
      const bareFollowUpContextPack = await buildLocalContextPack(projectRoot, {
        question: bareFollowUpQuestion,
        limit: 40,
        followUp,
      });
      const bareFollowUpAnswer = await answerBase({
        question: bareFollowUpQuestion,
        kg,
        provider,
        contextPack: bareFollowUpContextPack,
        followUp,
        executeCertifiedBlock,
        executeGeneratedSql,
      });

      expect(bareFollowUpAnswer.kind).toBe('uncertified');
      expect(bareFollowUpAnswer.sourceCertifiedBlock).not.toBe('top_customers');
      expect(bareFollowUpAnswer.proposedSql).toMatch(/f\.product_type\s+IN\s+\('jaffle', 'beverage'\)/i);
      expect(bareFollowUpAnswer.proposedSql).toMatch(/LIMIT\s+5/i);
      expect(bareFollowUpAnswer.result?.columns).toEqual(['customer_name', 'category', 'revenue']);
      expect(bareFollowUpAnswer.result?.rowCount).toBe(5);
    } finally {
      kg.close();
    }
  });

  it('does not certify product blocks for misspelled beverage customer questions', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new SequencedProvider([
        [
          '```json',
          JSON.stringify({
            summary: 'Top beverage customers generated from order items, orders, and customer metadata.',
            sql: [
              'SELECT',
              '  c.customer_name AS customer_name,',
              '  f.product_type AS category,',
              '  SUM(f.product_price) AS revenue,',
              '  COUNT(*) AS units',
              'FROM order_items AS f',
              'JOIN fct_orders AS o ON f.order_id = o.order_id',
              'JOIN dim_customers AS c ON o.customer_id = c.customer_id',
              "WHERE f.product_type = 'beverage'",
              'GROUP BY c.customer_name, f.product_type',
              'ORDER BY revenue DESC, units DESC',
              'LIMIT 10',
            ].join('\n'),
            viz: 'bar',
            outputs: ['customer_name', 'category', 'revenue', 'units'],
          }),
          '```',
        ].join('\n'),
      ]);
      const question = 'who are the best cusomers for buying the beverage products?';
      const contextPack = await buildLocalContextPack(projectRoot, {
        question,
        limit: 40,
      });

      const result = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        executeCertifiedBlock,
        executeGeneratedSql,
      });

      expect(result.kind).toBe('uncertified');
      expect(result.sourceCertifiedBlock).not.toBe('top_products');
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.map((message) => message.content).join('\n\n')).toContain('order_items');
      expect(result.proposedSql).toMatch(/JOIN\s+fct_orders/i);
      expect(result.proposedSql).toMatch(/JOIN\s+dim_customers/i);
      expect(result.proposedSql).toMatch(/WHERE\s+f\.product_type\s+=\s+'beverage'/i);
      expect(result.proposedSql).toMatch(/SUM\s*\(\s*f\.product_price\s*\)\s+AS\s+revenue/i);
      expect(result.proposedSql).not.toMatch(/\bf\.revenue\b/i);
      expect(result.result?.columns).toEqual(['customer_name', 'category', 'revenue', 'units']);
      expect(result.result?.rowCount).toBe(5);
      // 'product' and 'customer' are extracted generically from the question words;
      // 'category' is no longer injected by a jaffle-specific 'beverage' rule.
      expect(contextPack.questionPlan.requestedShape.dimensions).toEqual(
        expect.arrayContaining(['customer', 'product']),
      );
      // top_products is a product block; a customer question must NOT certify it as
      // the answer. It's used as context at most (context_only / rejected_for_fit),
      // and its fit is missing the customer dimension.
      const topProductsFit = contextPack.retrievalDiagnostics.certifiedCandidateFits
        .find((candidate) => candidate.name === 'top_products');
      expect(topProductsFit).toBeDefined();
      expect(['context_only', 'rejected_for_fit', 'not_applicable']).toContain(topProductsFit!.action);
      expect(topProductsFit!.fit?.missingDimensions ?? []).toEqual(expect.arrayContaining(['customer']));
    } finally {
      kg.close();
    }
  });

  it('AGT-005/AGT-006 does not answer beverage spend with the broad top-customers block', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new SequencedProvider([[
        '```json',
        JSON.stringify({
          summary: 'Top customers by beverage spend.',
          sql: [
            'SELECT c.customer_name, SUM(f.product_price) AS beverage_spend',
            'FROM order_items AS f',
            'JOIN fct_orders AS o ON f.order_id = o.order_id',
            'JOIN dim_customers AS c ON o.customer_id = c.customer_id',
            "WHERE f.product_type = 'beverage'",
            'GROUP BY c.customer_name',
            'ORDER BY beverage_spend DESC',
            'LIMIT 10',
          ].join('\n'),
          viz: 'bar',
          outputs: ['customer_name', 'beverage_spend'],
        }),
        '```',
      ].join('\n')]);
      const question = 'who are the customers who spent most on beverages?';
      const contextPack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      const result = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        executeCertifiedBlock,
        executeGeneratedSql,
      });

      expect(result.sourceCertifiedBlock).not.toBe('top_customers');
      expect(result.proposedSql).toMatch(/product_type\s*=\s*'beverage'/i);
      expect(result.result?.columns).toEqual(['customer_name', 'beverage_spend']);
      expect(contextPack.questionPlan.requestedShape).toMatchObject({
        grain: 'customer',
        measures: expect.arrayContaining(['spend']),
        filters: expect.arrayContaining(['beverage']),
        rankingDirection: 'top',
      });
      expect(contextPack.retrievalDiagnostics.certifiedCandidateFits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'top_customers',
          action: expect.stringMatching(/context_only|rejected_for_fit/),
          fit: expect.objectContaining({ unsupportedFilters: expect.arrayContaining(['beverage']) }),
        }),
      ]));
    } finally {
      kg.close();
    }
  });

  it('E2E-010 preserves a named product binding, rejects the broad profile, and generates once', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new SequencedProvider([[
        '```json',
        JSON.stringify({
          summary: 'Customers who purchased Flame Impala, ranked by product revenue.',
          sql: [
            'SELECT c.customer_name, f.product_name, SUM(f.product_price) AS revenue',
            'FROM order_items AS f',
            'JOIN fct_orders AS o ON f.order_id = o.order_id',
            'JOIN dim_customers AS c ON o.customer_id = c.customer_id',
            "WHERE LOWER(f.product_name) = LOWER('flame impala')",
            'GROUP BY c.customer_name, f.product_name',
            'ORDER BY revenue DESC',
            'LIMIT 10',
          ].join('\n'),
          viz: 'bar',
          outputs: ['customer_name', 'product_name', 'revenue'],
        }),
        '```',
      ].join('\n')]);
      const question = 'who are the customer from flame impala';
      const followUp = {
        kind: 'drilldown' as const,
        filters: ['flame impala'],
        dimensions: ['customer', 'product'],
        priorResultColumns: ['product_name', 'region', 'revenue'],
        priorResultValues: { product_name: ['flame impala'] },
        priorMeasures: ['revenue'],
        memberBindings: [{
          dimension: 'product',
          values: ['flame impala'],
          source: 'prior_result' as const,
          confidence: 'exact' as const,
          sourceTurnId: 'turn_products',
        }],
        resolvedReferences: ['product: flame impala'],
      };
      const contextPack = await buildLocalContextPack(projectRoot, { question, followUp, limit: 40 });
      const result = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        followUp,
        executeCertifiedBlock,
        executeGeneratedSql,
      });

      expect(result.sourceCertifiedBlock).not.toBe('top_customers');
      expect(result.proposedSql).toMatch(/product_name\)\s*=\s*LOWER\('flame impala'\)/i);
      expect(result.result?.columns).toEqual(['customer_name', 'product_name', 'revenue']);
      expect(result.result?.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ customer_name: 'Alice Johnson', product_name: 'Flame Impala' }),
      ]));
      expect(provider.calls).toHaveLength(1);
      expect(contextPack.questionPlan.requestedShape.memberBindings).toEqual(followUp.memberBindings);
      expect(contextPack.retrievalDiagnostics.certifiedCandidateFits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'top_customers',
          action: expect.stringMatching(/context_only|rejected_for_fit/),
          fit: expect.objectContaining({ unsupportedFilters: expect.arrayContaining(['flame impala']) }),
        }),
      ]));
    } finally {
      kg.close();
    }
  });

  it('answers product, supply, and order detail questions and expands follow-ups without grounding dead-ends', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new SequencedProvider([
        [
          '```sql',
          'SELECT',
          '  oi.product_id,',
          '  oi.order_id,',
          '  s.supply_id,',
          '  s.supply_name,',
          '  SUM(oi.product_price) AS product_value,',
          '  SUM(s.supply_cost) AS supply_cost',
          'FROM order_items oi',
          'JOIN supplies s ON oi.product_id = s.product_id',
          'GROUP BY oi.product_id, oi.order_id, s.supply_id, s.supply_name',
          'ORDER BY product_value DESC',
          'LIMIT 10',
          '```',
        ].join('\n'),
        [
          '```sql',
          'SELECT',
          '  oi.product_id,',
          '  oi.product_name,',
          '  oi.product_type,',
          '  oi.order_id,',
          '  s.supply_id,',
          '  s.supply_name,',
          '  s.supply_cost,',
          '  oi.product_price AS product_value',
          'FROM order_items oi',
          'JOIN supplies s ON oi.product_id = s.product_id',
          'ORDER BY product_value DESC, oi.product_id, s.supply_id',
          'LIMIT 10',
          '```',
        ].join('\n'),
      ]);
      const question = 'Can you give me the complete supply chain with product and order details with top 10 value';
      const contextPack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      const firstAnswer = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        executeCertifiedBlock,
        executeGeneratedSql,
        expandGroundingContext: createCatalogExpander(projectRoot),
      });

      expect(firstAnswer.kind).toBe('uncertified');
      expect(firstAnswer.proposedSql).toMatch(/JOIN\s+supplies/i);
      expect(firstAnswer.result?.columns).toEqual([
        'product_id',
        'order_id',
        'supply_id',
        'supply_name',
        'product_value',
        'supply_cost',
      ]);
      expect(firstAnswer.result?.rowCount).toBe(10);
      expect(firstAnswer.text).not.toMatch(/needs more context|could not safely/i);

      const followUp = {
        kind: 'drilldown' as const,
        sourceQuestion: question,
        sourceAnswer: firstAnswer.text,
        priorResultColumns: ['product_id', 'order_id', 'supply_id', 'supply_name', 'product_value', 'supply_cost'],
        priorResultValues: {
          product_id: uniqueStrings(
            (firstAnswer.result?.rows as Array<Record<string, unknown>>).map((row) => String(row.product_id)),
          ),
          supply_id: uniqueStrings(
            (firstAnswer.result?.rows as Array<Record<string, unknown>>).map((row) => String(row.supply_id)),
          ),
        },
        priorMeasures: ['product_value', 'supply_cost'],
      };
      const followUpQuestion = 'can you include the product details with previous results and give me final including all values';
      const followUpContextPack = await buildLocalContextPack(projectRoot, {
        question: followUpQuestion,
        limit: 40,
        followUp,
      });
      const followUpAnswer = await answerBase({
        question: followUpQuestion,
        kg,
        provider,
        contextPack: followUpContextPack,
        followUp,
        executeCertifiedBlock,
        executeGeneratedSql,
        expandGroundingContext: createCatalogExpander(projectRoot),
      });

      expect(followUpAnswer.kind).toBe('uncertified');
      expect(followUpAnswer.proposedSql).toMatch(/JOIN\s+supplies/i);
      expect(followUpAnswer.result?.columns).toEqual([
        'product_id',
        'product_name',
        'product_type',
        'order_id',
        'supply_id',
        'supply_name',
        'supply_cost',
        'product_value',
      ]);
      expect(followUpAnswer.result?.rowCount).toBe(10);
      expect(followUpAnswer.text).not.toMatch(/needs more context|could not safely/i);
    } finally {
      kg.close();
    }
  });

  it('contextual carry neither excludes certified artifacts nor forces prior filters onto a topic shift', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new ThrowingProvider();
      // Prior turn answered from the category revenue block. The user now shifts
      // topic with a question matching NEITHER follow-up regex — always-on carry
      // attaches the prior turn as advisory 'contextual' state instead of dropping it.
      const followUp = {
        kind: 'contextual' as const,
        sourceBlockName: 'food_vs_drink_revenue',
        sourceQuestion: 'Revenue split between food and drink',
        sourceAnswer: 'Food 240877, Drink 396567.',
        priorResultColumns: ['category', 'revenue'],
        priorResultValues: { category: ['Food', 'Drink'] },
        priorMeasures: ['revenue'],
      };
      const question = 'who are our top customers?';
      const contextPack = await buildLocalContextPack(projectRoot, {
        question,
        limit: 40,
        followUp,
      });

      // Advisory carry must not leak the prior turn's filters or measures into the
      // new question's requested shape (that would bias the fit gate to the old topic).
      expect(contextPack.questionPlan.requestedShape.filters).not.toEqual(expect.arrayContaining(['Food']));
      expect(contextPack.questionPlan.requestedShape.filters).not.toEqual(expect.arrayContaining(['Drink']));
      expect(contextPack.questionPlan.requestedShape.measures).not.toEqual(expect.arrayContaining(['revenue']));

      const result = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        followUp,
        executeCertifiedBlock,
        executeGeneratedSql,
      });

      // No artifact exclusion: the certified block that matches the NEW question is
      // still served as certified — contextual carry never derails certified routing.
      expect(result.sourceCertifiedBlock).toBe('top_customers');
      expect(result.kind).toBe('certified');
      expect(result.result?.columns).toEqual(['customer_name', 'lifetime_spend', 'order_count']);
    } finally {
      kg.close();
    }
  });

  it('executes the complete Jaffle monthly-revenue block before a semantic fallback can freeze time (AGT-027)', async () => {
    // This mirrors the Jaffle fixture's certified contract: the block answers
    // monthly revenue directly, while `gross_revenue` is a generic output
    // modifier rather than a business scope such as beverage or priority.
    writeFileSync(join(projectRoot, 'blocks', 'monthly_revenue.dql'), `block "monthly_revenue" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Monthly gross order revenue and order count. One row per calendar month."
  tags = ["revenue", "trend", "growth"]
  grain = "one row per calendar month"
  entities = ["order"]
  outputs = ["month", "gross_revenue", "order_count"]
  dimensions = ["month"]
  query = """
    SELECT
      strftime('%Y-%m-01', ordered_at) AS month,
      SUM(product_price) AS gross_revenue,
      COUNT(*) AS order_count
    FROM order_items
    GROUP BY 1
    ORDER BY 1
  """
}`,'utf-8');
    await reindexProject(projectRoot, { loadSkills: false });

    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new ThrowingProvider();
      const question = 'What is monthly revenue?';
      const contextPack = await buildLocalContextPack(projectRoot, { question, limit: 40 });

      expect(contextPack.routeDecision).toMatchObject({
        route: 'certified',
        exactObjectKey: 'dql:block:monthly_revenue',
        blockFit: { kind: 'exact', confidence: 'high' },
      });
      expect(contextPack.retrievalDiagnostics.certifiedCandidateFits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          objectKey: 'dql:block:monthly_revenue',
          action: 'certified_answer',
          fit: expect.objectContaining({ kind: 'exact', confidence: 'high' }),
        }),
      ]));

      const result = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        executeCertifiedBlock,
        executeGeneratedSql,
      });

      expect(provider.calls).toHaveLength(0);
      expect(result).toMatchObject({
        kind: 'certified',
        sourceCertifiedBlock: 'monthly_revenue',
        certification: 'certified',
      });
      expect(result.result?.columns).toEqual(['month', 'gross_revenue', 'order_count']);
      expect(result.result?.sql).toContain("strftime('%Y-%m-01', ordered_at)");
    } finally {
      kg.close();
    }
  });

  it('AGT-034 freezes and executes the exact individual order-item question once as review-required exploration', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new ThrowingProvider();
      const question = 'Show the five most expensive individual order items with order ID, product ID, and product price.';
      const contextPack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      const orderItemsObject = contextPack.objects.find((object) =>
        object.objectKey === 'dbt:model:order_items'
        || object.fullName === 'order_items'
        || object.payload?.relation === 'order_items');
      const orderItemsRelation = contextPack.allowedSqlContext.relations.find((relation) =>
        relation.relation === 'order_items');

      // This is the exact router-owned physical closure used by the
      // exploratory authorizer. The test intentionally does not make the
      // neighbouring customer/order models executable just because they were
      // retrieved in the same Jaffle snapshot.
      expect(orderItemsObject).toBeDefined();
      expect(orderItemsRelation).toBeDefined();
      const exploratoryCandidateIds = [orderItemsObject!.objectKey];
      orderItemsRelation!.objectKey = orderItemsObject!.objectKey;
      const sql = [
        'SELECT order_items.order_id AS order_id, order_items.product_id AS product_id, order_items.product_price AS product_price',
        'FROM order_items',
        'ORDER BY product_price DESC',
        'LIMIT 5',
      ].join('\n');
      const capability = {
        version: 1 as const,
        runId: 'fixture-order-item-exploratory',
        executionId: 'fixture-order-item-exploratory:initial',
        snapshotId: contextPack.freshness.fingerprint,
        planId: 'rap:fixture-order-item-exploratory',
        targetFingerprint: 'target:fixture-order-items',
        bindingsFingerprint: 'bindings:fixture-order-items',
        candidateSqlFingerprint: 'fixture-order-items-sql',
        provenIdentifiers: [
          'order_items',
          'order_items.order_id',
          'order_items.product_id',
          'order_items.product_price',
        ],
        evidence: {
          order_items: 'schema_tool' as const,
          'order_items.order_id': 'schema_tool' as const,
          'order_items.product_id': 'schema_tool' as const,
          'order_items.product_price': 'schema_tool' as const,
        },
        exploratoryAuthorizationAttempt: { version: 1 as const, index: 0 as const },
      };
      const freeze = {
        version: 1 as const,
        selectedTier: 'exploratory_sql' as const,
        planId: capability.planId,
        planFingerprint: 'f'.repeat(64),
        snapshotId: capability.snapshotId,
        targetFingerprint: capability.targetFingerprint,
        sqlFingerprint: 'a'.repeat(32),
        candidateIds: exploratoryCandidateIds,
        authorization: 'capability_minted' as const,
        requiredOutputBindings: [
          { version: 1 as const, outputName: 'order_id', qualifiedId: 'dbt:column:order_items.order_id', relation: 'order_items', column: 'order_id' },
          { version: 1 as const, outputName: 'product_id', qualifiedId: 'dbt:column:order_items.product_id', relation: 'order_items', column: 'product_id' },
          { version: 1 as const, outputName: 'product_price', qualifiedId: 'dbt:column:order_items.product_price', relation: 'order_items', column: 'product_price' },
        ],
        authorizationAttempt: { version: 1 as const, index: 0 as const },
      };
      // The route freezes explicit outputs as projection bindings, rather than
      // turning `order ID` / `product ID` into grouping dimensions.  The
      // answer loop uses this exact host-owned contract after execution too,
      // so an adapter cannot return a closest partial table.
      const frozenOutputPlan = {
        schemaVersion: 1,
        mode: 'authoritative',
        planId: capability.planId,
        fingerprint: freeze.planFingerprint,
        snapshotId: capability.snapshotId,
        question,
        interpretedQuestion: question,
        questionType: 'ranking',
        confidence: 'high',
        selectedConceptIds: exploratoryCandidateIds,
        recommendedRoute: 'exploratory',
        capability: 'bounded_exploration',
        query: {
          measures: [{ requested: 'product price', qualifiedId: 'dbt:column:order_items.product_price', status: 'resolved', candidateIds: ['dbt:column:order_items.product_price'] }],
          dimensions: [],
          filters: [],
          order: 'desc',
          limit: 5,
        },
        // The frozen plan carries its physical SQL closure separately from
        // its selected evidence IDs. A dbt-model evidence ID is not itself a
        // relation proof for output projection authorization.
        sourceRelationIds: ['order_items'],
        relationshipPathIds: [],
        compatibilityProof: [],
        outputContract: {
          measures: ['product_price'],
          dimensions: [],
          requiredOutputs: [
            { requested: 'order id', qualifiedId: 'dbt:column:order_items.order_id', outputName: 'order_id', status: 'resolved', candidateIds: ['dbt:column:order_items.order_id'] },
            { requested: 'product id', qualifiedId: 'dbt:column:order_items.product_id', outputName: 'product_id', status: 'resolved', candidateIds: ['dbt:column:order_items.product_id'] },
            { requested: 'product price', qualifiedId: 'dbt:column:order_items.product_price', outputName: 'product_price', status: 'resolved', candidateIds: ['dbt:column:order_items.product_price'] },
          ],
        },
        evidenceIds: exploratoryCandidateIds,
        rejectedCandidates: [],
        missingInformation: [],
      } as ResolvedAnalyticalPlan;
      let prepareCalls = 0;
      let executionCalls = 0;
      const result = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds,
        resolvedAnalyticalPlan: frozenOutputPlan,
        forcedGeneratedProposal: { sql, summary: 'The five most expensive individual order items.' },
        prepareExploratorySqlExecution: async (preparedSql) => {
          prepareCalls += 1;
          expect(preparedSql).toBe(sql);
          return { capability, freeze };
        },
        executeAgenticGeneratedSql: async (receivedCapability, preparedSql) => {
          executionCalls += 1;
          expect(receivedCapability).toBe(capability);
          return executeSql(preparedSql);
        },
      });

      expect(provider.calls).toHaveLength(0);
      expect(prepareCalls).toBe(1);
      expect(executionCalls).toBe(1);
      expect(result).toMatchObject({
        kind: 'uncertified',
        certification: 'ai_generated',
        reviewStatus: 'draft_ready',
        exploratoryExecutionFreeze: freeze,
      });
      expect(result.proposedSql).toBe(sql);
      expect(result.result).toMatchObject({
        columns: ['order_id', 'product_id', 'product_price'],
        rowCount: 5,
      });
      expect((result.result?.rows as Array<Record<string, unknown>>).map((row) => row.product_price)).toEqual([
        13.5, 12, 12, 12, 12,
      ]);

      // An output alias cannot borrow a sibling column.  The plan selected the
      // exact order-id binding, so `product_id AS order_id` must be denied
      // before a host authorization or warehouse execution is attempted.
      let spoofedAuthorizations = 0;
      let spoofedExecutions = 0;
      const spoofedOutputResult = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds,
        resolvedAnalyticalPlan: frozenOutputPlan,
        forcedGeneratedProposal: {
          sql: [
            'SELECT order_items.product_id AS order_id, order_items.product_id AS product_id, order_items.product_price AS product_price',
            'FROM order_items',
            'ORDER BY product_price DESC',
            'LIMIT 5',
          ].join('\n'),
          summary: 'Spoofed output alias.',
        },
        prepareExploratorySqlExecution: async () => {
          spoofedAuthorizations += 1;
          return { capability, freeze };
        },
        executeAgenticGeneratedSql: async () => {
          spoofedExecutions += 1;
          return executeSql(sql);
        },
      });
      expect(spoofedAuthorizations).toBe(0);
      expect(spoofedExecutions).toBe(0);
      expect(spoofedOutputResult).toMatchObject({
        kind: 'no_answer',
        certification: 'analyst_review_required',
        reviewStatus: 'none',
      });
      expect(spoofedOutputResult.text).toContain('order_id');

      // Result column names alone are insufficient.  A server-owned receipt
      // must retain the exact parser proof generated at authorization time.
      const unprovenFreeze = { ...freeze, requiredOutputBindings: [] };
      const unprovenResult = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds,
        resolvedAnalyticalPlan: frozenOutputPlan,
        forcedGeneratedProposal: { sql, summary: 'Unproven output receipt.' },
        prepareExploratorySqlExecution: async () => ({ capability, freeze: unprovenFreeze }),
        executeAgenticGeneratedSql: async () => executeSql(sql),
      });
      expect(unprovenResult).toMatchObject({
        kind: 'no_answer',
        certification: 'analyst_review_required',
        reviewStatus: 'none',
        result: undefined,
      });
      expect(unprovenResult.text).toContain('order_id');

      const missingOutputResult = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds,
        resolvedAnalyticalPlan: frozenOutputPlan,
        forcedGeneratedProposal: { sql, summary: 'The five most expensive individual order items.' },
        prepareExploratorySqlExecution: async () => ({ capability, freeze }),
        executeAgenticGeneratedSql: async () => ({
          columns: ['product_id', 'product_price'],
          rows: [{ product_id: 'JF001', product_price: 13.5 }],
          rowCount: 1,
        }),
      });

      // Q3 negative: explicit identifiers are not optional enrichment.  A
      // returned result missing `order_id` must not become a visible
      // review-required table or a reusable SQL/draft artifact.
      expect(missingOutputResult).toMatchObject({
        kind: 'no_answer',
        certification: 'analyst_review_required',
        reviewStatus: 'none',
        result: undefined,
      });
      expect(missingOutputResult.proposedSql).toBeUndefined();
      expect(missingOutputResult.text).toContain('order_id');
      expect(missingOutputResult.validationWarnings).toEqual(expect.arrayContaining([
        expect.stringContaining('frozen output contract: order_id'),
      ]));
    } finally {
      kg.close();
    }
  });

  it('AGT-031 permits one same-plan repair for the Jaffle order-item exploration and denies a second repair', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const provider = new ThrowingProvider();
      const question = 'Show the five most expensive individual order items with order ID, product ID, and product price.';
      const contextPack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      const orderItemsObject = contextPack.objects.find((object) =>
        object.objectKey === 'dbt:model:order_items'
        || object.fullName === 'order_items'
        || object.payload?.relation === 'order_items');
      const orderItemsRelation = contextPack.allowedSqlContext.relations.find((relation) =>
        relation.relation === 'order_items');
      expect(orderItemsObject).toBeDefined();
      expect(orderItemsRelation).toBeDefined();
      const exploratoryCandidateIds = [orderItemsObject!.objectKey];
      orderItemsRelation!.objectKey = orderItemsObject!.objectKey;
      const initialSql = [
        'SELECT order_id, product_id, product_price',
        'FROM order_items AS oi',
        'ORDER BY product_price DESC',
        'LIMIT 5',
      ].join('\n');
      const initialCapability = {
        version: 1 as const,
        runId: 'fixture-order-item-repair',
        executionId: 'fixture-order-item-repair:initial',
        snapshotId: contextPack.freshness.fingerprint,
        planId: 'rap:fixture-order-item-repair',
        targetFingerprint: 'target:fixture-order-item-repair',
        bindingsFingerprint: 'bindings:fixture-order-item-repair',
        candidateSqlFingerprint: 'a'.repeat(32),
        provenIdentifiers: [
          'order_items',
          'order_items.order_id',
          'order_items.product_id',
          'order_items.product_price',
        ],
        evidence: {
          order_items: 'schema_tool' as const,
          'order_items.order_id': 'schema_tool' as const,
          'order_items.product_id': 'schema_tool' as const,
          'order_items.product_price': 'schema_tool' as const,
        },
        exploratoryAuthorizationAttempt: { version: 1 as const, index: 0 as const },
      };
      const repairCapability = {
        ...initialCapability,
        executionId: 'fixture-order-item-repair:repair-1',
        candidateSqlFingerprint: 'b'.repeat(32),
        exploratoryAuthorizationAttempt: {
          version: 1 as const,
          index: 1 as const,
          parentSqlFingerprint: 'a'.repeat(32),
        },
      };
      const initialFreeze = {
        version: 1 as const,
        selectedTier: 'exploratory_sql' as const,
        planId: initialCapability.planId,
        planFingerprint: 'f'.repeat(64),
        snapshotId: initialCapability.snapshotId,
        targetFingerprint: initialCapability.targetFingerprint,
        sqlFingerprint: 'a'.repeat(32),
        candidateIds: exploratoryCandidateIds,
        authorization: 'capability_minted' as const,
        authorizationAttempt: { version: 1 as const, index: 0 as const },
      };
      const repairFreeze = {
        ...initialFreeze,
        sqlFingerprint: 'b'.repeat(32),
        authorizationAttempt: {
          version: 1 as const,
          index: 1 as const,
          parentSqlFingerprint: initialFreeze.sqlFingerprint,
        },
      };
      const preparationAttempts: Array<{ index: 0 | 1; parentSqlFingerprint?: string }> = [];
      let executionCalls = 0;
      const result = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds,
        forcedGeneratedProposal: { sql: initialSql },
        prepareExploratorySqlExecution: async (_sql, _artifact, attempt) => {
          preparationAttempts.push(attempt ?? { index: 0 });
          return attempt
            ? { capability: repairCapability, freeze: repairFreeze }
            : { capability: initialCapability, freeze: initialFreeze };
        },
        executeAgenticGeneratedSql: async (_capability, sql) => {
          executionCalls += 1;
          if (executionCalls === 1) {
            throw new Error('Binder Error: ambiguous column name order_id');
          }
          return executeSql(sql);
        },
      });

      expect(provider.calls).toHaveLength(0);
      expect(preparationAttempts).toEqual([
        { index: 0 },
        { version: 1, index: 1, parentSqlFingerprint: initialFreeze.sqlFingerprint },
      ]);
      expect(executionCalls).toBe(2);
      expect(result.proposedSql).toContain('oi.order_id');
      expect(result).toMatchObject({
        certification: 'ai_generated',
        reviewStatus: 'draft_ready',
        exploratoryExecutionFreeze: initialFreeze,
        exploratoryRepairExecutionFreeze: repairFreeze,
      });
      expect(result.result?.rowCount).toBe(5);

      // A second retryable warehouse failure must not mint another capability,
      // replan, or fall back to an ambient generated-SQL executor.
      const deniedPrepares: Array<{ index: 0 | 1; parentSqlFingerprint?: string }> = [];
      let deniedExecutions = 0;
      const denied = await answerBase({
        question,
        kg,
        provider,
        contextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds,
        forcedGeneratedProposal: { sql: initialSql },
        prepareExploratorySqlExecution: async (_sql, _artifact, attempt) => {
          deniedPrepares.push(attempt ?? { index: 0 });
          return attempt
            ? { capability: repairCapability, freeze: repairFreeze }
            : { capability: initialCapability, freeze: initialFreeze };
        },
        executeAgenticGeneratedSql: async () => {
          deniedExecutions += 1;
          throw new Error('Binder Error: ambiguous column name order_id');
        },
      });

      expect(deniedPrepares).toEqual([
        { index: 0 },
        { version: 1, index: 1, parentSqlFingerprint: initialFreeze.sqlFingerprint },
      ]);
      expect(deniedExecutions).toBe(2);
      // The failed draft remains visibly review-required for diagnosis, but
      // the bounded repair contract stopped at the one authorized retry.
      expect(denied).toMatchObject({
        kind: 'uncertified',
        certification: 'ai_generated',
        reviewStatus: 'analyst_review_required',
      });
      expect(denied.analysisPlan?.repairAttempts).toBe(1);
      expect(denied.exploratoryExecutionFreeze).toEqual(initialFreeze);
      expect(denied.exploratoryRepairExecutionFreeze).toEqual(repairFreeze);
    } finally {
      kg.close();
    }
  });

  it('AGT-017 freezes a complete two-metric month tuple, composes it through the pinned adapter, and executes it once', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const question = 'show revenue and refunds by month';
      const revenueId = 'semantic:metric:order_items.revenue';
      const refundsId = 'semantic:metric:order_items.refunds';
      const orderedAtId = 'semantic:dimension:order_items.ordered_at';
      const capabilityFor = (metricId: string): MetricCapabilityContract => ({
        metricId,
        semanticModelId: 'semantic:model:order_items',
        measureIds: [metricId],
        primaryEntityId: 'order_item',
        defaultResultGrainId: 'order_item',
        resultGrainIds: ['order_item'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [],
        timeDimensions: [{
          dimensionId: orderedAtId,
          role: 'event_time',
          supportedGrains: ['day', 'month'],
        }],
        operations: ['group'],
        supportedOutputKinds: ['dimension', 'metric_value'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-fixture' }],
        sourceFingerprint: 'fixture:order-items-multi-metric',
      });
      const revenueCapability = capabilityFor(revenueId);
      const refundsCapability = capabilityFor(refundsId);
      const candidates: AgentEvidenceCandidate[] = [
        {
          id: revenueId,
          qualifiedId: revenueId,
          kind: 'semantic_metric',
          trustTier: 'semantic',
          name: 'Revenue',
          aliases: ['revenue', 'sales'],
          sourceObjects: ['order_items'],
          relevanceScore: 1,
          matchReasons: ['exact fixture metric'],
          compatibility: 'compatible',
          analyticalCapability: revenueCapability,
        },
        {
          id: refundsId,
          qualifiedId: refundsId,
          kind: 'semantic_metric',
          trustTier: 'semantic',
          name: 'Refunds',
          aliases: ['refunds'],
          sourceObjects: ['order_items'],
          relevanceScore: 0.99,
          matchReasons: ['exact fixture metric'],
          compatibility: 'compatible',
          analyticalCapability: refundsCapability,
        },
        {
          id: orderedAtId,
          qualifiedId: orderedAtId,
          kind: 'semantic_member',
          semanticObjectType: 'dimension',
          trustTier: 'semantic',
          name: 'Ordered At',
          aliases: ['month', 'ordered at'],
          sourceObjects: ['order_items'],
          relevanceScore: 0.98,
          matchReasons: ['shared fixture time dimension'],
          compatibility: 'compatible',
        },
      ];
      const router = createHybridRouter({
        requireMeaningCallForNaturalLanguage: false,
        getEvidence: async () => ({
          snapshotId: 'fixture:jaffle-multi-metric',
          sourceFingerprint: 'fixture:jaffle-multi-metric',
          parsedIntent: { measures: ['revenue', 'refunds'], dimensions: [], filters: [], timeGrain: 'month' },
          candidates,
        }),
      });
      const decision = await router.decide({ question });

      expect(decision.analyticalCascadeDecision).toMatchObject({
        selectedTier: 'semantic',
        planFrozen: true,
      });
      expect(decision.resolvedAnalyticalPlan?.analyticalFrame?.version).toBe(2);
      expect(decision.resolvedAnalyticalPlan?.query).toMatchObject({
        measures: [
          expect.objectContaining({ requested: 'revenue', qualifiedId: revenueId }),
          expect.objectContaining({ requested: 'refunds', qualifiedId: refundsId }),
        ],
        timeGrain: 'month',
      });

      // The sanitized fixture already has the one-to-one order-item grain; add
      // its separate refund measure only for this exact semantic lifecycle.
      // This gives the safety proof two distinct, qualified aggregates rather
      // than pretending the same physical amount is two different metrics.
      db.exec('ALTER TABLE order_items ADD COLUMN refund_amount REAL NOT NULL DEFAULT 0');
      db.exec("UPDATE order_items SET refund_amount = CASE WHEN product_type = 'beverage' THEN product_price * 0.1 ELSE 0 END");

      const semanticLayer = new SemanticLayer({
        metrics: [
          {
            name: 'revenue', label: 'Revenue', description: 'Fixture revenue.', domain: 'commerce',
            sql: 'product_price', type: 'sum', table: 'order_items', cube: 'order_items', aggTimeDimension: 'ordered_at',
          },
          {
            name: 'refunds', label: 'Refunds', description: 'Fixture refunds.', domain: 'commerce',
            sql: 'refund_amount', type: 'sum', table: 'order_items', cube: 'order_items', aggTimeDimension: 'ordered_at',
          },
        ],
        dimensions: [{
          name: 'ordered_at', label: 'Ordered At', description: 'Fixture order time.', domain: 'commerce',
          sql: 'ordered_at', type: 'date', table: 'order_items', cube: 'order_items', isTimeDimension: true,
        }],
      });
      // Force the exact frozen member selection through the configured semantic
      // adapter. The adapter gets no chance to rematch only the first metric.
      vi.spyOn(semanticLayer, 'composeQuery').mockReturnValue(undefined);
      appendFixtureKgNodes(kg, [
        fixtureSemanticMetricNode(revenueId, 'revenue', revenueCapability, 'product_price'),
        fixtureSemanticMetricNode(refundsId, 'refunds', refundsCapability, 'refund_amount'),
        {
          nodeId: 'dimension:order_items.ordered_at',
          kind: 'dimension',
          name: 'order_items.ordered_at',
          domain: 'commerce',
          payload: { registryQualifiedId: orderedAtId, qualifiedId: orderedAtId, localId: 'ordered_at' },
        },
      ]);
      let compilerCalls = 0;
      let executorCalls = 0;
      const result = await answerBase({
        question,
        kg,
        provider: new ThrowingProvider(),
        semanticLayer,
        resolvedAnalyticalPlan: decision.resolvedAnalyticalPlan,
        selectedCascadeTier: 'semantic',
        semanticQueryCompiler: async (selection) => {
          compilerCalls += 1;
          expect(selection).toMatchObject({
            metrics: ['revenue', 'refunds'],
            timeDimension: { name: 'ordered_at', granularity: 'month' },
          });
          return {
            sql: [
              "SELECT strftime('%Y-%m-01', ordered_at) AS ordered_at_month,",
              '  SUM(product_price) AS revenue,',
              '  SUM(refund_amount) AS refunds',
              'FROM order_items',
              'GROUP BY 1',
              'ORDER BY 1',
            ].join('\n'),
            engine: 'metricflow-fixture' as const,
            selection,
            trace: {
              version: 1 as const,
              adapter: 'metricflow-fixture' as const,
              status: 'compiled' as const,
              authoringRequest: { metrics: selection.metrics, dimensions: selection.dimensions ?? [] },
              bindings: [],
              warnings: [],
              steps: [],
            },
          };
        },
        executeGeneratedSql: async (sql) => {
          executorCalls += 1;
          return executeSql(sql);
        },
      });

      expect(compilerCalls).toBe(1);
      expect(executorCalls).toBe(1);
      expect(result).toMatchObject({
        sourceTier: 'semantic_layer',
        certification: 'governed',
        reviewStatus: 'governed',
      });
      expect(result.result?.columns).toEqual(['ordered_at_month', 'revenue', 'refunds']);
      expect(result.result?.rowCount).toBeGreaterThan(0);
    } finally {
      kg.close();
    }
  });

  it('AGT-017 keeps different-model/adaptor multi-metric evidence pre-freeze and never compiles just the first metric', async () => {
    const question = 'show revenue and refunds by month';
    const revenueId = 'semantic:metric:order_items.revenue';
    const refundsId = 'semantic:metric:refunds.refunds';
    const orderedAtId = 'semantic:dimension:order_items.ordered_at';
    const capabilityFor = (metricId: string, semanticModelId: string, adapterId: string): MetricCapabilityContract => ({
      metricId,
      semanticModelId,
      measureIds: [metricId],
      primaryEntityId: 'order_item',
      defaultResultGrainId: 'order_item',
      resultGrainIds: ['order_item'],
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: [],
      timeDimensions: [{ dimensionId: orderedAtId, role: 'event_time', supportedGrains: ['month'] }],
      operations: ['group'],
      supportedOutputKinds: ['dimension', 'metric_value'],
      executionCapabilities: [{ route: 'semantic', adapterId }],
      sourceFingerprint: `fixture:${semanticModelId}`,
    });
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'fixture:jaffle-incompatible-multi-metric',
        sourceFingerprint: 'fixture:jaffle-incompatible-multi-metric',
        parsedIntent: { measures: ['revenue', 'refunds'], dimensions: [], filters: [], timeGrain: 'month' },
        candidates: [
          {
            id: revenueId, qualifiedId: revenueId, kind: 'semantic_metric', trustTier: 'semantic',
            name: 'Revenue', aliases: ['revenue'], relevanceScore: 1, matchReasons: ['exact fixture metric'],
            compatibility: 'compatible', analyticalCapability: capabilityFor(revenueId, 'semantic:model:order_items', 'metricflow-fixture'),
          },
          {
            id: refundsId, qualifiedId: refundsId, kind: 'semantic_metric', trustTier: 'semantic',
            name: 'Refunds', aliases: ['refunds'], relevanceScore: 0.99, matchReasons: ['exact fixture metric'],
            compatibility: 'compatible', analyticalCapability: capabilityFor(refundsId, 'semantic:model:refunds', 'different-metricflow-fixture'),
          },
        ],
      }),
    });
    const compiler = vi.fn();
    const decision = await router.decide({ question });

    expect(decision.analyticalCascadeDecision).toMatchObject({ planFrozen: false });
    expect(decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'semantic')).toMatchObject({
      outcome: expect.stringMatching(/ineligible|unavailable/),
      planFrozen: false,
    });
    expect(decision.resolvedAnalyticalPlan?.query).toMatchObject({
      measures: [
        expect.objectContaining({ requested: 'revenue', qualifiedId: revenueId }),
        expect.objectContaining({ requested: 'refunds', qualifiedId: refundsId }),
      ],
      timeGrain: 'month',
    });
    // There is no router-frozen semantic plan to hand to the adapter. In
    // particular, it cannot compile the first metric and erase `refunds`.
    expect(compiler).not.toHaveBeenCalled();
  });

  it('AGT-034 routes the exact region wording through semantic compilation and one fixture executor call', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const question = 'Show revenue by sales based on the region';
      // Match the packaged Jaffle semantic metadata shape from the built-CLI
      // failure: a revenue metric at order-item grain and a location display
      // key reachable only through the MetricFlow-native entity path.
      const metricId = 'semantic:order_item:revenue';
      const regionId = 'semantic:uncategorized:dimension:locations.location_name';
      const capability: MetricCapabilityContract = {
        metricId,
        semanticModelId: 'semantic:uncategorized:model:order_item',
        measureIds: ['semantic:uncategorized:measure:order_item.revenue'],
        primaryEntityId: 'semantic:uncategorized:entity:order_item.order_item',
        defaultResultGrainId: 'semantic:uncategorized:entity:order_item.order_item',
        resultGrainIds: [
          'semantic:uncategorized:entity:order_item.order_item',
          'semantic:uncategorized:entity:locations.location',
        ],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [{
          dimensionId: regionId,
          entityId: 'semantic:uncategorized:entity:locations.location',
          label: 'Location Name',
          aliases: ['region', 'location name'],
          supportedRoles: ['group_by', 'display'],
          nativeGroupingReference: 'order_id__location__location_name',
          nativeGroupingPath: ['order_id', 'location'],
          relationshipPathIds: [
            'commerce::relationship::order_to_location',
            'dql:relationship:commerce::relationship::order_to_location',
            'order_to_location',
          ],
        }],
        timeDimensions: [],
        operations: ['group'],
        supportedOutputKinds: ['dimension', 'metric_value'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
        sourceFingerprint: 'fixture:jaffle-order-item-revenue-location',
      };
      const candidates: AgentEvidenceCandidate[] = [
        {
          id: metricId,
          qualifiedId: metricId,
          kind: 'semantic_metric',
          trustTier: 'semantic',
          name: 'Revenue',
          aliases: ['revenue', 'sales'],
          sourceObjects: ['order_items'],
          relevanceScore: 1,
          matchReasons: ['fixture metric'],
          compatibility: 'compatible',
          analyticalCapability: capability,
        },
        {
          id: regionId,
          qualifiedId: regionId,
          kind: 'semantic_member',
          semanticObjectType: 'dimension',
          trustTier: 'semantic',
          name: 'Location Name',
          aliases: ['region'],
          sourceObjects: ['order_items'],
          relevanceScore: 0.99,
          matchReasons: ['fixture dimension'],
          compatibility: 'compatible',
          compatibilityFacts: ['alternative-for:region'],
        },
      ];
      const router = createHybridRouter({
        requireMeaningCallForNaturalLanguage: false,
        getEvidence: async () => ({
          snapshotId: 'fixture:jaffle-region',
          sourceFingerprint: 'fixture:jaffle-region',
          parsedIntent: {
            measures: ['sales based on the region'],
            dimensions: ['sales based on the region'],
            filters: [],
          },
          candidates,
        }),
      });
      const decision = await router.decide({ question });
      expect(decision.analyticalCascadeDecision).toMatchObject({
        selectedTier: 'semantic',
        planFrozen: true,
      });
      expect(decision.resolvedAnalyticalPlan?.query).toMatchObject({
        measures: [expect.objectContaining({ requested: 'revenue', qualifiedId: metricId })],
        dimensions: [expect.objectContaining({ requested: 'region', qualifiedId: regionId })],
      });

      // A real local relational execution confirms that the semantic compiler
      // can issue the native path's physical join when the immutable proof
      // authorizes it. These are test-local rows, not project/dbt fixture
      // edits. The production DuckDB adapter remains covered at the CLI
      // runtime boundary rather than claiming this SQLite harness is DuckDB.
      db.exec(`
        CREATE TABLE orders (order_id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL);
        CREATE TABLE locations (location_id INTEGER PRIMARY KEY, location_name TEXT NOT NULL);
        INSERT INTO locations VALUES (1, 'North'), (2, 'South');
        INSERT INTO orders
          SELECT order_id, CASE WHEN order_id % 2 = 0 THEN 2 ELSE 1 END
          FROM fct_orders;
      `);
      const semanticLayer = new SemanticLayer();
      const cube = (name: string, table: string, joins: Array<{
        name: string;
        left: string;
        right: string;
        type: 'left';
        sql: string;
        entity?: string;
      }> = []) => ({
        name, label: name, description: '', sql: `SELECT * FROM ${table}`, table,
        domain: 'commerce', measures: [], dimensions: [], timeDimensions: [], joins,
        segments: [], preAggregations: [],
      });
      semanticLayer.addCube(cube('order_item', 'order_items', [{
        name: 'orders', left: 'order_item', right: 'orders', type: 'left',
        sql: '${left}.order_id = ${right}.order_id', entity: 'order_id',
      }]));
      semanticLayer.addCube(cube('orders', 'orders', [{
        name: 'locations', left: 'orders', right: 'locations', type: 'left',
        sql: '${left}.location_id = ${right}.location_id', entity: 'location',
      }]));
      semanticLayer.addCube(cube('locations', 'locations'));
      semanticLayer.addMetric({
        name: 'revenue', label: 'Revenue', description: 'Fixture revenue.', domain: 'commerce',
        sql: 'product_price', type: 'sum', table: 'order_items', cube: 'order_item',
      });
      semanticLayer.addDimension({
        name: 'location_name', label: 'Location Name', description: 'Fixture location.', domain: 'commerce',
        sql: 'location_name', type: 'string', table: 'locations', cube: 'locations',
        entityLink: 'location', qualifiedName: 'order_id__location__location_name',
      });
      // Model the configured MetricFlow path: member resolution remains local
      // and pinned, while the semantic runtime—not the native compiler—owns
      // SQL compilation for this complete semantic tuple.
      vi.spyOn(semanticLayer, 'composeQuery').mockReturnValue(undefined);
      // The execution adapter binds only identities from the pinned registry.
      // Add the two fixture semantic nodes to the same local KG snapshot rather
      // than letting the semantic compiler rematch the router's selections by
      // display name.
      const compactRegistryCapability: MetricCapabilityContract = {
        ...capability,
        dimensions: capability.dimensions.map(({ relationshipPathIds: _relationshipPathIds, ...dimension }) => dimension),
      };
      appendFixtureKgNodes(kg, [
        {
          nodeId: 'metric:order_items.revenue',
          kind: 'metric',
          name: 'order_items.revenue',
          domain: 'commerce',
          payload: {
            registryQualifiedId: metricId,
            qualifiedId: metricId,
            localId: 'revenue',
            // The local KG uses a compact projection. The execution proof must
            // retain the RAP's full relationship authority instead.
            analyticalCapability: compactRegistryCapability,
          },
        },
        {
          nodeId: 'dimension:locations.location_name',
          kind: 'dimension',
          name: 'locations.location_name',
          domain: 'commerce',
          payload: {
            registryQualifiedId: regionId,
            qualifiedId: regionId,
            localId: 'location_name',
          },
        },
      ]);
      let compilerCalls = 0;
      let executorCalls = 0;
      const result = await answerBase({
        question,
        kg,
        provider: new ThrowingProvider(),
        semanticLayer,
        resolvedAnalyticalPlan: decision.resolvedAnalyticalPlan,
        selectedCascadeTier: 'semantic',
        semanticQueryCompiler: async (selection) => {
          compilerCalls += 1;
          expect(selection.metrics).toEqual(expect.arrayContaining(['revenue']));
          expect(selection.dimensions).toEqual(expect.arrayContaining(['order_id__location__location_name']));
          return {
            sql: [
              'SELECT l.location_name AS location_name, SUM(oi.product_price) AS revenue',
              'FROM order_items AS oi',
              'JOIN orders AS o ON oi.order_id = o.order_id',
              'JOIN locations AS l ON o.location_id = l.location_id',
              'GROUP BY l.location_name',
              'ORDER BY l.location_name',
            ].join('\n'),
            engine: 'metricflow-fixture' as const,
            selection,
            trace: {
              version: 1 as const,
              adapter: 'metricflow-fixture' as const,
              status: 'compiled' as const,
              authoringRequest: { metrics: selection.metrics, dimensions: selection.dimensions ?? [] },
              bindings: [],
              warnings: [],
              steps: [],
            },
          };
        },
        executeGeneratedSql: async (sql) => {
          executorCalls += 1;
          return executeSql(sql);
        },
      });

      expect(result).toMatchObject({
        kind: 'uncertified',
        sourceTier: 'semantic_layer',
        certification: 'governed',
        reviewStatus: 'governed',
      });
      expect(compilerCalls).toBe(1);
      expect(executorCalls).toBe(1);
      expect(result.result?.columns).toEqual(['location_name', 'revenue']);
      expect(result.result?.rowCount).toBe(2);
      expect(result.aggregationSafetyProof).toMatchObject({
        status: 'safe',
        fanout: 'proven_absent',
        issueCodes: [],
      });
    } finally {
      kg.close();
    }
  });

  it('AGT-034 falls through the exact customer/category request from an ineligible semantic tuple to one authorized exploratory execution', async () => {
    const kg = new KGStore(defaultKgPath(projectRoot));
    try {
      const question = 'who are the top customers who have revenue by product category?';
      const source = 'runtime:relation:order_items';
      const semanticUnavailable: AgentEvidenceCandidate = {
        id: 'semantic:metric:orders.revenue',
        qualifiedId: 'semantic:metric:orders.revenue',
        kind: 'semantic_metric',
        trustTier: 'semantic',
        name: 'orders.revenue',
        aliases: ['revenue', 'sales'],
        relevanceScore: 1,
        matchReasons: ['exact fixture measure'],
        compatibility: 'incompatible',
        compatibilityFacts: ['fixture: semantic model intentionally does not support customer plus product category'],
      };
      const physical: AgentEvidenceCandidate[] = [
        {
          id: 'dbt:model:order_items', qualifiedId: 'dbt:model:order_items', kind: 'dbt_model', trustTier: 'exploratory',
          name: 'order_items', sourceObjects: [source], relevanceScore: 0.98,
          matchReasons: ['single-relation fixture closure'], compatibility: 'compatible',
        },
        {
          id: 'dbt:column:order_items.customer_name', qualifiedId: 'dbt:column:order_items.customer_name', kind: 'sql_column', trustTier: 'exploratory',
          name: 'customer_name', aliases: ['customer', 'customer name'], sourceObjects: [source], relevanceScore: 0.97,
          matchReasons: ['customer display key'], compatibility: 'compatible',
        },
        {
          id: 'dbt:column:order_items.product_type', qualifiedId: 'dbt:column:order_items.product_type', kind: 'sql_column', trustTier: 'exploratory',
          name: 'product_type', aliases: ['product category', 'category'], sourceObjects: [source], relevanceScore: 0.96,
          matchReasons: ['product category'], compatibility: 'compatible',
        },
        {
          id: 'dbt:column:order_items.product_price', qualifiedId: 'dbt:column:order_items.product_price', kind: 'sql_column', trustTier: 'exploratory',
          name: 'product_price', aliases: ['product price', 'revenue', 'sales'], sourceObjects: [source], relevanceScore: 0.95,
          matchReasons: ['revenue amount'], compatibility: 'compatible',
        },
      ];
      const router = createHybridRouter({
        requireMeaningCallForNaturalLanguage: false,
        getEvidence: async () => ({
          snapshotId: 'fixture:jaffle-customer-category',
          sourceFingerprint: 'fixture:jaffle-customer-category',
          parsedIntent: { measures: ['revenue'], dimensions: ['product category'], filters: [], order: 'desc', limit: 10 },
          candidates: [semanticUnavailable, ...physical],
        }),
      });
      const decision = await router.decide({ question });
      const frozenPlan = decision.resolvedAnalyticalPlan;
      const exploratoryAttempt = decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql');
      expect(decision.analyticalCascadeDecision).toMatchObject({
        selectedTier: 'exploratory_sql',
        planFrozen: true,
      });
      expect(decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'semantic')?.outcome)
        .toMatch(/ineligible|unavailable/);
      expect(frozenPlan?.query).toMatchObject({
        measures: [expect.objectContaining({ requested: 'revenue', qualifiedId: 'dbt:column:order_items.product_price' })],
        dimensions: expect.arrayContaining([
          expect.objectContaining({ requested: 'customer name', qualifiedId: 'dbt:column:order_items.customer_name' }),
          expect.objectContaining({ requested: 'product category', qualifiedId: 'dbt:column:order_items.product_type' }),
        ]),
        order: 'desc',
        limit: 10,
      });
      expect(frozenPlan).toBeDefined();
      expect(exploratoryAttempt).toBeDefined();
      const exploratoryCandidateIds = exploratoryAttempt!.candidateIds;
      expect(exploratoryCandidateIds).toEqual(expect.arrayContaining(physical.map((candidate) => candidate.id)));

      const contextPack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      const relation = contextPack.allowedSqlContext.relations.find((candidate) => candidate.relation === 'order_items');
      expect(relation).toBeDefined();
      relation!.objectKey = 'dbt:model:order_items';
      const sql = [
        'SELECT customer_name, product_type AS product_category, SUM(product_price) AS revenue',
        'FROM order_items',
        'GROUP BY customer_name, product_type',
        'ORDER BY revenue DESC',
        'LIMIT 10',
      ].join('\n');
      const capability = {
        version: 1 as const,
        runId: 'fixture-customer-category-exploratory',
        executionId: 'fixture-customer-category-exploratory:initial',
        snapshotId: frozenPlan!.snapshotId,
        planId: frozenPlan!.planId,
        targetFingerprint: 'target:fixture-customer-category',
        bindingsFingerprint: frozenPlan!.fingerprint,
        candidateSqlFingerprint: 'fixture-customer-category-sql',
        provenIdentifiers: [
          'order_items',
          'order_items.customer_name',
          'order_items.product_type',
          'order_items.product_price',
        ],
        evidence: {
          order_items: 'schema_tool' as const,
          'order_items.customer_name': 'schema_tool' as const,
          'order_items.product_type': 'schema_tool' as const,
          'order_items.product_price': 'schema_tool' as const,
        },
        exploratoryAuthorizationAttempt: { version: 1 as const, index: 0 as const },
      };
      const freeze = {
        version: 1 as const,
        selectedTier: 'exploratory_sql' as const,
        planId: frozenPlan!.planId,
        planFingerprint: frozenPlan!.fingerprint,
        snapshotId: frozenPlan!.snapshotId,
        targetFingerprint: capability.targetFingerprint,
        sqlFingerprint: 'c'.repeat(32),
        candidateIds: exploratoryCandidateIds,
        authorization: 'capability_minted' as const,
        authorizationAttempt: { version: 1 as const, index: 0 as const },
      };
      let authorizations = 0;
      let executions = 0;
      const result = await answerBase({
        question,
        kg,
        provider: new ThrowingProvider(),
        contextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds,
        resolvedAnalyticalPlan: frozenPlan,
        forcedGeneratedProposal: { sql, summary: 'Top customer revenue by product category.' },
        prepareExploratorySqlExecution: async (candidateSql) => {
          authorizations += 1;
          expect(candidateSql).toBe(sql);
          return { capability, freeze };
        },
        executeAgenticGeneratedSql: async (receivedCapability, candidateSql) => {
          executions += 1;
          expect(receivedCapability).toBe(capability);
          return executeSql(candidateSql);
        },
      });

      expect(authorizations).toBe(1);
      expect(executions).toBe(1);
      expect(result).toMatchObject({
        kind: 'uncertified',
        sourceTier: 'dbt_manifest',
        certification: 'ai_generated',
        reviewStatus: 'draft_ready',
        exploratoryExecutionFreeze: freeze,
      });
      expect(result.result).toMatchObject({
        columns: ['customer_name', 'product_category', 'revenue'],
        rowCount: expect.any(Number),
      });
      expect(result.result?.rowCount).toBeGreaterThan(0);
    } finally {
      kg.close();
    }
  });

  async function executeCertifiedBlock(block: KGNode): Promise<AgentResultPayload> {
    const catalog = openMetadataCatalog(projectRoot);
    try {
      const object = catalog.getObject(`dql:block:${block.name}`);
      const sql = object?.payload?.sql;
      if (typeof sql !== 'string' || !sql.trim()) {
        throw new Error(`No SQL found for certified block ${block.name}`);
      }
      return executeSql(sql, block.name);
    } finally {
      catalog.close();
    }
  }

  function createCatalogExpander(projectRoot: string) {
    return async (request: Parameters<typeof expandGroundingFromCatalog>[1]) => {
      const catalog = openMetadataCatalog(projectRoot);
      try {
        return expandGroundingFromCatalog(catalog, request);
      } finally {
        catalog.close();
      }
    };
  }

  async function executeGeneratedSql(sql: string): Promise<AgentResultPayload> {
    return executeSql(sql);
  }

  function executeSql(sql: string, blockName?: string): AgentResultPayload {
    const statement = db.prepare(sql);
    const rows = statement.all() as Array<Record<string, unknown>>;
    const columns = rows[0]
      ? Object.keys(rows[0])
      : statement.columns().map((column) => column.name);
    return {
      columns,
      rows,
      rowCount: rows.length,
      sql,
      ...(blockName ? { blockName } : {}),
    };
  }
});

function seedJaffleProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  mkdirSync(join(projectRoot, 'target'), { recursive: true });
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'jaffle_shop' }), 'utf-8');
  writeFileSync(
    join(projectRoot, 'blocks', 'food_vs_drink_revenue.dql'),
    `block "food_vs_drink_revenue" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Revenue split between food and drinks, from order items."
  tags = ["revenue", "food", "drink", "category"]
  llmContext = "Use only for food vs drink category revenue, not product-level revenue."
  grain = "category"
  entities = ["Category"]
  outputs = ["category", "revenue"]
  dimensions = ["category"]
  query = """
    SELECT
      CASE
        WHEN product_type = 'jaffle' THEN 'Food'
        WHEN product_type = 'beverage' THEN 'Drink'
        ELSE product_type
      END AS category,
      SUM(product_price) AS revenue
    FROM order_items
    GROUP BY 1
    ORDER BY revenue DESC
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(projectRoot, 'blocks', 'top_customers.dql'),
    `block "top_customers" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top 10 customers by lifetime spend, with order counts."
  tags = ["customers", "revenue", "ranking"]
  llmContext = "Use for global lifetime customer spend only, not category-scoped customer drilldowns."
  grain = "customer"
  entities = ["Customer"]
  outputs = ["customer_name", "lifetime_spend", "order_count"]
  dimensions = ["customer"]
  query = """
    SELECT customer_name, lifetime_spend, count_lifetime_orders AS order_count
    FROM dim_customers
    ORDER BY lifetime_spend DESC
    LIMIT 10
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(projectRoot, 'blocks', 'top_products.dql'),
    `block "top_products" {
  domain = "orders"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Top 10 products by revenue, with units sold."
  tags = ["products", "revenue", "ranking"]
  llmContext = "Use for product-level revenue rankings only, not customer-grain questions."
  grain = "product"
  entities = ["Product"]
  outputs = ["product_name", "revenue", "units"]
  dimensions = ["product"]
  query = """
    SELECT product_name, SUM(product_price) AS revenue, COUNT(*) AS units
    FROM order_items
    GROUP BY product_name
    ORDER BY revenue DESC
    LIMIT 10
  """
}`,
    'utf-8',
  );
  writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.order_items': dbtModel('order_items', 'Order item rows with product name, category, and revenue.', ['orders', 'products', 'revenue'], {
        order_item_id: dbtColumn('order_item_id', 'number', 'Order item identifier.'),
        order_id: dbtColumn('order_id', 'number', 'Order identifier.'),
        product_id: dbtColumn('product_id', 'text', 'Product SKU.'),
        product_name: dbtColumn('product_name', 'text', 'Product display name.'),
        product_type: dbtColumn('product_type', 'text', 'Product category such as jaffle or beverage.'),
        customer_name: dbtColumn('customer_name', 'text', 'Customer display name for the sanitized order-item fixture.'),
        region: dbtColumn('region', 'text', 'Sales location region for the sanitized fixture.'),
        product_price: dbtColumn('product_price', 'number', 'Product revenue amount.'),
        ordered_at: dbtColumn('ordered_at', 'timestamp', 'Order timestamp.'),
      }),
      'model.jaffle_shop.supplies': dbtModel('supplies', 'Supply rows linked to products for supply-chain analysis.', ['products', 'supplies', 'supply-chain'], {
        supply_id: dbtColumn('supply_id', 'text', 'Supply identifier.'),
        product_id: dbtColumn('product_id', 'text', 'Product SKU.'),
        supply_name: dbtColumn('supply_name', 'text', 'Supply display name.'),
        supply_cost: dbtColumn('supply_cost', 'number', 'Unit supply cost.'),
        is_perishable_supply: dbtColumn('is_perishable_supply', 'boolean', 'Whether the supply is perishable.'),
      }),
      'model.jaffle_shop.fct_orders': dbtModel('fct_orders', 'Order fact rows with customer ids and subtotal revenue.', ['orders', 'customers', 'revenue'], {
        order_id: dbtColumn('order_id', 'number', 'Order identifier.'),
        customer_id: dbtColumn('customer_id', 'number', 'Customer identifier.'),
        order_total: dbtColumn('order_total', 'number', 'Order total.'),
        count_food_items: dbtColumn('count_food_items', 'number', 'Food item count.'),
        count_drink_items: dbtColumn('count_drink_items', 'number', 'Drink item count.'),
        subtotal_food_items: dbtColumn('subtotal_food_items', 'number', 'Food revenue.'),
        subtotal_drink_items: dbtColumn('subtotal_drink_items', 'number', 'Drink revenue.'),
        subtotal: dbtColumn('subtotal', 'number', 'Subtotal revenue.'),
      }),
      'model.jaffle_shop.dim_customers': dbtModel('dim_customers', 'Customer dimension with names and lifetime spend.', ['customers'], {
        customer_id: dbtColumn('customer_id', 'number', 'Customer identifier.'),
        customer_name: dbtColumn('customer_name', 'text', 'Customer display name.'),
        count_lifetime_orders: dbtColumn('count_lifetime_orders', 'number', 'Lifetime order count.'),
        lifetime_spend: dbtColumn('lifetime_spend', 'number', 'Lifetime customer spend.'),
      }),
    },
  }), 'utf-8');
}

function seedJaffleDatabase(db: Database.Database): void {
  db.exec(`
    CREATE TABLE order_items (
      order_item_id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_type TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      region TEXT NOT NULL,
      product_price REAL NOT NULL,
      ordered_at TEXT NOT NULL
    );
    CREATE TABLE supplies (
      supply_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      supply_name TEXT NOT NULL,
      supply_cost REAL NOT NULL,
      is_perishable_supply INTEGER NOT NULL
    );
    CREATE TABLE fct_orders (
      order_id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      order_total REAL NOT NULL,
      count_food_items INTEGER NOT NULL,
      count_drink_items INTEGER NOT NULL,
      subtotal_food_items REAL NOT NULL,
      subtotal_drink_items REAL NOT NULL,
      subtotal REAL NOT NULL
    );
    CREATE TABLE dim_customers (
      customer_id INTEGER PRIMARY KEY,
      customer_name TEXT NOT NULL,
      count_lifetime_orders INTEGER NOT NULL,
      lifetime_spend REAL NOT NULL
    );

    INSERT INTO dim_customers VALUES
      (1, 'Alice Johnson', 3, 40.00),
      (2, 'Brian Smith', 2, 33.00),
      (3, 'Carla Gomez', 2, 25.00),
      (4, 'Deepak Patel', 1, 13.50),
      (5, 'Emma Davis', 1, 12.00),
      (6, 'Farah Khan', 1, 5.50);

    INSERT INTO fct_orders VALUES
      (1001, 1, 16.50, 1, 1, 12.00, 4.50, 16.50),
      (1002, 2, 16.50, 1, 1, 11.00, 5.50, 16.50),
      (1003, 1, 12.00, 1, 0, 12.00, 0.00, 12.00),
      (1004, 4, 18.00, 1, 1, 13.50, 4.50, 18.00),
      (1005, 3, 17.50, 1, 1, 12.00, 5.50, 17.50),
      (1006, 5, 12.00, 1, 0, 12.00, 0.00, 12.00),
      (1007, 6, 5.50, 0, 1, 0.00, 5.50, 5.50);

    INSERT INTO order_items VALUES
      (1, 1001, 'JF001', 'Flame Impala', 'jaffle', 'Alice Johnson', 'West', 12.00, '2024-01-05'),
      (2, 1001, 'DR001', 'Cold Brew', 'beverage', 'Alice Johnson', 'West', 4.50, '2024-01-05'),
      (3, 1002, 'JF002', 'Veggie Jaffle', 'jaffle', 'Brian Smith', 'East', 11.00, '2024-01-07'),
      (4, 1002, 'DR002', 'Chai Latte', 'beverage', 'Brian Smith', 'East', 5.50, '2024-01-07'),
      (5, 1003, 'JF001', 'Flame Impala', 'jaffle', 'Alice Johnson', 'North', 12.00, '2024-02-02'),
      (6, 1004, 'JF003', 'Breakfast Jaffle', 'jaffle', 'Deepak Patel', 'South', 13.50, '2024-02-19'),
      (7, 1004, 'DR001', 'Cold Brew', 'beverage', 'Deepak Patel', 'South', 4.50, '2024-02-19'),
      (8, 1005, 'JF001', 'Flame Impala', 'jaffle', 'Carla Gomez', 'North', 12.00, '2024-03-03'),
      (9, 1005, 'DR002', 'Chai Latte', 'beverage', 'Carla Gomez', 'North', 5.50, '2024-03-03'),
      (10, 1006, 'JF001', 'Flame Impala', 'jaffle', 'Emma Davis', 'West', 12.00, '2024-03-15'),
      (11, 1007, 'DR002', 'Chai Latte', 'beverage', 'Farah Khan', 'East', 5.50, '2024-04-08');

    INSERT INTO supplies VALUES
      ('SUP-001', 'JF001', 'bread', 0.33, 1),
      ('SUP-002', 'JF001', 'cheese', 0.20, 1),
      ('SUP-003', 'JF001', 'serving boat', 0.11, 0),
      ('SUP-004', 'JF002', 'bread', 0.33, 1),
      ('SUP-005', 'JF002', 'mushrooms', 0.44, 1),
      ('SUP-006', 'JF003', 'bread', 0.33, 1),
      ('SUP-007', 'JF003', 'egg', 0.27, 1),
      ('SUP-008', 'JF003', 'napkin', 0.04, 0),
      ('SUP-009', 'DR001', '16oz compostable cup', 0.13, 0),
      ('SUP-010', 'DR001', 'coffee', 0.52, 1),
      ('SUP-011', 'DR002', '16oz compostable cup', 0.13, 0),
      ('SUP-012', 'DR002', 'chai mix', 0.98, 1);
  `);
}

function dbtModel(
  name: string,
  description: string,
  tags: string[],
  columns: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resource_type: 'model',
    name,
    alias: name,
    description,
    depends_on: { nodes: [] },
    tags,
    original_file_path: `models/${name}.sql`,
    config: { materialized: 'table' },
    columns,
  };
}

function dbtColumn(name: string, dataType: string, description: string): Record<string, string> {
  return {
    name,
    data_type: dataType,
    description,
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Test-only registry augmentation for a semantic adapter fixture. The production
 * adapter intentionally refuses IDs that are not in its immutable registry; a
 * hand-created router candidate alone is therefore insufficient evidence.
 */
function appendFixtureKgNodes(kg: KGStore, additions: KGNode[]): void {
  const kinds: KGNode['kind'][] = [
    'block', 'term', 'business_view', 'metric', 'dimension', 'measure',
    'entity', 'model_area', 'semantic_model', 'saved_query', 'domain',
    'dbt_model', 'dbt_source', 'notebook', 'dashboard', 'app', 'skill',
    'relationship', 'contract', 'domain_export', 'domain_import',
    'conformance', 'policy', 'evaluation',
  ];
  const existing = kinds.flatMap((kind) => kg.getNodesByKind(kind, 100_000));
  const byNodeId = new Map(existing.map((node) => [node.nodeId, node]));
  for (const node of additions) byNodeId.set(node.nodeId, node);
  // Edges are irrelevant to this single-model fixture. Execution identities
  // remain fully pinned by the nodes above, which is the property under test.
  kg.rebuild([...byNodeId.values()], []);
}

function fixtureSemanticMetricNode(
  qualifiedId: string,
  localId: string,
  analyticalCapability: MetricCapabilityContract,
  measureColumn: string,
): KGNode {
  return {
    nodeId: `metric:order_items.${localId}`,
    kind: 'metric',
    name: `order_items.${localId}`,
    domain: 'commerce',
    payload: {
      registryQualifiedId: qualifiedId,
      qualifiedId,
      localId,
      relation: 'order_items',
      measureColumn,
      analyticalCapability,
    },
  };
}
