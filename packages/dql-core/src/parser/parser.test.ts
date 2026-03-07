import { describe, it, expect } from 'vitest';
import { parse } from './parser.js';
import { NodeKind } from '../ast/nodes.js';

describe('Parser', () => {
  it('parses a standalone chart call', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue,
      title = "Revenue Trend"
    )`;

    const ast = parse(source);
    expect(ast.kind).toBe(NodeKind.Program);
    expect(ast.statements).toHaveLength(1);

    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('line');
      expect(chart.query.rawSQL).toContain('SELECT date, revenue FROM sales');
      expect(chart.args).toHaveLength(3);
      expect(chart.args[0].name).toBe('x');
      expect(chart.args[1].name).toBe('y');
      expect(chart.args[2].name).toBe('title');
    }
  });

  it('parses a dashboard with variables and charts', () => {
    const source = `dashboard "Daily Report" {
      let today = CURRENT_DATE

      chart.kpi(
        SELECT SUM(revenue) as total FROM orders,
        metrics = ["total"],
        compare_to_previous = true
      )

      chart.bar(
        SELECT product, SUM(qty) as units FROM items GROUP BY product,
        x = product,
        y = units,
        title = "Top Products"
      )
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);

    const dashboard = ast.statements[0];
    expect(dashboard.kind).toBe(NodeKind.Dashboard);
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.title).toBe('Daily Report');
      expect(dashboard.body).toHaveLength(3); // 1 variable + 2 charts

      // Variable
      expect(dashboard.body[0].kind).toBe(NodeKind.VariableDecl);

      // KPI chart
      expect(dashboard.body[1].kind).toBe(NodeKind.ChartCall);

      // Bar chart
      expect(dashboard.body[2].kind).toBe(NodeKind.ChartCall);
    }
  });

  it('parses decorators', () => {
    const source = `@schedule(daily, "9:00 AM")
    @email_to("team@company.com")
    dashboard "Report" {
      chart.line(
        SELECT date, value FROM data,
        x = date,
        y = value
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    expect(dashboard.kind).toBe(NodeKind.Dashboard);
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.decorators).toHaveLength(2);
      expect(dashboard.decorators[0].name).toBe('schedule');
      expect(dashboard.decorators[0].arguments).toHaveLength(2);
      expect(dashboard.decorators[1].name).toBe('email_to');
    }
  });

  it('parses chart with theme and styling options', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue,
      theme = "dark",
      color = "#FF6B6B",
      line_width = 3,
      fill_opacity = 0.3,
      title = "Revenue Trend",
      show_grid = true,
      show_legend = true
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.args).toHaveLength(9);
      const themeArg = chart.args.find((a) => a.name === 'theme');
      expect(themeArg).toBeDefined();
      if (themeArg && themeArg.value.kind === NodeKind.StringLiteral) {
        expect(themeArg.value.value).toBe('dark');
      }
    }
  });

  it('parses SQL with template interpolation', () => {
    const source = `dashboard "Test" {
      let today = CURRENT_DATE

      chart.line(
        SELECT * FROM orders WHERE date = '{today}',
        x = date,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    if (dashboard.kind === NodeKind.Dashboard) {
      const chart = dashboard.body[1];
      if (chart.kind === NodeKind.ChartCall) {
        expect(chart.query.interpolations).toHaveLength(1);
        expect(chart.query.interpolations[0].variableName).toBe('today');
      }
    }
  });

  it('parses SQL with ${param} interpolation', () => {
    const source = `dashboard "Test" {
      param region: string = "NA"

      chart.line(
        SELECT * FROM orders WHERE region = \${region},
        x = date,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    if (dashboard.kind === NodeKind.Dashboard) {
      const chart = dashboard.body[1];
      if (chart.kind === NodeKind.ChartCall) {
        expect(chart.query.interpolations).toHaveLength(1);
        expect(chart.query.interpolations[0].variableName).toBe('region');
      }
    }
  });

  it('parses array literal arguments', () => {
    const source = `chart.kpi(
      SELECT SUM(rev) as r, COUNT(*) as c FROM t,
      metrics = ["r", "c"]
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    if (chart.kind === NodeKind.ChartCall) {
      const metricsArg = chart.args.find((a) => a.name === 'metrics');
      expect(metricsArg).toBeDefined();
      if (metricsArg && metricsArg.value.kind === NodeKind.ArrayLiteral) {
        expect(metricsArg.value.elements).toHaveLength(2);
      }
    }
  });

  it('handles empty dashboard', () => {
    const source = `dashboard "Empty" { }`;
    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    if (ast.statements[0].kind === NodeKind.Dashboard) {
      expect(ast.statements[0].body).toHaveLength(0);
    }
  });

  it('parses chart with drill_down and link_to interaction args', () => {
    const source = `chart.bar(
      SELECT category, SUM(revenue) as rev FROM orders GROUP BY category,
      x = category,
      y = rev,
      title = "Revenue by Category",
      drill_down = "SELECT * FROM orders WHERE category = '{clicked_value}'",
      link_to = "detail.dql"
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.args).toHaveLength(5);
      const drillArg = chart.args.find((a) => a.name === 'drill_down');
      expect(drillArg).toBeDefined();
      if (drillArg && drillArg.value.kind === NodeKind.StringLiteral) {
        expect(drillArg.value.value).toContain('{clicked_value}');
      }
      const linkArg = chart.args.find((a) => a.name === 'link_to');
      expect(linkArg).toBeDefined();
      if (linkArg && linkArg.value.kind === NodeKind.StringLiteral) {
        expect(linkArg.value.value).toBe('detail.dql');
      }
    }
  });

  it('parses chart with filter_by arg', () => {
    const source = `chart.pie(
      SELECT category, COUNT(*) as cnt FROM products GROUP BY category,
      x = category,
      y = cnt,
      filter_by = category
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    if (chart.kind === NodeKind.ChartCall) {
      const filterArg = chart.args.find((a) => a.name === 'filter_by');
      expect(filterArg).toBeDefined();
      if (filterArg && filterArg.value.kind === NodeKind.Identifier) {
        expect(filterArg.value.name).toBe('category');
      }
    }
  });

  it('parses hyphen chart aliases and normalizes chart type', () => {
    const source = `chart.grouped-bar(
      SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
      x = category,
      y = total
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('grouped_bar');
    }
  });

  it('parses tree-map alias and normalizes to treemap', () => {
    const source = `chart.tree-map(
      SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
      x = category,
      y = total
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('treemap');
    }
  });

  it('parses flow alias and normalizes to sankey', () => {
    const source = `chart.flow(
      SELECT src, dst, val FROM flows,
      x = src,
      y = val,
      color_field = dst
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('sankey');
    }
  });

  it('parses spark alias and normalizes to sparkline', () => {
    const source = `chart.spark(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('sparkline');
    }
  });

  it('parses small-multiples alias and normalizes to small_multiples', () => {
    const source = `chart.small-multiples(
      SELECT date, region, revenue FROM sales,
      x = date,
      y = revenue,
      facet = region
    )`;

    const ast = parse(source);
    const chart = ast.statements[0];
    expect(chart.kind).toBe(NodeKind.ChartCall);
    if (chart.kind === NodeKind.ChartCall) {
      expect(chart.chartType).toBe('small_multiples');
    }
  });

  it('parses filter.dropdown with SQL query', () => {
    const source = `dashboard "Test" {
      filter.dropdown(
        SELECT DISTINCT category FROM products,
        label = "Category",
        param = "cat_filter"
      )

      chart.bar(
        SELECT name, revenue FROM products,
        x = name,
        y = revenue
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    expect(dashboard.kind).toBe(NodeKind.Dashboard);
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.body).toHaveLength(2);
      expect(dashboard.body[0].kind).toBe(NodeKind.FilterCall);
      if (dashboard.body[0].kind === NodeKind.FilterCall) {
        expect(dashboard.body[0].filterType).toBe('dropdown');
        expect(dashboard.body[0].query).toBeDefined();
        expect(dashboard.body[0].query?.rawSQL).toContain('SELECT DISTINCT category FROM products');
        expect(dashboard.body[0].args).toHaveLength(2);
        expect(dashboard.body[0].args[0].name).toBe('label');
        expect(dashboard.body[0].args[1].name).toBe('param');
      }
    }
  });

  it('parses filter.text without SQL query', () => {
    const source = `dashboard "Test" {
      filter.text(
        label = "Search",
        param = "search_q",
        placeholder = "Type to search..."
      )

      chart.table(
        SELECT * FROM products,
        title = "Products"
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    if (dashboard.kind === NodeKind.Dashboard) {
      const filterNode = dashboard.body[0];
      expect(filterNode.kind).toBe(NodeKind.FilterCall);
      if (filterNode.kind === NodeKind.FilterCall) {
        expect(filterNode.filterType).toBe('text');
        expect(filterNode.query).toBeUndefined();
        expect(filterNode.args).toHaveLength(3);
      }
    }
  });

  it('parses multiple filters in a dashboard', () => {
    const source = `dashboard "Filtered" {
      filter.dropdown(
        SELECT DISTINCT status FROM orders,
        label = "Status",
        param = "status_filter"
      )

      filter.date_range(
        label = "Date",
        param = "date_filter"
      )

      chart.line(
        SELECT date, COUNT(*) as cnt FROM orders GROUP BY date,
        x = date,
        y = cnt
      )
    }`;

    const ast = parse(source);
    const dashboard = ast.statements[0];
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.body).toHaveLength(3);
      expect(dashboard.body[0].kind).toBe(NodeKind.FilterCall);
      expect(dashboard.body[1].kind).toBe(NodeKind.FilterCall);
      expect(dashboard.body[2].kind).toBe(NodeKind.ChartCall);

      if (dashboard.body[0].kind === NodeKind.FilterCall) {
        expect(dashboard.body[0].filterType).toBe('dropdown');
      }
      if (dashboard.body[1].kind === NodeKind.FilterCall) {
        expect(dashboard.body[1].filterType).toBe('date_range');
      }
    }
  });
});

describe('Parser - Block Declaration', () => {
  it('parses a minimal block declaration', () => {
    const source = `block "Revenue by Segment" {
      domain = "revenue"
      type = "chart.bar"
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.name).toBe('Revenue by Segment');
      expect(block.domain).toBe('revenue');
      expect(block.blockType).toBe('chart.bar');
    }
  });

  it('parses a full block with all sections', () => {
    const source = `block "Revenue by Segment" {
      domain = "revenue"
      type = "chart.bar"
      description = "Quarterly revenue breakdown"
      tags = ["revenue", "segment", "quarterly"]

      params {
        period = "current_quarter"
        compare = "prev_quarter"
      }

      query = """
        SELECT s.tier AS segment, SUM(r.revenue) AS revenue
        FROM fct_revenue r
        JOIN dim_segment s ON r.segment_id = s.id
        WHERE r.period = {period}
        GROUP BY s.tier
      """

      visualization {
        chart = "bar"
        x = segment
        y = revenue
        color = "#7c8cf5"
      }

      tests {
        assert row_count > 0
        assert revenue > 0
        assert segment IN ["Enterprise", "Mid-Market", "SMB"]
      }
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.name).toBe('Revenue by Segment');
      expect(block.domain).toBe('revenue');
      expect(block.blockType).toBe('chart.bar');
      expect(block.description).toBe('Quarterly revenue breakdown');
      expect(block.tags).toEqual(['revenue', 'segment', 'quarterly']);

      // Params
      expect(block.params).toBeDefined();
      expect(block.params!.params).toHaveLength(2);
      expect(block.params!.params[0].name).toBe('period');
      expect(block.params!.params[1].name).toBe('compare');

      // Query
      expect(block.query).toBeDefined();
      expect(block.query!.rawSQL).toContain('SELECT s.tier AS segment');
      expect(block.query!.rawSQL).toContain('fct_revenue');
      expect(block.query!.interpolations).toHaveLength(1);
      expect(block.query!.interpolations[0].variableName).toBe('period');

      // Visualization
      expect(block.visualization).toBeDefined();
      expect(block.visualization!.properties).toHaveLength(4);
      expect(block.visualization!.properties[0].name).toBe('chart');
      expect(block.visualization!.properties[1].name).toBe('x');
      expect(block.visualization!.properties[2].name).toBe('y');
      expect(block.visualization!.properties[3].name).toBe('color');

      // Tests
      expect(block.tests).toBeDefined();
      expect(block.tests).toHaveLength(3);
      expect(block.tests![0].field).toBe('row_count');
      expect(block.tests![0].operator).toBe('>');
      expect(block.tests![1].field).toBe('revenue');
      expect(block.tests![1].operator).toBe('>');
      expect(block.tests![2].field).toBe('segment');
      expect(block.tests![2].operator).toBe('IN');
    }
  });

  it('parses block with decorators', () => {
    const source = `@schedule(daily, "9:00 AM")
    @cache("1h")
    block "Daily Revenue" {
      domain = "revenue"
      type = "metric.card"
      query = """
        SELECT SUM(revenue) as total FROM fct_revenue
      """
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(1);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.decorators).toHaveLength(2);
      expect(block.decorators[0].name).toBe('schedule');
      expect(block.decorators[1].name).toBe('cache');
      expect(block.name).toBe('Daily Revenue');
    }
  });

  it('parses block alongside dashboard', () => {
    const source = `block "Churn KPI" {
      domain = "retention"
      type = "metric.card"
    }

    dashboard "Overview" {
      chart.bar(
        SELECT region, SUM(rev) as revenue FROM sales GROUP BY region,
        x = region,
        y = revenue
      )
    }`;

    const ast = parse(source);
    expect(ast.statements).toHaveLength(2);
    expect(ast.statements[0].kind).toBe(NodeKind.BlockDecl);
    expect(ast.statements[1].kind).toBe(NodeKind.Dashboard);
  });

  it('parses block owner field', () => {
    const source = `block "Owned" {
      domain = "revenue"
      type = "chart.bar"
      owner = "kranthi"
    }`;
    const ast = parse(source);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.owner).toBe('kranthi');
    }
  });

  it('parses block test operators >= <= == !=', () => {
    const source = `block "Operator Test" {
      domain = "ops"
      type = "chart.bar"
      tests {
        assert row_count >= 1
        assert row_count <= 100
        assert row_count == 42
        assert row_count != 0
      }
    }`;
    const ast = parse(source);
    const block = ast.statements[0];
    expect(block.kind).toBe(NodeKind.BlockDecl);
    if (block.kind === NodeKind.BlockDecl) {
      expect(block.tests).toHaveLength(4);
      expect(block.tests?.map((t) => t.operator)).toEqual(['>=', '<=', '==', '!=']);
    }
  });

  it('parses use declaration with quoted name', () => {
    const source = `dashboard "Composed" {
      use "Revenue by Segment"
    }`;
    const ast = parse(source);
    const dashboard = ast.statements[0];
    expect(dashboard.kind).toBe(NodeKind.Dashboard);
    if (dashboard.kind === NodeKind.Dashboard) {
      expect(dashboard.body).toHaveLength(1);
      expect(dashboard.body[0].kind).toBe(NodeKind.UseDecl);
      if (dashboard.body[0].kind === NodeKind.UseDecl) {
        expect(dashboard.body[0].name).toBe('Revenue by Segment');
      }
    }
  });
});
