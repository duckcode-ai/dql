# Saved BI Query to DQL Block

This guide shows how to migrate a saved query or card from BI tools such as Metabase, Tableau, or Looker into a reusable DQL block.

## When to use this guide

Use this when you already have:

- a saved BI query
- a chart that business users revisit often
- a card, tile, worksheet, or explore result worth versioning in Git

## Goal

Extract the durable parts of the BI artifact and re-create them in DQL:

- title
- description
- owner
- tags
- SQL query or metric reference
- chart type
- basic tests

## Step 1: Capture the source asset

From the original BI tool, collect:

- the SQL or generated SQL
- chart type
- filters or parameters
- owner/team
- business description

## Step 2: Create a DQL block

Example starting point:

```dql
block "Top Opportunities" {
    domain = "sales"
    type = "custom"
    description = "Migrated from a saved BI query for pipeline review"
    owner = "revops"
    tags = ["sales", "pipeline", "migration"]

    query = """
        SELECT
            account_name,
            stage,
            amount
        FROM opportunities
        ORDER BY amount DESC
        LIMIT 20
    """

    visualization {
        chart = "table"
    }

    tests {
        assert row_count > 0
    }
}
```

## Step 3: Convert filters into params

If the BI artifact used filters, move them into DQL params instead of hard-coding them.

For example:

```dql
params {
    region = "North America"
}
```

Then use that in the SQL query.

## Step 4: Validate and preview

```bash
dql parse blocks/top_opportunities.dql
dql preview blocks/top_opportunities.dql --open
```

## How to choose chart types

Common mappings:

- BI table card → `chart = "table"`
- bar chart → `chart = "bar"`
- trend chart → `chart = "line"`
- headline metric → `chart = "kpi"`

## CLI helper

You can generate scaffolds with:

```bash
dql migrate metabase
dql migrate looker
dql migrate tableau
```

In the OSS CLI these flows are currently scaffold-only, so plan to review and edit the generated block manually.

## Good target assets

Saved BI queries are strong DQL migration candidates when they are:

- repeatedly used in weekly reviews
- copied across dashboards or teams
- business-critical enough to test
- stable enough to deserve Git history and ownership
