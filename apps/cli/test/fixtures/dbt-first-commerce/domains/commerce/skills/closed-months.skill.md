---
id: closed_months
domain: commerce
kind: metric_policy
status: active
owner: commerce@company.test
description: Commerce trend reporting leaves the running month out.
triggers:
  - monthly trend
  - by month
analytical_policy:
  completeness_policy: latest_complete
  comparison_alignment: calendar_period
---

A monthly trend shows complete months only; the running month is left out and said so.
