---
id: acquisition_analysis
domain: growth
kind: analysis
status: active
owner: growth@company.test
description: Analyze certified acquisition performance without changing governed metric meaning.
triggers:
  - acquisition channel
  - campaign performance
exclusions:
  - fulfillment operations
preferred_metrics:
  - gross_revenue
preferred_blocks:
  - Revenue by Acquisition Channel
preferred_dimensions:
  - acquisition_channel
required_filters:
  - reporting period
clarify_when:
  - no reporting period is supplied
vocabulary:
  paid growth: acquisition channel
source_refs:
  - growth::relationship::acquisition_to_customer
---

Use the certified commerce-to-growth route. Compare acquisition channels at the
declared grain and retain the reporting-period filter in every result.
