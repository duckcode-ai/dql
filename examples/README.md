# DQL Examples

This folder now contains both small syntax references and fuller open-source showcase projects you can inspect without setting up DuckCode Studio.

## Included Examples

- `blocks/revenue_by_segment.dql` — a simple charted block example
- `blocks/revenue_trend_query_only.dql` — a simple query-only block example
- `ecommerce-analytics/` — realistic commerce KPIs, funnel analysis, and notebook walkthrough
- `saas-metrics/` — MRR, churn, and retention examples with notebook walkthrough
- `nyc-taxi/` — trip operations example with browser notebook support
- `finance-kpi/` — smallest runnable KPI-style project
- `dashboard-local/` — multi-chart local dashboard example
- `workbook-local/` — multi-page workbook example
- `duckdb-local/` — local-first preview using the `duckdb` driver
- `semantic-block/` — structure-first semantic block and semantic-layer example

## Recommended Flow

For the easiest runnable experience, scaffold a starter project first or open one of the richer showcase projects above:

```bash
dql init my-dql-project
cd my-dql-project
dql notebook
```

The starter template adds local sample data and a ready-to-use `dql.config.json`.

## Best Next Steps

- Start with `ecommerce-analytics/` if you want the most polished open-source demo
- Start with `saas-metrics/` if you want recurring-revenue metrics and churn analysis
- Start with `nyc-taxi/` if you want city operations and trip analysis
- Start with `finance-kpi/` if you want the smallest runnable project
- Open `dashboard-local/` if you want to see multiple charts in one file
- Open `workbook-local/` if you want to see multi-page reporting
- Open `duckdb-local/` if you want to test a DuckDB connection path
- Open `semantic-block/` if you want to understand semantic block layout

## Related Docs

- [`../docs/quickstart.md`](../docs/quickstart.md)
- [`../docs/examples.md`](../docs/examples.md)
