# Dashboard Local Example

This example shows a dashboard with multiple chart calls over local CSV data.

## What it demonstrates

- dashboard syntax
- KPI, bar, and table charts in one file
- local file-based preview without warehouse credentials

## Run it

```bash
cd dql/examples/dashboard-local
dql doctor
dql preview dashboards/pipeline_overview.dql --open
```

## Build it

```bash
dql build dashboards/pipeline_overview.dql
dql serve dist/pipeline_overview --open
```
