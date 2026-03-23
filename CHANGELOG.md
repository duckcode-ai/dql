# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

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
