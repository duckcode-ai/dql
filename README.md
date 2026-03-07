# DQL

DQL is an open language and toolkit for durable analytics assets in Git. It gives teams a typed way to define reusable blocks, semantic-layer metadata, testing rules, and editor tooling without depending on the closed DuckCode coworker product.

## V1 scope

Included in this repo:
- `@dql/core` for parsing, semantic analysis, and formatting
- `@dql/compiler`, `@dql/runtime`, and `@dql/charts` for rendering and execution
- `@dql/project` for Git-backed block/project primitives
- `@dql/governance` for testing and certification primitives
- `@dql/lsp` and `DQL Language Support` for VS Code authoring
- examples and a starter template

Not included:
- notebook coworker UI
- agentic generation
- MCP runtime
- approvals, run memory, or product orchestration

## Quick start

```bash
pnpm install
pnpm build
node apps/cli/dist/index.js parse examples/blocks/revenue_by_segment.dql
node apps/cli/dist/index.js fmt --check examples/blocks/revenue_by_segment.dql
```

## Workspace layout

```text
apps/
  cli/                Public DQL CLI
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
  semantic-layer/     Example metric and dimension definitions

templates/
  starter/            Minimal Git-native starter project
```

## Use cases this repo supports

- Author reusable DQL blocks in Git
- Validate and format blocks locally
- Define semantic-layer metadata for metrics and dimensions
- Test and certify blocks before promotion
- Build DQL-aware editor workflows in VS Code

See [Getting Started](./docs/getting-started.md), [Project Structure](./docs/project-structure.md), [V1 Support Scope](./docs/v1-support-scope.md), and [Publishing](./docs/publishing.md).
