# Compatibility

## Runtime

- **Node.js** — 18, 20, or 22 (active LTS)
- **Package managers** — npm, pnpm, yarn all work for consuming published packages
- **OS** — macOS, Linux, Windows

## Connectors

All 15 drivers ship in `@duckcodeailabs/dql-connectors`. For first-run local
exploration, start with `duckdb` or `file`. See [Connectors](./connectors.md).

## Chart types

`bar`, `line`, `scatter`, `donut`, `pie`, `area`, `heatmap`, `kpi`, `table`,
`histogram`, `grouped-bar`, `stacked-bar`, `waterfall`, `funnel`, `gauge`,
`geo`, `combo`, `boxplot`, `forecast`, `stacked-area`.

## Editor support

- **VS Code** — [`dql.dql-language-support`](https://marketplace.visualstudio.com/items?itemName=dql.dql-language-support) extension (syntax, snippets, LSP)
- **Any LSP client** — `@duckcodeailabs/dql-lsp` speaks standard LSP

## What's in this repo

- DQL language (parser, formatter, AST)
- CLI (`init`, `notebook`, `compile`, `sync`, `diff`, `preview`, `serve`, `certify`, `test`, `fmt`, `doctor`)
- Notebook UI (SQL + DQL cells, block studio, lineage panel, git panel)
- Semantic layer (local YAML + dbt import)
- Lineage DAG (table / block / notebook granularity)
- 15 database connectors
- Plugin API (custom connectors, charts, governance rules)
- OpenLineage export

## What's **not** in this repo

Lives in the closed DuckCode Cloud product:

- Column-level lineage
- Hosted multi-user workspace (SSO, RBAC, audit log)
- Scheduled runs, alerting, orchestration
- Regulatory governance packs (SOX, HIPAA, GDPR)
- AI / agentic block generation
- Premium connectors (SAP, Oracle, mainframe)
- Federated multi-warehouse blocks
