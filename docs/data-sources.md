# Data Sources & Connector Reference

DQL supports **14 database connectors** out of the box. Start with local file mode (no database needed), then connect to your warehouse when ready.

> **Step-by-step walkthrough:** [Enterprise Getting Started](./enterprise-getting-started.md) shows how to configure your database connection, browse schema, and build blocks — all from the notebook UI.

---

## Quick Start (No Database)

```bash
npm install -g @duckcodeailabs/dql-cli
dql init my-project && cd my-project
dql notebook
```

The default `driver: "file"` uses DuckDB in-memory. Query local CSV, Parquet, and JSON files:

```sql
SELECT * FROM read_csv_auto('./data/orders.csv')
SELECT * FROM read_parquet('./data/events.parquet')
SELECT * FROM read_json('./data/config.json')
```

---

## Connector Config Reference

All connections go in `dql.config.json` under `defaultConnection`. Use `${ENV_VAR}` for secrets — DQL resolves them from your shell environment.

### Local / Embedded

#### DuckDB In-Memory (`file`)

```json
{
  "defaultConnection": {
    "driver": "file",
    "filepath": ":memory:"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `driver` | | Must be `"file"` |
| `filepath` | | Path to `.duckdb` file, or `":memory:"` (default) |

#### DuckDB File (`duckdb`)

```json
{
  "defaultConnection": {
    "driver": "duckdb",
    "filepath": "./data/warehouse.duckdb"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `driver` | | Must be `"duckdb"` |
| `filepath` | | Path to the `.duckdb` database file |

#### SQLite (`sqlite`)

```json
{
  "defaultConnection": {
    "driver": "sqlite",
    "database": "./data/analytics.sqlite"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `driver` | | Must be `"sqlite"` |
| `database` | | Path to the `.sqlite` or `.db` file |

---

### Relational Databases

#### PostgreSQL (`postgres`)

```json
{
  "defaultConnection": {
    "driver": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "analytics",
    "username": "analyst",
    "password": "${POSTGRES_PASSWORD}",
    "ssl": false
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"postgres"` |
| `host` | | — | Hostname or IP address |
| `port` | | `5432` | Port number |
| `database` | | — | Database name |
| `username` | | — | Database user |
| `password` | | — | Password (use `${ENV_VAR}`) |
| `ssl` | | `false` | Enable SSL/TLS |
| `schema` | | `"public"` | Default schema |

**Works with:** PostgreSQL, Supabase, Amazon RDS, Aurora, Neon, CockroachDB

#### MySQL (`mysql`)

```json
{
  "defaultConnection": {
    "driver": "mysql",
    "host": "localhost",
    "port": 3306,
    "database": "analytics",
    "username": "root",
    "password": "${MYSQL_PASSWORD}",
    "ssl": false
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"mysql"` |
| `host` | | — | Hostname or IP address |
| `port` | | `3306` | Port number |
| `database` | | — | Database name |
| `username` | | — | Database user |
| `password` | | — | Password (use `${ENV_VAR}`) |
| `ssl` | | `false` | Enable SSL/TLS |

**Works with:** MySQL, MariaDB, PlanetScale, TiDB, Vitess

#### SQL Server (`mssql`)

```json
{
  "defaultConnection": {
    "driver": "mssql",
    "host": "localhost",
    "port": 1433,
    "database": "analytics",
    "username": "sa",
    "password": "${MSSQL_PASSWORD}",
    "ssl": false
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"mssql"` |
| `host` | | — | Hostname or IP address |
| `port` | | `1433` | Port number |
| `database` | | — | Database name |
| `username` | | — | Database user |
| `password` | | — | Password (use `${ENV_VAR}`) |
| `ssl` | | `false` | Enable SSL/TLS |

**Works with:** SQL Server, Azure SQL Database, Azure SQL Managed Instance

---

### Cloud Data Warehouses

#### Snowflake (`snowflake`)

```json
{
  "defaultConnection": {
    "driver": "snowflake",
    "account": "your-account.snowflakecomputing.com",
    "username": "your_user",
    "password": "${SNOWFLAKE_PASSWORD}",
    "database": "ANALYTICS",
    "schema": "PUBLIC",
    "warehouse": "COMPUTE_WH",
    "role": "ANALYST"
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"snowflake"` |
| `account` | | — | Snowflake account identifier (e.g., `abc123.us-east-1`) |
| `username` | | — | Snowflake username |
| `password` | | — | Password (use `${ENV_VAR}`) |
| `database` | | — | Database name |
| `schema` | | `"PUBLIC"` | Default schema |
| `warehouse` | | — | Virtual warehouse name |
| `role` | | — | Role to use for the session |

#### BigQuery (`bigquery`)

```json
{
  "defaultConnection": {
    "driver": "bigquery",
    "project": "your-gcp-project-id",
    "dataset": "analytics",
    "keyFilename": "./service-account.json"
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"bigquery"` |
| `project` | | — | GCP project ID |
| `dataset` | | — | Default dataset |
| `keyFilename` | | — | Path to service account JSON key file |
| `location` | | `"US"` | Dataset location (e.g., `"EU"`, `"us-central1"`) |

**Auth:** If `keyFilename` is not set, uses Application Default Credentials (`gcloud auth application-default login`).

#### Amazon Redshift (`redshift`)

```json
{
  "defaultConnection": {
    "driver": "redshift",
    "host": "cluster.abc123.us-east-1.redshift.amazonaws.com",
    "port": 5439,
    "database": "analytics",
    "username": "analyst",
    "password": "${REDSHIFT_PASSWORD}",
    "ssl": true
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"redshift"` |
| `host` | | — | Cluster endpoint |
| `port` | | `5439` | Port number |
| `database` | | — | Database name |
| `username` | | — | Database user |
| `password` | | — | Password (use `${ENV_VAR}`) |
| `ssl` | | `true` | Enable SSL (recommended) |
| `schema` | | `"public"` | Default schema |

#### Databricks SQL (`databricks`)

```json
{
  "defaultConnection": {
    "driver": "databricks",
    "host": "dbc-example.cloud.databricks.com",
    "warehouse": "your-sql-warehouse-id",
    "catalog": "main",
    "schema": "analytics",
    "token": "${DATABRICKS_TOKEN}"
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"databricks"` |
| `host` | | — | Workspace hostname |
| `warehouse` | | — | SQL Warehouse ID (from the HTTP Path) |
| `catalog` | | `"main"` | Unity Catalog name |
| `schema` | | `"default"` | Default schema |
| `token` | | — | Personal access token (use `${ENV_VAR}`) |

#### ClickHouse (`clickhouse`)

```json
{
  "defaultConnection": {
    "driver": "clickhouse",
    "host": "play.clickhouse.com",
    "port": 8443,
    "database": "default",
    "username": "play",
    "password": "${CLICKHOUSE_PASSWORD}",
    "ssl": true
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"clickhouse"` |
| `host` | | — | Hostname |
| `port` | | `8443` | HTTP(S) port |
| `database` | | `"default"` | Database name |
| `username` | | — | User |
| `password` | | — | Password (use `${ENV_VAR}`) |
| `ssl` | | `true` | Enable SSL |

**Works with:** ClickHouse Cloud, self-hosted ClickHouse

#### Amazon Athena (`athena`)

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

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"athena"` |
| `region` | | — | AWS region |
| `database` | | — | Athena database (Glue catalog) |
| `outputLocation` | | — | S3 path for query results |
| `workgroup` | | `"primary"` | Athena workgroup |

**Auth:** Uses AWS SDK default credential chain (env vars, `~/.aws/credentials`, IAM role).

#### Trino (`trino`)

```json
{
  "defaultConnection": {
    "driver": "trino",
    "host": "trino.example.com",
    "port": 8080,
    "catalog": "lakehouse",
    "schema": "analytics",
    "username": "analyst",
    "password": "${TRINO_PASSWORD}",
    "ssl": true
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"trino"` |
| `host` | | — | Trino coordinator hostname |
| `port` | | `8080` | Port number |
| `catalog` | | — | Default catalog |
| `schema` | | `"default"` | Default schema |
| `username` | | — | User |
| `password` | | — | Password (if auth is enabled) |
| `ssl` | | `false` | Enable SSL |

**Works with:** Trino, Starburst, Starburst Galaxy

#### Microsoft Fabric (`fabric`)

```json
{
  "defaultConnection": {
    "driver": "fabric",
    "host": "workspace.datawarehouse.fabric.microsoft.com",
    "port": 1433,
    "database": "analytics",
    "username": "user",
    "password": "${FABRIC_PASSWORD}",
    "ssl": true
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `driver` | | — | Must be `"fabric"` |
| `host` | | — | Fabric SQL endpoint |
| `port` | | `1433` | Port number |
| `database` | | — | Lakehouse or warehouse name |
| `username` | | — | Azure AD user or service principal |
| `password` | | — | Password or token (use `${ENV_VAR}`) |
| `ssl` | | `true` | Enable SSL (required for Fabric) |

---

## All Connectors at a Glance

| Driver | `driver` value | Typical use | Auth method |
|---|---|---|---|
| DuckDB In-Memory | `file` | Local CSV/Parquet analysis | None |
| DuckDB File | `duckdb` | Persistent local warehouse | None |
| SQLite | `sqlite` | Lightweight embedded DB | None |
| PostgreSQL | `postgres` | Supabase, RDS, Aurora, Neon | user/password |
| MySQL | `mysql` | MariaDB, PlanetScale, TiDB | user/password |
| SQL Server | `mssql` | Azure SQL, on-prem MSSQL | user/password |
| Snowflake | `snowflake` | Cloud data warehouse | user/password + account |
| BigQuery | `bigquery` | Google Cloud analytics | Service account or ADC |
| Redshift | `redshift` | AWS data warehouse | user/password |
| Databricks | `databricks` | Lakehouse analytics | Personal access token |
| ClickHouse | `clickhouse` | Real-time analytics | user/password |
| Athena | `athena` | S3-based serverless queries | AWS credentials |
| Trino | `trino` | Federated queries, Starburst | user/password |
| Fabric | `fabric` | Microsoft Fabric lakehouse | Azure AD |

---

## Security Best Practices

**Never hardcode secrets.** Use environment variables:

```json
{
  "defaultConnection": {
    "driver": "snowflake",
    "password": "${SNOWFLAKE_PASSWORD}"
  }
}
```

Set the variable before running DQL:

```bash
export SNOWFLAKE_PASSWORD="your-secret"
npx @duckcodeailabs/dql-cli notebook
```

Or use a `.env` file (add to `.gitignore`):

```bash
# .env (never commit this)
SNOWFLAKE_PASSWORD=your-secret
POSTGRES_PASSWORD=your-secret
```

---

## Semantic Layer + Connector Integration

All 14 connectors support the semantic layer. DQL generates **database-specific SQL** for each driver.

### SQL dialect differences (handled automatically)

| Feature | PostgreSQL | BigQuery | MySQL | Snowflake | MSSQL | ClickHouse | SQLite |
|---------|-----------|----------|-------|-----------|-------|------------|--------|
| DATE_TRUNC | `DATE_TRUNC('month', col)` | `DATE_TRUNC(col, MONTH)` | `DATE_FORMAT(col, '%Y-%m-01')` | `DATE_TRUNC('month', col)` | `DATETRUNC(month, col)` | `toStartOfMonth(col)` | `STRFTIME('%Y-%m-01', col)` |
| LIMIT | `LIMIT N` | `LIMIT N` | `LIMIT N` | `LIMIT N` | `OFFSET 0 ROWS FETCH NEXT N ROWS ONLY` | `LIMIT N` | `LIMIT N` |
| Identifier quoting | `"col"` | `` `col` `` | `` `col` `` | `"col"` | `[col]` | `"col"` | `"col"` |

### Semantic Query API

The notebook runtime exposes `POST /api/semantic-query`:

```json
{
  "metrics": ["total_revenue"],
  "dimensions": ["channel"],
  "timeDimension": { "name": "order_date", "granularity": "month" },
  "filters": [{ "dimension": "channel", "operator": "equals", "values": ["web"] }],
  "limit": 100
}
```

Uses `defaultConnection` automatically. Override with a `"connection": { ... }` field if needed.

---

## Test Your Connection

### From the CLI

```bash
dql doctor
```

Look for:
```
  ✓ Default connection    driver=postgres
  ✓ Local query runtime   driver=postgres is available
```

### From the Notebook Connection Panel

1. Launch: `dql notebook`
2. Click the **Connection** icon (plug icon) in the left sidebar
3. You'll see the current connection config and a status indicator
4. Click **Test Connection** to verify
5. See "Connected to postgres successfully" (or your driver)

### Change connections at runtime

The Connection Panel lets you switch databases without restarting:

1. Select a **Quick Connect** preset (DuckDB, PostgreSQL, Snowflake) or fill in fields manually
2. Click **Save** — DQL hot-swaps the connection immediately
3. The Schema sidebar refreshes with the new database's tables
4. All subsequent queries run against the new connection

> You can also edit `dql.config.json` directly and restart `dql notebook`.

---

## Lineage with Remote Databases

All 14 connectors work with DQL's lineage engine. When your blocks query remote tables, lineage automatically tracks the source tables:

```dql
block "Revenue Summary" {
    domain = "finance"
    type   = "custom"
    owner  = "finance-team"
    query  = """
        SELECT segment, SUM(amount) AS revenue
        FROM analytics.public.fct_orders
        GROUP BY segment
    """
}
```

`dql lineage` shows `analytics.public.fct_orders` as a `source_table` node connected to the block. Schema-qualified names are preserved.

Use `ref()` to connect blocks that span different domains or teams:

```dql
block "Exec Dashboard" {
    domain = "executive"
    query  = """
        SELECT * FROM ref("revenue_summary")
    """
}
```

Cross-domain flows (e.g., `finance → executive`) are detected automatically. See the [Lineage Guide](./lineage.md) for the full lineage CLI and API.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `command not found: dql` | CLI not installed | Use `npx @duckcodeailabs/dql-cli` |
| `read_csv_auto(...) file not found` | Wrong path | Use `./data/file.csv` (project-relative) |
| Connection refused | Database not running or wrong host/port | Check `host`, `port`, firewall rules |
| Authentication failed | Wrong credentials | Verify `username`, `password`, env vars |
| SSL required | Cloud database requires SSL | Add `"ssl": true` to config |
| `${ENV_VAR}` not resolved | Environment variable not set | `export ENV_VAR=value` before running |
| DuckDB native module error | Node version changed | Run `pnpm install` to rebuild bindings |
