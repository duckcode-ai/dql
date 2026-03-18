# Changelog

All notable changes to the DQL project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
DQL uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-03-17

Initial public release of the DQL open-source toolchain.

### Added

**CLI (`@duckcodeailabs/dql-cli`)**

- `dql parse <file.dql>` — lexes, parses, and runs semantic analysis on a `.dql` file. Reports syntax errors, unknown block fields, missing required fields, and unrecognised chart types. Supports `--verbose` (full AST) and `--format json`.
- `dql certify <file.dql>` — evaluates governance certification rules (owner, domain, description, tags, type) against every block in a file. Exits 1 if any block fails. Supports `--format json`.
- `dql fmt <file.dql>` — applies the canonical DQL formatter in place. `--check` mode exits 1 when the file differs from its formatted form; safe for pre-commit hooks and CI.
- `dql test <file.dql>` — executes `tests { assert ... }` assertions using DuckDB in-process. Defaults to `:memory:`; use `--db <path>` to target a real DuckDB file. Exits 1 on assertion failure.
- `dql run <file.dql>` — compiles the block and serves the rendered Vega-Lite visualization at `http://localhost:4040`. Use `--db <path>` for a real database, `--port <n>` to change the port.
- `dql notebook` — starts the DQL Notebook: a browser-based, DuckDB-WASM-powered authoring environment with live execution, a file browser, and a DQL editor backed by the LSP.
- `dql info <file.dql>` — prints structured metadata for every block (domain, type, owner, tags, param count, test count) and a static query cost estimate score (0–100).
- `dql migrate <source>` — scaffolds a DQL block from a foreign tool definition. Supported sources: `looker`, `tableau`, `dbt`, `metabase`, `raw-sql`.

**Chart types (19)**

`chart.bar`, `chart.line`, `chart.area`, `chart.scatter`, `chart.pie`, `chart.donut`, `chart.kpi`, `chart.treemap`, `chart.gauge`, `chart.heatmap`, `chart.waterfall`, `chart.funnel`, `chart.sparkline`, `chart.sankey`, `chart.combo`, `chart.histogram`, `chart.stacked-bar`, `chart.grouped-bar`, `chart.geo`

**Packages**

- `@duckcodeailabs/dql-core` — lexer, parser, full typed AST, semantic analyser, canonical formatter (`formatDQL` / `formatProgram`).
- `@duckcodeailabs/dql-compiler` — IR lowering from AST, Vega-Lite emitter, HTML emitter, React emitter (stub — see known limitations), runtime emitter.
- `@duckcodeailabs/dql-governance` — `Certifier` class with pluggable rule set, `TestRunner` that executes `assert` expressions against DuckDB, static query cost estimator.
- `@duckcodeailabs/dql-project` — Git-backed block registry; `DQLProject` class for scanning, indexing, and querying `.dql` files in a directory tree.
- `@duckcodeailabs/dql-lsp` — Language Server Protocol implementation (`textDocument/completion`, `textDocument/hover`, `textDocument/publishDiagnostics`). Bundled into the VS Code extension; also ships a standalone `dql-lsp` binary.
- `@duckcodeailabs/dql-runtime` — browser runtime: DuckDB-WASM data fetching, Vega-Lite rendering, hot-reload WebSocket client.
- `@duckcodeailabs/dql-charts` — visx-powered React SVG chart components covering all 19 chart types.
- `@duckcodeailabs/dql-cli` — the `dql` binary; thin orchestration layer over the packages above.

**VS Code extension**

- `DQL Language Support` — syntax highlighting, snippet expansion, format-on-save, hover documentation, and live diagnostics. Language server is bundled; no separate process required.

**Governance system**

- `@certified` decorator — marks a block as production-grade.
- `dql certify` enforces: `domain`, `type`, `description`, `owner` present and non-empty; `tags` array present; at least one test assertion.
- `tests { assert <expr> }` block — assertions over query result aggregates (`row_count`, `max(col)`, `min(col)`, `distinct_count(col)`).

**Semantic block type**

- `type = "semantic"` — blocks that define reusable metrics, dimensions, and hierarchies without a chart visualization. Used by the semantic layer sub-system in `@duckcodeailabs/dql-project`.

**DuckDB-WASM notebook**

- Browser-native notebook (`dql notebook`) backed by DuckDB-WASM. Load CSV, Parquet, or JSON directly in the browser. All query execution is local — no server round-trip.

**Starter template and examples**

- `templates/starter/` — minimal Git-native DQL project template.
- `examples/blocks/` — annotated example blocks covering a range of chart types and domains.
- `examples/semantic-layer/` — example metric, dimension, and hierarchy definitions.

---

### Known limitations

- **Import / use statements** — `import` and `use` directives are parsed by the lexer and appear in the AST, but module resolution is not implemented. References to symbols from other files will not resolve and will not produce an error; they are silently ignored.
- **React codegen emitter** — `compile(ast, { target: 'react' })` is a stub. It returns a placeholder component. The Vega-Lite and HTML emitters are fully functional.
- **Forecast chart type** — `chart.forecast` renders as a plain `chart.line`. The confidence band (upper/lower bounds) is parsed and stored in the IR but is not yet emitted in any output target.
- **`dql run` requires local DuckDB data** — running against a remote warehouse (Snowflake, BigQuery, Redshift) is not yet supported in the OSS CLI. Use `dql test --db` for DuckDB file targets.
- **`dql migrate`** — the `dbt` source is planning-only in v0.1.0; it prints migration notes but does not read dbt project files. `looker`, `metabase`, and `raw-sql` produce scaffold templates.

---

[0.1.0]: https://github.com/duckcode-ai/dql/releases/tag/v0.1.0
