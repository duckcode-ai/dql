# DQL Examples

This folder now contains both small syntax references and fuller open-source showcase projects you can inspect without setting up DuckCode Studio.

## Showcase Examples (with Semantic Layer)

| Example | Data | Metrics | Dimensions | Blocks |
|---|---|---|---|---|
| `ecommerce-analytics/` | 50 orders across 4 regions | gmv, order_count, avg_order_value, gross_margin_pct, repeat_rate | channel, segment, region, order_date | 5 |
| `saas-metrics/` | 31 SaaS accounts + 12 cohorts | mrr, expansion_mrr, account_count, avg_mrr | plan_tier, status, owner_segment, risk_bucket | 4 |
| `nyc-taxi/` | 40 taxi trips across 5 boroughs | total_fare, trip_count, avg_fare, total_tips | pickup_borough, dropoff_borough, payment_type, airport_flag | 3 |

## Utility Examples

- `blocks/revenue_by_segment.dql` — a simple charted block example
- `blocks/revenue_trend_query_only.dql` — a simple query-only block example
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
