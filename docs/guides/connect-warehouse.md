# Connect a Warehouse

> ~3 minutes · ends with `dql doctor` confirming the configured connection

DQL ships 14 drivers out of the box. Connections live in `dql.config.json` at
the project root. Keep secrets in environment variables and reference them with
`${ENV_VAR}` interpolation.

## 1. Pick your connector

```json
{
  "connections": {
    "default": {
      "driver": "postgresql",
      "host": "${PGHOST}",
      "port": 5432,
      "database": "analytics",
      "username": "${PGUSER}",
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
dql doctor
# Local query runtime
# driver=postgresql is available
```

If that passes, the notebook and CLI resolve table references against this
connection.

## Multiple connections

```json
{
  "connections": {
    "default": { "driver": "duckdb", "filepath": "./warehouse.duckdb" },
    "prod": { "driver": "snowflake", "account": "${SNOWFLAKE_ACCOUNT}" },
    "raw": { "driver": "postgresql", "host": "${RAW_PGHOST}" }
  }
}
```

Reference a non-default connection from a cell:

```sql
-- @connection: prod
select count(*) from analytics.orders
```

## Troubleshooting

- **`connection refused`** — firewall, VPN, wrong host, or wrong port. Run `dql doctor` after checking the resolved environment variables.
- **`role does not have USAGE on schema`** — warehouse permissions. DQL needs `USAGE` on the schema and `SELECT` on queried objects.
- **BigQuery service account** — set `GOOGLE_APPLICATION_CREDENTIALS`, or configure `keyFilename` / `serviceAccountJson` when your enterprise setup requires an explicit key file.
- **Snowflake key-pair auth** — set `authMethod` to `key_pair` and provide `privateKeyPath` or `privateKey`.
- **Athena enterprise auth** — use the AWS default provider chain for SSO, or set `profile`, `accessKeyId`, `secretAccessKey`, and optional `sessionToken`.
