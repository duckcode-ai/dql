# __PROJECT_NAME__

This template packages a city mobility analytics sandbox with taxi trip data.

## Included assets

- `blocks/revenue_by_segment.dql` — trip volume by pickup borough
- `blocks/airport_mix.dql` — airport trip fare mix
- `dashboards/city_operations.dql` — operations dashboard with fares and trip counts
- `data/trips.csv` — local taxi trip sample dataset
- `notebooks/welcome.dqlnb` — browser notebook walkthrough

## Quick start

```bash
dql doctor
dql notebook
dql preview blocks/revenue_by_segment.dql --open
```
