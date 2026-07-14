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
});
