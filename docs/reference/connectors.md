# Connectors

DQL ships 15 drivers out of the box. Each supports **query execution** and
**schema introspection** (tables, columns, types). Configure connections in
`cdql.yaml`.

## Driver matrix

| Driver | Ident | Auth | Notes |
| --- | --- | --- | --- |
| DuckDB | `duckdb` | file path | Default for local dev |
| MotherDuck | `motherduck` | token | Cloud DuckDB |
| Postgres | `postgres` | user/pass | Also aliases Aurora, Crunchy, etc. |
| MySQL | `mysql` | user/pass | |
| SQLite | `sqlite` | file path | |
| Snowflake | `snowflake` | user/pass, keypair | |
| BigQuery | `bigquery` | service account | `GOOGLE_APPLICATION_CREDENTIALS` |
| Redshift | `redshift` | user/pass | |
| ClickHouse | `clickhouse` | user/pass | |
| Databricks | `databricks` | PAT | |
| Trino | `trino` | user | |
| Athena | `athena` | AWS | |
| MSSQL | `mssql` | user/pass | |
| StarRocks | `starrocks` | user/pass | |
| Oracle | `oracle` | user/pass | |

## Common options

```yaml
connections:
  default:
    driver: postgres
    host: prod-db.internal
    port: 5432
    database: analytics
    user: ${PGUSER}
    password: ${PGPASSWORD}
    schema: public
    ssl: true             # optional; most drivers honor it
    pool:
      max: 10
      idleTimeoutMs: 30000
```

## Per-driver specifics

### DuckDB

```yaml
driver: duckdb
path: ./warehouse.duckdb    # or :memory:
```

### BigQuery

```yaml
driver: bigquery
projectId: my-gcp-project
location: US
# GOOGLE_APPLICATION_CREDENTIALS env var is read automatically
```

### Snowflake

```yaml
driver: snowflake
account: xy12345.us-east-1
user: ${SNOWFLAKE_USER}
password: ${SNOWFLAKE_PASSWORD}
warehouse: ANALYTICS_WH
database: PROD
role: ANALYST
```

For the full per-driver option list, see each connector's README under
[`packages/dql-connectors/src/`](https://github.com/duckcode-ai/dql/tree/main/packages/dql-connectors/src).
