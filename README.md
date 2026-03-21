# DQL

SQL queries disappear into Slack. Charts drift from the queries that power them. AI generates code that nobody can find next week. DQL fixes that.

**DQL is an open-source analytics language, CLI, and notebook UI** — each analytics answer lives in a single `.dql` file: SQL + visualization config + owner + tests + parameters, all Git-trackable.

- Your team copy-pastes the same query into 12 dashboards. They drift. Nobody knows which is right.
- Someone changes the SQL. The chart breaks. There was no review.
- AI generated a perfect query last Tuesday. It's gone now.
- "Is this metric still correct?" — nobody can answer that.

DQL turns one-off analytics work into durable, testable, reviewable assets.

```dql
block "Revenue by Segment" {
    domain      = "revenue"
    owner       = "data-team"
    tags        = ["revenue", "segment", "quarterly"]

    params {
        period = "current_quarter"
    }

    query = """
        SELECT segment_tier AS segment, SUM(amount) AS revenue
        FROM fct_revenue
        WHERE fiscal_period = ${period}
        GROUP BY segment_tier
        ORDER BY revenue DESC
    """

    visualization {
        chart = "bar"
        x     = segment
        y     = revenue
    }

    tests {
        assert row_count > 0
    }
}
```

`dql notebook` opens a local browser notebook — SQL cells, markdown, param widgets, and auto-charting, all powered by DuckDB. No cloud required.

---

## Install

Requires Node 18, 20, or 22 (active LTS).

### Install the CLI

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

Scaffold a project and open the notebook:

```bash
mkdir DQL-Examples
cd DQL-Examples
dql init dql-example --template ecommerce
cd dql-example
dql doctor
dql notebook
```

Run `dql notebook` from the project root containing `dql.config.json`. To run from a parent directory: `dql notebook ./dql-example`.

### Without a global install

```bash
mkdir DQL-Examples
cd DQL-Examples
npm init -y
npm install -D @duckcodeailabs/dql-cli
npx dql --help
npx dql init dql-example --template ecommerce
```

### Library packages only

Installing just the libraries does not give you the `dql` command:

```bash
npm install @duckcodeailabs/dql-core @duckcodeailabs/dql-compiler
```

Those are library packages. For the CLI, install `@duckcodeailabs/dql-cli`.

### Source / contributor workflow

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
pnpm test
pnpm --filter @duckcodeailabs/dql-cli exec dql --help
```

Scaffold and test from the repo:

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-smoke --template ecommerce
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-smoke
```

### Common mistakes

- `zsh: command not found: dql` — CLI is not installed globally or not on your PATH.
- `No projects matched the filters` — you are running `pnpm --filter` outside the DQL monorepo.
- Installed only `dql-core` and `dql-compiler` — those are libraries, not the CLI.

---

## 60-Second Quickstart

```bash
npm install -g @duckcodeailabs/dql-cli
dql init my-dql-project --template ecommerce
cd my-dql-project
dql doctor
dql notebook
```

The notebook sidebar lists all blocks in the project. Open any `.dql` file, run SQL cells, and explore the data interactively.

---

## Quick Start — Full Workflow

```bash
dql init my-dql-project --template ecommerce
cd my-dql-project
dql notebook
dql new block "Pipeline Health"
dql new semantic-block "ARR Growth"
dql new dashboard "Revenue Overview"
dql new workbook "Quarterly Review"
dql doctor
dql parse blocks/pipeline_health.dql
dql preview blocks/pipeline_health.dql --open
dql build blocks/pipeline_health.dql
dql serve dist/pipeline_health
```

---

## Templates

| Template | Best for | What you get |
|---|---|---|
| `starter` | Smallest local-first flow | Revenue sample data, starter blocks, welcome notebook |
| `ecommerce` | Strongest OSS product demo | Channel revenue, funnel analysis, realistic commerce dataset |
| `saas` | Revenue + retention evaluation | MRR, churn pressure, cohort analysis |
| `taxi` | Time-series and operations analysis | Trip volume, fare trends, borough analysis |

```bash
dql init my-project --template ecommerce
```

---

## Common Use Cases

