# __PROJECT_NAME__

This template packages a city mobility analytics sandbox with taxi trip data. It covers trip volume trends, fare analysis, borough breakdowns, and time-series patterns — a strong starting point for operational and geospatial analytics.

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

## What to explore

- Analyze trip volume and fare trends by borough and time of day
- Compare airport vs. non-airport trip economics
- Build time-series line charts for daily or weekly trip counts

## Next Steps

- [Authoring Blocks](https://github.com/duckcodeailabs/dql/blob/main/docs/authoring-blocks.md) — promote your notebook queries into certified, reusable `.dql` blocks
- [Semantic Layer Guide](https://github.com/duckcodeailabs/dql/blob/main/docs/semantic-layer-guide.md) — define trip-level metrics and borough dimensions in YAML
- [Getting Started](https://github.com/duckcodeailabs/dql/blob/main/docs/getting-started.md) — connect to a cloud database or add DQL to an existing repo
