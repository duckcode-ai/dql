# Getting Started

## Prerequisites

- Node.js 20 or newer
- pnpm 9 or newer

## Install and build

```bash
pnpm install
pnpm build
```

## Run the public CLI

```bash
pnpm exec dql parse examples/blocks/revenue_by_segment.dql
pnpm exec dql test examples/blocks/revenue_by_segment.dql
pnpm exec dql certify examples/blocks/revenue_by_segment.dql
pnpm exec dql info examples/blocks/revenue_trend_query_only.dql
```

## Build the VS Code extension

```bash
pnpm --filter dql-language-support build
```

The extension bundles the DQL language server from `packages/dql-lsp`.

## Start from the template

Copy `templates/starter` into a new Git repo, then:

1. add charted or query-only blocks under `blocks/`
2. add metrics, dimensions, and hierarchies under `semantic-layer/`
3. add block companion YAML under `semantic-layer/blocks/` when you need business metadata that should travel with a block but stay separate from executable DQL

## What this repo does not provide

- notebook UI
- natural-language block generation
- MCP runtime
- approvals or run history

Those remain part of the closed DuckCode product.
