---
id: revenue_reporting
domain: commerce
kind: metric_policy
status: active
owner: commerce@company.test
description: Govern current-period and comparative reporting for the Commerce gross-revenue metric.
triggers:
  - revenue
  - gross revenue
  - current revenue
  - last year revenue
preferred_metrics:
  - semantic:orders:gross_revenue
preferred_dimensions:
  - semantic:uncategorized:dimension:report_date
  - semantic:uncategorized:dimension:customer_name
analytical_policy:
  metric_ids:
    - semantic:orders:gross_revenue
  time_role: report_as_of
  calendar_id: calendar:gregorian
  timezone: America/Chicago
  completeness_policy: latest_complete
  comparison_alignment: elapsed_period
  default_ranking_period: current
  narrative_guidance:
    - State the covered reporting period
    - Explain the largest governed driver when a breakdown is requested
---

Use the published gross-revenue metric and its declared reporting date. Apply
customer dimensions only through the governed customer entity relationship.
