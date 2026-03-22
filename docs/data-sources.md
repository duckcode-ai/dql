# Data Sources

DQL Phase 1 is optimized for **local-first experimentation with a browser notebook on top**.

The easiest way to adopt DQL is to preview blocks against local files using the
`file` or `duckdb` connectors.

---

## Best First Experience

Use the starter project and sample CSV, then open the notebook immediately:

```bash
dql init my-dql-project
cd my-dql-project
dql doctor
dql notebook
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

- File-backed local DuckDB queries
- DuckDB
- SQLite
- PostgreSQL
- Redshift
- MySQL
- SQL Server / MSSQL
- Microsoft Fabric
- Snowflake
- BigQuery
- ClickHouse
- Databricks SQL
- Amazon Athena
- Trino

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

### Redshift

```json
{
  "defaultConnection": {
    "driver": "redshift",
    "host": "example-cluster.abc123.us-east-1.redshift.amazonaws.com",
    "port": 5439,
    "database": "analytics",
    "username": "analyst",
    "password": "secret",
    "ssl": true
  }
}
```

### Microsoft Fabric

```json
{
  "defaultConnection": {
    "driver": "fabric",
    "host": "workspace.datawarehouse.fabric.microsoft.com",
    "port": 1433,
    "database": "analytics",
    "username": "user",
    "password": "secret",
    "ssl": true
  }
}
```

### ClickHouse

```json
{
  "defaultConnection": {
    "driver": "clickhouse",
    "host": "play.clickhouse.com",
    "port": 8443,
    "database": "default",
    "username": "play",
    "password": "play",
    "ssl": true
  }
}
```

### Databricks SQL

```json
{
  "defaultConnection": {
    "driver": "databricks",
    "host": "dbc-example.cloud.databricks.com",
    "warehouse": "warehouse-id",
    "catalog": "main",
    "schema": "analytics",
    "token": "dapi..."
  }
}
```

### Athena

```json
{
  "defaultConnection": {
    "driver": "athena",
    "region": "us-east-1",
    "database": "analytics",
    "outputLocation": "s3://my-query-results/",
    "workgroup": "primary"
  }
}
```

### Trino

```json
{
  "defaultConnection": {
    "driver": "trino",
    "host": "trino.example.com",
    "port": 8080,
    "catalog": "lakehouse",
    "schema": "analytics",
    "username": "analyst",
    "password": "secret",
    "ssl": true
  }
}
```

---

## Semantic Layer + Connector Integration

All 14 connectors fully support the semantic layer. When you define metrics and
dimensions in `semantic-layer/` YAML files, DQL automatically generates
**database-specific SQL** for the configured connector.

### How It Works

1. Define metrics/dimensions in YAML (same shape as dbt semantic layer):

```yaml
# semantic-layer/metrics/revenue.yaml
name: total_revenue
sql: SUM(amount)
type: sum
table: orders
```

2. Reference them in semantic blocks (no raw SQL needed):

```dql
block "Revenue by Channel" {
    type = "semantic"
    metric = "total_revenue"
    visualization { chart = "bar" }
}
```

3. DQL composes the right SQL for your database:

| Feature | PostgreSQL | BigQuery | MySQL | Snowflake | MSSQL | ClickHouse | SQLite |
|---------|-----------|----------|-------|-----------|-------|------------|--------|
| DATE_TRUNC | `DATE_TRUNC('month', col)` | `DATE_TRUNC(col, MONTH)` | `DATE_FORMAT(col, '%Y-%m-01')` | `DATE_TRUNC('month', col)` | `DATETRUNC(month, col)` | `toStartOfMonth(col)` | `STRFTIME('%Y-%m-01', col)` |
| LIMIT | `LIMIT N` | `LIMIT N` | `LIMIT N` | `LIMIT N` | `OFFSET 0 ROWS FETCH NEXT N ROWS ONLY` | `LIMIT N` | `LIMIT N` |
| Identifier quoting | `"col"` | `` `col` `` | `` `col` `` | `"col"` | `[col]` | `"col"` | `"col"` |

### Semantic Query API

The runtime exposes `POST /api/semantic-query` for programmatic access:

```json
{
  "metrics": ["total_revenue"],
  "dimensions": ["channel"],
  "timeDimension": { "name": "order_date", "granularity": "month" },
  "filters": [{ "dimension": "channel", "operator": "equals", "values": ["web"] }],
  "limit": 100,
  "connection": {
    "driver": "snowflake",
    "account": "...",
    "warehouse": "...",
    "database": "...",
    "username": "...",
    "password": "..."
  }
}
```

The `connection` field is optional — if omitted, uses `defaultConnection` from
`dql.config.json`. The dialect is automatically selected based on the driver.

---

## Tips for Easy Testing

- keep sample datasets in `data/`
- start with `dql notebook` so you can iterate cell-by-cell before formalizing blocks
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
