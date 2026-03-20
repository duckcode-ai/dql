import { describe, expect, it } from 'vitest';
import { buildExecutionPlan } from './execute.js';

describe('buildExecutionPlan', () => {
  it('extracts SQL, params, and visualization from a DQL block', () => {
    const plan = buildExecutionPlan({
      id: 'cell-1',
      type: 'dql',
      title: 'Revenue',
      source: `block "Revenue" {\n  domain = "finance"\n  type = "custom"\n  params {\n    period = "current_quarter"\n  }\n  query = """SELECT segment, SUM(amount) AS revenue FROM revenue WHERE fiscal_period = ${'${period}'} GROUP BY segment"""\n  visualization {\n    chart = "bar"\n    x = segment\n    y = revenue\n  }\n  tests {\n    assert row_count > 0\n  }\n}`,
    });

    expect(plan?.sql).toContain('$1');
    expect(plan?.variables).toEqual({ period: 'current_quarter' });
    expect(plan?.chartConfig).toEqual({ chart: 'bar', x: 'segment', y: 'revenue' });
    expect(plan?.tests).toHaveLength(1);
  });

  it('passes SQL cells through unchanged', () => {
    const plan = buildExecutionPlan({ id: 'cell-2', type: 'sql', title: 'Ad hoc', source: 'SELECT 1 AS ok' });
    expect(plan?.sql).toBe('SELECT 1 AS ok');
    expect(plan?.sqlParams).toEqual([]);
  });
});
