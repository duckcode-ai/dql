# {{PROJECT_NAME}}

A DQL project scaffolded by `create-dql-app`.

DQL means **Domain Query Language**. It is the open-source analytics language
for turning source data, SQL, dbt models, business terms, notebooks,
dashboards, apps, and lineage into one Git-versioned project.

The core path is:

```text
source data -> DQL block -> business_view -> dashboard/app/AI answer
```

Run `dql compile .` to produce `dql-manifest.json`, the local manifest that
connects technical lineage with business lineage.

## Connect your warehouse

Edit `dql.config.json` or open the notebook connection panel. DQL uses a flat
install by default: Databricks SQL works through the built-in HTTP connector,
and DuckDB or Snowflake drivers can be installed project-locally when needed.
[docs/reference/connectors.md](https://github.com/duckcode-ai/dql/blob/main/docs/reference/connectors.md).
Add your warehouse connection in the notebook or config. For local files, add a
DuckDB/file connection and query CSV or Parquet data with functions such as
`read_csv_auto('./file.csv')`.

```bash
npm install
npm run doctor
```

## Start the notebook

```bash
npm run notebook
```

Open `notebooks/welcome.dqlnb` first. It shows the starter workflow:

1. Explore data with SQL.
2. Promote repeated logic into reusable DQL blocks under `blocks/`.
3. Define shared vocabulary under `terms/`.
4. Compose business outcomes under `business-views/`.
5. Use Lineage to trace source data into business views and consumption.

## Have a dbt project?

Point `dql.config.json` at it (auto-wired if a sibling dbt project was
detected at scaffold time), then:

```bash
dbt parse          # inside the dbt project
npx dql sync dbt   # import models + lineage into DQL
```

No dbt project handy? Try the example repo:
[github.com/duckcode-ai/jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).
