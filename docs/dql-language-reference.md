# DQL Language Reference

**Version:** 1.0
**Package:** `@duckcodeailabs/dql-core`

---

## Table of Contents

1. [Overview](#1-overview)
2. [File Structure and Conventions](#2-file-structure-and-conventions)
3. [Block Declaration](#3-block-declaration)
4. [Dashboard Declaration](#4-dashboard-declaration)
5. [Chart Types Reference](#5-chart-types-reference)
6. [Interactions and Drill-Down](#6-interactions-and-drill-down)
7. [Parameters and Templating](#7-parameters-and-templating)
8. [Tests and Assertions](#8-tests-and-assertions)
9. [Decorators](#9-decorators)
10. [Certification Rules](#10-certification-rules)
11. [Migration](#11-migration)
12. [CLI Reference](#12-cli-reference)
13. [Complete Examples](#13-complete-examples)

---

## 1. Overview

DQL (DuckCode Query Language) is a declarative analytics language for defining self-contained, testable, version-controlled units of data analysis. A DQL file wraps SQL queries with metadata, visualization configuration, parameters, test assertions, and governance information.

**Relationship to SQL:** DQL does not replace SQL — it wraps it. Every data-bearing DQL construct embeds standard SQL directly in triple-quoted strings. You write SQL exactly as you would in any query tool; DQL adds the surrounding structure that makes analytics blocks governable, testable, and composable.

**Key concepts:**

- A **block** is the atomic unit — one SQL query, one visualization, one set of tests.
- A **dashboard** composes multiple charts and filters into a layout.
- A **workbook** groups multiple pages, each of which is a dashboard.
- **Certification** is the governance gate that ensures every block has an owner, description, domain, and passing tests before it can be promoted to production.

**Compilation pipeline:**

```
Source (.dql)
  → Lexer → Tokens
  → Parser → AST
  → Semantic Analyzer → Diagnostics
  → IR Lowering → DashboardIR
  → Code Generation
      ├── Vega-Lite (charts)
      ├── React/visx (components)
      ├── HTML (static export)
      └── Runtime JS (interactive dashboards)
```

---

## 2. File Structure and Conventions

DQL files use the `.dql` extension.

### Lexical rules

- **Comments:** Single-line only, introduced with `//`.
- **String literals:** Double-quoted `"value"` for single-line strings; triple-quoted `"""value"""` for multi-line strings (used for SQL).
- **Numbers:** Integer or floating-point: `42`, `3.14`, `-1`.
- **Booleans:** `true`, `false`.
- **Arrays:** `["a", "b", "c"]`.
- **Identifiers:** Used in visualization config to reference column names without quoting: `x = region`.

### Top-level declarations

A `.dql` file may contain one or more top-level declarations in any order:

| Keyword | Description |
|---|---|
| `block` | Atomic analytics block — SQL + metadata + visualization + tests |
| `dashboard` | Composed view of charts and filters |
| `workbook` | Multi-page collection of dashboards |
| `chart` | Standalone chart declaration (wraps in an implicit single-chart dashboard) |
| `import` | Import blocks from another `.dql` file |

### File conventions

- One block per file is idiomatic for governed, certified blocks.
- Dashboards may span many charts and are commonly a single declaration per file.
- File names should use `kebab-case` and match the block or dashboard name.
- The canonical path for certified blocks must not contain `_drafts/`.

---

## 3. Block Declaration

A block is the fundamental unit in DQL. It binds a SQL query to metadata, visualization, tests, and decorators.

### Full syntax

```dql
@decorator_name(args)
block "Block Name" {
  domain      = "domain_name"
  type        = "custom"
  description = "Human-readable description"
  tags        = ["tag1", "tag2"]
  owner       = "team-or-username"
  metric      = "metric_name"          // semantic blocks only

  params {
    param_name = default_value
  }

  query = """
    SELECT column FROM table WHERE condition = ${param_name}
  """

  visualization {
    chart  = "chart_type"
    x      = column_name
    y      = column_name
    color  = "#hex" | column_name
    label  = column_name
    value  = column_name
    size   = column_name
    format = "format_string"
  }

  tests {
    assert row_count > 0
    assert field_name >= value
  }
}
```

### 3.1 Metadata fields

| Field | Type | Required | Description |
|---|---|---|---|
| `domain` | string | Yes | Business domain the block belongs to (e.g., `"revenue"`, `"retention"`, `"sales"`) |
| `type` | string | Yes | Execution type — `"custom"` or `"semantic"` (see below) |
| `description` | string | No | Human-readable description of what the block measures |
| `tags` | string[] | No | Discoverability tags. Recommended for certification. |
| `owner` | string | No | Owner or team responsible for this block. Required for certification. |
| `metric` | string | No | dbt metric name — **only valid on `type = "semantic"` blocks** |

#### Block types

| Value | Behavior |
|---|---|
| `"custom"` | Certified SQL block. The `query` field contains the SQL executed at runtime. The `metric` field must be absent. |
| `"semantic"` | Semantic layer reference. The `metric` field names a dbt metric; SQL is managed by the semantic layer. The `query` field must be absent. |

```dql
// Custom block
block "Revenue by Segment" {
  domain = "revenue"
  type   = "custom"
  query  = """SELECT segment, SUM(revenue) FROM fct_revenue GROUP BY 1"""
}

// Semantic block — no query field
block "ARR Growth" {
  domain = "finance"
  type   = "semantic"
  metric = "annual_recurring_revenue"
}
```

### 3.2 params block

The `params` block declares named parameters with default values. Parameters are interpolated into SQL at runtime.

```dql
params {
  period            = "current_quarter"
  limit             = 10
  include_forecast  = false
}
```

- Parameter names must be valid identifiers.
- Default values may be strings, numbers, or booleans.
- Parameter type is inferred from the default value: number literals become `number`, boolean literals become `boolean`, everything else becomes `string`.
- Parameters are used in `query` via `${param_name}` or the legacy `{param_name}` syntax.

### 3.3 query field

Required for `type = "custom"` blocks; must be omitted for `type = "semantic"` blocks.

```dql
query = """
  SELECT
    segment_tier  AS segment,
    SUM(amount)   AS revenue
  FROM fct_revenue
  WHERE fiscal_period = ${period}
  GROUP BY segment_tier
  ORDER BY revenue DESC
"""
```

- SQL is written inside triple-quoted strings and may span multiple lines.
- Standard SQL is supported; DQL does not restrict or modify the SQL syntax.
- Parameter placeholders: `${param_name}` (preferred) or `{param_name}` (legacy).

### 3.4 visualization block

Optional. When present, maps query result columns to chart rendering properties.

```dql
visualization {
  chart  = "bar"
  x      = segment
  y      = revenue
  color  = "#6366f1"
}
```

The `chart` property accepts any of the 19 chart type identifiers or their aliases (see [Section 5](#5-chart-types-reference)).

**Common visualization properties:**

| Property | Type | Description |
|---|---|---|
| `chart` | string | Chart type identifier |
| `x` | identifier | Column mapped to the x-axis or category dimension |
| `y` | identifier | Column mapped to the y-axis or primary value |
| `color` | identifier or hex string | Column for color encoding, or a fixed hex color |
| `label` | identifier | Column used as a display label (pie, funnel) |
| `value` | identifier | Column used as the value (donut, funnel, kpi) |
| `size` | identifier | Column mapped to point size (scatter, geo) |
| `format` | string | Number format string |

Block-level visualizations support a subset of chart config properties. For the full set of chart-specific properties see [Section 5](#5-chart-types-reference).

### 3.5 tests block

Optional assertions that run against the query result. All assertions must pass for the block to receive certification.

```dql
tests {
  assert row_count > 0
  assert max(total_revenue) > 0
  assert min(retention_pct) >= 0
  assert churn_rate <= 1
  assert status IN ["active", "pending"]
}
```

See [Section 8](#8-tests-and-assertions) for the complete operators reference.

### 3.6 Block decorators

Decorators appear immediately before the `block` keyword.

```dql
@schedule(daily, "9:00 AM")
@email_to("team@example.com")
@cache("24h")
@alert("SELECT COUNT(*) FROM errors", ">= 100")
block "Error Rate Monitor" { ... }
```

See [Section 9](#9-decorators) for all decorator types.

---

## 4. Dashboard Declaration

A dashboard composes multiple charts, filters, and layout directives into a single view.

### Full syntax

```dql
@schedule(daily, "9:00 AM")
@email_to("stakeholder@example.com")
@cache("1h")
dashboard "Dashboard Title" {

  // Typed parameters
  param region:  string  = "all"
  param start:   date    = "2024-01-01"
  param limit:   number  = 100
  param active:  boolean = true

  // Variables (computed at runtime)
  let today = CURRENT_DATE

  // Filter controls
  filter.dropdown(SELECT DISTINCT region FROM sales, label="Region", param="region", default_value="all", placeholder="All regions", width=200)
  filter.date_range(label="Date Range", param="start", default_value="2024-01-01", format="YYYY-MM-DD", width=200)
  filter.text(label="Search", param="search", placeholder="Type to search...", debounce=300, width=200)
  filter.multi_select(SELECT DISTINCT status FROM orders, label="Status", param="status", default_value=["active", "pending"], placeholder="Select statuses...", width=200)
  filter.range(label="Price Range", param="price", min=0, max=1000, step=10, width=200)

  // Inline chart calls
  chart.bar(SELECT region, SUM(revenue) AS revenue FROM sales GROUP BY region, x=region, y=revenue, title="Revenue by Region")
  chart.line(SELECT month, revenue FROM monthly_summary, x=month, y=revenue, title="Monthly Trend")
  chart.kpi(SELECT SUM(revenue) AS total_revenue, COUNT(*) AS deals FROM sales, metrics=["total_revenue", "deals"], format="currency")

  // Reference a named block
  use "Revenue by Segment"

  // Grid layout
  layout {
    columns = 12
  }
}
```

### 4.1 param declarations

Typed parameter declarations at the top of a dashboard define the variables available to filters and chart SQL.

```dql
param name: string  = "default_value"
param name: number  = 0
param name: boolean = false
param name: date    = "2024-01-01"
```

| Type | Description |
|---|---|
| `string` | Text value |
| `number` | Integer or float |
| `boolean` | `true` or `false` |
| `date` | ISO date string `"YYYY-MM-DD"` |

Parameters are passed into chart SQL using `${param_name}` interpolation.

### 4.2 let variables

`let` binds a runtime variable to a computed expression.

```dql
let today = CURRENT_DATE
```

Variables are evaluated in the runtime context and injected into SQL the same way as parameters.

### 4.3 Filters

Filters render interactive controls that update parameter values, which in turn re-execute charts. DQL supports five filter types.

#### filter.dropdown

Renders a single-selection dropdown populated by a SQL query.

```dql
filter.dropdown(
  SELECT DISTINCT region FROM sales ORDER BY region,
  label         = "Region",
  param         = "region",
  default_value = "all",
  placeholder   = "All regions",
  width         = 200
)
```

| Argument | Type | Required | Description |
|---|---|---|---|
| SQL query | SQL | Yes (first positional) | Query providing dropdown options |
| `label` | string | No | Display label above the control |
| `param` | string | Yes | Parameter name to set when selection changes |
| `default_value` | string | No | Initial selected value |
| `placeholder` | string | No | Placeholder text when no value is selected |
| `width` | number | No | Control width in pixels |

#### filter.date_range

Renders a date range picker.

```dql
filter.date_range(
  label         = "Date Range",
  param         = "start_date",
  default_value = "2024-01-01",
  format        = "YYYY-MM-DD",
  width         = 200
)
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `label` | string | No | Display label |
| `param` | string | Yes | Parameter name |
| `default_value` | string | No | Initial date |
| `format` | string | No | Date format string (e.g., `"YYYY-MM-DD"`) |
| `width` | number | No | Control width in pixels |

#### filter.text

Renders a free-text input field with optional debounce.

```dql
filter.text(
  label       = "Search",
  param       = "search_term",
  placeholder = "Type to search...",
  debounce    = 300,
  width       = 200
)
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `label` | string | No | Display label |
| `param` | string | Yes | Parameter name |
| `placeholder` | string | No | Input placeholder text |
| `debounce` | number | No | Debounce delay in milliseconds before updating param |
| `width` | number | No | Control width in pixels |

#### filter.multi_select

Renders a multi-selection dropdown populated by a SQL query.

```dql
filter.multi_select(
  SELECT DISTINCT status FROM orders ORDER BY status,
  label         = "Status",
  param         = "status",
  default_value = ["active", "pending"],
  placeholder   = "Select statuses...",
  width         = 200
)
```

| Argument | Type | Required | Description |
|---|---|---|---|
| SQL query | SQL | Yes (first positional) | Query providing options |
| `label` | string | No | Display label |
| `param` | string | Yes | Parameter name |
| `default_value` | string[] | No | Initial selected values (array) |
| `placeholder` | string | No | Placeholder text |
| `width` | number | No | Control width in pixels |

#### filter.range

Renders a numeric range slider.

```dql
filter.range(
  label  = "Price Range",
  param  = "price",
  min    = 0,
  max    = 1000,
  step   = 10,
  width  = 200
)
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `label` | string | No | Display label |
| `param` | string | Yes | Parameter name |
| `min` | number | No | Minimum slider value |
| `max` | number | No | Maximum slider value |
| `step` | number | No | Step increment |
| `width` | number | No | Control width in pixels |

### 4.4 chart.type() inline calls

Inline chart calls embed a SQL query directly, avoiding the need to declare a separate block.

```dql
chart.bar(
  SELECT region, SUM(revenue) AS revenue FROM sales GROUP BY region,
  x     = region,
  y     = revenue,
  title = "Revenue by Region"
)
```

The general form is:

```dql
chart.<type>(
  <SQL query>,
  <named_arg> = <value>,
  ...
)
```

All 19 chart types are available as `chart.<type>(...)` calls. The first argument is always the SQL query (positional, no keyword). All subsequent arguments are named. See [Section 5](#5-chart-types-reference) for per-type required and optional arguments.

### 4.5 use references

`use` embeds a named block (by its quoted string name) into the dashboard.

```dql
use "Revenue by Segment"
```

The block must be declared in the same file or imported via `import`. The block's SQL, visualization config, and params are all inherited.

### 4.6 import

Import named blocks from another `.dql` file.

```dql
import { RevenueBySegment, MonthlyTrend } from "./revenue/blocks.dql"
```

Imported blocks can be referenced with `use` or composed into dashboards.

### 4.7 layout block

The `layout` block configures the grid system used for chart placement.

```dql
layout {
  columns = 12
}
```

| Property | Type | Default | Description |
|---|---|---|---|
| `columns` | number | `12` | Total grid columns. Charts auto-span based on count: 1 chart = 12 columns; 2+ charts = 6 columns each. |

The layout system uses CSS grid. Charts are placed left-to-right, wrapping to a new row when columns are exhausted. For precise placement, use `layout` blocks with explicit `row` declarations (see workbook page layouts).

### 4.8 Dashboard decorators

Decorators appear immediately before the `dashboard` keyword.

```dql
@schedule(daily, "9:00 AM")
@email_to("team@company.com")
@cache("1h")
dashboard "Executive Summary" { ... }
```

See [Section 9](#9-decorators).

---

## 5. Chart Types Reference

DQL supports 19 canonical chart types. Each chart type has required fields, optional fields, and supports the full set of common optional arguments listed at the end of this section.

### Common optional arguments

These arguments are supported by all chart types:

| Argument | Type | Description |
|---|---|---|
| `title` | string | Chart title displayed above the chart |
| `title_font_size` | number | Title font size in points |
| `theme` | `"dark"` \| `"light"` | Visual theme override |
| `color` | string (hex) | Fixed color for the chart's primary series |
| `show_grid` | boolean | Show/hide grid lines |
| `show_legend` | boolean | Show/hide legend |
| `width` | number | Chart width in pixels |
| `height` | number | Chart height in pixels |
| `on_click` | string | Action on bar/point click (see [Section 6](#6-interactions-and-drill-down)) |
| `drill_down` | string | Column to drill into on click |
| `link_to` | string | URL to navigate to on click |
| `filter_by` | string \| string[] | Column(s) to use for cross-dashboard filtering on click |
| `drill_hierarchy` | string | Named semantic hierarchy for structured drill-down |
| `drill_path` | string | Starting path within the drill hierarchy |
| `drill_mode` | `"modal"` \| `"replace"` \| `"expand"` | How drill-down renders (default: `"modal"`) |
| `y2` | string | Column for a secondary y-axis (combo charts) |
| `tooltip` | string[] | Columns to include in the hover tooltip |
| `format_x` | string | Format string for x-axis labels |
| `format_y` | string | Format string for y-axis labels |
| `color_rule` | string | Conditional color rule expression |
| `connection` | string | Named database connection to use for this chart |
| `rollup` | `"sum"` \| `"count"` \| `"count_distinct"` \| `"avg"` \| `"min"` \| `"max"` \| `"none"` | Aggregation method for drill rollups |

---

### 5.1 line

Renders a line chart. Suitable for time-series and continuous data.

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `line_width` | number | Stroke width of the line |
| `fill_opacity` | number | Fill opacity under the line (0–1); `0` = no fill |
| `stroke_dash` | string | Dash pattern for the line stroke (e.g., `"4,2"`) |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.line(
  SELECT month, SUM(revenue) AS revenue FROM monthly_sales GROUP BY month ORDER BY month,
  x             = month,
  y             = revenue,
  title         = "Monthly Revenue",
  line_width    = 2,
  fill_opacity  = 0.1,
  x_axis_label  = "Month",
  y_axis_label  = "Revenue ($)",
  show_grid     = true
)
```

**Aliases:** `forecast` (normalizes to `line`)

---

### 5.2 bar

Renders a bar chart. Default orientation is vertical (column chart).

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `orientation` | `"vertical"` \| `"horizontal"` | Bar direction (default: `"vertical"`) |
| `bar_width` | number | Width of each bar in pixels |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.bar(
  SELECT region, SUM(revenue) AS revenue FROM sales GROUP BY region ORDER BY revenue DESC,
  x             = region,
  y             = revenue,
  color         = "#6366f1",
  title         = "Revenue by Region",
  bar_width     = 30,
  x_axis_label  = "Region",
  y_axis_label  = "Total Revenue"
)
```

---

### 5.3 scatter

Renders a scatter plot. Suitable for correlation and distribution analysis.

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `size` | string | Column to map to point size |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.scatter(
  SELECT region, SUM(revenue) AS revenue, SUM(units) AS units FROM sales GROUP BY region,
  x            = units,
  y            = revenue,
  color        = region,
  size         = revenue,
  title        = "Revenue vs Units by Region",
  x_axis_label = "Units Sold",
  y_axis_label = "Revenue"
)
```

---

### 5.4 area

Renders an area chart. Like a line chart with the region below the line filled.

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `fill_opacity` | number | Opacity of the filled area (0–1, default: 0.3) |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.area(
  SELECT week, SUM(signups) AS signups FROM user_events GROUP BY week ORDER BY week,
  x            = week,
  y            = signups,
  fill_opacity = 0.4,
  title        = "Weekly Signups",
  color        = "#10b981"
)
```

**Aliases:** `stacked-area`, `stacked_area` (both normalize to `area`)

---

### 5.5 pie

Renders a pie chart. Use `inner_radius` for a donut variant.

**Required:** `x` (category/label), `y` (value)

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `inner_radius` | number | Inner radius ratio (0–1). `0` = full pie; `0.5` = donut. |

**Example:**

```dql
chart.pie(
  SELECT product, SUM(revenue) AS revenue FROM sales GROUP BY product,
  x     = product,
  y     = revenue,
  title = "Revenue Mix by Product"
)
```

**Donut variant:**

```dql
chart.pie(
  SELECT product, SUM(revenue) AS revenue FROM sales GROUP BY product,
  x            = product,
  y            = revenue,
  inner_radius = 0.5,
  title        = "Revenue Mix (Donut)"
)
```

**Aliases:** `donut` (normalizes to `pie` with `inner_radius = 0.5`)

---

### 5.6 heatmap

Renders a heatmap. Encodes a numeric value as color intensity across a two-dimensional grid.

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `color_field` | string | Column used for color intensity encoding |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.heatmap(
  SELECT day_of_week, hour_of_day, COUNT(*) AS events FROM user_events GROUP BY 1, 2,
  x           = day_of_week,
  y           = hour_of_day,
  color_field = events,
  title       = "Activity Heatmap"
)
```

---

### 5.7 kpi

Renders one or more KPI cards — large numeric displays with optional comparison.

**Required:** none (uses `metrics` to specify columns)

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `metrics` | string[] | Columns to render as KPI cards. Each column becomes one card. |
| `compare_to_previous` | boolean | Show change indicator vs. prior period |
| `format` | `"currency"` \| `"percent"` \| `"integer"` | Number formatting mode |

**Format values:**

| Value | Behavior |
|---|---|
| `"currency"` | Formats as `$1,234.56` |
| `"percent"` | Multiplies by 100, formats as `12.3%` |
| `"integer"` | Formats as `1,234` (no decimal places) |
| _(omitted)_ | Formats to 2 decimal places |

**Example:**

```dql
chart.kpi(
  SELECT SUM(revenue) AS total_revenue, COUNT(*) AS deal_count, AVG(deal_size) AS avg_deal FROM sales,
  metrics            = ["total_revenue", "deal_count", "avg_deal"],
  compare_to_previous = true,
  format             = "currency",
  title              = "Sales Summary"
)
```

---

### 5.8 table

Renders a paginated data table.

**Required:** none (all columns from the query result are shown by default)

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `columns` | string[] | Explicit list of columns to display, in order |
| `sortable` | boolean | Allow column sort on click (default: `true`) |
| `page_size` | number | Rows per page (default: `25`) |
| `pin_columns` | string[] | Columns to pin to the left side of the table |
| `row_color` | string | Column or expression to conditionally color rows |

**Example:**

```dql
chart.table(
  SELECT id, customer, region, revenue, status FROM deals ORDER BY revenue DESC,
  columns     = ["id", "customer", "region", "revenue", "status"],
  sortable    = true,
  page_size   = 50,
  pin_columns = ["id", "customer"],
  title       = "Deal List"
)
```

---

### 5.9 metric

Renders a single prominent metric display. Simpler than `kpi` — intended for one value.

**Required:** none

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `format` | string | Number format string |
| `compare_to_previous` | boolean | Show change indicator |

**Example:**

```dql
chart.metric(
  SELECT SUM(mrr) AS mrr FROM subscriptions WHERE active = true,
  format             = "currency",
  compare_to_previous = true,
  title              = "MRR"
)
```

---

### 5.10 stacked_bar

Renders a stacked bar chart where multiple series are stacked vertically (or horizontally) within each bar.

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `orientation` | `"vertical"` \| `"horizontal"` | Stack direction (default: `"vertical"`) |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.stacked_bar(
  SELECT region, product, SUM(revenue) AS revenue FROM sales GROUP BY region, product,
  x     = region,
  y     = revenue,
  color = product,
  title = "Revenue by Region and Product"
)
```

**Aliases:** `stacked-bar`

---

### 5.11 grouped_bar

Renders a grouped (clustered) bar chart where multiple series appear side-by-side within each group.

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `orientation` | `"vertical"` \| `"horizontal"` | Group direction (default: `"vertical"`) |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.grouped_bar(
  SELECT quarter, segment, SUM(revenue) AS revenue FROM sales GROUP BY quarter, segment,
  x     = quarter,
  y     = revenue,
  color = segment,
  title = "Revenue by Quarter and Segment"
)
```

**Aliases:** `grouped-bar`

---

### 5.12 combo

Renders a combination chart — bars for one series, lines for another, optionally on a dual y-axis.

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `y2` | string | Column for the secondary y-axis (rendered as a line) |
| `color_field` | string | Column used for color encoding |
| `line_width` | number | Width of the line series |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Primary y-axis label |

**Example:**

```dql
chart.combo(
  SELECT month, SUM(revenue) AS revenue, AVG(margin_pct) AS margin FROM monthly_sales GROUP BY month,
  x            = month,
  y            = revenue,
  y2           = margin,
  title        = "Revenue and Margin",
  y_axis_label = "Revenue ($)",
  line_width   = 2
)
```

---

### 5.13 histogram

Renders a frequency histogram. The x-axis is the value being binned; the y-axis is the count.

**Required:** `x`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `y` | string | If provided, used as the value for aggregation (instead of count) |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.histogram(
  SELECT deal_size FROM deals,
  x            = deal_size,
  title        = "Deal Size Distribution",
  x_axis_label = "Deal Size ($)",
  y_axis_label = "Count"
)
```

---

### 5.14 funnel

Renders a funnel chart showing stage-by-stage conversion.

**Required:** `x` (stage name), `y` (count or value)

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.funnel(
  SELECT stage, COUNT(*) AS count FROM pipeline GROUP BY stage ORDER BY step_order,
  x     = stage,
  y     = count,
  title = "Sales Funnel",
  color = "#6366f1"
)
```

---

### 5.15 treemap

Renders a hierarchical treemap where rectangles are sized by value.

**Required:** `x` (category), `y` (value)

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `color_field` | string | Column used for color encoding |

**Example:**

```dql
chart.treemap(
  SELECT product_category, SUM(revenue) AS revenue FROM sales GROUP BY product_category,
  x           = product_category,
  y           = revenue,
  color_field = revenue,
  title       = "Revenue by Category"
)
```

**Aliases:** `tree-map`

---

### 5.16 sankey

Renders a Sankey flow diagram showing flow between nodes.

**Required:** `x` (source), `y` (target). A third column for flow value is typically expected in the query.

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `color_field` | string | Column used for color encoding |

**Example:**

```dql
chart.sankey(
  SELECT source_channel, conversion_stage, COUNT(*) AS users FROM funnel_events GROUP BY 1, 2,
  x           = source_channel,
  y           = conversion_stage,
  color_field = source_channel,
  title       = "User Flow by Channel"
)
```

**Aliases:** `flow`

---

### 5.17 sparkline

Renders a compact sparkline — a small line chart without axes, intended for embedding in tables or KPI grids.

**Required:** `x`, `y`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `line_width` | number | Stroke width of the sparkline |

**Example:**

```dql
chart.sparkline(
  SELECT week, SUM(revenue) AS revenue FROM weekly_sales GROUP BY week ORDER BY week,
  x          = week,
  y          = revenue,
  line_width = 1.5,
  height     = 60
)
```

**Aliases:** `spark-line`, `spark`

---

### 5.18 small_multiples

Renders a trellis of small charts, one per value of a facet dimension.

**Required:** `x`, `y`, `facet`

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `color_field` | string | Column used for color encoding within each facet |
| `line_width` | number | Line width for line-type facets |
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.small_multiples(
  SELECT region, month, SUM(revenue) AS revenue FROM sales GROUP BY region, month,
  x            = month,
  y            = revenue,
  facet        = region,
  title        = "Revenue Trend by Region",
  x_axis_label = "Month",
  y_axis_label = "Revenue"
)
```

**Aliases:** `small-multiples`, `small_multiple`, `small-multiple`

---

### 5.19 gauge

Renders a gauge / dial chart. Suitable for displaying a value relative to a target or threshold.

**Required:** `y` (the value column)

**Example:**

```dql
chart.gauge(
  SELECT AVG(satisfaction_score) AS score FROM nps_surveys,
  y     = score,
  title = "NPS Score",
  color = "#10b981"
)
```

---

### 5.20 waterfall

Renders a waterfall chart showing incremental changes from a starting value to a final value.

**Required:** `x` (category), `y` (value)

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.waterfall(
  SELECT component, value FROM revenue_bridge ORDER BY sort_order,
  x            = component,
  y            = value,
  title        = "Revenue Bridge",
  x_axis_label = "Component",
  y_axis_label = "Revenue Impact ($)"
)
```

---

### 5.21 boxplot

Renders a box-and-whisker chart showing distribution statistics (median, quartiles, outliers).

**Required:** `x` (category), `y` (value distribution)

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `x_axis_label` | string | Custom x-axis label |
| `y_axis_label` | string | Custom y-axis label |

**Example:**

```dql
chart.boxplot(
  SELECT region, deal_size FROM deals,
  x            = region,
  y            = deal_size,
  title        = "Deal Size Distribution by Region",
  x_axis_label = "Region",
  y_axis_label = "Deal Size ($)"
)
```

---

### 5.22 geo

Renders a geographic map with point markers overlaid on a world map.

**Required:** `x` (longitude), `y` (latitude)

**Type-specific optional arguments:**

| Argument | Type | Description |
|---|---|---|
| `color_field` | string | Column used for point color encoding |
| `size` | string | Column mapped to point size |
| `topology_url` | string | URL of a TopoJSON topology file. Default: Vega world-110m |

The default projection is Mercator. Points are rendered as circles with opacity 0.8.

**Example:**

```dql
chart.geo(
  SELECT city, longitude, latitude, revenue FROM store_locations,
  x           = longitude,
  y           = latitude,
  color_field = revenue,
  size        = revenue,
  title       = "Store Revenue by Location"
)
```

---

### Chart type alias table

| Alias | Canonical type |
|---|---|
| `donut` | `pie` (with `inner_radius = 0.5`) |
| `forecast` | `line` |
| `stacked-bar` | `stacked_bar` |
| `grouped-bar` | `grouped_bar` |
| `stacked-area`, `stacked_area` | `area` |
| `tree-map` | `treemap` |
| `flow` | `sankey` |
| `spark-line`, `spark` | `sparkline` |
| `small-multiples`, `small_multiple`, `small-multiple` | `small_multiples` |

---

## 6. Interactions and Drill-Down

Charts support interactive behaviors that respond to user clicks.

### 6.1 on_click

Executes a named action when a chart element is clicked.

```dql
chart.bar(
  ...,
  on_click = "navigate_to_detail"
)
```

### 6.2 link_to

Navigates to a URL when a chart element is clicked. The URL may include parameter interpolations.

```dql
chart.bar(
  ...,
  link_to = "/dashboards/region-detail?region=${region}"
)
```

### 6.3 drill_down

Specifies a column or dimension to drill into when a chart element is clicked. Used for simple drill-down without a semantic hierarchy.

```dql
chart.bar(
  ...,
  drill_down = "product_category"
)
```

### 6.4 filter_by

Specifies a column (or array of columns) that act as cross-dashboard filters when clicked. Clicking a chart element sets a filter that propagates to other charts sharing the same parameter.

```dql
chart.bar(
  ...,
  filter_by = "region"
)

// Multiple columns
chart.scatter(
  ...,
  filter_by = ["region", "segment"]
)
```

### 6.5 drill_hierarchy and drill_mode

Structured drill-down uses a named semantic hierarchy defined in the semantic layer. This enables a multi-level drill path (e.g., Year → Quarter → Month).

```dql
chart.bar(
  SELECT fiscal_year, SUM(revenue) AS revenue FROM fct_revenue GROUP BY fiscal_year,
  x               = fiscal_year,
  y               = revenue,
  drill_hierarchy = "revenue_time",
  drill_path      = "fiscal_year",
  drill_mode      = "modal"
)
```

| Argument | Type | Description |
|---|---|---|
| `drill_hierarchy` | string | Name of the semantic hierarchy to use |
| `drill_path` | string | Starting level within the hierarchy |
| `drill_mode` | `"modal"` \| `"replace"` \| `"expand"` | How the drill-down view renders |

**drill_mode values:**

| Value | Behavior |
|---|---|
| `"modal"` | Opens drill-down in an overlay modal (default) |
| `"replace"` | Replaces the current chart in-place |
| `"expand"` | Expands the chart area to show the drill-down content |

When `drill_hierarchy` is provided without `drill_path` or `drill_mode`, those default to the hierarchy's first level and `"modal"` respectively.

---

## 7. Parameters and Templating

### 7.1 Parameter syntax

DQL supports two interpolation syntaxes for embedding parameters in SQL:

| Syntax | Status | Example |
|---|---|---|
| `${param_name}` | Preferred | `WHERE region = ${region}` |
| `{param_name}` | Legacy (supported) | `WHERE region = {region}` |

Both forms are recognized by the lexer and produce identical parameterized queries at compile time. New DQL files should use `${...}`.

### 7.2 Block params

Block-level params are declared in the `params` block and interpolated into `query`:

```dql
block "Revenue by Period" {
  domain = "finance"
  type   = "custom"

  params {
    period     = "current_quarter"
    segment    = "all"
    limit      = 100
  }

  query = """
    SELECT segment, SUM(revenue) AS revenue
    FROM fct_revenue
    WHERE fiscal_period = ${period}
      AND (${segment} = 'all' OR segment_tier = ${segment})
    GROUP BY segment
    LIMIT ${limit}
  """
}
```

### 7.3 Dashboard params

Dashboard-level params use explicit type annotations and are interpolated into chart SQL:

```dql
dashboard "Sales Overview" {
  param region:     string  = "all"
  param start_date: date    = "2024-01-01"
  param limit:      number  = 50
  param show_all:   boolean = false

  chart.bar(
    SELECT region, SUM(revenue) AS revenue FROM sales
    WHERE (${region} = 'all' OR region = ${region})
      AND sale_date >= ${start_date}
    GROUP BY region
    LIMIT ${limit},
    x = region,
    y = revenue
  )
}
```

### 7.4 param types

| Type | DQL keyword | Default value example |
|---|---|---|
| Text | `string` | `= "default"` |
| Numeric | `number` | `= 100` |
| Flag | `boolean` | `= true` |
| Calendar | `date` | `= "2024-01-01"` |

### 7.5 Runtime variables

`let` declares a variable computed at runtime. The only built-in runtime value is `CURRENT_DATE`.

```dql
let today = CURRENT_DATE
```

Variables participate in SQL interpolation the same way as params.

---

## 8. Tests and Assertions

The `tests` block in a block declaration defines assertions that must pass against the query result for the block to be certified.

### Assertion syntax

```dql
tests {
  assert <field_expression> <operator> <expected_value>
}
```

### 8.1 Comparison operators

| Operator | Meaning | Example |
|---|---|---|
| `>` | Greater than | `assert row_count > 0` |
| `>=` | Greater than or equal | `assert row_count >= 12` |
| `<` | Less than | `assert max(cost) < 10000000` |
| `<=` | Less than or equal | `assert churn_rate <= 1` |
| `==` | Equal to | `assert status == "active"` |
| `!=` | Not equal to | `assert error_count != 0` |
| `IN` | Value in set | `assert status IN ["active", "pending"]` |

### 8.2 Field expressions

| Expression | Description |
|---|---|
| `row_count` | Total number of rows returned by the query |
| `field_name` | A column value (applied row-by-row or as an aggregate) |
| `max(field_name)` | Maximum value of a column |
| `min(field_name)` | Minimum value of a column |

### 8.3 Examples

```dql
tests {
  // Data freshness — at least one row returned
  assert row_count > 0

  // Value range checks
  assert min(revenue) >= 0
  assert max(churn_rate) <= 1
  assert min(retention_pct) >= 0

  // Exact count check
  assert row_count >= 12

  // Enum validation
  assert status IN ["active", "churned", "trial"]

  // Null-equivalent check using == with numeric threshold
  assert max(error_count) == 0
}
```

### 8.4 Test execution

In the CLI, `dql test <file.dql>` performs a dry run (lists assertions without executing them). Live execution requires a database connection. All tests must pass before `dql certify` can succeed.

---

## 9. Decorators

Decorators are annotations that attach scheduling, notification, caching, and alerting behavior to blocks and dashboards. They appear on the lines immediately before the declaration they annotate.

### 9.1 @schedule

Schedules the block or dashboard for automatic refresh.

```dql
@schedule(daily, "9:00 AM")
@schedule(weekly, "monday")
@schedule(hourly)
@schedule(cron, "30 8 * * 1-5")   // Every weekday at 8:30 AM
```

| Form | Cron equivalent | Description |
|---|---|---|
| `@schedule(daily, "HH:MM AM/PM")` | `MM HH * * *` | Daily at the specified time |
| `@schedule(daily)` | `0 0 * * *` | Daily at midnight |
| `@schedule(weekly, "day_name")` | `0 0 * * N` | Weekly on the specified day |
| `@schedule(weekly)` | `0 0 * * 1` | Weekly on Monday |
| `@schedule(hourly)` | `0 * * * *` | Every hour |
| `@schedule(cron, "expr")` | The cron expression | Raw cron expression |

Day names for weekly schedule: `sunday`, `monday`, `tuesday`, `wednesday`, `thursday`, `friday`, `saturday`.

### 9.2 @email_to

Sends the dashboard output to one or more email recipients after a scheduled refresh.

```dql
@email_to("analyst@company.com")
@email_to("team@company.com", "executive@company.com")
```

Multiple recipients can be specified as additional arguments, or by stacking multiple `@email_to` decorators.

### 9.3 @cache

Caches query results for the specified duration. Subsequent loads within the TTL window serve cached data without re-querying.

```dql
@cache("1h")    // 1 hour
@cache("24h")   // 24 hours
@cache(300)     // 300 seconds (5 minutes)
```

| Form | Description |
|---|---|
| `@cache("Nh")` | Cache for N hours |
| `@cache(N)` | Cache for N seconds |

Applies to dashboards and standalone chart calls. On a block, it controls caching when the block's query is executed.

### 9.4 @if

Conditionally renders a chart based on a parameter value. The chart is included only when the named parameter is truthy.

```dql
@if(show_forecast)
chart.line(
  SELECT month, revenue FROM forecast,
  x = month,
  y = revenue
)
```

The argument must be a parameter name. The chart is omitted from the rendered dashboard if the parameter evaluates to `false`, `null`, `""`, or `0`.

### 9.5 @alert

Triggers a notification when a SQL condition exceeds a threshold. Designed for monitoring blocks.

```dql
@alert("SELECT COUNT(*) FROM error_log WHERE created_at > NOW() - INTERVAL '1 hour'", ">= 10")
@alert("SELECT AVG(p95_latency_ms) FROM api_metrics", "> 2000", "High latency detected")
```

| Argument | Position | Description |
|---|---|---|
| SQL condition | 1 | SQL query returning a single numeric value |
| Threshold expression | 2 | Operator and threshold value (e.g., `">= 10"`, `"> 500"`) |
| Message | 3 (optional) | Human-readable alert message |

Supported threshold operators: `>`, `<`, `>=`, `<=`, `==`, `!=`.

### 9.6 @refresh

Controls automatic refresh interval for dashboards (in seconds).

```dql
@refresh(60)   // Refresh every 60 seconds
```

### 9.7 @rls (Row-Level Security)

Applies row-level security by injecting a WHERE clause into the chart's SQL. Used on individual chart calls within dashboards.

```dql
@rls("user_id", "{current_user_id}")
chart.table(SELECT * FROM user_data, ...)
```

| Argument | Position | Description |
|---|---|---|
| Column | 1 | The column to filter on |
| Value | 2 | A variable reference `{variable_name}` or a literal value |

The decorator wraps the chart SQL as `SELECT * FROM (<original_sql>) _dql_rls WHERE <column> = $N`.

### 9.8 @annotate

Adds a visual annotation to a chart at a specific x-axis value.

```dql
@annotate("2024-01-01", "New pricing launched", "#ef4444")
chart.line(SELECT month, revenue FROM monthly, x=month, y=revenue)
```

| Argument | Position | Description |
|---|---|---|
| x value | 1 | The x-axis value where the annotation appears |
| Label | 2 | Annotation text |
| Color | 3 (optional) | Hex color for the annotation marker |

### 9.9 @materialize

Marks a chart for materialization, pre-computing and caching results on a schedule.

```dql
@materialize("hourly")
chart.bar(SELECT ..., x=region, y=revenue)
```

### 9.10 @slack_channel

Sends dashboard output to a Slack channel after a scheduled refresh.

```dql
@slack_channel("#analytics-reports")
```

---

## 10. Certification Rules

Certification is the governance gate that validates a block before it can be promoted to production. Run `dql certify <file.dql>` to evaluate all blocks in a file.

### Standard rules (all blocks)

| Rule ID | Severity | Passes when |
|---|---|---|
| `has-description` | **error** | `description` field is present and non-empty |
| `has-owner` | **error** | `owner` field is present and non-empty |
| `has-domain` | **error** | `domain` field is present and non-empty |
| `has-tags` | warning | `tags` array is present and contains at least one entry |
| `tests-pass` | **error** | All test assertions pass (requires test results) |
| `has-tests` | warning | At least one `assert` statement is declared in `tests` |
| `cost-reasonable` | warning | Static query cost estimate is ≤ 100 |

A block is **certifiable** when all error-severity rules pass. Warnings do not block certification but are reported.

### Promote-only rules

These additional rules apply when promoting a block to a production registry:

| Rule ID | Severity | Passes when |
|---|---|---|
| `canonical-git-path` | **error** | Block's Git path does not contain `/_drafts/` or start with `blocks/_drafts/` |
| `stable-version` | **error** | Block has a semantic version matching `/^\d+\.\d+\.\d+$/` |

### Cost estimate

The `cost-reasonable` rule uses a static analysis score (0–100) that penalizes patterns like missing WHERE clauses, `SELECT *`, high JOIN counts, and missing aggregation limits. View the breakdown with `dql info <file.dql> --verbose`.

### Certification output example

```
Block: "Revenue by Segment"
Status: ✓ CERTIFIABLE

Warnings (1):
  ⚠ recommend-tags: No tags specified
```

```
Block: "Ad Hoc Query"
Status: ✗ NOT CERTIFIABLE

Errors (2):
  ✗ has-owner: Missing owner
  ✗ has-description: Missing description
```

---

## 11. Migration

The `dql migrate` command scaffolds DQL blocks from existing analytics tools. It is a scaffold-only command — it generates templates and migration notes. It does not automatically parse or transform source files (except as noted).

```bash
dql migrate <source> [--input <path>]
```

### Supported migration sources

| Source | Method | Automation level |
|---|---|---|
| `looker` | Parses LookML explores, measures, and dimensions → DQL blocks + semantic layer YAML | ~80% automated |
| `tableau` | Extracts via REST API → one DQL block per sheet | Semi-automated |
| `dbt` | Inspects models and metrics → DQL blocks + semantic layer files | Planning-only in v1 |
| `metabase` | Exports via API → one DQL block per saved question | ~85% automated |
| `raw-sql` | AI-assisted wrapping of ad-hoc SQL into DQL block structure | AI-assisted |

### Flags

| Flag | Description |
|---|---|
| `--input <path>` | Source path (e.g., a dbt project directory or LookML file) |

### Migration workflow

```bash
# 1. Generate a template for the target source
dql migrate looker

# 2. Point at actual source files
dql migrate looker --input ./my-lookml-project

# 3. Review generated blocks in blocks/migrated/
# 4. Run tests
dql test blocks/migrated/example.dql

# 5. Run certification and fix any errors
dql certify blocks/migrated/example.dql

# 6. Commit and push for promotion
```

---

## 12. CLI Reference

The `dql` binary is provided by `@duckcodeailabs/dql-cli`.

### Usage

```bash
dql <command> <file.dql> [flags]
```

### Global flags

| Flag | Short | Default | Description |
|---|---|---|---|
| `--format json\|text` | | `text` | Output format. Use `json` for CI pipelines and programmatic consumers. |
| `--verbose` | `-v` | `false` | Show detailed output (full AST for `parse`, cost factor breakdown for `info`). |
| `--help` | `-h` | | Print help and exit. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Parse error, semantic error, certification failure, unformatted file (with `--check`), unknown command, or unhandled runtime error |

---

### dql parse

Parse a `.dql` file and run semantic analysis.

```bash
dql parse <file.dql> [--verbose] [--format json|text]
```

Validates:
- Lexer and parser correctness (syntax errors)
- Semantic rules: required block fields (`domain`, `type`), valid chart types, structural consistency

**Text output (clean):**
```
  ✓ Parsed: examples/blocks/revenue_by_segment.dql
    Statements: 1
    Diagnostics: ✓ No errors, no warnings
```

**JSON output shape:**
```json
{
  "file": "examples/blocks/revenue_by_segment.dql",
  "statements": 1,
  "diagnostics": [],
  "ast": { }
}
```
The `ast` key is only present with `--verbose`.

---

### dql test

Inspect test assertions in each block. Performs a dry run — actual execution requires a live database connection.

```bash
dql test <file.dql> [--format json|text]
```

**Text output:**
```
  ✓ Found 1 block(s) in examples/blocks/revenue_by_segment.dql

  Block: "Revenue by Segment"
    Tests: 1 assertion(s)
    → assert row_count > 0
    Status: ⚠ Dry run (no database connection)
    Hint: Connect a database to execute assertions
```

**JSON output shape:**
```json
{
  "file": "examples/blocks/revenue_by_segment.dql",
  "blocks": [
    { "name": "Revenue by Segment", "tests": 1 }
  ],
  "note": "Test execution requires a database connection."
}
```

---

### dql certify

Evaluate certification rules against every block in the file.

```bash
dql certify <file.dql> [--format json|text]
```

Checks: `has-description`, `has-owner`, `has-domain`, `has-tags`, `tests-pass`, `has-tests`, `cost-reasonable`.

**Text output (passes):**
```
  Block: "Revenue by Segment"
  Status: ✓ CERTIFIABLE
```

**Text output (fails):**
```
  Block: "Revenue by Segment"
  Status: ✗ NOT CERTIFIABLE

  Errors (1):
    ✗ requires-owner: Block must have an owner field

  Warnings (1):
    ⚠ recommend-tags: Block has no tags; add tags to improve discoverability
```

**JSON output shape:**
```json
{
  "certified": false,
  "errors": [
    { "rule": "requires-owner", "message": "Block must have an owner field" }
  ],
  "warnings": []
}
```

---

### dql fmt

Format a `.dql` file in place using the canonical DQL formatter.

```bash
dql fmt <file.dql> [--check]
```

| Flag | Description |
|---|---|
| `--check` | Do not write; exit 1 if the file differs from canonical form. Suitable for CI and pre-commit hooks. |

**Text output (write mode, changed):**
```
  ✓ Formatted: examples/blocks/revenue_by_segment.dql
```

**Text output (check mode, needs changes):**
```
  ✗ Needs formatting: examples/blocks/revenue_by_segment.dql
```

**JSON output shape:**
```json
{ "file": "examples/blocks/revenue_by_segment.dql", "changed": true, "mode": "check" }
```

---

### dql info

Print structured metadata for every block in the file, including a static query cost estimate.

```bash
dql info <file.dql> [--verbose] [--format json|text]
```

**Text output:**
```
  Block: "Revenue by Segment"
    Domain:      revenue
    Type:        custom
    Owner:       data-team
    Description: Quarterly revenue grouped by customer segment
    Tags:        revenue, segment, quarterly
    Params:      1
    Tests:       1 assertion(s)

    Cost Estimate: 15/100
    → Query looks efficient
```

With `--verbose`, individual cost factors are listed (e.g., missing WHERE clause, SELECT *, JOIN count).

**JSON output shape:**
```json
{
  "name": "Revenue by Segment",
  "domain": "revenue",
  "type": "custom",
  "description": "...",
  "owner": "data-team",
  "tags": ["revenue", "segment", "quarterly"],
  "query": "SELECT ...",
  "params": { "period": "current_quarter" },
  "tests": 1,
  "costEstimate": {
    "score": 15,
    "recommendation": "Query looks efficient",
    "factors": []
  }
}
```

---

### dql migrate

Scaffold a DQL block from a foreign tool definition.

```bash
dql migrate <source> [--input <path>] [--format json|text]
```

Sources: `looker`, `tableau`, `dbt`, `metabase`, `raw-sql`

| Flag | Description |
|---|---|
| `--input <path>` | Source path for the migration (e.g., dbt project directory) |

---

## 13. Complete Examples

### Example 1: Bar chart block with tests

A fully certified block showing revenue by region with a bar chart and assertions.

```dql
@schedule(daily, "8:00 AM")
@email_to("analytics@company.com")
block "Revenue by Region" {
  domain      = "sales"
  type        = "custom"
  description = "Total revenue broken down by sales region, updated daily"
  tags        = ["sales", "regional", "revenue", "certified"]
  owner       = "analytics-team"

  params {
    start_date = "2024-01-01"
    end_date   = "2024-12-31"
  }

  query = """
    SELECT
      region,
      SUM(revenue)  AS total_revenue,
      COUNT(*)      AS deal_count,
      AVG(revenue)  AS avg_deal_size
    FROM fct_sales
    WHERE sale_date BETWEEN ${start_date} AND ${end_date}
    GROUP BY region
    ORDER BY total_revenue DESC
  """

  visualization {
    chart  = "bar"
    x      = region
    y      = total_revenue
    color  = "#6366f1"
  }

  tests {
    assert row_count > 0
    assert min(total_revenue) >= 0
    assert max(total_revenue) < 100000000
    assert min(deal_count) > 0
  }
}
```

Run the certification check:

```bash
dql certify sales/revenue-by-region.dql
# Block: "Revenue by Region"
# Status: ✓ CERTIFIABLE
```

---

### Example 2: Dashboard with filters, three charts, and params

A full dashboard with a dropdown filter, date range filter, and three charts using shared parameters.

```dql
@schedule(daily, "7:00 AM")
@email_to("vp-sales@company.com")
@cache("2h")
dashboard "Sales Performance Dashboard" {

  param region:     string = "all"
  param start_date: date   = "2024-01-01"
  param end_date:   date   = "2024-12-31"

  // Filter controls
  filter.dropdown(
    SELECT DISTINCT region FROM fct_sales ORDER BY region,
    label         = "Region",
    param         = "region",
    default_value = "all",
    placeholder   = "All Regions",
    width         = 200
  )

  filter.date_range(
    label         = "Date Range",
    param         = "start_date",
    default_value = "2024-01-01",
    format        = "YYYY-MM-DD",
    width         = 200
  )

  // KPI row
  chart.kpi(
    SELECT
      SUM(revenue)      AS total_revenue,
      COUNT(DISTINCT id) AS deal_count,
      AVG(revenue)      AS avg_deal
    FROM fct_sales
    WHERE sale_date BETWEEN ${start_date} AND ${end_date}
      AND (${region} = 'all' OR region = ${region}),
    metrics = ["total_revenue", "deal_count", "avg_deal"],
    format  = "currency",
    title   = "Sales KPIs"
  )

  // Monthly trend line
  chart.line(
    SELECT
      DATE_TRUNC('month', sale_date) AS month,
      SUM(revenue) AS revenue
    FROM fct_sales
    WHERE sale_date BETWEEN ${start_date} AND ${end_date}
      AND (${region} = 'all' OR region = ${region})
    GROUP BY 1
    ORDER BY 1,
    x            = month,
    y            = revenue,
    title        = "Monthly Revenue Trend",
    line_width   = 2,
    fill_opacity = 0.1,
    x_axis_label = "Month",
    y_axis_label = "Revenue ($)",
    show_grid    = true
  )

  // Revenue by product stacked bar
  chart.stacked_bar(
    SELECT
      region,
      product_line,
      SUM(revenue) AS revenue
    FROM fct_sales
    WHERE sale_date BETWEEN ${start_date} AND ${end_date}
      AND (${region} = 'all' OR region = ${region})
    GROUP BY region, product_line
    ORDER BY region,
    x     = region,
    y     = revenue,
    color = product_line,
    title = "Revenue by Region and Product Line"
  )

  layout {
    columns = 12
  }
}
```

---

### Example 3: Semantic block referencing MetricFlow

A block that delegates SQL execution to the dbt semantic layer via a named metric.

```dql
block "ARR by Customer Tier" {
  domain      = "finance"
  type        = "semantic"
  metric      = "annual_recurring_revenue"
  description = "Annual Recurring Revenue segmented by customer tier, sourced from the dbt semantic layer"
  tags        = ["finance", "arr", "semantic", "certified"]
  owner       = "finance-analytics"

  visualization {
    chart  = "bar"
    x      = customer_tier
    y      = annual_recurring_revenue
    color  = "#10b981"
  }

  tests {
    assert row_count > 0
    assert min(annual_recurring_revenue) >= 0
  }
}
```

The corresponding semantic layer YAML definitions that back this block:

```yaml
# semantic-layer/metrics/arr.yaml
metrics:
  - name: annual_recurring_revenue
    sql: SUM(mrr * 12)
    type: sum
    table: fct_subscriptions
    description: Annual Recurring Revenue
    dimensions:
      - customer_tier
      - contract_type
      - region
```

```yaml
# semantic-layer/blocks/arr_by_customer_tier.yaml
name: arr_by_customer_tier
block: arr_by_customer_tier
domain: finance
description: ARR semantic mappings for the customer tier breakdown block
semanticMappings:
  customer_tier: customer_tier_dimension
  annual_recurring_revenue: annual_recurring_revenue
reviewStatus: approved
```

When the runtime encounters `type = "semantic"`, it routes the query to MetricFlow rather than executing inline SQL. The `metric` field is the dbt metric name; the dimensions available as `x` in the visualization are declared in the metric's YAML definition.

To parse and inspect this block:

```bash
dql parse finance/arr-by-tier.dql
dql certify finance/arr-by-tier.dql
dql info finance/arr-by-tier.dql --format json
```
