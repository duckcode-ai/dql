import { describe, expect, it } from 'vitest';

import { setBlockStringField } from './block-studio';

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
});
