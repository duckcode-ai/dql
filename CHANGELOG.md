# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## v1.4.0 — 2026-04-25

### Apps, Agentic Analytics, programmable end-to-end DQL

A major scope expansion landing the consumption layer (Apps + first-class
dashboards), an OSS block-first agent (knowledge graph + Skills + multi-provider),
a Slack front-end, and CI-grade reproducibility. Identity stays single-user
in OSS; RBAC declarations are programmable and enforced via persona switching.

See `docs/tutorials/` for hands-on walkthroughs (Acme Bank scenario).

### Added

- **Apps** — first-class consumption-layer artifact at `apps/<id>/dql.app.json`.
  Members + roles + access policies + RLS bindings + schedules + homepage,
  validated by [`packages/dql-core/src/apps/app-document.ts`](packages/dql-core/src/apps/app-document.ts).
- **Dashboards (`.dqld`)** — first-class grid-layout artifact distinct from
  notebook-as-dashboard, validated by [`packages/dql-core/src/apps/dashboard-document.ts`](packages/dql-core/src/apps/dashboard-document.ts).
  Block refs by id or path; viz config per tile; params + filters.
- **Persona registry** — runtime active-user state in
  [`packages/dql-project/src/persona.ts`](packages/dql-project/src/persona.ts).
  Drives the existing PolicyEngine + a new
  [`personaVariables()`](packages/dql-project/src/persona-variables.ts) helper
  that supplies template values to `executor.executeQuery`'s `variables` map,
  so `@rls("col", "{user.var}")` decorators resolve at execution time.
- **Manifest extensions** — `apps[]`, `dashboards[]`, `ManifestApp`,
  `ManifestDashboard` in [`packages/dql-core/src/manifest/types.ts`](packages/dql-core/src/manifest/types.ts).
  Builder cross-checks homepage + schedule references and surfaces unresolved
  block refs as diagnostics.
- **Lineage** — populates the previously-reserved `app` node type and
  `dashboard → app` `contains` edges, completing the chain
  `Domain → App → Dashboard → Block → metric/dimension → dbt_model → source`.
- **SQLite registries** — `app_registry` + `dashboard_registry` tables in
  [`packages/dql-project/src/sqlite-storage.ts`](packages/dql-project/src/sqlite-storage.ts)
  for fast queries from the API layer (file format remains source of truth).
- **CLI: `dql app new|ls|show|build|reindex`** — see
  [`apps/cli/src/commands/app.ts`](apps/cli/src/commands/app.ts).
- **API endpoints** — `GET/POST /api/apps`, `/api/apps/:id`,
  `/api/apps/:id/dashboards/:did`, `/api/persona` in
  [`apps/cli/src/apps-api.ts`](apps/cli/src/apps-api.ts).
- **Desktop UI** — new `mainView: 'apps'` with
  [`AppsView`](apps/dql-notebook/src/components/apps/AppsView.tsx),
  [`PersonaSwitcher`](apps/dql-notebook/src/components/apps/PersonaSwitcher.tsx),
  and [`DashboardRenderer`](apps/dql-notebook/src/components/apps/DashboardRenderer.tsx)
  wired into `AppShell` + the activity bar.
- **`@duckcodeailabs/dql-agent`** — new package with:
  - SQLite + FTS5 knowledge graph at `.dql/cache/agent-kg.sqlite`,
    built from manifest + Skills.
  - Skills loader for `.dql/skills/*.skill.md` (YAML frontmatter +
    markdown body).
  - Block-first answer loop: certified blocks first, otherwise LLM-proposed
    SQL marked Uncertified and routed through analyst review.
  - Provider abstractions for Claude, OpenAI / OpenAI-compatible, Gemini,
    and local Ollama, with automatic `pickProvider()` fallback.
  - `getPromotionCandidates()` — surface uncertified answers ready for
    certification.
- **MCP tools** — `kg_search` and `feedback_record` join the existing 8
  tools (`search_blocks`, `get_block`, `query_via_block`, `list_metrics`,
  `list_dimensions`, `lineage_impact`, `certify`, `suggest_block`) in
  [`packages/dql-mcp/src/tools/kg.ts`](packages/dql-mcp/src/tools/kg.ts).
