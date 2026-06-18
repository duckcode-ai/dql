# Connect a Warehouse

> ~3 minutes · ends with `dql doctor` confirming the configured connection

DQL `1.6.15` keeps the CLI install small. Databricks SQL is built in. DuckDB,
local files, and Snowflake are enabled by installing the project-local driver
from the notebook connection panel.

Connections live in `dql.config.json` at the project root. Keep secrets in
environment variables and reference them with `${ENV_VAR}` interpolation.

## 1. Pick your connector

Databricks example:

```json
{
  "connections": {
    "default": {
      "driver": "databricks",
      "host": "${DATABRICKS_HOST}",
      "httpPath": "/sql/1.0/warehouses/${DATABRICKS_WAREHOUSE_ID}",
      "catalog": "main",
      "schema": "analytics",
      "token": "${DATABRICKS_TOKEN}"
    }
  }
}
```

Snowflake example:

```json
{
  "connections": {
    "default": {
      "driver": "snowflake",
      "account": "${SNOWFLAKE_ACCOUNT}",
      "username": "${SNOWFLAKE_USER}",
      "authMethod": "key_pair",
      "privateKeyPath": "${SNOWFLAKE_PRIVATE_KEY_PATH}",
      "warehouse": "ANALYTICS_WH",
      "database": "PROD",
      "schema": "MARTS",
      "role": "ANALYST"
    }
  }
}
```

Per-driver options live in the [Connector reference](../reference/connectors.md).

## 2. Install optional drivers

Open the notebook connection panel and click **Install** for DuckDB or
Snowflake. The driver is installed into the project under `.dql/connectors/`.
Databricks does not need an extra package.

CLI equivalents:

```bash
npm install --prefix .dql/connectors duckdb          # DuckDB and local files
npm install --prefix .dql/connectors snowflake-sdk   # Snowflake
```

## 3. Export credentials

```bash
export DATABRICKS_HOST=adb-123456789.0.azuredatabricks.net
export DATABRICKS_WAREHOUSE_ID=9196548d010cf14d
export DATABRICKS_TOKEN=...
```

or:

```bash
export SNOWFLAKE_ACCOUNT=xy12345.us-east-1
export SNOWFLAKE_USER=svc_dql
export SNOWFLAKE_PRIVATE_KEY_PATH="$HOME/.ssh/snowflake_key.p8"
```

## 4. Verify

```bash
dql doctor
```

If that passes, the notebook and CLI resolve table references against this
connection.

## Multiple connections

```json
{
  "connections": {
    "default": { "driver": "databricks", "host": "${DATABRICKS_HOST}", "token": "${DATABRICKS_TOKEN}" },
    "prod": { "driver": "snowflake", "account": "${SNOWFLAKE_ACCOUNT}" },
    "local": { "driver": "duckdb", "filepath": "./warehouse.duckdb" }
  }
}
```

Reference a non-default connection from a cell:

```sql
-- @connection: prod
select count(*) from analytics.orders
```

## Troubleshooting

- **`driver package is not installed`** — open the notebook connection panel
  and install the project-local driver for DuckDB or Snowflake.
- **`connection refused`** — firewall, VPN, wrong host, or wrong port. Run
  `dql doctor` after checking the resolved environment variables.
- **`role does not have USAGE on schema`** — warehouse permissions. DQL needs
  `USAGE` on the schema and `SELECT` on queried objects.
- **Snowflake key-pair auth** — set `authMethod` to `key_pair` and provide
  `privateKeyPath` or `privateKey`. The public key belongs on the Snowflake
  user, not in DQL config.
- **Databricks HTTP path** — paste the dbt/JDBC path
  `/sql/1.0/warehouses/<id>` or the raw warehouse ID.
