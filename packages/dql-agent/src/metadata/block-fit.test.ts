import { describe, expect, it } from 'vitest';
import { buildAnalysisQuestionPlan } from './analysis-planner.js';
import { evaluateCertifiedBlockFit } from './block-fit.js';
import type { MetadataObject } from './catalog.js';

function certifiedBlock(name: string, payload: Record<string, unknown>): MetadataObject {
  return {
    objectKey: `dql:block:${name}`,
    objectType: 'dql_block',
    name,
    status: 'certified',
    description: typeof payload.description === 'string' ? payload.description : undefined,
    payload,
  };
}

function fit(question: string, block: MetadataObject) {
  const plan = buildAnalysisQuestionPlan(question);
  return evaluateCertifiedBlockFit({ question, plan, block });
}

describe('certified block fit', () => {
  it('AGT-006 rejects an unfiltered lifetime-spend block for beverage-scoped ranking', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'lifetime_spend', 'order_count'],
      dimensions: ['customer'],
      sql: 'select customer_name, lifetime_spend, order_count from customers order by lifetime_spend desc limit 10',
    });

    const result = fit('who are the customers who spent most on beverages?', block);

    expect(result.kind).toBe('context_only');
    expect(result.unsupportedFilters).toContain('beverage');
    expect(result.reasons.join(' ')).toContain('unsupported requested filters');
  });

  it('accepts a certified customer ranking whose beverage restriction is baked into its contract and SQL (AGT-009, AGT-010)', () => {
    const block = certifiedBlock('top_beverage_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'],
      dimensions: ['customer'],
      allowedFilters: ['top_n'],
      tags: ['beverage', 'customer', 'revenue', 'ranking'],
      description: 'Top customers ranked by beverage revenue. One row per customer.',
      sql: `select customer_name, sum(product_price) as beverage_revenue
        from order_items
        join products on order_items.product_id = products.product_id
        where products.is_beverage = true
        group by customer_name
        order by beverage_revenue desc
        limit 10`,
    });

    const result = fit('who are the top customers who spent on beverage category products?', block);

    expect(result.kind).toBe('exact');
    expect(result.confidence).toBe('high');
    expect(result.missingDimensions).toEqual([]);
    expect(result.missingOutputs).toEqual([]);
    expect(result.unsupportedFilters).toEqual([]);
  });

  it('rejects a high-overlap customer block for a product flow with different required outputs', () => {
    const block = certifiedBlock('top_beverage_customers', {
      grain: 'customer',
      // These are joined/source entities, not the returned row grain.
      entities: ['Order Item', 'Product'],
      declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'],
      dimensions: ['customer'],
      tags: ['beverage', 'customer', 'revenue', 'ranking'],
      description: 'Top customers ranked by beverage revenue. One row per customer.',
      sql: 'select customer_name, beverage_revenue, beverage_orders, beverage_product_types from customer_beverage order by beverage_revenue desc limit 10',
    });

    const result = fit('Show revenue by product type and product name as a source-to-target flow.', block);

    expect(result.kind).toBe('context_only');
    expect(result.missingOutputs).toEqual(expect.arrayContaining(['product_type', 'product_name']));
    expect(result.grainMismatch).toMatch(/customer.*product/i);
    expect(result.reasons.join(' ')).toContain('missing requested outputs');
  });

  it('AGT-009/AGT-010 keeps a row-level profile as context for a scalar aggregate', () => {
    const block = certifiedBlock('customer_profile', {
      grain: 'one row per customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'lifetime_spend', 'first_ordered_at'],
      dimensions: ['customer_name'],
      description: 'Customer lifetime profile. One row per customer.',
      sql: 'select customer_name, lifetime_spend, first_ordered_at from customers',
    });

    const result = fit('What is total lifetime spend across all customers?', block);

    expect(result.kind).toBe('context_only');
    expect(result.grainMismatch).toContain('one aggregate value');
    expect(result.reasons.join(' ')).toContain('one aggregate value');
  });

  it('rejects a category-level revenue block for a product-level revenue request', () => {
    const block = certifiedBlock('food_vs_drink_revenue', {
      grain: 'category',
      entities: ['Category'],
      declaredOutputs: ['category', 'revenue'],
      dimensions: ['category'],
      sql: 'select category, sum(revenue) as revenue from order_items group by category',
    });

    const result = fit(
      'Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue',
      block,
    );

    expect(result.kind).toBe('context_only');
    expect(result.confidence).toBe('high');
    expect(result.missingDimensions).toContain('product');
    expect(result.missingOutputs).toContain('product_name');
    expect(result.reasons.join(' ')).toMatch(/product/i);
  });

  it('allows an exact product-level revenue block', () => {
    const block = certifiedBlock('product_revenue', {
      grain: 'product',
      entities: ['Product'],
      declaredOutputs: ['product_name', 'category', 'revenue'],
      dimensions: ['product', 'category'],
      sql: 'select product_name, category, sum(revenue) as revenue from order_items group by product_name, category',
    });

    const result = fit('Show revenue by product with product name, category, and revenue', block);

    expect(result.kind).toBe('exact');
    expect(result.confidence).toBe('high');
    expect(result.missingOutputs).toEqual([]);
    expect(result.missingDimensions).toEqual([]);
  });

  it('uses typed outputContract columns when declared outputs are absent', () => {
    const block = certifiedBlock('product_revenue_contract', {
      grain: 'product',
      entities: ['Product'],
      outputContract: [
        { name: 'product_name', role: 'dimension' },
        { name: 'category', role: 'dimension' },
        { name: 'revenue', role: 'metric' },
      ],
      dimensions: ['product', 'category'],
    });

    const result = fit('Show revenue by product with product name, category, and revenue', block);

    expect(result.kind).toBe('exact');
    expect(result.confidence).toBe('high');
    expect(result.missingOutputs).toEqual([]);
    expect(result.missingDimensions).toEqual([]);
  });

  it('marks dimension-covered inferred contracts as medium confidence', () => {
    const block = certifiedBlock('legacy_product_revenue', {
      grain: 'product',
      entities: ['Product'],
      dimensions: ['product'],
      description: 'Revenue by product from legacy certified block metadata.',
    });

    const result = fit('Show revenue by product', block);

    expect(result.kind).toBe('exact');
    expect(result.confidence).toBe('medium');
    expect(result.missingOutputs).toEqual([]);
    expect(result.missingDimensions).toEqual([]);
  });

  it('treats top-N mismatch as trim-safe when the block otherwise fits', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'revenue', 'order_count'],
      dimensions: ['customer'],
      sql: 'select customer_name, revenue, order_count from customers order by revenue desc limit 10',
    });

    const result = fit('Who are the top 5 customers by revenue?', block);

    expect(result.kind).toBe('trim_safe');
    expect(result.topNAction).toBe('trim');
  });

  it('rejects global top customers for a category-scoped customer follow-up', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'revenue', 'order_count'],
      dimensions: ['customer'],
      sql: 'select customer_name, revenue, order_count from customers order by revenue desc limit 10',
    });

    const result = fit('Who are the top 5 customers for these categories?', block);

    expect(result.kind).toBe('context_only');
    expect(result.missingDimensions).toContain('category');
  });

  it('rejects global top customers for deictic-only category follow-ups', () => {
    const block = certifiedBlock('top_customers', {
      grain: 'customer',
      entities: ['Customer'],
      declaredOutputs: ['customer_name', 'revenue', 'order_count'],
      dimensions: ['customer'],
      sql: 'select customer_name, revenue, order_count from customers order by revenue desc limit 10',
    });
    const plan = buildAnalysisQuestionPlan('Who are the top 5 customers for those?', {
      kind: 'drilldown',
      dimensions: ['category'],
      filters: ['Food', 'Drink'],
      priorResultValues: { category: ['Food', 'Drink'] },
      priorMeasures: ['revenue'],
    });

    const result = evaluateCertifiedBlockFit({
      question: 'Who are the top 5 customers for those?',
      plan,
      block,
    });

    expect(result.kind).toBe('context_only');
    expect(result.missingDimensions).toContain('category');
  });

  it('AGT-012 rejects a broad customer profile that cannot honor a named product binding', () => {
    const block = certifiedBlock('customer_profile', {
      grain: 'customer',
      declaredOutputs: ['customer_name', 'customer_type', 'lifetime_spend'],
      dimensions: ['customer'],
      sql: 'select customer_name, customer_type, lifetime_spend from customers order by lifetime_spend desc',
    });
    const question = 'who are the customer from flame impala';
    const plan = buildAnalysisQuestionPlan(question, {
      kind: 'drilldown',
      filters: ['flame impala'],
      dimensions: ['customer', 'product'],
      priorResultValues: { product_name: ['flame impala'] },
      memberBindings: [{
        dimension: 'product',
        values: ['flame impala'],
        source: 'prior_result',
        confidence: 'exact',
      }],
    });

    const result = evaluateCertifiedBlockFit({ question, plan, block });

    expect(result.kind).toBe('context_only');
    expect(result.missingDimensions).toContain('product');
    expect(result.unsupportedFilters).toContain('flame impala');
  });

  it('AGT-012 permits a certified product/customer result that exposes the bound dimension', () => {
    const block = certifiedBlock('product_customers', {
      grain: 'customer_product',
      declaredOutputs: ['customer_name', 'product_name', 'revenue'],
      dimensions: ['customer', 'product'],
      allowedFilters: ['product'],
      sql: 'select customer_name, product_name, revenue from product_customers',
    });
    const question = 'who are the customer from flame impala';
    const plan = buildAnalysisQuestionPlan(question, {
      kind: 'drilldown',
      filters: ['flame impala'],
      dimensions: ['customer', 'product'],
      priorResultValues: { product_name: ['flame impala'] },
      memberBindings: [{
        dimension: 'product',
        values: ['flame impala'],
        source: 'prior_result',
        confidence: 'exact',
      }],
    });

    expect(evaluateCertifiedBlockFit({ question, plan, block }).unsupportedFilters).toEqual([]);
  });
});

