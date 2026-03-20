# CLI Reference

The `dql` binary is provided by `@duckcodeailabs/dql-cli`. Most commands accept a positional file path argument and a shared set of flags.

## Usage

```text
dql init [directory]
dql new <block|semantic-block|dashboard|workbook> <name> [flags]
dql <command> <file.dql> [flags]
```

Run `dql --help` (or `dql -h`) to print the help text and exit.

---

## Shared Flags

These flags are the most commonly used flags across the CLI.

| Flag | Short | Default | Description |
|---|---|---|---|
| `--format json\|text` | | `text` | Output format. `json` is suitable for CI pipelines and programmatic consumers. |
| `--verbose` | `-v` | `false` | Show detailed output (e.g. full AST for `parse`, cost factor breakdown for `info`). |
| `--open` | | | Open the preview or served bundle in a browser. |
| `--no-open` | | | Disable automatic browser opening even if the project config enables it. |
| `--help` | `-h` | | Print help and exit 0. |
| `--out-dir <path>` | | | Output directory for `build`. |
| `--port <number>` | | | Preferred local port for `preview` or `serve`. |

## `new` Flags

These flags are specific to `dql new ...` scaffolds.

| Flag | Default | Description |
|---|---|---|
| `--chart <type>` | | | Chart type for `new block` scaffolds. |
| `--domain <name>` | | | Domain for `new block` scaffolds. |
| `--owner <name>` | | | Owner for `new block` scaffolds. |
| `--query-only` | | `false` | Create a query-only block without a visualization section. |

---

## Commands

### `dql init [directory]`

Create a local DQL starter project with sample data, starter blocks, and `dql.config.json`.

```bash
dql init my-dql-project
cd my-dql-project
```

**What it creates:**

- `blocks/` with starter charted and query-only blocks
- `dashboards/` for dashboard scaffolds
- `data/revenue.csv` for local preview flows
- `dql.config.json` with a file/DuckDB-friendly default connection
- `workbooks/` for workbook scaffolds
- `semantic-layer/` starter definitions

---

### `dql new <block|semantic-block|dashboard|workbook> <name>`

Create a new DQL block, semantic block, dashboard, or workbook inside the current project.

```bash
dql new block "Pipeline Health"
dql new semantic-block "ARR Growth"
dql new dashboard "Revenue Overview" --chart line
dql new workbook "Quarterly Review"
dql new block "Revenue Trend" --chart line --domain finance
dql new block "Top Accounts" --chart table --query-only
```

**What it does:**

- creates a new `.dql` file in `blocks/`, `dashboards/`, or `workbooks/` by default
- for `semantic-block`, also creates starter semantic-layer YAML in `semantic-layer/metrics/` and `semantic-layer/blocks/`
- uses local `data/revenue.csv` if it exists, so starter projects get previewable blocks immediately
- falls back to placeholder SQL when no starter data is available
- supports `--out-dir` if you want to write somewhere other than the default scaffold folder

**Flags most useful for `new block`:**

- `--chart <type>` — scaffold `bar`, `line`, `table`, or `kpi`
- `--domain <name>` — set the block domain
- `--owner <name>` — set the block owner
- `--query-only` — omit the visualization section

**Semantic block note:**

`dql new semantic-block` generates:

- a `type = "semantic"` block in `blocks/`
- a starter metric definition in `semantic-layer/metrics/`
- companion block metadata in `semantic-layer/blocks/`

**Text output:**

```text
  ✓ Created DQL block: Pipeline Health
    Path: /path/to/project/blocks/pipeline_health.dql

  Next steps:
    1. dql parse blocks/pipeline_health.dql
    2. dql preview blocks/pipeline_health.dql
```

---

### `dql doctor [path]`

Run a lightweight setup check for a DQL project.

```bash
dql doctor
dql doctor my-dql-project
dql doctor --format json
```

**What it checks:**

- Node.js version
- project root discovery
- `dql.config.json`
- `blocks/`, `semantic-layer/`, and `data/`
- default connection presence
- `duckdb` dependency when local file/DuckDB preview is configured
- local query runtime readiness for the configured default connection

---

### `dql preview <file.dql>`

Compile a block, dashboard, or workbook to local HTML and serve it with a tiny local query API for browser preview.

```bash
dql preview blocks/pipeline_health.dql
```

**What it does:**

- Compiles the DQL source to HTML
- Starts a local HTTP server
- Exposes `POST /api/query` backed by the default connection in `dql.config.json`
- Renders charts against local DuckDB/file-backed sample data when applicable
- Uses `--port` when provided; otherwise falls back to `dql.config.json` and then `3474`

