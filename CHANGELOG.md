# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

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
