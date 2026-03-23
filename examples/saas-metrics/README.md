# SaaS Metrics

SaaS KPI analytics using DQL — 31 accounts across 3 plan tiers with MRR, expansion, churn risk, and cohort retention analysis plus full semantic layer.

## Run it

```bash
cd dql/examples/saas-metrics
dql doctor
dql notebook
```

## What you'll learn

- MRR breakdown by plan tier and owner segment
- Expansion revenue tracking and growth analysis
- At-risk revenue identification by risk bucket
- Cohort retention trends (account and MRR retention)
- Semantic layer metrics for ad-hoc SaaS queries

## Blocks

- `blocks/revenue_by_segment.dql` — MRR by plan tier
- `blocks/risk_analysis.dql` — At-risk and churned revenue by risk bucket
- `blocks/cohort_retention.dql` — Monthly cohort retention trend
- `blocks/expansion_by_segment.dql` — Expansion MRR by owner segment

## Semantic Layer

- **Metrics:** mrr, expansion_mrr, account_count, avg_mrr
- **Dimensions:** plan_tier, status, owner_segment, risk_bucket

## Data

- `data/subscriptions.csv` — 31 SaaS accounts with MRR, expansion, and risk data
- `data/cohorts.csv` — 12-month cohort retention with MRR retention
