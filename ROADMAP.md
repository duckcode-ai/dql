# DQL Roadmap

This document describes planned work and known limitations. It is a living document — priorities shift based on community feedback and maintainer availability.

For completed changes, see [CHANGELOG.md](./CHANGELOG.md).

---

## Current State (v0.8.7)

DQL is **production-usable** for:
- Authoring and validating `.dql` blocks with SQL, tests, and governance metadata
- Running the notebook against local files (DuckDB) or cloud databases (Postgres, BigQuery, Snowflake, etc.)
- Connecting to existing semantic layers (dbt, Cube.js, Snowflake semantic views)
- Building and serving static HTML dashboards and workbooks
- Certifying blocks with live test assertion execution
- **Answer-layer lineage** — `ref()` system, SQL table extraction, lineage graph, cross-domain flow tracking, trust chains, impact analysis
- **Interactive lineage DAG** — React Flow + dagre graph visualization in the notebook with filtering, focus mode, minimap, and detail panel
- **`dql compile`** — generates `dql-manifest.json` project artifact with blocks, notebooks, metrics, sources, dependencies, and lineage
- **dbt project auto-detection** — `dql init` detects `dbt_project.yml` and `.duckdb` files, configures semantic layer provider, auto-imports semantic definitions
- **Jaffle Shop integration** — canonical getting-started path uses the dbt Jaffle Shop project
- **Enterprise onboarding** — connect any of 14 database drivers, import semantic metrics, build/test/save blocks from Block Studio
- **Connection hot-swap** — change database connections at runtime from the notebook Connection Panel without restarting
- **14 database connectors** — DuckDB, PostgreSQL, MySQL, Snowflake, BigQuery, Redshift, Databricks, MSSQL, SQLite, ClickHouse, Athena, Trino, Fabric, with `listTables()` and `listColumns()` introspection
- **Block Studio** — built-in IDE with database explorer, semantic panel, live validation, run/test/save workflow
- **Lineage CLI** — `dql lineage` with summary, block, table, metric, domain, impact, trust-chain, and JSON export subcommands
- **Lineage API** — REST endpoints for lineage graph, block lineage, domain lineage, impact analysis

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

## Planned for v0.9.0

- Remove `dql test` command (deprecated in v0.5.2)
- Block Governance Bar: switch from regex to full AST round-trip editing
- `dql migrate dbt` — parse dbt model files and translate refs to DQL block syntax
- Dimension, hierarchy, and cube creation from the Semantic Panel UI
- `dql preview --mock` — synthetic data preview without a live connection
- Streaming / paginated query results for large datasets
- **Materializations** — `materialized = "table" | "view" | "incremental" | "ephemeral"` for blocks
- **Column-level lineage** — track which specific columns flow through which blocks

---

## Planned for v1.0.0

- dbt Cloud API integration for remote schema discovery
- Offline semantic layer cache for Snowflake provider
- `dql diff` — show semantic diff between two `.dql` files or block versions
- Improved LSP: completions for `@metric()` / `@dim()` refs in SQL cells
- OpenLineage export for integration with DataHub, Atlan, Monte Carlo

---

## In Progress (open source)

A larger scope expansion landed in v1.4 (work-in-progress on the
`claude/loving-volhard-a2d18e` branch):

- **Apps** — first-class consumption-layer artifact (`apps/<id>/dql.app.json`)
  bundling dashboards, members, roles, access policies, RLS bindings, and
  schedules. CLI: `dql app new|ls|show|build|reindex`.
- **Dashboards** — first-class `.dqld` grid-layout artifact distinct from the
  existing notebook-as-dashboard mode.
- **Programmable RBAC (single-user enforcement)** — App documents declare
  members, roles, and `AccessPolicy` rules; PolicyEngine enforces them
  through a runtime persona registry. Identity stays single-user OSS — the
  local owner can switch personas to preview as a member.
- **Deferred RLS** — `personaVariables()` builds the template-variable map
  for `executor.executeQuery` so `@rls("col", "{user.var}")` decorators are
  resolved at execution time from the active persona.
- **Agent (`@duckcodeailabs/dql-agent`)** — local SQLite + FTS5 knowledge
  graph built from the manifest + dbt + semantic layer + Skills. Block-first
  answer loop: certified blocks first, otherwise the LLM proposes SQL marked
  `Uncertified` and routed through analyst review.
- **Pluggable LLM providers** — Claude Messages API, OpenAI / OpenAI-compatible
  endpoints, Gemini, and local Ollama. `pickProvider()` falls back to the
  first available, ending on Ollama for offline use.
- **MCP tools** — `kg_search` and `feedback_record` join the existing 8 tools
  (`search_blocks`, `get_block`, `query_via_block`, `list_metrics`,
  `list_dimensions`, `lineage_impact`, `certify`, `suggest_block`).
- **Self-learning** — feedback rows feed `getPromotionCandidates()`, surfacing
  uncertified answers ready for analyst certification.
- **Slack front-end (`@duckcodeailabs/dql-slack`)** — slash-command bot
  (`/dql ask <q>`, `/dql block <id>`) + Block-Kit feedback buttons. Same
  block-first loop, Slack signature verification.
- **`dql verify`** — proves the on-disk `dql-manifest.json` is reproducible
  from source. Used by CI to keep programmable artifacts in lock-step.

## Not Planned (Closed Product)

The following remain out of scope for this open-source repository:

- Real authentication (login screens, OIDC, password storage, hosted SSO)
- Hosted cloud notebook or multi-tenant deployment
- Approval workflows, run history, or orchestration as a managed service

These remain part of the closed DuckCode product.

---

## Feedback

Have a feature request or found a bug? [Open a GitHub issue](https://github.com/duckcode-ai/dql/issues) or start a [Discussion](https://github.com/duckcode-ai/dql/discussions).
