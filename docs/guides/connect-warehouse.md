# Connect a warehouse

> ~3 minutes · ends with a successful `dql test-connection`

DQL ships 15 drivers out of the box. Connections live in `cdql.yaml` at the
project root — never committed with secrets (use `${ENV_VAR}` interpolation).

## 1. Pick your connector

```yaml
# cdql.yaml
connections:
  default:
    driver: postgres           # one of: postgres, duckdb, snowflake, bigquery,
                               # redshift, mysql, clickhouse, mssql, trino,
                               # databricks, athena, sqlite, motherduck,
                               # starrocks, oracle
    host: ${PGHOST}
    port: 5432
    database: analytics
    user: ${PGUSER}
    password: ${PGPASSWORD}
    schema: public
```

Per-driver options live in the [Connector reference](../reference/connectors.md).

## 2. Export credentials

```bash
export PGHOST=prod-db.internal
export PGUSER=analyst_ro
export PGPASSWORD=…
```

## 3. Verify

```bash
dql test-connection
# ✓ default (postgres) — 14 schemas, 312 tables
```

If that passes, the notebook and CLI will resolve `@table(...)` against
this connection.

## Multiple connections

```yaml
connections:
  default: { driver: duckdb, path: ./warehouse.duckdb }
  prod:    { driver: snowflake, account: ..., ... }
  raw:     { driver: postgres, host: ..., ... }
```

Reference a non-default connection from a cell:

```sql
-- @connection: prod
select count(*) from analytics.orders
```

## Troubleshooting

- **`connection refused`** — firewall / VPN / wrong port. `dql
  test-connection --debug` prints the resolved DSN (redacted).
- **`role does not have USAGE on schema`** — warehouse permissions. DQL
  needs `USAGE` on the schema and `SELECT` on the objects you query.
- **BigQuery service account** — set `GOOGLE_APPLICATION_CREDENTIALS` to the
  key file path; the driver auto-picks it up.
