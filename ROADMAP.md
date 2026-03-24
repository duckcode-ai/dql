# DQL Roadmap

This document describes planned work and known limitations. It is a living document — priorities shift based on community feedback and maintainer availability.

For completed changes, see [CHANGELOG.md](./CHANGELOG.md).

---

## Current State (v0.7.0)

DQL is **production-usable** for:
- Authoring and validating `.dql` blocks with SQL, tests, and governance metadata
- Running the notebook against local files (DuckDB) or cloud databases (Postgres, BigQuery, Snowflake, etc.)
- Connecting to existing semantic layers (dbt, Cube.js, Snowflake semantic views)
- Building and serving static HTML dashboards and workbooks
- Certifying blocks with live test assertion execution
- **Answer-layer lineage** — `ref()` system, SQL table extraction, lineage graph, cross-domain flow tracking, trust chains, impact analysis
- **`dql compile`** — generates `dql-manifest.json` project artifact with blocks, notebooks, metrics, sources, dependencies, and lineage
- **dbt manifest import** — `dql compile --dbt-manifest` connects dbt's lineage as upstream into DQL's answer layer
- **Notebook lineage** — `.dqlnb` SQL/DQL cells included in lineage graph and manifest
- **Smart lineage lookup** — `dql lineage <name>` resolves any node type; `--table`, `--metric`, `--impact` work on all node types
- **Lineage CLI** — `dql lineage` with summary, block, table, metric, domain, impact, trust-chain, and JSON export subcommands
- **Lineage API** — REST endpoints for lineage graph, block lineage, domain lineage, impact analysis
- **Lineage notebook panel** — interactive sidebar panel for browsing lineage in the notebook UI

---

## Known Limitations

### Language

- **Block Governance Bar uses regex parsing** — the inline governance form in the notebook parses `block { ... }` with regex rather than the AST. Complex multi-line blocks with nested braces in string values may not parse correctly. A full round-trip AST edit is planned for v0.6.0.
- **`dql migrate`** — currently scaffolds a template skeleton only; it does not parse the source file and translate SQL or schema references automatically. Richer source-specific translation is planned.
- **No streaming query results** — large query results are loaded fully into memory before rendering. Pagination and streaming are not yet supported.

### Semantic Layer

- **New Metric form writes YAML only** — the "New Metric" form in the Semantic Panel creates a `metrics/` YAML file. Creating dimensions, hierarchies, or cubes from the UI is not yet supported; use a text editor for those.
- **Snowflake semantic views** — requires a live Snowflake connection at notebook startup. If the connection is unavailable, the semantic layer falls back to empty. Better error messaging and offline cache are planned.
- **dbt semantic models** — reads `models/**/*.yml` files only. dbt Cloud API integration (for remote schema) is not yet implemented.

### CLI

- **`dql test` is deprecated** — use `dql certify --connection` instead. `dql test` will be removed in v0.6.0.
- **`dql preview` requires a connection** — there is no mock-data preview mode. A `--mock` flag that generates synthetic data from the schema is planned.

### Tooling

- **VS Code extension** — syntax highlighting and snippets work. LSP-based completions, hover documentation, and inline diagnostics are available but may lag on very large files.
- **No browser extension or cloud notebook** — the notebook runs locally only. A hosted/cloud version is part of the closed DuckCode product, not this repo.

---

## Planned for v0.8.0

- Remove `dql test` command (deprecated in v0.5.2)
- Block Governance Bar: switch from regex to full AST round-trip editing
- `dql migrate dbt` — parse dbt model files and translate refs to DQL block syntax
- Dimension, hierarchy, and cube creation from the Semantic Panel UI
- `dql preview --mock` — synthetic data preview without a live connection
- Streaming / paginated query results for large datasets
- **Materializations** — `materialized = "table" | "view" | "incremental" | "ephemeral"` for blocks
- **Column-level lineage** — track which specific columns flow through which blocks
- **Interactive lineage visualization** — DAG rendering in the notebook with domain coloring and trust indicators
- **Database catalog introspection** — `dql compile --connection` introspects actual table schemas into manifest

---

## Planned for v0.9.0

- dbt Cloud API integration for remote schema discovery
- Offline semantic layer cache for Snowflake provider
- `dql diff` — show semantic diff between two `.dql` files or block versions
- Improved LSP: completions for `@metric()` / `@dim()` refs in SQL cells
- More project templates: healthcare KPIs, marketing attribution
- OpenLineage export for integration with DataHub, Atlan, Monte Carlo

---

## Not Planned (Closed Product)

The following are intentionally out of scope for this open-source repository:

- Natural-language / agentic block generation
- MCP runtime integration
- Approval workflows, run history, or orchestration
- Hosted cloud notebook or multi-user collaboration

These remain part of the closed DuckCode product.

---

## Feedback

Have a feature request or found a bug? [Open a GitHub issue](https://github.com/duckcode-ai/dql/issues) or start a [Discussion](https://github.com/duckcode-ai/dql/discussions).