- **CLI: `dql agent ask|reindex|feedback`** — block-first answer loop on the
  command line, see [`apps/cli/src/commands/agent.ts`](apps/cli/src/commands/agent.ts).
- **`@duckcodeailabs/dql-slack`** — new package with a slash-command bot,
  Slack signature verification, Block-Kit reply formatting, and feedback
  buttons.
- **CLI: `dql slack serve`** — boots the bot.
- **CLI: `dql verify`** — proves `dql-manifest.json` is reproducible from
  source. Non-zero on drift; structured diagnostic; CI-ready.
- **Tutorials** — full Acme Bank walkthrough at `docs/tutorials/` covering
  setup, authoring, Apps + RBAC + personas, dashboards, schedules + Slack,
  agentic analytics, end-to-end fraud spike, promoting AI to certified,
  CI + verify, troubleshooting.
- **Tests** — 31 new tests across the new code (12 app-document, 6 dashboard-
  document, 6 persona, 3 manifest scan, 21 dql-agent, 8 dql-slack). All 489
  workspace tests green.

### Changed

- `dql app new` now scaffolds the new programmable schema (`dql.app.json`
  with members/roles/policies/RLS bindings/schedules) instead of the
  earlier `app.yml`-based prototype.
- `dql-mcp` now depends on `dql-agent` for the KG-backed tools.
- `ROADMAP.md` updated — multi-user identity / hosted SSO remains closed
  product; agent + apps + RBAC declarations are now OSS.

### Out of scope (still closed product)

- Real authentication (login screens, OIDC, password storage)
- Hosted cloud / multi-tenant deployment
- Approval workflows or run history as a managed service

---

## v1.0.3 — 2026-04-21

### v0.11 — Block-First Notebook (Tracks 1–6)

Collapses three authoring paths (notebook SQL, notebook DQL, Block Studio) into one mental model: **every notebook cell is a draft block; blocks are live-referenced with `bound` / `forked` state; promotion is certification-gated**.

### Added
- **Unified `@metric()` / `@dim()` resolver** — notebook SQL cells now resolve semantic refs the same way Block Studio does. `SELECT @metric(revenue) FROM @dim(date)` runs against the warehouse instead of throwing.
- **Block Picker as primary palette tile** — `Block` is the left-most tile in the Add-Cell palette; picking a block drops a **bound cell** (live reference, not `@include` SQL).
- **Semantic-aware cell pickers** — Chart / Pivot / SingleValue / Filter pickers read `QueryResult.semanticRefs` and show typed icons (`# metric`, `∴ dimension`, `abc column`); falls back to inference with a "no semantic binding" nag strip.
- **Save-as-Block governance gate** — `SaveAsBlockModal` runs `BUILTIN_RULES` inline; missing owner / domain / description blocks the save. Git metadata (commit SHA, repo, branch) auto-captured and written to the companion YAML.
- **Bound-cell state model** — `BlockBinding { path, commitSha?, version?, state, originalContent? }` on each cell. Green chrome for `bound`, yellow for `forked` after a local edit. Inline chip with path · 🔒 · Revert (forked only) · Unbind.
- **Bound cells in lineage** — bound cells flow into the lineage graph as `block:<name> → dashboard:<notebook>` edges. Draft SQL cells stay excluded (design preserved).

### Changed
- Palette surface: dropped `Python` / `Map` / `Writeback` "coming soon" tiles and the legacy `DQL block` entry; single row, block-first ordering.
- `SingleValueCell` / `ChartCell` / `PivotCell` / `FilterCell` empty states rewritten to guide the user toward the upstream cell.
- Git metadata moved from `.dql` block body into companion YAML (DQL parser drops unknown tokens; body now only carries parser-known keys).

### Fixed
- Notebook SQL cells containing `@metric()` / `@dim()` previously failed with a raw warehouse error. Resolver is now shared between the notebook path and the Block Studio path.
- `workspace:*` dependency resolution (retained from v0.8.2): release script rewrites to real `^x.y.z` before publish.

---

## v0.8.7 — 2026-04-14

