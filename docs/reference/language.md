# DQL language

The source of truth for the language lives in
[`docs/dql-language-spec.md`](https://github.com/duckcode-ai/dql/blob/main/docs/dql-language-spec.md).
This page summarizes the surface; the spec goes deeper on grammar and
evaluation order.

## File structure

```dql
// dql-format: 1

// Optional dashboard header
dashboard: { title: "…", layout: "grid" }

// Optional params
param region: select(options: ["us", "eu"], default: "us")

// Cells or blocks
---
query: select count(*) from @table("orders")
visualization: kpi
---
```

## Blocks

```dql
block my_block {
  domain: "finance"
  owner:  "team@company.com"
  tags:   ["tag1"]
  description: "…"

  query: |
    select …

  visualization: bar(x: "…", y: "…")

  tests:
    - row_count > 0
    - unique: [id]
}
```

## References

Inside `query` strings you can reference:

| Syntax | Resolves to |
| --- | --- |
| `@table("name")` | A semantic table (dbt model or DQL-local) |
| `@metric("name")` | A semantic metric with SQL-level substitution |
| `@dim("cube.name")` | A dimension |
| `@block("name")` | An inline-compiled block |
| `@param("name")` | A notebook parameter value |

## Visualizations

Primary chart types: `bar`, `line`, `area`, `pie`, `donut`, `scatter`,
`heatmap`, `funnel`, `waterfall`, `histogram`, `gauge`, `stacked-bar`,
`grouped-bar`, `kpi`, `table`.

Each takes an options object:

```dql
visualization: line(x: "date", y: "revenue", color: "segment",
                    title: "Daily revenue", legendPosition: "bottom")
```

For the full grammar and type system, see the
[language spec](https://github.com/duckcode-ai/dql/blob/main/docs/dql-language-spec.md).
