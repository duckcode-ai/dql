# DuckDB Local

Local-first analytics using the `duckdb` driver — no warehouse credentials needed.

## Scaffold

```bash
dql init my-project --template duckdb-local
cd my-project
```

## What it demonstrates

- DuckDB as the default connection
- Local CSV-backed analytics with DuckDB execution
- Line chart preview and static export

## Run it

```bash
dql doctor
dql preview blocks/orders_by_region.dql --open
```

## Build it

```bash
dql build blocks/orders_by_region.dql
dql serve dist/orders_by_region --open
```
