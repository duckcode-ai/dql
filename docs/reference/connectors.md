# Connectors

DQL `1.6.16` uses a flat install. The CLI installs quickly and does not bundle
every database driver. Configure connections in `dql.config.json` or through
the notebook connection panel.

## Active connectors

| Connector | Driver | Install model | Notes |
| --- | --- | --- | --- |
| Databricks SQL | `databricks` | Built in | Uses the Databricks Statement Execution API over HTTPS |
| DuckDB | `duckdb` | Project-local install | Install from the notebook connection panel when needed |
| Local files | `file` | Project-local DuckDB install | CSV, Parquet, and JSON through DuckDB |
| Snowflake | `snowflake` | Project-local install | Supports password, key pair, SSO, OAuth, PAT, MFA, and workload identity fields |

Other warehouse connectors are planned/legacy code paths, but they are not
active in the lightweight `1.6.16` package.

## Project-local driver install

Open the notebook connection panel and use **Install** for DuckDB or Snowflake.
DQL installs the driver into:

```text
.dql/connectors/
```

CLI equivalents:

```bash
npm install --prefix .dql/connectors duckdb          # DuckDB and local files
npm install --prefix .dql/connectors snowflake-sdk   # Snowflake
```

This keeps the global CLI install small while still letting each project opt
into the database packages it actually uses.

## Common shape

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

Environment variables are resolved at runtime, so keep secrets out of git.

## Databricks SQL

Use either a warehouse ID or the dbt/JDBC HTTP path. DQL extracts the warehouse
ID from paths like `/sql/1.0/warehouses/<id>`.

```json
{
  "driver": "databricks",
  "host": "adb-123456789.0.azuredatabricks.net",
  "httpPath": "/sql/1.0/warehouses/9196548d010cf14d",
  "catalog": "main",
  "schema": "marts",
  "authMethod": "oauth",
  "token": "${DATABRICKS_TOKEN}",
  "waitTimeout": "50s",
  "byteLimit": 25000000
}
```

For automation, prefer an enterprise-approved OAuth token or service principal
token rather than a personal token.

## DuckDB and local files

```json
{
  "driver": "duckdb",
  "filepath": "./warehouse.duckdb"
}
```

For CSV/Parquet/JSON exploration, use the `file` driver with DuckDB installed:

```json
{
  "driver": "file",
  "filepath": ":memory:"
}
```

Then query files from SQL:

```sql
select * from read_csv_auto('./data/orders.csv')
```

## Snowflake

Password auth:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "password",
  "password": "${SNOWFLAKE_PASSWORD}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "role": "ANALYST"
}
```

Key-pair auth:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "key_pair",
  "privateKeyPath": "${SNOWFLAKE_PRIVATE_KEY_PATH}",
  "privateKeyPassphrase": "${SNOWFLAKE_PRIVATE_KEY_PASSPHRASE}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "role": "ANALYST"
}
```

Use either `privateKeyPath` or `privateKey`. The public key is configured on
the Snowflake user; DQL only needs the private key material or file path.

Enterprise auth fields are passed through to the Snowflake Node driver:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "programmatic_access_token",
  "token": "${SNOWFLAKE_PAT}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "schema": "MARTS",
  "queryTag": "team=analytics;app=dql",
  "proxyHost": "${HTTPS_PROXY_HOST}",
  "proxyPort": 8080
}
```

Supported `authMethod` values include `password`, `mfa`, `key_pair`,
`external_browser`, `oauth`, `oauth_authorization_code`,
`oauth_client_credentials`, `programmatic_access_token`, and
`workload_identity`.

For dbt `profiles.yml`, DQL imports Snowflake `private_key_path`,
`private_key`, `private_key_passphrase`, `authenticator`, `token`, proxy
fields, OAuth fields, workload identity fields, and query tags where present.