describe('member bindings vs Tier-1 termination (Slice 1c)', () => {
  const rankingBlock = (allowedFilters: string[]) => ({
    nodeId: 'block:top_beverage_customers',
    kind: 'block',
    name: 'top_beverage_customers',
    status: 'certified',
    description: 'Top customers ranked by beverage revenue, with beverage order count and product variety. One row per customer.',
    tags: ['beverage', 'customer', 'revenue', 'ranking'],
    grain: 'one row per customer in the beverage purchase ranking',
    declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'],
    dimensions: ['customer_name'],
    allowedFilters,
    sql: 'SELECT 1',
    examples: [],
  });
  const joyFollowUp = {
    kind: 'drilldown',
    memberBindings: [{ dimension: 'customer', values: ['Joy Lam'], source: 'prior_result', confidence: 'exact' }],
  };

  it('keeps the broad ranking question exact (no member binding)', () => {
    const question = 'who are the top customers bought a beverage product?';
    const fit = evaluateCertifiedBlockFit({ question, plan: buildAnalysisQuestionPlan(question), block: rankingBlock([]) as never });
    expect(fit.kind).toBe('exact');
  });

  it('demotes a member-bound follow-up: a dimension column cannot apply the filter verbatim', () => {
    // Regression for the "Joy Lam" hijack: Tier-1 executed the unfiltered
    // top-10 ranking as a certified answer for a member-scoped follow-up
    // because a customer DIMENSION was treated as binding support.
    const question = 'Joy Lam is a customer data. we are asking from the results so I need his products by revenue in berearage';
    const fit = evaluateCertifiedBlockFit({ question, plan: buildAnalysisQuestionPlan(question, joyFollowUp), block: rankingBlock([]) as never });
    expect(fit.kind).toBe('context_only');
    expect(fit.unsupportedFilters).toContain('Joy Lam');
  });

  it('keeps a member binding supported when the block exposes a parameterized filter', () => {
    const question = 'top beverage customers for Joy Lam';
    const fit = evaluateCertifiedBlockFit({ question, plan: buildAnalysisQuestionPlan(question, joyFollowUp), block: rankingBlock(['customer_name']) as never });
    expect(fit.kind).toBe('exact');
    expect(fit.unsupportedFilters).toEqual([]);
  });
});