### Added
- **14-driver schema introspection** — all database connectors now implement `listTables()` and `listColumns()` with a 3-tier fallback strategy (information_schema → connector methods → lazy loading)
- **Connection hot-swap** — changing the database connection via the notebook Connection Panel or `PUT /api/connections` re-initializes the executor at runtime without restarting the server
- **Block Studio improvements** — save guard opens NewBlockModal when metadata is missing, save/catalog errors shown as inline banners with retry, sidebar no longer forced closed
- **`dql doctor` notebook asset check** — verifies the notebook SPA assets (`index.html`) are bundled correctly
- **`dql --version` / `-V` flag** — prints the CLI version
- **Driver-aware welcome notebook** — `createWelcomeNotebook()` generates database-specific SQL (`SHOW TABLES` for DuckDB, `information_schema` for Postgres/Snowflake/etc.)
- **Semantic import uses project config** — re-resolve after import uses `dql.config.json` provider, not hardcoded `'dql'`
- **`/api/describe-table` endpoint** — lazy column loading for the schema sidebar and Block Studio
- **Type-colored column badges** — shared color utility for schema browser (blue=string, green=number, pink=boolean, gold=date, purple=json)

### Documentation
- **README rewrite** — three clear install paths (DQL-only, Jaffle Shop, Enterprise), Block Studio section, version 0.8.7
- **Quickstart rewrite** — two-track guide (Path A: DQL-only 2min, Path B: dbt+Jaffle Shop 5min) with Block Studio walkthrough
- **Getting Started rewrite** — fixed stale table references, added Block Studio step-by-step (Step 7), clarified auto-import behavior
- **NEW: Enterprise Getting Started** — 11-step guide for teams with existing dbt repos and production databases (Snowflake, Postgres, BigQuery, etc.)
- **Examples rewrite** — three-path table, Block Studio in learning path, parameterized block examples
- **Semantic Layer Guide** — added Snowflake provider section (Option D) with config and notebook UI import steps
- **Data Sources** — documented Connection Panel hot-swap workflow

---

## v0.8.2 — 2026-03-25

### Fixed
- **`workspace:*` dependency resolution** — published packages on npm previously contained raw `workspace:*` dependency versions, causing `EUNSUPPORTEDPROTOCOL` errors during `npm install -g`. The release script now explicitly resolves workspace dependencies to real `^x.y.z` versions before publishing.

---

## v0.8.1 — 2026-03-25

### Fixed
- **`dql init` detection improvements** — added more DuckDB filename candidates (`database.duckdb`, `analytics.duckdb`, `target/jaffle_shop.duckdb`), improved detection output with clear status for dbt project and DuckDB file discovery
- **`dql init` works on non-empty directories** — removed the "Target directory is not empty" guard so `dql init .` works inside existing dbt projects (e.g., Jaffle Shop)

### Changed
- Init output now shows detection results: dbt project (yes/no), DuckDB file path, and semantic layer provider

---

## v0.8.0 — 2026-03-25

### Added
- **Interactive lineage DAG visualization** — full React Flow + dagre-powered graph in the notebook, with node type filtering, click-to-focus highlighting, minimap, legend, and detail panel (`LineageDAG.tsx`)
- **Lineage fullscreen toggle** — "Open Graph View" button in lineage sidebar panel switches main content area to the DAG canvas
- **Jaffle Shop getting-started flow** — `dql init` auto-detects `dbt_project.yml` and `.duckdb` files, scaffolds config with dbt provider, creates welcome notebook

### Removed
- **Project templates** — removed `templates/` directory, `--template` CLI flag, and all template-based scaffolding. `dql init` now always creates a minimal project structure.
- **Example projects** — removed `examples/` and `my-dql-project/` directories

### Changed
- All documentation updated to use Jaffle Shop dbt project as the canonical getting-started path
- README, quickstart, CLI reference, FAQ, and use cases rewritten to remove template references
- Package versions bumped to 0.8.0 across all 10 packages

---

## v0.7.1 — 2026-03-24

### Added
- **Inline cell lineage** — SQL cells in the notebook now show upstream table dependencies and `@metric()` / `@dim()` tracking inline
- **Client-side ColumnMeta normalization** — backward-compatible normalization of `ColumnMeta[]` to `string[]` at the API boundary

