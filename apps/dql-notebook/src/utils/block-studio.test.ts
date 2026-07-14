import { describe, expect, it } from 'vitest';
import {
  inferVisualParameterType,
  parseVisualBlockParameters,
  removeVisualBlockParameter,
  setSemanticRuntimeFilters,
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
});
