# CLI Reference

The `dql` binary is provided by `@dql/cli`. All commands accept a positional file path argument and a shared set of flags.

## Usage

```
dql <command> <file.dql> [flags]
```

Run `dql --help` (or `dql -h`) to print the help text and exit.

---

## Global Flags

These flags are accepted by every command.

| Flag | Short | Default | Description |
|---|---|---|---|
| `--format json\|text` | | `text` | Output format. `json` is suitable for CI pipelines and programmatic consumers. |
| `--verbose` | `-v` | `false` | Show detailed output (e.g. full AST for `parse`, cost factor breakdown for `info`). |
| `--help` | `-h` | | Print help and exit 0. |

---

## Commands

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

**What it checks (via `Certifier` in `@dql/governance`):**

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

Format a `.dql` file in place using the canonical DQL formatter (`formatDQL` from `@dql/core`).

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

This command is **scaffold-only** in the OSS CLI. It prints a template block and migration notes; it does not parse or transform actual source files automatically (except for dbt, which requires manual inspection).

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
| `looker` | Parse LookML explores + measures + dimensions → DQL blocks + semantic layer YAML | ~80% automated |
| `tableau` | Extract via REST API → generate one DQL block per sheet | Semi-automated |
| `dbt` | Inspect models and metrics, scaffold DQL blocks and semantic layer files | Planning-only in V1 |
| `metabase` | Export via API → generate one DQL block per saved question | ~85% automated |
| `raw-sql` | AI-assisted wrapping of ad-hoc SQL into DQL block structure | AI-assisted |

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

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success (or `--help` / `--check` with no changes needed) |
| `1` | Parse error, semantic error, certification failure, unformatted file (with `--check`), unknown command, missing argument, or unhandled runtime error |
