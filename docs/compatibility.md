# Compatibility

This document describes the current DQL open-source compatibility target for local use, package consumption, and experimentation.

## Runtime Requirements

### Node.js

- Node.js 18 or newer is required for the public CLI and package workspace.

### Package Managers

- `npm` works for published package installation.
- `pnpm` is recommended when working from source in the monorepo.

## Supported CLI Workflows

The current open-source Phase 1 workflow centers on:

- `dql init`
- `dql doctor`
- `dql parse`
- `dql fmt`
- `dql info`
- `dql test`
- `dql certify`
- `dql preview`
- `dql build`
- `dql serve`

Recommended first-run path:

```bash
dql init my-dql-project
cd my-dql-project
dql doctor
dql new block "Pipeline Health"
dql preview blocks/pipeline_health.dql --open
```

## Supported Project Config

Current local-first docs and starter templates assume `dql.config.json` as the project config file.

It is used for:

- default connection settings
- preview host and port
- auto-open behavior
- theme selection

## Connector Compatibility

The connector layer currently includes these drivers:

| Driver | Status | Best Use |
|---|---|---|
| `file` | Recommended for first-run | Local CSV/Parquet exploration |
| `duckdb` | Recommended for first-run | Local DuckDB-backed analytics |
| `sqlite` | Supported | Lightweight local database workflows |
| `postgresql` | Supported | Warehouse or OLTP-backed query execution |
| `mysql` | Supported | MySQL-backed query execution |
| `mssql` | Supported | SQL Server-backed query execution |
| `bigquery` | Supported | BigQuery-backed query execution |
| `snowflake` | Supported | Snowflake-backed query execution |

### Recommendation

For open-source evaluation, start with:

- `file`
- `duckdb`

These have the lowest onboarding friction and work best with the starter project model.

## Visualization Compatibility

The language spec currently documents support for these chart types:

- `bar`
- `line`
- `scatter`
- `donut`
- `pie`
- `area`
- `heatmap`
- `kpi`
- `table`
- `histogram`
- `grouped-bar`
- `stacked-bar`
- `waterfall`
- `funnel`
- `gauge`
- `geo`
- `combo`
- `boxplot`
- `forecast`
- `stacked-area`

For easiest first-run results, start with:

- `bar`
- `line`
- `table`
- `kpi`

## Language Surface Compatibility

### Reusable blocks

Supported block types:

- `type = "custom"`
- `type = "semantic"`

### Dashboards and workbooks

DQL also supports:

- `dashboard "..." { ... }`
- `workbook "..." { ... }`

### Recommended starting point

For open-source adoption and local experimentation, start with:

- reusable `custom` blocks
- local data
- `dql preview`

## Editor Compatibility

The open DQL repo includes:

- a VS Code extension
- a reusable language-server package: `@duckcodeailabs/dql-lsp`

These provide:

- syntax highlighting
- formatting
- hover docs
- completions
- diagnostics

## Platform Notes

Because the connector workspace depends on several database client libraries, some setups may require compatible native binaries or system libraries depending on the driver you use.

If you want the lowest-friction setup, prefer the local-first path:

- starter project
- `file` or `duckdb` connector
- local preview server

## Known OSS Phase 1 Limits

- The easiest supported path today is local-first preview, not full enterprise deployment.
- `dql preview` and `dql serve` use a lightweight local query API for interactive rendering.
- `dql test` is most useful when a runnable query execution path is configured.
- The fastest adoption path is currently the CLI and source workspace; published package availability may depend on your release process.

## Recommended Baseline for New Users

If you want the smoothest experience, use this baseline:

- Node.js 18+
- starter project created with `dql init`
- local sample data
- `file` or `duckdb` connection
- `dql preview` for experimentation

## Related Docs

- [Quickstart](./quickstart.md)
- [FAQ](./faq.md)
- [Project Config](./project-config.md)
- [Data Sources](./data-sources.md)
- [CLI Reference](./cli-reference.md)
