# DQL Language Specification

**Version:** 1.0.0  
**Status:** Implemented in `@dql/core`

---

## Overview

DQL (DuckCode Query Language) is a declarative language for defining analytics blocks — self-contained, testable, version-controlled units of data analysis. Each block wraps SQL with metadata, optional visualization config, parameters, and test assertions.

## Lexical Structure

### Keywords

```
block, domain, type, description, tags, owner, params, query, visualization,
tests, assert, var, chart, import, use, dashboard, workbook, filter, layout
```

### Chart Types

```
bar, line, scatter, donut, pie, area, heatmap, kpi, table, histogram,
grouped-bar, stacked-bar, waterfall, funnel, gauge, geo, combo, boxplot,
forecast, stacked-area
```

### Literals

- **Strings:** `"double quoted"` or `"""triple quoted for multi-line"""`
- **Numbers:** `42`, `3.14`, `-1`
- **Booleans:** `true`, `false`
- **Arrays:** `["a", "b", "c"]`

### Comments

```dql
// Single-line comment
```

### SQL Fragments

SQL is embedded in triple-quoted strings. Parameter interpolation supports both `${param_name}` and `{param_name}` (legacy).

## Block Declaration

A block is the atomic unit of the platform:

```dql
block "Block Name" {
    domain = "domain_name"
    type = "chart.bar"
    description = "Human-readable description"
    tags = ["tag1", "tag2"]
    owner = "username"

    params { ... }
    query = """..."""
    visualization { ... }
    tests { ... }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `domain` | string | Business domain (revenue, retention, sales, etc.) |
| `type` | string | Block type (chart.bar, metric.card, predict.score, etc.) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Human-readable description |
| `tags` | string[] | Discoverability tags |
| `owner` | string | Block owner/maintainer |

## Parameters

Parameters allow blocks to be reusable with different inputs:

```dql
params {
    period = "current_quarter"
    limit = 10
    include_forecast = false
}
```

Parameters are interpolated in SQL via `${param_name}` or `{param_name}`.

## Query

The query field contains SQL wrapped in triple-quoted strings:

```dql
query = """
    SELECT segment, SUM(revenue) AS revenue
    FROM fct_revenue
    WHERE period = ${period}
    GROUP BY segment
    ORDER BY revenue DESC
"""
```

## Visualization

The `visualization` section is optional. Query-only blocks can omit it when the asset is meant for reuse, validation, or downstream composition rather than direct chart rendering.

Visualization config maps query columns to chart properties:

```dql
visualization {
    chart = "bar"
    x = segment
    y = revenue
    color = "#7c8cf5"
}
```

### Chart Properties

| Property | Description |
|----------|-------------|
| `x` | X-axis column |
| `y` | Y-axis column (or array for multi-series) |
| `color` | Color hex or column for color-by |
| `color_by` | Column for categorical coloring |
| `label` | Label column (for donut/funnel) |
| `value` | Value column (for donut/funnel/kpi) |
| `format` | Number format (compact, currency, percent) |

## Test Assertions

Blocks can include test assertions that validate query results:

```dql
tests {
    assert row_count > 0
    assert max(revenue) < 10000000
    assert min(retention_pct) >= 0
    assert churn_rate <= 1
}
```

### Assertion Operators

`>`, `<`, `>=`, `<=`, `==`, `!=`

## Dashboard Declaration

Multiple blocks can be composed into dashboards:

```dql
dashboard "Revenue Overview" {
    use RevenueBySegment
    use "ARR Trend"

    chart.bar(
      SELECT segment, SUM(revenue) AS revenue FROM fct_revenue GROUP BY segment,
      x = segment,
      y = revenue
    )
}
```

## Import System

Blocks can import from other files:

```dql
import { RevenueBySegment } from "./revenue/rev-by-segment.dql"
```

## Semantic Layer Integration

Blocks can reference metrics and dimensions from the semantic layer. The semantic layer can also carry hierarchy definitions and optional companion business metadata for individual blocks:

```yaml
# semantic-layer/metrics/revenue.yaml
metrics:
  - name: total_revenue
    sql: SUM(amount)
    type: sum
    table: fct_revenue
```

```yaml
# semantic-layer/hierarchies/revenue_time.yaml
name: revenue_time
label: Revenue Time
description: Calendar drill path for revenue reporting
domain: revenue
levels:
  - name: fiscal_year
    dimension: fiscal_year
    order: 1
  - name: fiscal_quarter
    dimension: fiscal_quarter
    order: 2
```

```yaml
# semantic-layer/blocks/revenue_by_segment.yaml
name: revenue_by_segment
block: revenue_by_segment
domain: revenue
description: Business context and semantic mappings for the segment revenue block
semanticMappings:
  segment: segment_tier
  revenue: total_revenue
reviewStatus: review
```

The `SemanticLayer` class validates metric, dimension, and hierarchy definitions. Companion metadata is a separate typed YAML contract for block-level business context.

## AST Node Types

The parser produces a typed AST with 30+ node kinds:

- `ProgramNode` — root node
- `BlockDeclNode` — block declaration
- `DashboardDeclNode` — dashboard declaration
- `ChartDeclNode` — chart configuration
- `QueryNode` — SQL query
- `ParamDeclNode` — parameter declaration
- `TestAssertionNode` — test assertion
- `ImportDeclNode` — import declaration
- `UseDeclNode` — use declaration
- `FilterDeclNode` — filter declaration
- `LayoutDeclNode` — layout configuration

## Compilation Pipeline

```
Source → Lexer → Tokens → Parser → AST → Semantic Analysis → IR → Code Generation
                                                                    ├── Vega-Lite
                                                                    ├── React (visx)
                                                                    ├── HTML
                                                                    └── Runtime JS
```
