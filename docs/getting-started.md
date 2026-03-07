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
node apps/cli/dist/index.js parse examples/blocks/revenue_by_segment.dql
node apps/cli/dist/index.js test examples/blocks/revenue_by_segment.dql
node apps/cli/dist/index.js certify examples/blocks/revenue_by_segment.dql
```

## Build the VS Code extension

```bash
pnpm --filter dql-language-support build
```

The extension bundles the DQL language server from `packages/dql-lsp`.

## Start from the template

Copy `templates/starter` into a new Git repo, then add blocks under `blocks/` and semantic definitions under `semantic-layer/`.

## What this repo does not provide

- notebook UI
- natural-language block generation
- MCP runtime
- approvals or run history

Those remain part of the closed DuckCode product.
