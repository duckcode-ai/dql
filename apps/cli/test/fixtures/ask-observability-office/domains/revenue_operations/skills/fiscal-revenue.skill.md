---
id: fiscal_revenue_reporting
domain: revenue_operations
kind: metric_policy
status: active
owner: revenue-operations@fixture.test
description: Synthetic fiscal revenue reporting policy for observability fixtures.
triggers:
  - lost opportunity
  - revenue
  - bcm
  - fiscal year
preferred_metrics:
  - semantic:lost_opportunities:lost_opportunity_count
  - semantic:lost_opportunities:lost_amount
  - semantic:account_revenue:revenue
  - semantic:account_revenue:bcm_run_rate
preferred_dimensions:
  - semantic:lost_opportunities:fiscal_period
  - semantic:lost_opportunities:competitor_name
  - semantic:account_revenue:account_name
analytical_policy:
  time_role: opportunity_close_date
  calendar_id: calendar:synthetic_fiscal
  timezone: America/Chicago
  completeness_policy: latest_complete
  comparison_alignment: fiscal_period
  default_ranking_period: current
  narrative_guidance:
    - State the fiscal period when it is requested.
    - Keep Revenue as the ranking measure when Revenue is explicitly named.
---

Use the declared fiscal close-date role for monthly fiscal questions. Do not use
the competitor-observation relationship for ranking because it is not certified
for attribution.
