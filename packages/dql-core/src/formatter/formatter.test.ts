import { describe, expect, it } from 'vitest';
import { formatDQL } from './formatter.js';
import { parse } from '../parser/parser.js';

describe('formatDQL', () => {
  it('formats dashboard charts and filters with stable indentation', () => {
    const source = `dashboard "Daily"{
@cache(300)
chart.line(SELECT order_date, SUM(revenue) as total FROM orders GROUP BY order_date,x=order_date,y=total,title="Revenue")
filter.dropdown(SELECT DISTINCT region FROM orders,label="Region",param="region")
}`;

    const formatted = formatDQL(source);

    expect(formatted).toBe(`dashboard "Daily" {
  @cache(300)
  chart.line(
    SELECT order_date, SUM(revenue) as total FROM orders GROUP BY order_date,
    x = order_date,
    y = total,
    title = "Revenue"
  )
  filter.dropdown(
    SELECT DISTINCT region FROM orders,
    label = "Region",
    param = "region"
  )
}
`);
  });

  it('formats block declarations with params/query/visualization/tests', () => {
    const source = `block "rev_by_segment" {
      domain = "sales"
      type = "custom"
      params { region = "NA" }
      query = """
        SELECT segment, SUM(revenue) as rev
        FROM orders
        GROUP BY segment
      """
      visualization { x = segment y = rev title = "Revenue by Segment" }
      tests {
        assert rev > 0
        assert segment IN ["Enterprise","SMB"]
      }
    }`;
    const formatted = formatDQL(source);

    expect(formatted).toContain('block "rev_by_segment" {');
    expect(formatted).toContain('params {');
    expect(formatted).toContain('query = """');
    expect(formatted).toContain('visualization {');
    expect(formatted).toContain('tests {');
    expect(formatted).toContain('assert segment IN ["Enterprise", "SMB"]');
  });

  it('preserves block status and agent-facing metadata', () => {
    const source = `block "fraud_by_region" {
      domain = "cards"
      type = "custom"
      status = "certified"
      description = "Fraud exposure by region"
      tags = ["fraud", "cards"]
      owner = "mei.chen@acme-bank.com"
      llmContext = "Use for fraud monitoring questions."
      examples = [{ question = "Where is fraud highest?", sql = "SELECT region FROM fraud" }]
      invariants = ["exposure_usd >= 0"]
      query = """
        SELECT region, SUM(exposure_usd) AS exposure_usd
        FROM fraud_alerts
        GROUP BY 1
      """
    }`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('status = "certified"');
    expect(formatted).toContain('llmContext = "Use for fraud monitoring questions."');
    expect(formatted).toContain(
      'examples = [{ question = "Where is fraud highest?", sql = "SELECT region FROM fraud" }]',
    );
    expect(formatted).toContain('invariants = ["exposure_usd >= 0"]');
  });

  it('is idempotent and parseable', () => {
    const source = `workbook "Ops Review" {
  page "Overview" {
    layout(columns = 12) {
      row {
        chart.bar(
          SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
          x = category,
          y = total
        ) span 6
        chart.sparkline(
          SELECT order_date, SUM(revenue) as total FROM orders GROUP BY order_date,
          x = order_date,
          y = total
        ) span 6
      }
    }
  }
}`;

    const once = formatDQL(source);
    const twice = formatDQL(once);
    expect(twice).toBe(once);
    expect(() => parse(twice)).not.toThrow();
  });
});
