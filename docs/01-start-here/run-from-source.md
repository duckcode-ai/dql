# Run DQL From Source

Use this guide if you want to download the repo, install dependencies, run DQL locally, and test it before publishing to npm.

## What You Will Do

1. Clone the repo
2. Install dependencies
3. Build and test the monorepo
4. Run the CLI from source
5. Smoke-test the notebook and block workflows

## Prerequisites

- Node.js 18, 20, or 22
- `pnpm` 9+
- Git

## Step 1: Clone The Repo

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
```

## Step 2: Install Dependencies

```bash
pnpm install
```

## Step 3: Build The Repo

```bash
pnpm build
```

## Step 4: Run The Test Suite

```bash
pnpm test
```

## Step 5: Verify The CLI Entry Point

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql --help
```

This confirms the CLI is runnable from the source checkout without needing a global npm install.

## Step 6: Smoke-Test A New Project

```bash
rm -rf /tmp/dql-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql doctor /tmp/dql-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-smoke
```

## Step 7: Smoke-Test A Block Workflow

```bash
cd /tmp/dql-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql new block "Test Block" --domain test
pnpm --filter @duckcodeailabs/dql-cli exec dql parse blocks/test_block.dql
pnpm --filter @duckcodeailabs/dql-cli exec dql certify blocks/test_block.dql
pnpm --filter @duckcodeailabs/dql-cli exec dql build blocks/test_block.dql
```

## Step 8: Optional npm Package Check

If you want to inspect the published CLI package contents before release:

```bash
cd apps/cli
pnpm build
npm pack
```

## Recommended Manual UI Checks

- open the notebook and confirm the welcome content loads
- run a SQL cell and confirm rows return
- open Block Studio and confirm the editor and results pane behave correctly
- open the connections screen and confirm driver settings render
- save a connection and test it

## Related Docs

- [Repo Testing](../repo-testing.md)
- [Publishing](../publishing.md)
- [OSS Readiness Checklist](../oss-readiness-checklist.md)
