import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

class ThrowingProvider implements AgentProvider {
  readonly name = 'openai' as const;

  async available(): Promise<boolean> {
    return true;
  }

  async generate(_messages: AgentMessage[]): Promise<string> {
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
      expect(contextPack.questionPlan.requestedShape.dimensions).toEqual(
        expect.arrayContaining(['customer', 'category', 'product']),
      );
      expect(contextPack.retrievalDiagnostics.certifiedCandidateFits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'top_products',
            action: 'rejected_for_fit',
            fit: expect.objectContaining({
              missingDimensions: expect.arrayContaining(['customer', 'category']),
            }),
          }),
        ]),
      );
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
      (1, 1001, 'JF001', 'Classic Jaffle', 'jaffle', 12.00, '2024-01-05'),
      (2, 1001, 'DR001', 'Cold Brew', 'beverage', 4.50, '2024-01-05'),
      (3, 1002, 'JF002', 'Veggie Jaffle', 'jaffle', 11.00, '2024-01-07'),
      (4, 1002, 'DR002', 'Chai Latte', 'beverage', 5.50, '2024-01-07'),
      (5, 1003, 'JF001', 'Classic Jaffle', 'jaffle', 12.00, '2024-02-02'),
      (6, 1004, 'JF003', 'Breakfast Jaffle', 'jaffle', 13.50, '2024-02-19'),
      (7, 1004, 'DR001', 'Cold Brew', 'beverage', 4.50, '2024-02-19'),
      (8, 1005, 'JF001', 'Classic Jaffle', 'jaffle', 12.00, '2024-03-03'),
      (9, 1005, 'DR002', 'Chai Latte', 'beverage', 5.50, '2024-03-03'),
      (10, 1006, 'JF001', 'Classic Jaffle', 'jaffle', 12.00, '2024-03-15'),
      (11, 1007, 'DR002', 'Chai Latte', 'beverage', 5.50, '2024-04-08');

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
