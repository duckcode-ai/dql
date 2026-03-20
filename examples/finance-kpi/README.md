# Finance KPI Example

This example shows the smallest useful local DQL project for a KPI-style block.

## What it demonstrates

- reusable `custom` block syntax
- local CSV-backed query execution
- KPI visualization
- local preview, build, and serve flow

## Run it

```bash
cd dql/examples/finance-kpi
dql doctor
dql preview blocks/arr_kpi.dql --open
```

## Build it

```bash
dql build blocks/arr_kpi.dql
dql serve dist/arr_kpi --open
```
