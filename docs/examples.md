# Examples

This page helps new users find the fastest working examples in the DQL repo.

## Best First Example

Start with the scaffolded starter project or the richer example folders:

```bash
dql init my-dql-project
cd my-dql-project
dql notebook
```

This is the recommended first-run experience because it includes local data and a working config file.

## Repo Examples

### `examples/ecommerce-analytics/`

Use this example if you want the strongest open-source first impression.

Good for learning:

- browser notebook flow with `.dqlnb` files
- realistic commerce metrics and funnel analysis
- reusable blocks plus a polished dashboard

### `examples/saas-metrics/`

Use this example to explore recurring revenue, churn, and cohort retention.

Good for learning:

- MRR and churn modeling in DQL
- notebook-first analysis for executive KPIs
- blending reusable blocks with dashboard rollups

### `examples/nyc-taxi/`

Use this example to explore mobility analytics with local sample trip data.

Good for learning:

- operations metrics and time-series analysis
- notebook-driven ad hoc SQL exploration
- charting non-financial datasets in DQL

### `examples/finance-kpi/`

Use this example if you want the smallest fully runnable DQL project.

Good for learning:

- local project layout
- KPI chart output
- `dql preview` and `dql build` basics

### `examples/dashboard-local/`

Use this example to see multiple chart calls in one dashboard file.

Good for learning:

- dashboard syntax
- mixing KPI, bar, and table charts
- local CSV-backed dashboards

### `examples/workbook-local/`

Use this example to see a workbook with multiple pages.

Good for learning:

- workbook syntax
- multi-page compiled output
- local reporting flows

### `examples/duckdb-local/`

Use this example to try DQL with a `duckdb` default connection.

Good for learning:

- local DuckDB execution path
- local analytics without warehouse credentials
- preview flow with a different default driver

### `examples/semantic-block/`

Use this example to understand semantic block structure and semantic-layer layout.

Good for learning:

- `type = "semantic"`
- metric references
- semantic-layer companion files

### `examples/blocks/revenue_by_segment.dql`

Use this example to understand a standard charted block with:

- a SQL query
- a visualization section
- reusable block metadata

Good for learning:

- block structure
- bar chart configuration
- field mapping from SQL output to chart axes

### `examples/blocks/revenue_trend_query_only.dql`

Use this example to understand a query-only block without a chart.

Good for learning:

- query-only assets
- metadata and block structure without visualization
- workflows where a table or downstream export matters more than charting

## Starter Template Files

When you run `dql init`, the starter template gives you a local project plus a browser notebook walkthrough to experiment with.

Key files:

- `blocks/revenue_by_segment.dql`
- `blocks/revenue_trend_query_only.dql`
- `data/revenue.csv`
- `dql.config.json`
- `notebooks/welcome.dqlnb`

These are the most important files for open-source evaluation because they work without external warehouse credentials.

## Recommended Order

1. `examples/ecommerce-analytics/`
2. `examples/saas-metrics/`
3. `examples/nyc-taxi/`
4. `examples/dashboard-local/`
5. `examples/workbook-local/`

## Suggested Learning Path

### 1. Preview the starter chart

```bash
dql preview blocks/pipeline_health.dql --open
```

### 2. Parse a block and inspect its structure

```bash
dql parse blocks/pipeline_health.dql --verbose
```

### 3. Build and serve the bundle

```bash
dql build blocks/pipeline_health.dql
dql serve dist/pipeline_health --open
```

### 4. Modify the block

Try changing:

- `chart = "bar"` to another supported chart
- the SQL aggregation
- the title or tags
- the preview port in `dql.config.json`

## Related Docs

- [Getting Started](./getting-started.md)
- [Language Specification](./dql-language-spec.md)
- [Data Sources](./data-sources.md)
- [Migration Guides](./migration-guides/README.md)
