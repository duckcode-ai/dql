# Repo Testing

This guide shows how to validate the full open-source DQL repo from a real source checkout.

## When to use this guide

Use this if you want to:

- verify the monorepo builds cleanly
- smoke-test the CLI from source
- test the browser notebook end-to-end
- validate starter templates and example projects before release

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

## 2. Smoke-test starter templates

The fastest confidence pass is to scaffold each template, run the local checks, and open the notebook.

### Starter

```bash
rm -rf /tmp/dql-starter-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-starter-smoke --template starter
pnpm --filter @duckcodeailabs/dql-cli exec dql doctor /tmp/dql-starter-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql parse /tmp/dql-starter-smoke/blocks/revenue_by_segment.dql
pnpm --filter @duckcodeailabs/dql-cli exec dql build /tmp/dql-starter-smoke/blocks/revenue_by_segment.dql
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-starter-smoke
```

### E-commerce, SaaS, Taxi

Repeat the same pattern for the themed templates:

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-ecommerce-smoke --template ecommerce
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-saas-smoke --template saas
pnpm --filter @duckcodeailabs/dql-cli exec dql init /tmp/dql-taxi-smoke --template taxi
```

For each generated project, run:

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql doctor /tmp/dql-ecommerce-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql parse /tmp/dql-ecommerce-smoke/blocks/revenue_by_segment.dql
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-ecommerce-smoke

pnpm --filter @duckcodeailabs/dql-cli exec dql doctor /tmp/dql-saas-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql parse /tmp/dql-saas-smoke/blocks/revenue_by_segment.dql
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-saas-smoke

pnpm --filter @duckcodeailabs/dql-cli exec dql doctor /tmp/dql-taxi-smoke
pnpm --filter @duckcodeailabs/dql-cli exec dql parse /tmp/dql-taxi-smoke/blocks/revenue_by_segment.dql
pnpm --filter @duckcodeailabs/dql-cli exec dql notebook /tmp/dql-taxi-smoke
```

## 3. Validate repo examples

These templates are the best high-signal OSS demos:

- `templates/ecommerce/`
- `templates/saas/`
- `templates/taxi/`

Scaffold and test each template:

```bash
dql init /tmp/test-ecommerce --template ecommerce
dql doctor /tmp/test-ecommerce
dql parse /tmp/test-ecommerce/blocks/revenue_by_segment.dql
dql notebook /tmp/test-ecommerce

dql init /tmp/test-saas --template saas
dql doctor /tmp/test-saas
dql parse /tmp/test-saas/blocks/revenue_by_segment.dql
dql notebook /tmp/test-saas

dql init /tmp/test-taxi --template taxi
dql doctor /tmp/test-taxi
dql parse /tmp/test-taxi/blocks/revenue_by_segment.dql
dql notebook /tmp/test-taxi
```

Also test at least one dashboard build per template:

```bash
dql build /tmp/test-ecommerce/dashboards/revenue_command_center.dql
dql build /tmp/test-saas/dashboards/growth_scorecard.dql
dql build /tmp/test-taxi/dashboards/city_operations.dql
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

Run this from at least one starter project and one example:

```bash
pnpm --filter @duckcodeailabs/dql-cli exec dql preview /tmp/dql-starter-smoke/blocks/revenue_by_segment.dql --open
pnpm --filter @duckcodeailabs/dql-cli exec dql build /tmp/dql-starter-smoke/blocks/revenue_by_segment.dql
```

## 6. Release confidence checklist

Before publishing or tagging a release, confirm:

- `pnpm build` passes from the repo root
- `pnpm test` passes from the repo root
- `dql --help` shows `notebook` and `--template`
- all four templates scaffold correctly
- the three showcase examples open in the notebook
- at least one block and one dashboard build successfully

## Troubleshooting

- If DuckDB bindings fail after changing Node versions, rerun `pnpm install`.
- If port `3474` is busy, pass `--port 4474` to `dql notebook`, `dql preview`, or `dql serve`.
- If `dql` is not on your shell `PATH`, run it with `pnpm --filter @duckcodeailabs/dql-cli exec dql` from the repo root.
