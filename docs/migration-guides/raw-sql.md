# Raw SQL to DQL

This guide shows how to turn an existing SQL query into a reusable DQL block.

## When to use this guide

Use this when you already have:

- an ad hoc SQL query
- a saved SQL file
- a notebook query you want to keep

## Goal

Take a SQL query and wrap it in a DQL block with:

- metadata
- optional parameters
- optional visualization
- basic assertions

## Starting SQL

```sql
SELECT
  segment,
  SUM(amount) AS revenue
FROM fct_revenue
GROUP BY segment
ORDER BY revenue DESC;
```

## Step 1: Create a DQL block

Create `blocks/revenue_by_segment.dql`:

```dql
block "Revenue by Segment" {
    domain = "revenue"
    type = "custom"
    description = "Revenue grouped by customer segment"
    owner = "finance-analytics"
    tags = ["revenue", "segment", "migration"]

    query = """
        SELECT
            segment,
            SUM(amount) AS revenue
        FROM fct_revenue
        GROUP BY segment
        ORDER BY revenue DESC
    """

    visualization {
        chart = "bar"
        x = segment
        y = revenue
    }

    tests {
        assert row_count > 0
    }
}
```

## Step 2: Validate the block

```bash
dql parse blocks/revenue_by_segment.dql
```

## Step 3: Preview it locally

If your query runs against local files or starter data:

```bash
dql preview blocks/revenue_by_segment.dql --open
```

## Step 4: Add parameters if needed

If your original query had date filters, region filters, or environment-specific values, move them into `params`.

Example:

```dql
params {
    period = "current_quarter"
}
```

Then reference them in SQL:

```sql
WHERE fiscal_period = ${period}
```

## Step 5: Add a minimal test

Start with a very small assertion:

```dql
tests {
    assert row_count > 0
}
```

Then expand later with business-specific assertions.

## Good migration candidates

Raw SQL is a strong fit for DQL when the query is:

- reused repeatedly
- shown to business users
- charted in the same way often
- important enough to test and version in Git

## CLI helper

You can generate a starting scaffold with:

```bash
dql migrate raw-sql
```

In the OSS CLI this is scaffold-only, so you still need to paste in the real query and review the block manually.

## Recommended next step

After migration, run:

```bash
dql parse blocks/revenue_by_segment.dql
dql build blocks/revenue_by_segment.dql
```
