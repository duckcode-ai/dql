# DQL Example Gallery

Three repositories showing DQL at three scales. Each is runnable in under
5 minutes from a clean machine via `create-dql-app` or direct git clone.

| Name | Scale | Dataset | What it demos |
| --- | --- | --- | --- |
| **jaffle-shop** | ~50 models | DuckDB seed | Quickstart, certified blocks, dashboard compile |
| **retail-mart** | ~500 models | Postgres | Multi-domain lineage, governance certification flow, impact analysis |
| **saas-analytics** | ~2,000 models | BigQuery | Manifest cache performance, selective dbt import, cross-domain detection |

## jaffle-shop (bundled in create-dql-app)

Ships as the default template.

```bash
npx create-dql-app my-demo
```

## retail-mart

Public repo: <https://github.com/duckcode-ai/dql-example-retail>

```bash
git clone https://github.com/duckcode-ai/dql-example-retail
cd dql-example-retail && pnpm install
dql notebook
```

## saas-analytics

Public repo: <https://github.com/duckcode-ai/dql-example-saas>

```bash
git clone https://github.com/duckcode-ai/dql-example-saas
cd dql-example-saas && pnpm install
dql sync dbt
dql notebook
```

## Stress test (synthetic 4,000-model dbt project)

For performance benchmarking — generated, not committed:

```bash
node scripts/bench/gen-dbt-project.mjs --models 4000 --out /tmp/stress
node scripts/bench/run-bench.mjs /tmp/stress
```

See [docs/contribute/testing.md](../../docs/contribute/testing.md).
