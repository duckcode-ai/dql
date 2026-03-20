# DQL

DQL (DuckCode Query Language) is an open, declarative language for defining durable analytics assets in Git. It gives teams a typed way to author reusable blocks — self-contained, testable, version-controlled units of data analysis that combine SQL, visualization config, parameters, and assertions. DQL does not require DuckCode Studio — it works standalone.

## Install

For local preview with the default file/DuckDB runtime, use an active LTS Node release such as Node 18, 20, or 22. If you switch Node versions after installing dependencies, rerun `pnpm install` so native modules are rebuilt for the current runtime.

If you are using a published CLI package:

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

To build from source instead:

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
# The dql binary is available from the repo root via:
node apps/cli/dist/index.js --help
# or
pnpm exec dql --help
# If you `cd` into a generated project without a global install, invoke:
../node_modules/.bin/dql --help
```

For library use:

```bash
npm install @duckcodeailabs/dql-core @duckcodeailabs/dql-compiler
```

## Quick Start

Create a starter project, parse a block, then preview it locally:

These commands assume `dql` is installed globally. If you are running from a source checkout, use `pnpm exec dql` from the repo root, or `../node_modules/.bin/dql` after `cd`-ing into the generated project.

```bash
dql init my-dql-project
cd my-dql-project
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
- [Quickstart](./docs/quickstart.md) — the fastest path from install to local chart preview
- [Getting Started](./docs/getting-started.md) — installation paths, first block walkthrough, Node.js API
- [Examples](./docs/examples.md) — where to start, what each example teaches, and what to try next
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
| `@duckcodeailabs/dql-lsp` | Language Server Protocol implementation |
| `@duckcodeailabs/dql-runtime` | Browser runtime: data fetching, Vega rendering, hot-reload client |
| `@duckcodeailabs/dql-charts` | visx-powered React SVG chart components |
| `@duckcodeailabs/dql-cli` | Public CLI (`dql init`, `dql preview`, `dql parse`, `dql certify`, `dql fmt`, …) |

## Workspace Layout

```
apps/
  cli/                Public DQL CLI (@duckcodeailabs/dql-cli)
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
