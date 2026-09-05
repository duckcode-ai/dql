---
id: sql-conventions
kind: sql_policy
status: active
owner: analytics@jaffle.shop
description: Project-wide SQL rules for dbt-backed DQL answers.
triggers: [sql, query, analysis, revenue, customer]
---
# SQL conventions

- Prefer a certified block when it answers the requested metric, grain, filters,
  ranking, and output columns.
- Use only dbt-built `dev` relations in this local DuckDB example.
- State the grain before aggregating. Count distinct order IDs when a query
  starts from order items.
- Generate read-only `SELECT` or `WITH` queries only.
