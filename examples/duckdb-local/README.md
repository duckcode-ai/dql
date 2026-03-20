# DuckDB Local Example

This example shows the same local-first preview flow using the `duckdb` driver in `dql.config.json`.

## What it demonstrates

- DuckDB as the default connection
- local CSV-backed analytics with a DuckDB execution path
- line chart preview and static export

## Run it

```bash
cd dql/examples/duckdb-local
dql doctor
dql preview blocks/orders_by_region.dql --open
```

## Build it

```bash
dql build blocks/orders_by_region.dql
dql serve dist/orders_by_region --open
```
