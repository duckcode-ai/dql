# Finance KPI

Smallest runnable DQL project — a single KPI block over local CSV data.

## Scaffold

```bash
dql init my-project --template finance-kpi
cd my-project
```

## What it demonstrates

- Reusable `custom` block syntax
- Local CSV-backed query execution
- KPI visualization
- Preview, build, and serve flow

## Run it

```bash
dql doctor
dql preview blocks/arr_kpi.dql --open
```

## Build it

```bash
dql build blocks/arr_kpi.dql
dql serve dist/arr_kpi --open
```
