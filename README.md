# DQL

**DQL is to analytics blocks what dbt is to data models — open source, Git-native, composable.**

[![npm version](https://img.shields.io/npm/v/@duckcodeailabs/dql-cli.svg)](https://www.npmjs.com/package/@duckcodeailabs/dql-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml/badge.svg)](https://github.com/duckcode-ai/dql/actions)

---

## What is DQL?

- **Declarative analytics blocks.** A `.dql` file is a self-contained unit: SQL query, visualization config, parameters, and test assertions live together in one file. Version-control it, lint it, certify it.
- **No proprietary lock-in.** DQL compiles to Vega-Lite, HTML, or React. The runtime uses DuckDB-WASM. Everything is open source under Apache-2.0.
- **Built for teams.** Governance is first class — blocks carry `owner`, `domain`, `tags`, and `@certified` directly in the source. `dql certify` and `dql test` run in CI the same way `dbt test` does.

---

## Install

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
pnpm exec dql --help
```

### Library use

```bash
npm install @duckcodeailabs/dql-core @duckcodeailabs/dql-compiler
```

---

## 5-minute quickstart

### 1. Write a block

Create `blocks/monthly_revenue.dql`:

```dql
block "Monthly Revenue" {
    domain      = "revenue"
    type        = "chart.line"
    description = "Monthly revenue trend with YoY comparison"
    owner       = "data-team"
    tags        = ["revenue", "trend"]

    @certified

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

### 2. Parse and validate

```bash
dql parse blocks/monthly_revenue.dql
```

```
  ✓ Parsed: blocks/monthly_revenue.dql
    Statements: 1
    Diagnostics: ✓ No errors, no warnings
```

### 3. Run tests

```bash
dql test blocks/monthly_revenue.dql
```

```
  ✓ Found 1 block(s) in blocks/monthly_revenue.dql

  Block: "Monthly Revenue"
    Tests: 2 assertion(s)
    → assert row_count > 0
    → assert max(revenue) < 10000000
    Status: ✓ All assertions passed  (DuckDB :memory:)
```

Use `--db <path>` to point at a real DuckDB file:

```bash
dql test blocks/monthly_revenue.dql --db ./warehouse.duckdb
```

### 4. Certify

```bash
dql certify blocks/monthly_revenue.dql
```

```
  Block: "Monthly Revenue"
  Status: ✓ CERTIFIABLE
```

### 5. Format

```bash
dql fmt blocks/monthly_revenue.dql --check   # CI-safe check
dql fmt blocks/monthly_revenue.dql           # write in place
```

---

## Core concepts

### Blocks

A `block` is the fundamental unit in DQL. Every block has a name, a `type`, and a SQL `query`. Everything else — params, visualization, tests, governance metadata — is optional but encouraged.

```dql
block "My Block" {
    domain = "finance"
    type   = "chart.bar"
    owner  = "analytics"
    query  = "SELECT ..."
}
```

### Chart types

Set `type = "chart.<name>"` to declare what the block renders. See the [full chart type table](#chart-types) below.

### Parameters

Params are typed default values injected into the query via `${param_name}`:

```dql
params {
    lookback_months = 12
    region          = "us-east"
}

query = """
    SELECT ...
    WHERE region = '${region}'
      AND date >= CURRENT_DATE - INTERVAL '${lookback_months} months'
"""
```

Override at runtime: `dql run block.dql --param lookback_months=6`.

### Tests

`tests` blocks declare assertions that are executed by `dql test` against DuckDB:

```dql
tests {
    assert row_count > 0
    assert max(revenue) < 10000000
    assert min(amount) >= 0
}
```

### Decorators

`@certified` marks a block as production-grade. The `dql certify` command verifies that all governance requirements are met before the decorator is honoured.

```dql
@certified

block "Monthly Revenue" { ... }
```

---

## Chart types

| Type | Description |
|---|---|
| `chart.bar` | Vertical bar chart |
| `chart.line` | Line chart with optional multi-series |
| `chart.area` | Stacked or overlapping area chart |
| `chart.scatter` | Scatter / bubble plot |
| `chart.pie` | Pie chart |
| `chart.donut` | Donut chart |
| `chart.kpi` | Single-value KPI card |
| `chart.treemap` | Hierarchical treemap |
| `chart.gauge` | Radial gauge |
| `chart.heatmap` | Grid heatmap |
| `chart.waterfall` | Waterfall / bridge chart |
| `chart.funnel` | Funnel chart |
| `chart.sparkline` | Inline sparkline (no axes) |
| `chart.sankey` | Sankey / flow diagram |
| `chart.combo` | Overlaid bar + line combo |
| `chart.histogram` | Distribution histogram |
| `chart.stacked-bar` | Stacked bar chart |
| `chart.grouped-bar` | Grouped bar chart |
| `chart.geo` | Choropleth / geographic map |

---

## Governance

DQL treats governance as language, not process.

**`@certified`** declares that a block meets your team's quality bar. The `dql certify` command enforces it:

```dql
block "Monthly Revenue" {
    domain      = "revenue"
    type        = "chart.line"
    description = "Monthly revenue trend with YoY comparison"
    owner       = "data-team"
    tags        = ["revenue", "trend"]

    @certified
    ...
}
```

`dql certify` checks:
- `domain`, `type`, `description`, `owner` are all present and non-empty
- `tags` array is present
- The block has at least one test assertion

**Tests** run against DuckDB in-process — no separate database server required:

```bash
dql test blocks/monthly_revenue.dql
dql test blocks/monthly_revenue.dql --db ./warehouse.duckdb
```

Integrate in CI:

```yaml
- run: dql fmt --check blocks/
- run: dql parse blocks/
- run: dql certify blocks/
- run: dql test blocks/
```

---

## Package reference

| Package | npm | Description |
|---|---|---|
| `dql-core` | `@duckcodeailabs/dql-core` | Lexer, parser, AST, semantic analyser, formatter |
| `dql-compiler` | `@duckcodeailabs/dql-compiler` | IR lowering, Vega-Lite / React / HTML / runtime codegen |
| `dql-governance` | `@duckcodeailabs/dql-governance` | Block testing, certification rules, cost estimation |
| `dql-project` | `@duckcodeailabs/dql-project` | Git-backed block registry and project primitives |
| `dql-lsp` | `@duckcodeailabs/dql-lsp` | Language Server Protocol implementation |
| `dql-runtime` | `@duckcodeailabs/dql-runtime` | Browser runtime: data fetching, Vega rendering, hot-reload |
| `dql-charts` | `@duckcodeailabs/dql-charts` | visx-powered React SVG chart components |
| `dql-cli` | `@duckcodeailabs/dql-cli` | Public CLI (`dql parse`, `dql certify`, `dql fmt`, …) |

---

## VS Code extension

Install **DQL Language Support** from the Extensions panel, or:

```bash
code --install-extension dql.dql-language-support
```

Provides syntax highlighting, snippet expansion, format-on-save, hover documentation, and live diagnostics via `@duckcodeailabs/dql-lsp`. The language server is bundled — no separate process required.

---

## Workspace layout

```
apps/
  cli/                 Public DQL CLI (@duckcodeailabs/dql-cli)
  vscode-extension/    DQL Language Support for VS Code

packages/
  dql-core/            Parser, AST, semantic analysis, formatter
  dql-compiler/        DQL compilation pipeline
  dql-runtime/         Browser runtime
  dql-charts/          React chart components
  dql-lsp/             Language server
  dql-connectors/      Database connector layer
  dql-governance/      Test and certification primitives
  dql-project/         Block registry and project primitives

examples/
  blocks/              Example DQL blocks
  semantic-layer/      Example metric, dimension, hierarchy definitions

templates/
  starter/             Minimal Git-native starter project
```

---

## DuckCode Studio

For teams that need a collaborative notebook, AI-powered block generation, and a semantic layer, **DuckCode Studio** extends DQL with a full product experience. Studio adds a browser-based DQL Notebook powered by DuckDB-WASM, a natural-language coworker that generates and edits blocks from plain English, a semantic layer editor for metrics and dimensions, run history, approval workflows, and MCP integration.

DQL blocks authored in Studio are identical `.dql` files — you can check them into Git, run `dql certify` in CI, and use the full OSS toolchain without any product lock-in. Studio is the fastest way to get a team producing certified analytics blocks from day one.

Learn more at [duckcode.ai](https://duckcode.ai).

---

## Documentation

| Document | Description |
|---|---|
| [Getting Started](./docs/getting-started.md) | Installation, first block, parameters, tests, certification |
| [Language Reference](./docs/dql-language-reference.md) | Full syntax, all block fields, chart types, AST |
| [CLI Reference](./docs/cli-reference.md) | All commands and flags |
| [Contributing](./CONTRIBUTING.md) | Dev setup, repo structure, how to add a chart type |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports, feature requests, and pull requests are welcome.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).
