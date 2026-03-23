# __PROJECT_NAME__

This template packages a realistic e-commerce analytics sandbox for DQL. It covers channel revenue analysis, repeat purchase behavior, funnel analysis, and semantic metrics — a complete starting point for commerce analytics.

## Included assets

- `blocks/revenue_by_segment.dql` — channel revenue block
- `blocks/repeat_rate.dql` — repeat purchase mix block
- `dashboards/revenue_command_center.dql` — KPI + bar + table dashboard
- `data/orders.csv` — orders with channel, region, and repeat purchase flags
- `data/funnel.csv` — acquisition and checkout funnel snapshot
- `data/customers.csv` — customer dimension data
- `notebooks/welcome.dqlnb` — browser notebook walkthrough

## Quick start

```bash
dql doctor
dql notebook
dql preview blocks/revenue_by_segment.dql --open
```

## What to explore

- Compare performance across paid, partner, organic, and lifecycle channels
- Track repeat order contribution by region and segment
- Use the notebook to iterate on funnel SQL before promoting it into reusable blocks

## Next Steps

- [Authoring Blocks](https://github.com/duckcodeailabs/dql/blob/main/docs/authoring-blocks.md) — promote your notebook queries into certified, reusable `.dql` blocks
- [Semantic Layer Guide](https://github.com/duckcodeailabs/dql/blob/main/docs/semantic-layer-guide.md) — extend the included semantic layer with your own metrics and dimensions
- [Getting Started](https://github.com/duckcodeailabs/dql/blob/main/docs/getting-started.md) — connect to a cloud database or add DQL to an existing repo
