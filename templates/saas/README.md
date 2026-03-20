# __PROJECT_NAME__

This template packages a SaaS KPI sandbox focused on MRR, retention, and expansion.

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
