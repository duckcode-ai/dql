---
id: fiscal_reporting
domain: finance
kind: metric_policy
status: active
owner: finance@company.test
description: Finance reports on the fiscal calendar and never counts test invoices.
triggers:
  - invoiced revenue
  - billed revenue
  - fiscal
required_filters:
  - is_test = false
vocabulary:
  revenue: term:Revenue
analytical_policy:
  time_role: invoice_date
  calendar_id: calendar:fiscal_feb
  comparison_alignment: fiscal_period
  completeness_policy: closed_period
---

Report invoiced revenue on the fiscal calendar (February start). Exclude test invoices.
