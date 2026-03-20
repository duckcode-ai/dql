# DQL

DQL (Domain Query Language) is an open, declarative language for defining durable analytics assets in Git. It gives teams a typed way to author reusable blocks — self-contained, testable, version-controlled units of data analysis that combine SQL, visualization config, parameters, and assertions. DQL does not require DuckCode Studio — it works standalone.

## Install

For local preview with the default file/DuckDB runtime, use an active LTS Node release such as Node 18, 20, or 22.

For most users, this is the only install path you need.

### Install the CLI

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

Then you can scaffold a project anywhere:

```bash
mkdir DQL-Examples
cd DQL-Examples
dql init dql-example --template ecommerce
cd dql-example
dql doctor
dql notebook
```

Run `dql notebook` from the project root that contains `dql.config.json`. If you stay in a parent folder, pass the project path explicitly with `dql notebook ./dql-example`.

### If you do not want a global install

```bash
mkdir DQL-Examples
cd DQL-Examples
npm init -y
npm install -D @duckcodeailabs/dql-cli
npx dql --help
npx dql init dql-example --template ecommerce
```

### If you installed only library packages

If you install only:

```bash
npm install @duckcodeailabs/dql-core @duckcodeailabs/dql-compiler
```

you will **not** get the `dql` command. Those are library packages, not the CLI.

### Source repo / contributor workflow

If you are contributing to DQL itself, use the monorepo workflow below. Commands such as `pnpm --filter @duckcodeailabs/dql-cli ...` work **only inside the DQL source repo**.

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
pnpm test
pnpm --filter @duckcodeailabs/dql-cli exec dql --help
```

From the repo root you can scaffold and test projects like this:

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-smoke --template ecommerce
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-smoke
```

### Common install mistakes

- If you see `zsh: command not found: dql`, the CLI is not installed globally and is not available on your `PATH`.
- If you see `No projects matched the filters`, you are running `pnpm --filter ...` outside the DQL monorepo.
- If you installed only `@duckcodeailabs/dql-core` and `@duckcodeailabs/dql-compiler`, you installed libraries, not the CLI.

## Fastest working command

```bash
npm install -g @duckcodeailabs/dql-cli
dql init my-dql-project --template ecommerce
cd my-dql-project
dql doctor
dql notebook
```

## Try DQL in 60 Seconds

The fastest way to evaluate DQL is to scaffold a themed project and open the browser notebook.

These commands assume `dql` is installed globally. If you used a local project install instead, replace `dql` with `npx dql`.

```bash
dql init my-dql-project --template ecommerce
cd my-dql-project
dql doctor
dql notebook
```

The notebook sidebar lists files from the active project and opens them as raw source links for quick inspection.

## Quick Start

Create a project, explore it in the notebook, then parse, preview, and build assets:

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

## Choose a Template

| Template | Best for | What you get |
|---|---|---|
| `starter` | Smallest local-first flow | Revenue sample data, starter blocks, welcome notebook |
| `ecommerce` | Strongest OSS product demo | Channel revenue, funnel analysis, realistic commerce dataset |
| `saas` | Revenue + retention evaluation | MRR, churn pressure, cohort analysis |
| `taxi` | Time-series and operations analysis | Trip volume, fare trends, borough analysis |

Use any template with:

```bash
dql init my-project --template ecommerce
```

## Common Use Cases

- **Evaluate DQL quickly** — scaffold a template, run `dql doctor`, and open `dql notebook`
- **Explore data interactively** — use DQL, SQL, markdown, and linked chart cells in the notebook
- **Author durable analytics blocks** — keep SQL, metadata, chart config, and tests in Git
- **Build static dashboards** — compile blocks, dashboards, and workbooks with `dql build`
- **Validate the full repo** — run source smoke tests before release or contribution

See [Use Cases](./docs/use-cases.md) for recommended paths by user goal.

## Real Repo Setup

If you want to work from the real repo instead of a published CLI package:

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
pnpm test
pnpm --filter @duckcodeailabs/dql-cli exec dql --help
```

Then smoke-test the browser notebook flow:

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-smoke --template ecommerce
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-smoke
```

For the full repo validation flow, see [Repo Testing](./docs/repo-testing.md).

### Example DQL block

```dql
block "Revenue by Segment" {
    domain      = "revenue"
    type        = "custom"
    description = "Quarterly revenue grouped by customer segment"
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

## Documentation

- [Why DQL](./docs/why-dql.md) — what problem DQL solves and when it is the right tool
- [Getting Started](./docs/getting-started.md) — canonical onboarding guide: install, notebook flow, first block walkthrough, and Node.js API
- [Quickstart](./docs/quickstart.md) — short compatibility page with the fastest commands
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
- [OSS Readiness Checklist](./docs/oss-readiness-checklist.md) — maintainer checklist for launch readiness and remaining blockers
- [Publishing](./docs/publishing.md) — maintainer guide for releasing `@duckcodeailabs/dql-*` packages
- [VS Code Extension](#vs-code-extension) — install `DQL Language Support`

## VS Code Extension

Search **DQL Language Support** in the Extensions panel, or install from the command line:

```bash
code --install-extension dql.dql-language-support
```

The extension provides syntax highlighting, snippets, formatting on save, and Language Server Protocol support (completions, hover, diagnostics) backed by `@duckcodeailabs/dql-lsp`.

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

## What This Repo Does Not Include

- Notebook coworker UI
- Agentic / natural-language block generation
- MCP runtime
- Approvals, run history, or product orchestration

Those remain part of the closed DuckCode product.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