**Text output:**

```text
  ✓ Preview ready: http://127.0.0.1:3474
    Press Ctrl+C to stop.
```

---

### `dql build <file.dql>`

Compile a block, dashboard, or workbook to a static output directory containing `index.html`, chart specs, and build metadata.

```bash
dql build blocks/pipeline_health.dql
dql build blocks/pipeline_health.dql --out-dir out/pipeline
```

**Text output:**

```text
  ✓ Built DQL bundle
    Source: /path/to/project/blocks/pipeline_health.dql
    Output: /path/to/project/dist/pipeline_health
```

---

### `dql serve [directory]`

Serve a built DQL bundle locally using the same lightweight `/api/query` runtime as `preview`.

```bash
dql serve dist/pipeline_health
dql serve --port 4488
```

If no directory is provided, `serve` defaults to `dist/` in the current working directory.

**Text output:**

```text
  ✓ Serving DQL bundle: http://127.0.0.1:3474
    Root: /path/to/project/dist/revenue_by_segment
    Press Ctrl+C to stop.
```

---

### `dql parse <file.dql>`

Parse a `.dql` file and run semantic analysis. Reports syntax errors, unknown keywords, missing required fields, and any semantic warnings.

```bash
dql parse examples/blocks/revenue_by_segment.dql
dql parse examples/blocks/revenue_by_segment.dql --verbose
dql parse examples/blocks/revenue_by_segment.dql --format json
```

**What it validates:**

- Lexer and parser correctness (syntax)
- Semantic rules via `SemanticAnalyzer`: required block fields (`domain`, `type`), valid chart types, structural consistency

**Text output (no issues):**

```
  ✓ Parsed: examples/blocks/revenue_by_segment.dql
    Statements: 1
    Diagnostics: ✓ No errors, no warnings
```

**Text output (with issues):**

```
  ✓ Parsed: examples/blocks/revenue_by_segment.dql
    Statements: 1

  ✗ Errors (1):
    → Block "Revenue by Segment" is missing required field: domain

  ⚠ Warnings (1):
    → Visualization chart type "barchart" is not recognised
```

**JSON output shape:**

```json
{
  "file": "examples/blocks/revenue_by_segment.dql",
  "statements": 1,
  "diagnostics": [],
  "ast": { ... }   // only present with --verbose
}
```

---

### `dql certify <file.dql>`

Evaluate certification rules against every block declared in the file. Certification checks that a block has the governance metadata required to be promoted (owner, description, tags, domain, and type).

```bash
dql certify examples/blocks/revenue_by_segment.dql
dql certify examples/blocks/revenue_by_segment.dql --format json
```

**What it checks (via `Certifier` in `@duckcodeailabs/dql-governance`):**

- `domain` field is present and non-empty
- `type` field is present (`"custom"` or `"semantic"`)
- `description` field is present
- `owner` field is present
- `tags` array is present (warnings if absent or empty)

**Text output (passes):**

```
  Block: "Revenue by Segment"
  Status: ✓ CERTIFIABLE
```

**Text output (fails):**

```
  Block: "Revenue by Segment"
  Status: ✗ NOT CERTIFIABLE

  Errors (1):
    ✗ requires-owner: Block must have an owner field

  Warnings (1):
    ⚠ recommend-tags: Block has no tags; add tags to improve discoverability
```

**JSON output shape:**

```json
{
  "certified": false,
  "errors": [
    { "rule": "requires-owner", "message": "Block must have an owner field" }
  ],
  "warnings": []
}
```

---

### `dql fmt <file.dql>`

Format a `.dql` file in place using the canonical DQL formatter (`formatDQL` from `@duckcodeailabs/dql-core`).

```bash
# Format and write back:
dql fmt examples/blocks/revenue_by_segment.dql

# Check only — exits 1 if the file needs formatting (CI-safe):
dql fmt examples/blocks/revenue_by_segment.dql --check
```

**Flags specific to `fmt`:**

| Flag | Description |
|---|---|
| `--check` | Do not write; exit 1 if the file differs from its formatted form. Useful in pre-commit hooks and CI. |

**Text output (write mode, changed):**

```
  ✓ Formatted: examples/blocks/revenue_by_segment.dql
```

**Text output (write mode, already formatted):**

```
  ✓ No changes: examples/blocks/revenue_by_segment.dql
```

**Text output (check mode, needs changes):**

```
  ✗ Needs formatting: examples/blocks/revenue_by_segment.dql
```

