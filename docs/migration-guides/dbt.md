# dbt Metric to Semantic Block

This guide shows how to represent a dbt metric or semantic concept as a DQL semantic block.

## When to use this guide

Use this when you already have:

- a dbt metric
- semantic-layer YAML
- a governed business metric you do not want to re-encode as raw SQL in every block

## Goal

Model the analytics asset as a DQL semantic block that references a metric rather than embedding SQL directly.

## Step 1: Start with the metric name

Suppose the source metric is:

- `annual_recurring_revenue`

## Step 2: Create a semantic block

Create `blocks/arr_growth.dql`:

```dql
block "ARR Growth" {
    domain = "finance"
    type = "semantic"
    description = "Semantic block for annual recurring revenue"
    owner = "finance-analytics"
    tags = ["finance", "arr", "semantic"]
    metric = "annual_recurring_revenue"
}
```

## Step 3: Add semantic-layer metadata

Create a metric definition in `semantic-layer/metrics/annual_recurring_revenue.yaml`:

```yaml
name: annual_recurring_revenue
label: Annual Recurring Revenue
description: Finance-approved recurring revenue metric
domain: finance
sql: SUM(arr_amount)
type: sum
table: finance_arr
owner: finance-analytics
```

## Step 4: Validate the block

```bash
dql parse blocks/arr_growth.dql
dql info blocks/arr_growth.dql
```

## Important rule

For a semantic block:

- keep `type = "semantic"`
- include `metric = "..."`
- do not start by adding a raw SQL `query` field

If your goal is to run local preview quickly, start with a `custom` block first. Semantic blocks are best when your metric contract already exists and you want DQL to reference that contract.

## When not to use a semantic block

Do not use `type = "semantic"` just because a query is important.

Use `type = "custom"` if:

- you want to author the SQL in the block itself
- you want local CSV or DuckDB preview immediately
- you do not yet have a stable metric definition

## CLI helper

You can inspect the scaffold flow with:

```bash
dql migrate dbt --input ./my-dbt-project
```

In the OSS CLI this is still scaffold-only, so treat it as planning support, not full automatic conversion.
