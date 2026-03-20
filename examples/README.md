# DQL Examples

This folder contains small DQL examples you can inspect without setting up DuckCode Studio.

## Included Examples

- `blocks/revenue_by_segment.dql` — a simple charted block example
- `blocks/revenue_trend_query_only.dql` — a simple query-only block example
- `finance-kpi/` — smallest runnable KPI-style project
- `dashboard-local/` — multi-chart local dashboard example
- `workbook-local/` — multi-page workbook example
- `duckdb-local/` — local-first preview using the `duckdb` driver
- `semantic-block/` — structure-first semantic block and semantic-layer example

## Recommended Flow

For the easiest runnable experience, scaffold a starter project first:

```bash
dql init my-dql-project
cd my-dql-project
dql new block "Pipeline Health"
dql preview blocks/pipeline_health.dql --open
```

The starter template adds local sample data and a ready-to-use `dql.config.json`.

## Best Next Steps

- Start with `finance-kpi/` if you want the smallest runnable project
- Open `dashboard-local/` if you want to see multiple charts in one file
- Open `workbook-local/` if you want to see multi-page reporting
- Open `duckdb-local/` if you want to test a DuckDB connection path
- Open `semantic-block/` if you want to understand semantic block layout

## Related Docs

- [`../docs/quickstart.md`](../docs/quickstart.md)
- [`../docs/examples.md`](../docs/examples.md)
