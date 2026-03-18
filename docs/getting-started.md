# Getting Started with DQL

This guide walks you from zero to a certified, tested analytics block in about ten minutes.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18 or newer |
| npm | 9 or newer (bundled with Node 18) |
| pnpm | 9 or newer — only needed for source builds |

Check your versions:

```bash
node --version   # v18.x.x or higher
npm --version    # 9.x.x or higher
```

---

## Install

### npm (recommended)

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

### From source

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build

# Run the CLI from inside the monorepo:
pnpm exec dql --help

# Or invoke the compiled entry point directly:
node apps/cli/dist/index.js --help
```

### Library use (embed in your application)

```bash
npm install @duckcodeailabs/dql-core @duckcodeailabs/dql-compiler
```

This gives you the parser, AST, semantic analyser, formatter, and full compilation pipeline as importable ESM modules. No CLI required.

---

## Your first block

### Step 1 — Create a `.dql` file

Create a directory and a new block file:

```bash
mkdir blocks
```

Create `blocks/monthly_revenue.dql` with the following content:

```dql
block "Monthly Revenue" {
    domain      = "revenue"
    type        = "chart.line"
    description = "Monthly revenue trend with YoY comparison"
    owner       = "data-team"
    tags        = ["revenue", "trend"]

    params {
        lookback_months = 12
    }

    query = """
        SELECT
            DATE_TRUNC('month', order_date) AS month,
            SUM(amount_usd)                 AS revenue
        FROM fct_orders
        WHERE order_date >= CURRENT_DATE - INTERVAL '${lookback_months} months'
        GROUP BY 1
        ORDER BY 1
    """

    visualization {
        x     = "month"
        y     = "revenue"
        color = "#6366f1"
    }

    tests {
        assert row_count > 0
        assert max(revenue) < 10000000
    }
}
```

### Step 2 — Parse the block

`dql parse` validates syntax and runs semantic analysis (required fields, valid chart types, structural consistency):

```bash
dql parse blocks/monthly_revenue.dql
```

Expected output (clean file):

```
  ✓ Parsed: blocks/monthly_revenue.dql
    Statements: 1
    Diagnostics: ✓ No errors, no warnings
```

If there are problems, parse tells you exactly what is wrong:

```
  ✗ Errors (1):
    → Block "Monthly Revenue" is missing required field: domain

  ⚠ Warnings (1):
    → Visualization chart type "linechart" is not recognised
```

Add `--verbose` to inspect the full AST, or `--format json` for machine-readable output:

```bash
dql parse blocks/monthly_revenue.dql --verbose
dql parse blocks/monthly_revenue.dql --format json
```

### Step 3 — Run the block

`dql run` compiles the block and opens the rendered visualization in your default browser. DuckDB runs in-process — no external database required for local CSV or Parquet files.

```bash
dql run blocks/monthly_revenue.dql
```

To point at a real DuckDB database:

```bash
dql run blocks/monthly_revenue.dql --db ./warehouse.duckdb
```

The rendered output is an interactive Vega-Lite chart served on `http://localhost:4040` (configurable with `--port`).

### Step 4 — Inspect block metadata

`dql info` prints a structured summary of every block in the file, including a static query cost estimate:

```bash
dql info blocks/monthly_revenue.dql
```

```
  Block: "Monthly Revenue"
    Domain:      revenue
    Type:        chart.line
    Owner:       data-team
    Description: Monthly revenue trend with YoY comparison
    Tags:        revenue, trend
    Params:      1
    Tests:       2 assertion(s)

    Cost Estimate: 12/100
    → Query looks efficient
```

---

## Parameters

`params` blocks declare named default values. Reference them in your query with `${param_name}`:

```dql
params {
    lookback_months = 12
    region          = "global"
}

query = """
    SELECT
        DATE_TRUNC('month', order_date) AS month,
        SUM(amount_usd)                 AS revenue
    FROM fct_orders
    WHERE region        = '${region}'
      AND order_date   >= CURRENT_DATE - INTERVAL '${lookback_months} months'
    GROUP BY 1
    ORDER BY 1
"""
```

Override any param at invocation time:

```bash
dql run blocks/monthly_revenue.dql --param lookback_months=6
dql run blocks/monthly_revenue.dql --param lookback_months=3 --param region=us-west
```

Params are type-inferred from their default values: integer, string, boolean, or float. The semantic analyser warns if a param referenced in the query is not declared in the `params` block.

