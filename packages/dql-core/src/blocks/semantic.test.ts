import { describe, expect, it } from 'vitest';
import { parse } from '../parser/index.js';
import { NodeKind, type BlockDeclNode } from '../ast/index.js';
import { canonicalize } from '../format/index.js';
import { renderSemanticBlockSource } from './semantic.js';

describe('canonical semantic block source (CONTRACT-002 / AGT-021 / API-006)', () => {
  it('always emits metric and dimension arrays and never embeds compiled SQL', () => {
    const source = renderSemanticBlockSource({
      name: 'capital_one_metrics',
      domain: 'uncategorized',
      description: 'Five governed metrics for Capital One',
      metrics: ['metric_a', 'metric_b', 'metric_c', 'metric_d', 'metric_e'],
      dimensions: [],
    });

    expect(source).toContain('type = "semantic"');
    expect(source).toContain('status = "draft"');
    expect(source).toContain('metrics = ["metric_a", "metric_b", "metric_c", "metric_d", "metric_e"]');
    expect(source).toContain('dimensions = []');
    expect(source).not.toMatch(/\n\s*metric\s*=/);
    expect(source).not.toContain('domain = "uncategorized"');
    expect(source).not.toContain('query = """');
  });

  it('preserves the complete semantic execution contract through canonical formatting', () => {
    const source = renderSemanticBlockSource({
      name: 'revenue_by_customer',
      domain: 'finance',
      metrics: ['revenue', 'refunds'],
      dimensions: ['customer_name'],
      timeDimension: { name: 'metric_time', granularity: 'month' },
      requestedFilters: ['customer_name=Capital One'],
      orderBy: [{ name: 'revenue', direction: 'desc' }],
      limit: 25,
      parameters: [{
        name: 'customer_name',
        type: 'string',
        default: 'Capital One',
        policy: 'dynamic',
        binding: 'customer_name',
      }],
    });
    const canonical = canonicalize(source);
    const block = parse(canonical).statements.find((item) => item.kind === NodeKind.BlockDecl) as BlockDeclNode;

    expect(block.metricsRef).toEqual(['revenue', 'refunds']);
    expect(block.dimensionsRef).toEqual(['customer_name']);
    expect(block.timeDimension).toBe('metric_time');
    expect(block.granularity).toBe('month');
    expect(block.requestedFilters).toEqual(['customer_name=Capital One']);
    expect(block.orderBy).toEqual(['revenue desc']);
    expect(block.limit).toBe(25);
    expect(canonical).toContain('time_dimension = "metric_time"');
    expect(canonical).toContain('requested_filters = ["customer_name=Capital One"]');
    expect(canonical).toContain('order_by = ["revenue desc"]');
    expect(canonical).toContain('limit = 25');
  });

  it('keeps AI drafts ownerless unless a human supplies an owner', () => {
    const source = renderSemanticBlockSource({
      name: 'ownerless_ai_draft',
      metrics: ['revenue'],
      dimensions: [],
    });
    expect(source).not.toContain('owner =');
  });
});
