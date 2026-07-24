import { describe, expect, it } from 'vitest';
import {
  ensureNotebookDqlBlockSource,
  inferVisualParameterType,
  parseVisualBlockParameters,
  reconcileSemanticCompatibility,
  removeVisualBlockParameter,
  setBlockQuery,
  setSemanticRuntimeFilters,
  upsertSemanticSelection,
  upsertVisualBlockParameter,
} from './block-studio.js';

const SOURCE = `block "Revenue by Region" {
  domain = "sales"
  type = "custom"
  query = """SELECT region, revenue FROM revenue WHERE region IN (${ '${region_set}' })"""
}`;

describe('visual block parameters', () => {
  it('infers author-entered values into safe DQL types', () => {
    expect(inferVisualParameterType('10', 'top_n')).toBe('number');
    expect(inferVisualParameterType('2026-01-01', 'start_date')).toBe('date');
    expect(inferVisualParameterType('Central, East', 'region_set')).toBe('string[]');
    expect(inferVisualParameterType('true', 'include_inactive')).toBe('boolean');
  });

  it('writes visual definitions back into the DQL source and reads source edits', () => {
    const withParameter = upsertVisualBlockParameter(SOURCE, {
      name: 'region_set',
      type: 'string[]',
      required: false,
      defaultText: 'Central, East',
      policy: 'dynamic',
    });

    expect(withParameter).toContain('region_set: string[] = ["Central", "East"]');
    expect(withParameter).toContain('region_set = "dynamic"');
    expect(parseVisualBlockParameters(withParameter)).toEqual([
      expect.objectContaining({
        name: 'region_set',
        type: 'string[]',
        default: ['Central', 'East'],
        required: false,
        binding: { kind: 'sql_value' },
      }),
    ]);
    expect(parseVisualBlockParameters(removeVisualBlockParameter(withParameter, 'region_set'))).toEqual([]);
  });

  it('creates a minimal draft block only when notebook parameter authoring needs one', () => {
    expect(ensureNotebookDqlBlockSource(SOURCE)).toBe(SOURCE);
    const source = ensureNotebookDqlBlockSource('SELECT * FROM orders');
    const withParameter = upsertVisualBlockParameter(source, {
      name: 'start_date',
      type: 'date',
      required: false,
      defaultText: '2026-01-01',
      policy: 'dynamic',
    });

    expect(withParameter).toContain('block "notebook_query"');
    expect(withParameter).toContain('SELECT * FROM orders');
    expect(withParameter).toContain('start_date: date = "2026-01-01"');
    expect(withParameter).not.toContain('top_n');
  });

  it('creates a complete dynamic semantic-filter contract from visual authoring', () => {
    const source = `block "Revenue" {
  domain = "sales"
  type = "semantic"
  metric = "revenue"
}`;
    const result = setSemanticRuntimeFilters(source, ['product_category']);
    expect(result).toContain('product_category: string');
    expect(result).toContain('product_category = "dynamic"');
    expect(result).toContain('product_category = "product_category"');
    expect(result).toContain('requested_filters = ["product_category"]');
  });

  it('preserves raw-SQL parameter and governance sections while editing the query', () => {
    const source = `block "Revenue" {
  domain = "sales"
  type = "custom"
  query = """
SELECT region, revenue FROM revenue WHERE region = \${region}
  """
  params {
    region: string
  }
  parameterPolicy {
    region = "dynamic"
  }
  filterBindings {
    region = "region"
  }
  visualization {
    chart = "bar"
  }
  tests {
    assert row_count >= 1
  }
}`;

    const result = setBlockQuery(source, 'SELECT region, SUM(revenue) AS revenue FROM revenue GROUP BY 1');

    expect(result).toContain('SELECT region, SUM(revenue) AS revenue FROM revenue GROUP BY 1');
    expect(result).toContain('params {\n    region: string');
    expect(result).toContain('parameterPolicy {\n    region = "dynamic"');
    expect(result).toContain('filterBindings {\n    region = "region"');
    expect(result).toContain('visualization {\n    chart = "bar"');
    expect(result).toContain('tests {\n    assert row_count >= 1');
  });

  it('keeps semantic parameter sections and removes selections outside the fresh compatibility answer', () => {
    const source = `block "Revenue" {
  domain = "sales"
  type = "semantic"
  metric = "revenue"
  dimensions = ["customer_name", "unrelated_region"]
  requested_filters = ["customer_name", "unrelated_region"]
  time_dimension = "unrelated_date"
  granularity = "month"
  params {
    customer_name: string
    unrelated_region: string
    custom_limit: number = 10
  }
  parameterPolicy {
    customer_name = "dynamic"
    unrelated_region = "dynamic"
    custom_limit = "business"
  }
  filterBindings {
    customer_name = "customer_name"
    unrelated_region = "unrelated_region"
  }
}`;

    const withMetric = upsertSemanticSelection(source, { kind: 'metric', name: 'gross_margin' });
    const result = reconcileSemanticCompatibility(withMetric, ['customer_name']);

    expect(result).toContain('metrics = ["revenue", "gross_margin"]');
    expect(result).toContain('dimensions = ["customer_name"]');
    expect(result).toContain('requested_filters = ["customer_name"]');
    expect(result).toContain('time_dimension = ""');
    expect(result).toContain('granularity = ""');
    expect(result).toContain('custom_limit: number = 10');
    expect(result).not.toContain('unrelated_region: string');
    expect(result).not.toContain('unrelated_region = "dynamic"');
  });
});