**JSON output shape:**

```json
{ "file": "examples/blocks/revenue_by_segment.dql", "changed": true, "mode": "check" }
```

---

### `dql test <file.dql>`

Inspect the test assertions declared in each block. In the OSS CLI, test execution requires a live database connection; this command performs a dry run that shows which assertions exist without executing them.

```bash
dql test examples/blocks/revenue_by_segment.dql
dql test examples/blocks/revenue_by_segment.dql --format json
```

**Text output:**

```
  ✓ Found 1 block(s) in examples/blocks/revenue_by_segment.dql

  Block: "Revenue by Segment"
    Tests: 1 assertion(s)
    → assert row_count > 0
    Status: ⚠ Dry run (no database connection)
    Hint: Connect a database to execute assertions
```

**JSON output shape:**

```json
{
  "file": "examples/blocks/revenue_by_segment.dql",
  "blocks": [
    { "name": "Revenue by Segment", "tests": 1 }
  ],
  "note": "Test execution requires a database connection. Use --connection to specify."
}
```

---

### `dql info <file.dql>`

Print structured metadata for every block in the file, including a query cost estimate score (0–100) derived from static SQL analysis.

```bash
dql info examples/blocks/revenue_by_segment.dql
dql info examples/blocks/revenue_by_segment.dql --verbose   # shows cost factors
dql info examples/blocks/revenue_by_segment.dql --format json
```

**Text output:**

```
  Block: "Revenue by Segment"
    Domain:      revenue
    Type:        custom
    Owner:       data-team
    Description: Quarterly revenue grouped by customer segment
    Tags:        revenue, segment, quarterly
    Params:      1
    Tests:       1 assertion(s)

    Cost Estimate: 15/100
    → Query looks efficient
```

With `--verbose`, individual cost factors are listed (e.g. missing WHERE clause, SELECT *, JOIN count).

**JSON output shape:**

```json
{
  "name": "Revenue by Segment",
  "domain": "revenue",
  "type": "custom",
  "description": "...",
  "owner": "data-team",
  "tags": ["revenue", "segment", "quarterly"],
  "query": "SELECT ...",
  "params": { "period": "current_quarter" },
  "tests": 1,
  "costEstimate": {
    "score": 15,
    "recommendation": "Query looks efficient",
    "factors": []
  }
}
```

---

### `dql migrate <source>`

Scaffold a DQL block from a foreign tool definition. The `<source>` argument is one of: `looker`, `tableau`, `dbt`, `metabase`, `raw-sql`.

This command is **scaffold-only** in the OSS CLI. It prints a template block and migration notes; it does not automatically parse or transform source files.

```bash
dql migrate looker
dql migrate dbt --input ./my-dbt-project
dql migrate raw-sql --format json
```

**Flags specific to `migrate`:**

| Flag | Description |
|---|---|
| `--input <path>` | Source path for the migration (e.g. dbt project directory). |

**Supported sources and coverage:**

| Source | Method | OSS Coverage |
|---|---|---|
| `looker` | Print a Looker-oriented scaffold and migration checklist | Scaffold-only |
| `tableau` | Print a Tableau-oriented scaffold and migration checklist | Scaffold-only |
| `dbt` | Print a dbt-oriented scaffold and semantic-block planning notes | Scaffold-only |
| `metabase` | Print a Metabase-oriented scaffold and migration checklist | Scaffold-only |
| `raw-sql` | Print a raw SQL wrapper scaffold for manual cleanup | Scaffold-only |

**Text output (example for `looker`):**

```
  DQL Migration: looker
  ─────────────────────────────
  Source: LookML explores + measures + dimensions
  Method: Parse LookML → generate DQL blocks + semantic layer YAML
  Coverage: ~80% automated

  Example generated block:
  ───
    block "migrated-from-looker" { ... }

  Next steps:
    1. Provide source files: dql migrate looker --input <path>
    2. Review generated blocks in blocks/migrated/
    3. Run: dql test blocks/migrated/example.dql
    4. Commit and push for certification
```

For practical migration walkthroughs, see:

- [`migration-guides/raw-sql.md`](./migration-guides/raw-sql.md)
- [`migration-guides/dbt.md`](./migration-guides/dbt.md)
- [`migration-guides/saved-bi-query.md`](./migration-guides/saved-bi-query.md)

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success (or `--help` / `--check` with no changes needed) |
| `1` | Parse error, semantic error, certification failure, unformatted file (with `--check`), unknown command, missing argument, or unhandled runtime error |
