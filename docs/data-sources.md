# Data Sources

DQL Phase 1 is optimized for **local-first experimentation**.

The easiest way to adopt DQL is to preview blocks against local files using the
`file` or `duckdb` connectors.

---

## Best First Experience

Use the starter project and sample CSV:

```bash
dql init my-dql-project
cd my-dql-project
dql doctor
dql new block "Pipeline Health"
dql preview blocks/pipeline_health.dql
```

The starter block reads from:

```sql
SELECT * FROM read_csv_auto('./data/revenue.csv')
```

This avoids needing a warehouse account on day one.

---

## Local File Mode

Use this in `dql.config.json`:

```json
{
  "defaultConnection": {
    "driver": "file",
    "filepath": ":memory:"
  }
}
```

Then write queries like:

```sql
SELECT *
FROM read_csv_auto('./data/revenue.csv')
```

You can also use DuckDB readers such as:

- `read_csv_auto(...)`
- `read_parquet(...)`
- `read_json(...)`

---

## DuckDB File Mode

If you already have a DuckDB database file:

```json
{
  "defaultConnection": {
    "driver": "duckdb",
    "filepath": "./local/dev.duckdb"
  }
}
```

Then your DQL query can use normal SQL against tables inside that database.

---

## Warehouse Connectors

DQL also ships connector support for:

- PostgreSQL
- MySQL
- SQLite
- Snowflake
- BigQuery
- SQL Server / MSSQL
- DuckDB
- File-backed local DuckDB queries

For open-source adoption, we recommend starting with local file or DuckDB mode
before connecting cloud warehouses.

---

## Connector Reference

Use strict JSON in `dql.config.json`. Pick one `defaultConnection` block and
replace the starter value with the connector you actually want to use.

### SQLite

1. Create or choose a local SQLite database file.
2. Update `dql.config.json`:

```json
{
  "defaultConnection": {
    "driver": "sqlite",
    "filepath": "./local/dev.sqlite"
  }
}
```

3. Query tables from that database directly in DQL.

### PostgreSQL

1. Make sure your PostgreSQL instance is reachable from your machine.
2. Update `dql.config.json`:

```json
{
  "defaultConnection": {
    "driver": "postgresql",
    "host": "localhost",
    "port": 5432,
    "database": "analytics",
    "username": "postgres",
    "password": "postgres",
    "ssl": false
  }
}
```

3. Run `dql doctor`.
4. Preview or build against your warehouse-backed tables.

### MySQL

1. Make sure your MySQL instance is reachable from your machine.
2. Update `dql.config.json`:

```json
{
  "defaultConnection": {
    "driver": "mysql",
    "host": "localhost",
    "port": 3306,
    "database": "analytics",
    "username": "root",
    "password": "root",
    "ssl": false
  }
}
```

3. Run `dql doctor`.

### Snowflake

1. Identify your Snowflake account, warehouse, database, schema, and role.
2. Update `dql.config.json`:

```json
{
  "defaultConnection": {
    "driver": "snowflake",
    "account": "your-account",
    "warehouse": "COMPUTE_WH",
    "database": "ANALYTICS",
    "schema": "PUBLIC",
    "username": "user",
    "password": "password",
    "role": "ANALYST"
  }
}
```

3. Run `dql doctor`.

### BigQuery

1. Make sure your local environment already has access to the target GCP project.
2. Update `dql.config.json`:

```json
{
  "defaultConnection": {
    "driver": "bigquery",
    "projectId": "your-gcp-project"
  }
}
```

3. Run `dql doctor`.

### SQL Server / MSSQL

1. Make sure your SQL Server instance is reachable from your machine.
2. Update `dql.config.json`:

```json
{
  "defaultConnection": {
    "driver": "mssql",
    "host": "localhost",
    "port": 1433,
    "database": "analytics",
    "username": "sa",
    "password": "yourStrong(!)Password",
    "ssl": false
  }
}
```

3. Run `dql doctor`.

---

## Tips for Easy Testing

- keep sample datasets in `data/`
- use query-only blocks for validation flows
- add `tests { assert row_count > 0 }` to every starter block
- prefer small local CSV or Parquet files for examples

---

## Troubleshooting

### Preview works but query fails

Run:

```bash
dql doctor
```

Check that:

- `dql.config.json` exists
- `defaultConnection` is set
- your query paths are correct relative to the project root
- your selected connector settings match the reference above

### `read_csv_auto(...)` cannot find a file

Use project-relative paths like:

```sql
FROM read_csv_auto('./data/revenue.csv')
```

### Local DuckDB support is missing

If your environment does not include DuckDB yet, add it to your local project:

```bash
npm install duckdb
```

If you changed Node versions after installing dependencies, rerun `pnpm install`
before using local file or DuckDB preview.