### Fixed
- React crash from inconsistent ColumnMeta format at API boundary
- Added `@codemirror/autocomplete` and `@codemirror/search` dependencies, updated `sql-formatter`

---

## v0.7.0 — 2026-03-24

### Added
- **`dql compile` command** — generates `dql-manifest.json`, a complete project artifact containing all blocks, notebooks, metrics, sources, dependencies, and pre-computed lineage (similar to dbt's `manifest.json`)
- **Manifest system** (`packages/dql-core/src/manifest/`) — `DQLManifest` type with `ManifestBlock`, `ManifestNotebook`, `ManifestMetric`, `ManifestSource`, `ManifestLineage`
- **Recursive directory scanning** — blocks and notebooks in nested subdirectories are now discovered (no longer flat-only)
- **Config-driven semantic layer path** — reads `semanticLayer.path` from `dql.config.json` instead of hardcoding `semantic-layer/`
- **Notebook lineage** — `.dqlnb` notebook SQL/DQL cells are scanned for table and ref() dependencies; DQL cells declaring blocks are added to the lineage graph
- **dbt manifest import** — `dql compile --dbt-manifest path/to/manifest.json` imports dbt models and sources with column-level metadata as upstream nodes
- **Smart node lookup** — `dql lineage <name>` auto-resolves to block, table, metric, or dimension (no type prefix needed)
- **`dql lineage --table <name>`** — show lineage for a specific source table
- **`dql lineage --metric <name>`** — show lineage for a specific metric
- **`dql lineage --impact <name>`** — impact analysis now works on any node type (tables, metrics), not just blocks
- **`dql lineage --no-manifest`** — force live scan, skip reading `dql-manifest.json`
- **DuckDB reader function extraction** — `read_csv_auto()`, `read_parquet()`, `read_json()` calls in SQL are now extracted as source table dependencies
- **Rich lineage summary** — `dql lineage` now shows actual block/table/metric names, ownership, data flow relationships, and a DAG tree visualization

### Changed
- `dql lineage` reads from `dql-manifest.json` when available for faster lookups; falls back to live scanning
- Lineage output shows direct vs transitive upstream/downstream, with `*` marking direct connections
- `dql lineage` data flow tree renders from root source tables through all downstream nodes

---

## v0.6.0 — 2026-03-24

### Added
- **Answer-layer lineage engine** — tracks data flow from source tables through blocks, semantic metrics, business domains, and charts
- **`ref("block_name")` system** — declare explicit block-to-block dependencies in SQL queries, similar to dbt's `ref()`
- **`dql lineage` CLI command** — full lineage analysis with subcommands:
  - `dql lineage` — project summary with node counts, cross-domain flows, domain trust scores
  - `dql lineage <block>` — upstream/downstream for a specific block
  - `dql lineage --domain <name>` — domain-scoped view with data flows in/out
  - `dql lineage --impact <block>` — impact analysis showing affected downstream nodes by domain
  - `dql lineage --trust-chain <from> <to>` — certification status at every hop between two blocks
  - `dql lineage --format json` — export full lineage graph as JSON
- **Cross-domain flow detection** — automatic detection when data crosses business domain boundaries (e.g., data → finance → executive)
- **Trust chain scoring** — certified blocks are trust checkpoints; trust score = certified/total ratio
- **Lineage API endpoints** — `GET /api/lineage`, `/api/lineage/block/:name`, `/api/lineage/domain/:name`, `/api/lineage/impact/:block`, `/api/lineage/trust-chain`
- **Notebook Lineage Panel** — sidebar panel showing blocks, metrics, source tables, domains, and cross-domain flows
- **SQL table extractor** — lightweight regex-based parser for FROM/JOIN/INTO/CTE table extraction
- **Dependency resolver** — topological sort with circular dependency detection
- **DuckDB reader normalization** — `read_csv_auto('./data/revenue.csv')` normalizes to `revenue` in lineage nodes
- **Edge deduplication** — prevents duplicate edges in the lineage graph
- **Comprehensive lineage documentation** — new `docs/lineage.md` with tutorials, CLI reference, and dbt complement strategy
- **Unified package versioning** — all 10 packages now share a single version number (0.6.0)

### Changed
- Updated all documentation to cover lineage, ref(), and cross-domain flows
- README now includes Lineage & Trust Chains section
- ROADMAP updated with lineage as shipped feature

---

## v0.5.2 — 2026-03-23

### Added
- **Snowflake semantic layer provider** — `provider: "snowflake"` in `dql.config.json` now wires a live Snowflake connection into the semantic layer; no manual YAML duplication required
- **Time dimension picker in Compose Query UI** — select a date dimension and granularity (`day` / `week` / `month` / `quarter` / `year`); generates dialect-correct `DATE_TRUNC()` SQL
- **Live test execution in `dql certify`** — `assert` statements in `.dql` blocks now run against real data before governance checks; use `--skip-tests` to bypass for metadata-only validation
- **`defaultConnection` auto-detection** — `dql certify` and `dql test` now read `defaultConnection` from `dql.config.json` without requiring `--connection`
- **Auto-refresh semantic layer via SSE** — editing a YAML file in `semantic-layer/` while the notebook is open now triggers an automatic panel reload (no manual Retry click)
- **New Metric form in notebook sidebar** — create a new metric YAML file from inside the Semantic Panel without leaving the notebook
- **Block Governance Bar** — DQL cells with a `block { ... }` declaration show an inline form for editing `domain`, `owner`, `tags`, and `description` without touching the raw syntax
- **DQL / SQL cell type tooltips** — hover over the cell type badge to see what each cell type does
- **`dql test` deprecation notice** — `dql test` now prints a deprecation warning; use `dql certify --connection` instead (removal planned for v0.6.0)

### Fixed
- Removed non-existent `@import` syntax from authoring-blocks.md and notebook reference panel; replaced with the real `@metric()` / `@dim()` patterns and Compose Query workflow
- Removed dead `BlockImportView` component and all `@import` dead code from the notebook frontend
- `dql certify` no longer reports "✓ certified" when `tests-pass` governance rule would have failed on live data

### Changed
- Semantic layer section in Reference Panel now leads with Compose Query (canonical path) and marks `@metric()` / `@dim()` as advanced
- `dql test` marked `[deprecated]` in help text

---

## v0.5.1 — 2026-03-20

### Fixed
- Resolved `workspace:*` dependency resolution issue for npm publish
- Version bumps across all packages for v0.5.0 release alignment

---

## v0.5.0 — 2026-03-18

### Added
- **Semantic Compose Query** — Semantic Panel now has a Compose Query section: select metrics, dimensions, compose SQL, and insert as a cell with one click
- **"Insert as Cell" button** — composed SQL can be inserted directly as a new SQL cell
- **Notebook semantic panel** — browse metrics, dimensions, and hierarchies from the sidebar; click to insert refs into SQL cells
- **`type = "semantic"` block** — reference a metric by name from a DQL block (`metric = "total_revenue"`)
- **`@metric()` / `@dim()` inline refs** — use semantic metrics and dimensions directly inside SQL cells
- Comprehensive documentation overhaul: authoring-blocks guide, own-repo tutorial, progressive doc index
- Tutorial rewrite for getting-started, data-sources connector reference, notebook semantic panel guide

---

## v0.4.0

### Added
- Semantic layer core: DQL native YAML provider, dbt provider, Cube.js provider
- 14-database SQL dialect abstraction in `composeQuery()`
- `dql certify` command with governance rule evaluation
- `dql fmt` format-on-save for `.dql` files
- DQL Language Support VS Code extension packaging

---

## v0.3.0

### Added
- Multi-cell notebook with param cells, markdown cells, and auto-charting
- DQL block AST: `block { domain, owner, tags, params, query, visualization, tests }`
- `dql parse` semantic analysis
- `dql preview` and `dql build` for static HTML bundles
- `dql serve` for local preview serving

---

## v0.1.0

Initial public DQL release.

- Open-sourced the DQL language core, compiler, runtime, connectors, governance, LSP, and Git-backed project package
- Published the `dql` CLI and the `DQL Language Support` VS Code extension packaging path
- Added starter docs, examples, templates, and GitHub release automation for the OSS repo
