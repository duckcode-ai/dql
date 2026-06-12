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

  it('formats digest declarations without dropping content', () => {
    const source = `digest "Weekly Exec" {
narrative { prompt = "Summarize the movement" sources = [ref("Revenue")] }
chart.line(SELECT week, revenue FROM weekly_revenue,x=week,y=revenue)
}`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('digest "Weekly Exec" {');
    expect(formatted).toContain('narrative {');
    expect(formatted).toContain('prompt = "Summarize the movement"');
    expect(formatted).toContain('sources = [ref("Revenue")]');
    expect(formatted).toContain('chart.line(');
    expect(() => parse(formatted)).not.toThrow();
  });

  it('formats business_view declarations with stable includes', () => {
    const source = `business_view "Customer 360"{
domain="Customer"
status="draft"
description="Complete customer view"
owner="Customer Analytics"
terms=["Customer"]
businessOutcome="Improve retention decisions"
includes{block "Customer Identity" business_view "Customer Service Summary"}
}`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('business_view "Customer 360" {');
    expect(formatted).toContain('domain = "Customer"');
    expect(formatted).toContain('terms = ["Customer"]');
    expect(formatted).toContain('businessOutcome = "Improve retention decisions"');
    expect(formatted).toContain('includes {');
    expect(formatted).toContain('block "Customer Identity"');
    expect(formatted).toContain('business_view "Customer Service Summary"');
    expect(() => parse(formatted)).not.toThrow();
  });

  it('formats term declarations and block term references', () => {
    const source = `term "Customer"{
domain="Customer"
type="entity"
status="draft"
description="Customer definition"
owner="Customer Analytics"
identifiers=["customer_id"]
synonyms=["Account"]
businessRules=["One row per customer_id"]
}

block "Customer Identity"{
domain="Customer"
type="custom"
terms=["Customer"]
query="""SELECT customer_id FROM dim_customer"""
}`;

    const formatted = formatDQL(source);

    expect(formatted).toContain('term "Customer" {');
    expect(formatted).toContain('type = "entity"');
    expect(formatted).toContain('identifiers = ["customer_id"]');
    expect(formatted).toContain('terms = ["Customer"]');
    expect(() => parse(formatted)).not.toThrow();
    expect(formatDQL(formatted)).toBe(formatted);
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