- **Evaluate DQL quickly** — scaffold a template, run `dql doctor`, open `dql notebook`
- **Explore data interactively** — SQL, markdown, linked chart cells, and param widgets in the notebook
- **Author durable analytics blocks** — SQL, metadata, chart config, and tests together in Git
- **Build static dashboards** — compile blocks, dashboards, and workbooks with `dql build`
- **Validate the full repo** — run source smoke tests before release or contribution

See [Use Cases](./docs/use-cases.md) for recommended paths by user goal.

---

## Documentation

- [Why DQL](./docs/why-dql.md) — what problem DQL solves and when it is the right tool
- [Getting Started](./docs/getting-started.md) — install, notebook flow, first block walkthrough, and Node.js API
- [Quickstart](./docs/quickstart.md) — fastest commands and compatibility notes
- [Use Cases](./docs/use-cases.md) — recommended paths for evaluation, notebook usage, authoring, and release validation
- [Examples](./docs/examples.md) — where to start, what each example teaches, and what to try next
- [Repo Testing](./docs/repo-testing.md) — full source checkout smoke tests and manual validation checklist
- [FAQ](./docs/faq.md) — common questions about standalone DQL usage and scope
- [Compatibility](./docs/compatibility.md) — current runtime, connector, and workflow support matrix
- [Language Specification](./docs/dql-language-spec.md) — full syntax reference, block types, chart types, AST
- [CLI Reference](./docs/cli-reference.md) — all commands and flags
- [Project Config](./docs/project-config.md) — how `dql.config.json` drives local preview and serving
- [Data Sources](./docs/data-sources.md) — local CSV/Parquet, DuckDB, and connector setup
- [Migration Guides](./docs/migration-guides/README.md) — practical paths from raw SQL, dbt metrics, and saved BI queries
- [OSS Readiness Checklist](./docs/oss-readiness-checklist.md) — maintainer checklist for launch readiness
- [Publishing](./docs/publishing.md) — maintainer guide for releasing `@duckcodeailabs/dql-*` packages
- [VS Code Extension](#vs-code-extension) — install `DQL Language Support`

---

## VS Code Extension

Search **DQL Language Support** in the Extensions panel, or:

```bash
code --install-extension dql.dql-language-support
```

Provides syntax highlighting, snippets, format-on-save, and LSP support (completions, hover, diagnostics) via `@duckcodeailabs/dql-lsp`.

---

## Package Reference

| Package | Description |
|---|---|
| `@duckcodeailabs/dql-core` | Lexer, parser, AST, semantic analysis, formatter |
| `@duckcodeailabs/dql-compiler` | IR lowering, Vega-Lite / React / HTML / runtime code generation |
| `@duckcodeailabs/dql-governance` | Block testing, certification rules, cost estimation |
| `@duckcodeailabs/dql-project` | Git-backed block registry and project primitives |
| `@duckcodeailabs/dql-notebook` | Notebook document model and execution helpers |
| `@duckcodeailabs/dql-lsp` | Language Server Protocol implementation |
| `@duckcodeailabs/dql-runtime` | Browser runtime: data fetching, Vega rendering, hot-reload client |
| `@duckcodeailabs/dql-charts` | visx-powered React SVG chart components |
| `@duckcodeailabs/dql-cli` | Public CLI (`dql init`, `dql preview`, `dql parse`, `dql certify`, `dql fmt`, …) |

---

## Workspace Layout

```
apps/
  cli/                Public DQL CLI (@duckcodeailabs/dql-cli)
  notebook-browser/   Browser-first notebook
  vscode-extension/   DQL Language Support for VS Code

packages/
  dql-core/           Parser, AST, semantic analysis, formatter
  dql-compiler/       DQL compilation pipeline
  dql-runtime/        Browser runtime
  dql-charts/         React chart components
  dql-lsp/            Language server
  dql-connectors/     Database connector layer
  dql-governance/     Test and certification primitives
  dql-project/        Block registry and project primitives
  dql-notebook/       Notebook document model and execution helpers

examples/
  README.md           Example guide
  blocks/             Example DQL blocks
  semantic-layer/     Example metric, dimension, hierarchy definitions

templates/
  starter/            Minimal Git-native starter project
```

---

## What This Repo Does Not Include

- Natural-language / agentic block generation
- MCP runtime
- Approvals, run history, or product orchestration

Those remain part of the closed DuckCode product.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).
