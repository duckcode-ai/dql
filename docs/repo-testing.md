# Repo Testing

This guide shows how to validate the full open-source DQL repo from a real source checkout.

## When to use this guide

Use this if you want to:

- verify the monorepo builds cleanly
- smoke-test the CLI from source
- test the browser notebook end-to-end
- validate the getting-started flow before release

## Prerequisites

- Node.js 18, 20, or 22 LTS
- `pnpm` 9+
- a fresh clone of the DQL repo

## 1. Install and build from source

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
pnpm test
```

Sanity-check the CLI entrypoint:

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql --help
```

The rest of this guide assumes you stay at the repo root and invoke the CLI the same way.

## 2. Smoke-test init and notebook

The fastest confidence pass is to scaffold a project, run the local checks, and open the notebook.

### Basic init (no dbt)

```bash
rm -rf /tmp/dql-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql doctor /tmp/dql-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-smoke
```

### With Jaffle Shop dbt project

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git /tmp/jaffle-shop
cd /tmp/jaffle-shop
pip install dbt-duckdb && dbt deps && dbt build --profiles-dir .
pnpm --filter @duckcodeailabs/dql-cli exec dql init .
pnpm --filter @duckcodeailabs/dql-cli exec dql doctor .
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook .
```

## 3. Validate block workflows

From a scaffolded project:

```bash
cd /tmp/dql-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql new block "Test Block" --domain test
pnpm --filter @duckcodeailabs/dql-cli exec dql parse blocks/test_block.dql
pnpm --filter @duckcodeailabs/dql-cli exec dql certify blocks/test_block.dql
```

## 4. Manual browser checklist

After opening the notebook, verify these flows manually:

- the notebook opens at `http://127.0.0.1:<port>`
- the welcome notebook loads automatically
- the file sidebar lists project assets
- a DQL cell runs and returns rows
- a SQL cell runs and returns rows
- a chart cell can link to a DQL or SQL cell
- the connection panel renders the available drivers
- the local `file` connection can be saved and tested
- notebook export downloads a `.dqlnb` file

## 5. Preview and serve compatibility

The new notebook flow should not break the classic preview flow.

Run this from a scaffolded project with a block:

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql preview /tmp/dql-smoke/blocks/test_block.dql --open
pnpm --filter @duckcodeailabs/dql-cli exec dql build /tmp/dql-smoke/blocks/test_block.dql
```

## 6. Release confidence checklist

Before publishing or tagging a release, confirm:

- `pnpm build` passes from the repo root
- `pnpm test` passes from the repo root
- `dql --help` shows `notebook` and all commands
- `dql init` scaffolds correctly (with and without dbt project)
- the notebook opens and queries run
- at least one block builds successfully

## Troubleshooting

- If DuckDB bindings fail after changing Node versions, rerun `pnpm install`.
- If port `3474` is busy, pass `--port 4474` to `dql notebook`, `dql preview`, or `dql serve`.
- If `dql` is not on your shell `PATH`, run it with `pnpm --filter @duckcodeailabs/dql-cli exec dql` from the repo root.
