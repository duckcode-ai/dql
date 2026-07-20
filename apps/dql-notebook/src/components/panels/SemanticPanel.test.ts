import { describe, expect, it } from 'vitest';
import { buildNotebookSemanticBlock } from './semantic-notebook-source';

describe('buildNotebookSemanticBlock', () => {
  it('preserves governed metric and dimension bindings in an executable DQL cell', () => {
    expect(buildNotebookSemanticBlock(
      ['customer_lifetime_spend', 'order_count'],
      ['customer_name'],
    )).toBe([
      'block "customer_lifetime_spend_by_order_count_by_customer_name" {',
      '  type = "semantic"',
      '  metrics = ["customer_lifetime_spend", "order_count"]',
      '  dimensions = ["customer_name"]',
      '}',
    ].join('\n'));
  });

  it('deduplicates selections and emits a stable block name', () => {
    const source = buildNotebookSemanticBlock(['revenue', 'revenue'], ['month', 'month']);
    expect(source).toContain('block "revenue_by_month"');
    expect(source).toContain('metrics = ["revenue"]');
    expect(source).toContain('dimensions = ["month"]');
  });
});
