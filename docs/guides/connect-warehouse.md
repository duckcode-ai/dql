# Connect a warehouse

> ~3 minutes · ends with a successful `dql test-connection`

DQL ships 15 drivers out of the box. Connections live in `dql.config.json` at
the project root. Keep secrets in environment variables and reference them with
`${ENV_VAR}` interpolation.

## 1. Pick your connector

```json
{
  "connections": {
    "default": {
      "driver": "postgres",
      "host": "${PGHOST}",
      "port": 5432,
      "database": "analytics",
      "user": "${PGUSER}",
      "password": "${PGPASSWORD}",
      "schema": "public"
    }
  }
}
```

Per-driver options live in the [Connector reference](../reference/connectors.md).

## 2. Export credentials

```bash
export PGHOST=prod-db.internal
export PGUSER=analyst_ro
export PGPASSWORD=...
```

## 3. Verify

```bash
dql test-connection
# ✓ default (postgres) — 14 schemas, 312 tables
```

If that passes, the notebook and CLI resolve table references against this
connection.

## Multiple connections

```json
{
  "connections": {
    "default": { "driver": "duckdb", "path": "./warehouse.duckdb" },
    "prod": { "driver": "snowflake", "account": "${SNOWFLAKE_ACCOUNT}" },
    "raw": { "driver": "postgres", "host": "${RAW_PGHOST}" }
  }
}
```

Reference a non-default connection from a cell:

```sql
-- @connection: prod
select count(*) from analytics.orders
```

## Troubleshooting

- **`connection refused`** — firewall, VPN, wrong host, or wrong port. `dql test-connection --debug` prints the resolved DSN with secrets redacted.
- **`role does not have USAGE on schema`** — warehouse permissions. DQL needs `USAGE` on the schema and `SELECT` on queried objects.
- **BigQuery service account** — set `GOOGLE_APPLICATION_CREDENTIALS` to the key file path; the driver auto-picks it up.
