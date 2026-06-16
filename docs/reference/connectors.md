# Connectors

DQL ships 14 drivers out of the box. Each supports **query execution** and
**schema introspection** (tables, columns, types). Configure connections in
`dql.config.json`.

## Driver matrix

| Driver | Ident | Auth | Notes |
| --- | --- | --- | --- |
| DuckDB | `duckdb` | file path | Default for local dev |
| Local files | `file` | file path | CSV, Parquet, and JSON through DuckDB |
| PostgreSQL | `postgresql` | user/pass, connection string | Also aliases Aurora, Crunchy, etc. |
| MySQL | `mysql` | user/pass | |
| SQLite | `sqlite` | file path | |
| Snowflake | `snowflake` | password, key pair, external browser SSO, OAuth | |
| BigQuery | `bigquery` | ADC, service account key file, service account JSON | |
| Redshift | `redshift` | user/pass | |
| ClickHouse | `clickhouse` | user/pass | |
| Databricks | `databricks` | PAT | |
| Trino | `trino` | user | |
| Athena | `athena` | AWS default chain, AWS profile, access key/session token | |
| MSSQL | `mssql` | user/pass | |
| Microsoft Fabric | `fabric` | user/pass | SQL endpoint over TDS |

## Common options

```json
{
  "connections": {
    "default": {
      "driver": "postgresql",
      "host": "prod-db.internal",
      "port": 5432,
      "database": "analytics",
      "username": "${PGUSER}",
      "password": "${PGPASSWORD}",
      "schema": "public",
      "ssl": true
    }
  }
}
```

## Per-driver specifics

### DuckDB

```json
{ "driver": "duckdb", "filepath": "./warehouse.duckdb" }
```

### BigQuery

Use Application Default Credentials:

```json
{
  "driver": "bigquery",
  "projectId": "my-gcp-project",
  "location": "US",
  "authMethod": "application_default"
}
```

Or provide a managed key file path:

```json
{
  "driver": "bigquery",
  "projectId": "my-gcp-project",
  "location": "US",
  "authMethod": "service_account_key_file",
  "keyFilename": "${BIGQUERY_KEY_FILE}"
}
```

`GOOGLE_APPLICATION_CREDENTIALS` is still picked up automatically when explicit
key material is omitted.

### Snowflake

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "password",
  "password": "${SNOWFLAKE_PASSWORD}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "role": "ANALYST"
}
```

For key-pair auth:

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
  "role": "ANALYST"
}
```

Use either `privateKeyPath` or `privateKey`. `privateKey` is useful when the key
comes from an environment variable or secret manager:

```json
{
  "driver": "snowflake",
  "account": "xy12345.us-east-1",
  "username": "${SNOWFLAKE_USER}",
  "authMethod": "key_pair",
  "privateKey": "${SNOWFLAKE_PRIVATE_KEY}",
  "privateKeyPassphrase": "${SNOWFLAKE_PRIVATE_KEY_PASSPHRASE}",
  "warehouse": "ANALYTICS_WH",
  "database": "PROD",
  "role": "ANALYST"
}
```

For dbt `profiles.yml`, DQL imports Snowflake `private_key_path`,
`private_key`, `private_key_passphrase`, and `authenticator: SNOWFLAKE_JWT`.
The public key is configured on the Snowflake user; DQL only needs the private
key material or file path.

### Athena

Use the local AWS provider chain, including SSO sessions and environment
credentials:

```json
{
  "driver": "athena",
  "region": "us-east-1",
  "database": "analytics",
  "outputLocation": "s3://my-query-results/athena/",
  "workgroup": "primary",
  "authMethod": "aws_default"
}
```

Or bind a named profile:

```json
{
  "driver": "athena",
  "region": "us-east-1",
  "database": "analytics",
  "outputLocation": "s3://my-query-results/athena/",
  "authMethod": "aws_profile",
  "profile": "prod-analytics"
}
```

For the full per-driver option list, see each connector's README under
[`packages/dql-connectors/src/`](https://github.com/duckcode-ai/dql/tree/main/packages/dql-connectors/src).
