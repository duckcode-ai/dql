# __PROJECT_NAME__

This template packages a SaaS KPI sandbox focused on MRR, retention, and expansion. It covers recurring revenue tracking, churn pressure analysis, cohort retention, and semantic metrics for subscription businesses.

## Included assets

- `blocks/revenue_by_segment.dql` — MRR by plan tier
- `blocks/churn_pressure.dql` — at-risk and churned revenue view
- `dashboards/growth_scorecard.dql` — executive SaaS KPI dashboard
- `data/subscriptions.csv` — recurring revenue and expansion sample data
- `data/cohorts.csv` — cohort retention snapshot
- `notebooks/welcome.dqlnb` — browser notebook walkthrough

## Quick start

```bash
dql doctor
dql notebook
dql preview blocks/revenue_by_segment.dql --open
```

## What to explore

- Track MRR growth and expansion by plan tier
- Identify at-risk accounts by churn pressure signals
- Analyze cohort retention curves over rolling periods

## Next Steps

- [Authoring Blocks](https://github.com/duckcodeailabs/dql/blob/main/docs/authoring-blocks.md) — promote your notebook queries into certified, reusable `.dql` blocks
- [Semantic Layer Guide](https://github.com/duckcodeailabs/dql/blob/main/docs/semantic-layer-guide.md) — extend the included semantic layer with MRR and churn metrics
- [Getting Started](https://github.com/duckcodeailabs/dql/blob/main/docs/getting-started.md) — connect to a cloud database or add DQL to an existing repo
