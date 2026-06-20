import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser.js';
import { analyze } from './analyzer.js';
import { DataLexContractRegistry } from '../contracts/index.js';

describe('SemanticAnalyzer', () => {
  it('reports no errors for valid chart with required args', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('accepts treemap chart args', () => {
    const source = `chart.treemap(
      SELECT category, SUM(revenue) as total FROM sales GROUP BY category,
      x = category,
      y = total,
      color_field = category
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('accepts sankey chart args', () => {
    const source = `chart.sankey(
      SELECT src, dst, SUM(val) as total FROM flows GROUP BY src, dst,
      x = src,
      y = total,
      color_field = dst
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('accepts sparkline chart args', () => {
    const source = `chart.sparkline(
      SELECT date, SUM(revenue) as total FROM sales GROUP BY date,
      x = date,
      y = total
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('accepts small_multiples chart args', () => {
    const source = `chart.small_multiples(
      SELECT date, region, SUM(revenue) as total FROM sales GROUP BY date, region,
      x = date,
      y = total,
      facet = region
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('reports error for missing required args', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      title = "Test"
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("requires argument 'x'"))).toBe(true);
  });

  it('warns about unknown chart arguments', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue,
      unknown_arg = "value"
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.some((w) => w.message.includes("Unknown argument 'unknown_arg'"))).toBe(true);
  });

  it('reports error for undefined template variable', () => {
    const source = `dashboard "Test" {
      chart.line(
        SELECT * FROM orders WHERE date = '{undefined_var}',
        x = date,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes("Undefined variable 'undefined_var'"))).toBe(true);
  });

  it('resolves declared variables in SQL templates', () => {
    const source = `dashboard "Test" {
      let today = CURRENT_DATE

      chart.line(
        SELECT * FROM orders WHERE date = '{today}',
        x = date,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('resolves declared variables in ${var} SQL templates', () => {
    const source = `dashboard "Test" {
      let region = "NA"

      chart.line(
        SELECT * FROM orders WHERE region = '\${region}',
        x = date,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('reports duplicate variable declarations', () => {
    const source = `dashboard "Test" {
      let x = 1
      let x = 2

      chart.kpi(
        SELECT 1 as val
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes("already declared"))).toBe(true);
  });

  it('validates @schedule decorator has arguments', () => {
    const source = `@schedule()
    dashboard "Test" {
      chart.kpi(SELECT 1 as val)
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('@schedule requires'))).toBe(true);
  });

  it('warns about empty dashboards', () => {
    const source = `dashboard "Empty" { }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.some((w) => w.message.includes('no charts'))).toBe(true);
  });

  it('kpi chart does not require x and y', () => {
    const source = `chart.kpi(
      SELECT SUM(revenue) as total FROM orders,
      metrics = ["total"]
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('allows drill_down and link_to args on charts without warnings', () => {
    const source = `chart.bar(
      SELECT cat, SUM(rev) as r FROM orders GROUP BY cat,
      x = cat,
      y = r,
      drill_down = "SELECT * FROM orders WHERE cat = '{clicked_value}'",
      link_to = "detail.dql"
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    // drill_down and link_to should be recognized, not flagged as unknown
    expect(warnings.some((w) => w.message.includes("Unknown argument 'drill_down'"))).toBe(false);
    expect(warnings.some((w) => w.message.includes("Unknown argument 'link_to'"))).toBe(false);
  });

  it('allows on_click and filter_by args on charts', () => {
    const source = `chart.pie(
      SELECT seg, COUNT(*) as cnt FROM users GROUP BY seg,
      x = seg,
      y = cnt,
      on_click = "drill_down",
      filter_by = seg
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.some((w) => w.message.includes("Unknown argument 'on_click'"))).toBe(false);
    expect(warnings.some((w) => w.message.includes("Unknown argument 'filter_by'"))).toBe(false);
  });

  it('accepts hierarchy drill args on charts', () => {
    const source = `chart.bar(
      SELECT order_year, SUM(revenue) as revenue FROM sales GROUP BY order_year,
      x = order_year,
      y = revenue,
      drill_hierarchy = "time_hierarchy",
      drill_path = "calendar",
      drill_mode = "replace"
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(errors).toHaveLength(0);
    expect(warnings.some((w) => w.message.includes("Unknown argument 'drill_hierarchy'"))).toBe(false);
  });

  it('reports error for invalid drill_mode values', () => {
    const source = `chart.bar(
      SELECT order_year, SUM(revenue) as revenue FROM sales GROUP BY order_year,
      x = order_year,
      y = revenue,
      drill_hierarchy = "time_hierarchy",
      drill_mode = "jump"
    )`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes("Invalid drill_mode 'jump'"))).toBe(true);
  });

  it('validates filter.dropdown requires label and param', () => {
    const source = `dashboard "Test" {
      filter.dropdown(
        SELECT DISTINCT cat FROM products
      )

      chart.bar(
        SELECT cat, SUM(rev) as r FROM orders GROUP BY cat,
        x = cat,
        y = r
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes("requires argument 'label'"))).toBe(true);
    expect(errors.some((e) => e.message.includes("requires argument 'param'"))).toBe(true);
  });

  it('reports no errors for valid filter with all required args', () => {
    const source = `dashboard "Test" {
      filter.dropdown(
        SELECT DISTINCT cat FROM products,
        label = "Category",
        param = "cat_filter"
      )

      chart.bar(
        SELECT cat, SUM(rev) as r FROM orders GROUP BY cat,
        x = cat,
        y = r
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('allows referencing filter param in SQL templates without explicit param decl', () => {
    const source = `dashboard "Test" {
      filter.dropdown(
        SELECT DISTINCT category FROM orders,
        label = "Category",
        param = "cat_filter"
      )

      chart.bar(
        SELECT category, SUM(revenue) as rev
        FROM orders
        WHERE ({cat_filter} = '' OR category = {cat_filter})
        GROUP BY category,
        x = category,
        y = rev
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('warns about unknown filter args', () => {
    const source = `dashboard "Test" {
      filter.text(
        label = "Search",
        param = "q",
        unknown_filter_opt = "oops"
      )

      chart.table(
        SELECT * FROM products
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.some((w) => w.message.includes("Unknown argument 'unknown_filter_opt'"))).toBe(true);
  });

  it('accepts @if decorator on chart without warnings', () => {
    const source = `dashboard "Test" {
      param show_details: boolean = true

      @if(show_details)
      chart.table(
        SELECT * FROM orders
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(errors).toHaveLength(0);
    expect(warnings.some((w) => w.message.includes("Unknown decorator '@if'"))).toBe(false);
  });

  it('reports error when @if has no arguments', () => {
    const source = `dashboard "Test" {
      @if()
      chart.table(
        SELECT * FROM orders
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('@if requires'))).toBe(true);
  });

  it('reports error when @if is applied to dashboard', () => {
    const source = `@if(show)
    dashboard "Test" {
      chart.kpi(SELECT 1 as val)
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('@if can only be applied to chart'))).toBe(true);
  });

  it('accepts @rls decorator on chart with two arguments', () => {
    const source = `dashboard "Test" {
      @rls("org_id", "{user.org}")
      chart.table(
        SELECT * FROM orders
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(errors).toHaveLength(0);
    expect(warnings.some((w) => w.message.includes("Unknown decorator '@rls'"))).toBe(false);
  });

  it('accepts @rls decorator on block declarations', () => {
    const source = `@rls("region", "{user.region}")
    @rls("branch_id", "{user.branch}")
    block "Daily Volume" {
      domain = "cards"
      type = "custom"
      query = """SELECT region, branch_id, COUNT(*) AS txn_count FROM transactions GROUP BY 1, 2"""
      visualization {
        chart = "table"
      }
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('reports error when @rls has fewer than 2 arguments', () => {
    const source = `dashboard "Test" {
      @rls("org_id")
      chart.table(
        SELECT * FROM orders
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('@rls requires two arguments'))).toBe(true);
  });

  it('reports error when @rls column argument is unsafe', () => {
    const source = `dashboard "Test" {
      @rls("org_id; DROP TABLE users", "{user.org}")
      chart.table(
        SELECT * FROM orders
      )
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('@rls first argument must be a safe SQL column identifier'))).toBe(true);
  });

  it('accepts @refresh decorator without warnings', () => {
    const source = `@refresh()
    dashboard "Live" {
      chart.kpi(SELECT COUNT(*) as active FROM sessions)
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.some((w) => w.message.includes("Unknown decorator '@refresh'"))).toBe(false);
  });
});

describe('SemanticAnalyzer - Block Declarations', () => {
  it('warns when block is missing domain', () => {
    const source = `block "Revenue" {
      type = "semantic"
      metric = "revenue_growth"
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.some((w) => w.message.includes('missing a domain'))).toBe(true);
  });

  it('defaults a legacy block without type to custom', () => {
    const source = `block "Revenue" {
      domain = "revenue"
      query = """SELECT SUM(amount) FROM orders"""
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('errors when a custom block has no query field', () => {
    const source = `block "Revenue" {
      domain = "revenue"
      type = "custom"
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('custom block must have a query'))).toBe(true);
  });

  it('validates SQL interpolations against block params', () => {
    const source = `block "Revenue" {
      domain = "revenue"
      type = "custom"

      params {
        period = "Q1"
      }

      query = """
        SELECT * FROM sales WHERE period = {period}
      """
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('Undefined variable'))).toBe(false);
  });

  it('reports undefined SQL interpolation variable in block', () => {
    const source = `block "Revenue" {
      domain = "revenue"
      type = "custom"

      query = """
        SELECT * FROM sales WHERE period = {undefined_var}
      """
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes("Undefined variable 'undefined_var'"))).toBe(true);
  });

  it('accepts a complete valid custom block without errors', () => {
    const source = `block "Revenue by Segment" {
      domain = "revenue"
      type = "custom"
      description = "Quarterly revenue"
      tags = ["revenue", "segment"]

      params {
        period = "Q1"
      }

      query = """
        SELECT tier, SUM(rev) as revenue
        FROM fct_revenue
        WHERE period = {period}
        GROUP BY tier
      """

      visualization {
        x = tier
        y = revenue
      }

      tests {
        assert row_count > 0
        assert revenue > 0
      }
    }`;

    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ── Phase A: blockType enforcement ───────────────────────────────────────────

describe('BlockDecl — blockType validation', () => {
  it('defaults a missing blockType to custom for legacy blocks', () => {
    const source = `
      block "Revenue KPI" {
        domain = "finance"
        description = "Monthly revenue"
        owner = "analytics@example.com"
        query = """SELECT SUM(amount) as revenue FROM orders"""
      }
    `;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('accepts a semantic block with both metricRef and query (import-adapter pattern)', () => {
    // Import adapters (dbt YAML, schema introspection) produce blocks with
    // metricRef (provenance) AND pre-compiled SQL. Both fields are valid together.
    const source = `
      block "Revenue Trend" {
        domain = "finance"
        type = "semantic"
        metric = "revenue_growth"
        description = "dbt metric"
        owner = "analytics@example.com"
        query = """SELECT date, SUM(amount) FROM orders GROUP BY date"""
      }
    `;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('errors when a custom block is missing a query field', () => {
    const source = `
      block "Pipeline Analysis" {
        domain = "sales"
        type = "custom"
        description = "Pipeline coverage"
        owner = "analytics@example.com"
      }
    `;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.message.includes('custom block must have a query'))).toBe(true);
  });

  it('accepts a valid semantic block with metricRef and no query', () => {
    const source = `
      block "Revenue Growth" {
        domain = "finance"
        type = "semantic"
        metric = "revenue_growth"
        description = "Monthly revenue growth from dbt metric"
        owner = "analytics@example.com"
        tags = ["finance", "revenue"]
        visualization {
          chart_type = "line"
        }
      }
    `;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('accepts a valid custom block with a query and no metricRef', () => {
    const source = `
      block "Pipeline Coverage" {
        domain = "sales"
        type = "custom"
        description = "Pipeline deal coverage by stage"
        owner = "analytics@example.com"
        tags = ["sales", "pipeline"]
        query = """
          SELECT stage, COUNT(*) as deals, SUM(arr) as arr
          FROM opportunities
          WHERE close_date >= CURRENT_DATE
          GROUP BY stage
          ORDER BY arr DESC
        """
        visualization {
          chart_type = "bar"
        }
      }
    `;
    const ast = parse(source);
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('parses the metricRef field correctly from a semantic block', () => {
    const source = `
      block "Churn Rate" {
        domain = "retention"
        type = "semantic"
        metric = "monthly_churn_rate"
        description = "Monthly churn from dbt semantic layer"
        owner = "analytics@example.com"
      }
    `;
    const ast = parse(source);
    const blockNode = ast.statements.find((s) => s.kind === 'BlockDecl') as any;
    expect(blockNode).toBeDefined();
    expect(blockNode.blockType).toBe('semantic');
    expect(blockNode.metricRef).toBe('monthly_churn_rate');
    expect(blockNode.query).toBeUndefined();
  });

  it('parses a fully-imported semantic block with metricRef and query', () => {
    const source = `
      block "Revenue Growth" {
        domain = "finance"
        type = "semantic"
        metric = "revenue_growth"
        query = """
          SELECT date, SUM(amount) as revenue
          FROM fct_revenue
          GROUP BY date
        """
        owner = "analytics@acme.com"
      }
    `;
    const ast = parse(source);
    const blockNode = ast.statements.find((s) => s.kind === 'BlockDecl') as any;
    expect(blockNode).toBeDefined();
    expect(blockNode.blockType).toBe('semantic');
    expect(blockNode.metricRef).toBe('revenue_growth');
    expect(blockNode.query).toBeDefined();
    const diagnostics = analyze(ast);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('errors when blockType value is not semantic or custom', () => {
    const source = `
      block "Bad Block" {
        domain = "finance"
        type = "chart.bar"
        description = "Using old visualization type syntax"
        owner = "analytics@example.com"
        query = """SELECT 1"""
      }
    `;
    // Parser should recover with an error diagnostic
    let parseErrors = 0;
    try {
      const ast = parse(source);
      const diagnostics = analyze(ast);
      // Either a parse error or analyze error is acceptable
      parseErrors = diagnostics.filter((d) => d.severity === 'error').length;
    } catch {
      parseErrors = 1;
    }
    expect(parseErrors).toBeGreaterThanOrEqual(1);
  });
});

describe('SemanticAnalyzer — datalex_contract resolution (Phase 2.1)', () => {
  const buildRegistry = () => {
    return new DataLexContractRegistry({
      manifest: {
        manifestSpecVersion: '1.0.0',
        datalexVersion: '1.8.2',
        generatedAt: '2026-05-01T12:00:00Z',
        project: { name: 'test_project', dialect: 'duckdb' },
        domains: [
          {
            name: 'commerce',
            entities: [
              {
                name: 'Customer',
                contracts: [
                  {
                    id: 'commerce.Customer.monthly_active_customers',
                    name: 'monthly_active_customers',
                    version: 1,
                  },
                  {
                    id: 'commerce.Customer.monthly_active_customers',
                    name: 'monthly_active_customers',
                    version: 2,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  };

  const certifiedBlockSource = (datalexContract: string) => `
    block "Monthly Active Customers" {
      domain = "customer"
      type = "custom"
      status = "certified"
      datalex_contract = "${datalexContract}"
      owner = "growth@example.com"
      query = """SELECT 1"""
    }
  `;

  it('parses datalex_contract as a first-class block field', () => {
    const ast = parse(certifiedBlockSource('commerce.Customer.monthly_active_customers'));
    const block = ast.statements.find((s) => s.kind === 'BlockDecl') as any;
    expect(block.datalexContract).toBe('commerce.Customer.monthly_active_customers');
  });

  it('warns once when no DataLex registry is loaded', () => {
    const ast = parse(certifiedBlockSource('commerce.Customer.monthly_active_customers'));
    const diagnostics = analyze(ast);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.some((w) => w.message.includes('no DataLex manifest is loaded'))).toBe(true);
  });

  it('passes when a certified block references a known contract', () => {
    const ast = parse(certifiedBlockSource('commerce.Customer.monthly_active_customers@2'));
    const diagnostics = analyze(ast, { datalexRegistry: buildRegistry() });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.filter((e) => e.message.includes('datalex_contract'))).toEqual([]);
  });

  it('errors when a certified block references an unknown contract id', () => {
    const ast = parse(certifiedBlockSource('commerce.Customer.does_not_exist'));
    const diagnostics = analyze(ast, { datalexRegistry: buildRegistry() });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('not found'))).toBe(true);
  });

  it('errors when a certified block pins a missing version', () => {
    const ast = parse(certifiedBlockSource('commerce.Customer.monthly_active_customers@99'));
    const diagnostics = analyze(ast, { datalexRegistry: buildRegistry() });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('pinned version is missing'))).toBe(true);
    expect(errors.some((e) => e.message.includes('available'))).toBe(true);
  });

  it('errors when the contract reference syntax is malformed (certified block)', () => {
    const ast = parse(certifiedBlockSource('not-a-valid-ref'));
    const diagnostics = analyze(ast, { datalexRegistry: buildRegistry() });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('not a valid contract reference'))).toBe(true);
  });

  it('downgrades to warning for draft blocks (work-in-progress is fine)', () => {
    const draftSource = `
      block "Draft Block" {
        domain = "customer"
        type = "custom"
        status = "draft"
        datalex_contract = "commerce.Customer.does_not_exist"
        owner = "growth@example.com"
        query = """SELECT 1"""
      }
    `;
    const ast = parse(draftSource);
    const diagnostics = analyze(ast, { datalexRegistry: buildRegistry() });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(errors.filter((e) => e.message.includes('datalex_contract'))).toEqual([]);
    expect(warnings.some((w) => w.message.includes('not found'))).toBe(true);
  });

  it('produces no contract diagnostics when the block omits datalex_contract', () => {
    const source = `
      block "Plain Certified Block" {
        domain = "customer"
        type = "custom"
        status = "certified"
        owner = "growth@example.com"
        query = """SELECT 1"""
      }
    `;
    const ast = parse(source);
    const diagnostics = analyze(ast, { datalexRegistry: buildRegistry() });
    const contractDiagnostics = diagnostics.filter((d) =>
      d.message.includes('datalex_contract'),
    );
    expect(contractDiagnostics).toEqual([]);
  });
});