---

## Tests

The `tests` block declares assertions that are executed against DuckDB when you run `dql test`. Assertions use a small expression language over the query result:

```dql
tests {
    assert row_count > 0
    assert max(revenue) < 10000000
    assert min(amount) >= 0
    assert distinct_count(user_id) > 100
}
```

Run the tests using DuckDB in-process (defaults to `:memory:`):

```bash
dql test blocks/monthly_revenue.dql
```

```
  ✓ Found 1 block(s) in blocks/monthly_revenue.dql

  Block: "Monthly Revenue"
    Tests: 2 assertion(s)
    → assert row_count > 0          ✓ PASSED
    → assert max(revenue) < 10000000  ✓ PASSED
    Status: ✓ All assertions passed
```

Use `--db` to run assertions against a real DuckDB file:

```bash
dql test blocks/monthly_revenue.dql --db ./warehouse.duckdb
```

When an assertion fails, `dql test` exits with code 1 and shows the actual value:

```
  Block: "Monthly Revenue"
    → assert row_count > 0          ✗ FAILED  (actual: 0)
  Status: ✗ 1 assertion(s) failed
```

Add `dql test` to your CI pipeline to gate merges on data quality:

```yaml
# .github/workflows/dql.yml
- name: Run DQL tests
  run: dql test blocks/ --db ./warehouse.duckdb
```

---

## Certification

`@certified` is a decorator that marks a block as production-grade. Place it before the `block` keyword:

```dql
@certified

block "Monthly Revenue" {
    domain      = "revenue"
    type        = "chart.line"
    description = "Monthly revenue trend with YoY comparison"
    owner       = "data-team"
    tags        = ["revenue", "trend"]
    ...
}
```

Run `dql certify` to evaluate the governance rules:

```bash
dql certify blocks/monthly_revenue.dql
```

```
  Block: "Monthly Revenue"
  Status: ✓ CERTIFIABLE
```

If required fields are missing:

```
  Block: "Monthly Revenue"
  Status: ✗ NOT CERTIFIABLE

  Errors (1):
    ✗ requires-owner: Block must have an owner field

  Warnings (1):
    ⚠ recommend-tags: Block has no tags; add tags to improve discoverability
```

`dql certify` checks:
- `domain`, `type`, `description`, and `owner` are all present and non-empty
- `tags` array is present
- The block has at least one test assertion (warning if absent)

Run certification in CI to prevent uncertified blocks from reaching main:

```yaml
- run: dql certify blocks/
```

---

## Using the DQL Notebook

`dql notebook` starts the DQL Notebook — a browser-based, DuckDB-WASM-powered environment for interactive block authoring.

```bash
dql notebook
```

The notebook opens at `http://localhost:4040`. From there you can:

1. **Load a CSV or Parquet file** — drag and drop onto the file browser, or use `File → Open`. The file is loaded directly into DuckDB-WASM in the browser; no server upload required.
2. **Write a block** — use the DQL editor with syntax highlighting, completions, and live diagnostics. The editor is backed by `@duckcodeailabs/dql-lsp`.
3. **Run a block** — press `Cmd+Enter` (or `Ctrl+Enter`) to execute the query and render the visualization inline.
4. **Save to disk** — blocks are saved as plain `.dql` files. They are immediately ready for `dql parse`, `dql test`, and `dql certify`.

To open the notebook on a specific port, or to load a file on startup:

```bash
dql notebook --port 8080
dql notebook --open blocks/monthly_revenue.dql
```

---

## Formatting

Use `dql fmt` to keep files canonically formatted. It is idempotent — running it twice produces no change.

```bash
# Format in place:
dql fmt blocks/monthly_revenue.dql

# Check only — exits 1 if the file needs formatting:
dql fmt blocks/monthly_revenue.dql --check

# Format an entire directory:
dql fmt blocks/
```

Add `dql fmt --check blocks/` as a pre-commit hook or CI step.

---

## Next steps

| Resource | Description |
|---|---|
| [Language Reference](./dql-language-reference.md) | Full syntax, all block fields, chart type reference, AST node types |
| [CLI Reference](./cli-reference.md) | Every command and flag |
| [examples/](../examples/) | Ready-to-run example blocks and a semantic layer starter |
| [templates/starter/](../templates/starter/) | Copy this into a new Git repo to bootstrap a DQL project |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to add a chart type, run tests, and open a PR |
