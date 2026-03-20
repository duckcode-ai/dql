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
