# {{PROJECT_NAME}}

A DQL project, scaffolded by `create-dql-app`.

## Connect your warehouse

Edit `dql.config.json` — DQL ships 15 drivers out of the box:
[docs/reference/connectors.md](https://github.com/duckcode-ai/dql/blob/main/docs/reference/connectors.md).
The default connection is in-memory DuckDB, so dropping a CSV into the project
and querying it with `read_csv_auto('./file.csv')` works with zero setup.

```bash
npm install
npm run doctor
```

## Start the notebook

```bash
npm run notebook
```

## Have a dbt project?

Point `dql.config.json` at it (auto-wired if a sibling dbt project was
detected at scaffold time), then:

```bash
dbt parse          # inside the dbt project
npx dql sync dbt   # import models + lineage into DQL
```

No dbt project handy? Try the example repo:
[github.com/duckcode-ai/jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).
