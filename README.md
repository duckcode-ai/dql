# DQL

DQL (DuckCode Query Language) is an open, declarative language for defining durable analytics assets in Git. It gives teams a typed way to author reusable blocks — self-contained, testable, version-controlled units of data analysis that combine SQL, visualization config, parameters, and assertions. DQL does not require DuckCode Studio — it works standalone.

## Install

npm packages are coming shortly. For now, clone from source:

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
# The dql binary is now available via:
node apps/cli/dist/index.js --help
# or
pnpm exec dql --help
```

Once published:

```bash
npm install -g @duckcodeailabs/dql-cli   # global dql binary
# or for library use:
npm install @duckcodeailabs/dql-core @duckcodeailabs/dql-compiler
```

## Quick Start

Write a block, parse it, then certify it:

```bash
# 1. Write a block (see example below)
# 2. Parse and validate
pnpm exec dql parse examples/blocks/revenue_by_segment.dql
# 3. Certify (checks owner, description, tags, domain)
pnpm exec dql certify examples/blocks/revenue_by_segment.dql
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

- [Getting Started](./docs/getting-started.md) — installation paths, first block walkthrough, Node.js API
- [Language Specification](./docs/dql-language-spec.md) — full syntax reference, block types, chart types, AST
- [CLI Reference](./docs/cli-reference.md) — all commands and flags
- [Publishing](./docs/publishing.md) — how to publish `@duckcodeailabs/dql-*` packages to npm
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
| `@duckcodeailabs/dql-cli` | Public CLI (`dql parse`, `dql certify`, `dql fmt`, …) |

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
