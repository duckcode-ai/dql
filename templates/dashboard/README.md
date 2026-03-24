# Dashboard

Multi-chart dashboard over local CSV data — KPI, bar, and table charts in one file.

## Scaffold

```bash
dql init my-project --template dashboard
cd my-project
```

## What it demonstrates

- Dashboard syntax
- KPI, bar, and table charts in one file
- Local file-based preview without warehouse credentials

## Run it

```bash
dql doctor
dql preview dashboards/pipeline_overview.dql --open
```

## Build it

```bash
dql build dashboards/pipeline_overview.dql
dql serve dist/pipeline_overview --open
```
