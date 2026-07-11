import { describe, expect, it } from 'vitest';
import { prepareBlockInvocation } from './block-invocation.js';

const SOURCE = `block "Top revenue" {
  domain = "sales"
  type = "custom"
  params {
    start_date: date
    top_n: number = 10
    region_set: string[] = ["Central"]
  }
  query = """
    SELECT region, revenue FROM revenue
    WHERE occurred_at >= ${'${start_date}'}
      AND region IN (${ '${region_set}' })
    LIMIT ${'${top_n}'}
  """
}`;

describe('prepareBlockInvocation', () => {
  it('uses explicit values over defaults and records their source', () => {
    const invocation = prepareBlockInvocation({
      source: SOURCE,
      parameters: { start_date: '2026-01-01', top_n: '25', region_set: 'East, West' },
      surface: 'mcp',
    });

    expect(invocation).toMatchObject({
      values: { start_date: '2026-01-01', top_n: 25, region_set: ['East', 'West'] },
      unresolvedParameters: [],
      errors: [],
    });
    expect(invocation.resolvedParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'top_n', value: 25, source: 'explicit' }),
    ]));
  });

  it('uses high-confidence question values but asks for missing required values', () => {
    const invocation = prepareBlockInvocation({
      source: SOURCE,
      question: 'Show the top 3 revenue regions',
      surface: 'ask_ai',
    });

    expect(invocation.values.top_n).toBe(3);
    expect(invocation.resolvedParameters).toContainEqual(
      expect.objectContaining({ name: 'top_n', source: 'question' }),
    );
    expect(invocation.unresolvedParameters).toEqual(['start_date']);
  });
});
