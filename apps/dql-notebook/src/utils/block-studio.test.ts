import { describe, expect, it } from 'vitest';

import {
  parseSemanticVisualFields,
  setBlockStringField,
  setDqlSectionBody,
  setSemanticArray,
  setSemanticMetrics,
  setSemanticScalar,
  upsertVisualizationConfig,
} from './block-studio';

describe('block-studio utils', () => {
  it('preserves generated source DQL lineage when normalizing a custom draft block', () => {
    const source = `block "product_supply_draft" {
  status = "draft"
  domain = "misc"
  type = "custom"
  description = "Can you include the product details with previous results?"
  owner = "analytics@example.com"
  tags = ["generated"]
  source_dql_kind = "certified_block"
  source_dql_name = "product_supply_breakdown"
  source_dql_path = "domains/supply_chain/blocks/product_supply_breakdown.dql"
  source_dql_hash = "abc123"
  source_dql_metrics = ["supply_cost"]
  source_dql_dimensions = ["product_id", "supply_id"]

  query = """
    SELECT 1
  """
}
`;

    const next = setBlockStringField(source, 'domain', 'supply_chain');

    expect(next).toContain('domain = "supply_chain"');
    expect(next).toContain('source_dql_kind = "certified_block"');
    expect(next).toContain('source_dql_name = "product_supply_breakdown"');
    expect(next).toContain('source_dql_path = "domains/supply_chain/blocks/product_supply_breakdown.dql"');
    expect(next).toContain('source_dql_hash = "abc123"');
    expect(next).toContain('source_dql_metrics = ["supply_cost"]');
    expect(next).toContain('source_dql_dimensions = ["product_id", "supply_id"]');
  });

  it('round-trips multi-metric visual fields without removing advanced clauses', () => {
    const source = `block "revenue_quality" {
  type = "semantic"
  metric = "revenue"
  dimensions = ["region"]
  custom_governance_clause = "preserve-me"
  tests {
    assert = "revenue >= 0"
  }
  visualization {
    chart = "bar"
    custom_palette = "finance"
  }
}
`;

    let next = setSemanticMetrics(source, ['revenue', 'gross_margin']);
    next = setSemanticArray(next, 'dimensions', ['region', 'channel']);
    next = setSemanticArray(next, 'requested_filters', ['region']);
    next = setSemanticScalar(next, 'time_dimension', 'order_date');
    next = setSemanticScalar(next, 'granularity', 'month');
    next = upsertVisualizationConfig(next, { chart: 'line', title: 'Revenue and margin' });
    next = setDqlSectionBody(next, 'tests', 'assert row_count >= 1\nassert revenue >= 0');

    expect(parseSemanticVisualFields(next)).toEqual({
      metrics: ['revenue', 'gross_margin'],
      dimensions: ['region', 'channel'],
      requestedFilters: ['region'],
      timeDimension: 'order_date',
      granularity: 'month',
    });
    expect(next).toContain('custom_governance_clause = "preserve-me"');
    expect(next).toContain('assert row_count >= 1');
    expect(next).toContain('assert revenue >= 0');
    expect(next).toContain('custom_palette = "finance"');
    expect(next).toContain('chart = "line"');
    expect(next).toContain('title = "Revenue and margin"');
  });
});
