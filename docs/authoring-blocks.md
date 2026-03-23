# Authoring Blocks

A DQL block is a single `.dql` file that contains everything needed to produce a trusted, reusable analytics answer: SQL or semantic reference, visualization config, ownership metadata, parameters, and tests — all in one place, all Git-trackable.

This guide walks through the full lifecycle: **create → validate → preview → certify → commit**.

---

## What Is a DQL Block?

```
blocks/revenue_by_segment.dql
  └── block "Revenue by Segment"
        ├── metadata   (domain, owner, description, tags)
        ├── params     (runtime variables with defaults)
        ├── query      (SQL or semantic reference)
        ├── visualization (chart type, axes)
        └── tests      (assertions that run on query results)
```

Blocks are the unit of governance in DQL. When a block is certified and committed, your team can trust that it has an owner, a description, tags for discoverability, and at least one test that protects against silent data failures.

---

## Two Block Types

### `type = "custom"` — You own the SQL

Use this when you have complex joins, window functions, or logic that doesn't fit a standard metric definition. You write the SQL directly in the block.

```dql
block "Funnel Drop-off" {
    type  = "custom"
    owner = "growth-team"
    query = """
        SELECT stage, COUNT(*) AS users, LAG(COUNT(*)) OVER (ORDER BY stage_order) AS prev
        FROM funnel_events GROUP BY stage, stage_order ORDER BY stage_order
    """
}
```

### `type = "semantic"` — References your semantic layer

Use this when the answer already exists as a metric in your semantic layer (DQL YAML, dbt, or Cube.js). No SQL duplication — the block references a named metric and dimensions, and DQL composes the query at runtime.

```dql
block "ARR by Plan Tier" {
    type   = "semantic"
    metric = "arr"
    dimensions = ["plan_tier"]
    owner  = "finance-team"
}
```

**When to use which:**
- If the metric already exists in your semantic layer → use `semantic`
- If you need custom joins, CTEs, or logic the semantic layer doesn't express → use `custom`

---

## Tutorial: Create a Custom Block

### Step 1 — Scaffold the file

```bash
dql new block "Revenue by Segment"
# Creates: blocks/revenue_by_segment.dql
```

Open `blocks/revenue_by_segment.dql`. It contains a scaffold you'll fill in:

```dql
block "Revenue by Segment" {
    domain      = ""
    type        = "custom"
    owner       = ""
    description = ""
    tags        = []

    params {
    }

    query = """
    """

    visualization {
        chart = "table"
    }

    tests {
    }
}
```

### Step 2 — Fill in the fields

```dql
block "Revenue by Segment" {
    domain      = "revenue"
    type        = "custom"
    owner       = "data-team"
    description = "GMV and order count broken out by customer segment and region, filterable by fiscal period"
    tags        = ["revenue", "segment", "region", "quarterly"]

    params {
        period = "current_quarter"
    }

    query = """
        SELECT
            segment_tier AS segment,
            region,
            SUM(amount)  AS revenue,
            COUNT(*)     AS orders
        FROM fct_revenue
        WHERE fiscal_period = ${period}
        GROUP BY segment_tier, region
        ORDER BY revenue DESC
    """

    visualization {
        chart = "bar"
        x     = segment
        y     = revenue
    }

    tests {
        assert row_count > 0
        assert revenue > 0
    }
}
```

**Field reference:**

| Field | Required | Description |
|---|---|---|
| `domain` | Yes (for certify) | Business domain — e.g. `"revenue"`, `"product"`, `"ops"` |
| `type` | No (defaults to `"custom"`) | `"custom"` or `"semantic"` |
| `owner` | Yes (for certify) | Team or person responsible — e.g. `"data-team"` |
| `description` | Yes (for certify) | What this block measures and how to use it |
| `tags` | Yes (for certify) | Search/filter labels |
| `params` | No | Key-value defaults for `${variable}` substitution in the query |
| `query` | Yes | SQL string (for `type = "custom"`) |
| `visualization` | No | Chart config — `chart`, `x`, `y`, `color`, `label` |
| `tests` | No | Assertions evaluated after query runs |

### Step 3 — Validate syntax

```bash
dql parse blocks/revenue_by_segment.dql
```

Expected output:

```
  Parsing blocks/revenue_by_segment.dql
  ✓ Syntax valid
  ✓ Semantic analysis passed
  ✓ Visualization config valid
  ✓ Test assertions parseable
  1 block parsed successfully
```

Fix any errors reported before proceeding.

### Step 4 — Preview with live data

```bash
dql preview blocks/revenue_by_segment.dql --open
```

This compiles the block, runs the query against your configured data source, and opens a browser tab showing the live chart. Change the `period` param in the UI to test the param substitution.

### Step 5 — Run tests

```bash
dql certify blocks/revenue_by_segment.dql
```

`dql certify` runs the query, evaluates your test assertions, and checks all governance fields. Example output:

```
  Certifying blocks/revenue_by_segment.dql

  Governance checks:
  ✓ domain       "revenue"
  ✓ owner        "data-team"
  ✓ description  present (67 chars)
  ✓ tags         ["revenue", "segment", "region", "quarterly"]

  Test assertions:
  ✓ row_count > 0   (result: 12 rows)
  ✓ revenue > 0     (result: min=4200, max=182000)

  ✓ Block certified
```

### Step 6 — Format and commit

```bash
dql fmt blocks/revenue_by_segment.dql
git add blocks/revenue_by_segment.dql
git commit -m "feat: add revenue by segment block"
```

`dql fmt` normalizes whitespace and indentation in place — safe to run before every commit.

---

## Tutorial: Create a Semantic Block

### Prerequisites

Your project must have a semantic layer configured — either DQL YAML files, a dbt project with `semantic_models`, or a Cube.js project. See [Getting Started](./getting-started.md) Tutorials 2–4 for setup.

### Step 1 — Discover the right metric

Open the notebook:

```bash
dql notebook
```

In the **Semantic Layer** sidebar panel:
1. Expand **Compose Query**
2. Browse available metrics (e.g., `arr`, `mrr`, `churn_rate`)
3. Check the metric and one or more dimensions
4. Click **Compose SQL** to see the generated query
5. Click **+ Insert as Cell** to run it and confirm the results look right

Note the exact metric name shown — you'll use it in the block.

### Step 2 — Scaffold the block

```bash
dql new block "ARR by Plan Tier"
# Creates: blocks/arr_by_plan_tier.dql
```

### Step 3 — Write the semantic block

```dql
block "ARR by Plan Tier" {
    domain      = "revenue"
    type        = "semantic"
    owner       = "finance-team"
    description = "Annual Recurring Revenue broken out by subscription plan tier"
    tags        = ["arr", "revenue", "saas", "plan-tier"]

    metric     = "arr"
    dimensions = ["plan_tier"]

    params {
        period = "current_year"
    }

    visualization {
        chart = "bar"
        x     = plan_tier
        y     = arr
    }

    tests {
        assert row_count > 0
        assert arr > 0
    }
}
```

**Semantic block fields:**

| Field | Description |
|---|---|
| `type = "semantic"` | Tells DQL to resolve `metric` from the semantic layer, not run raw SQL |
| `metric` | The metric name as defined in your semantic layer |
| `dimensions` | List of dimension names to group by |
| `params` | Optional — passed to the semantic layer's query composition |

### Step 4 — Validate and preview

```bash
dql parse blocks/arr_by_plan_tier.dql
dql preview blocks/arr_by_plan_tier.dql --open
```

DQL resolves the `arr` metric from your semantic layer, composes the SQL, and runs it. You'll see the chart in the browser.

### Step 5 — Certify and commit

```bash
dql certify blocks/arr_by_plan_tier.dql
dql fmt blocks/arr_by_plan_tier.dql
git add blocks/arr_by_plan_tier.dql
git commit -m "feat: add ARR by plan tier semantic block"
```

---

## Using Blocks in the Notebook

There are three ways to work with semantic metrics and blocks in a notebook.

### Pattern 1 — Reference semantic metrics inline in a SQL cell

In any SQL cell, use `@metric(name)` and `@dim(name)` inline refs. DQL resolves these at execution time — `@metric(name)` expands to the metric's aggregation expression aliased as the metric name, and `@dim(name)` expands to the dimension column. GROUP BY is cleaned up automatically.

```sql
SELECT @dim(segment), @metric(total_revenue)
FROM fct_revenue
GROUP BY @dim(segment)
ORDER BY @metric(total_revenue) DESC
```

This is the recommended pattern for exploratory queries that reference your semantic layer without duplicating metric definitions.

### Pattern 2 — Write a DQL block inline in a notebook DQL cell

Add a cell with type `dql` and write the block body directly inside the cell. This is for ad-hoc governed queries inside the notebook without a separate `.dql` file.

```dql
block "Revenue by Segment" {
    type   = "semantic"
    metric = "total_revenue"
    dimensions = ["segment"]
    owner  = "data-team"
}
```

### Pattern 3 — Use Compose Query to insert a SQL cell (recommended)

The canonical workflow for semantic metrics is:

1. Open the **Semantic Layer** sidebar panel
2. Expand **Compose Query**
3. Pick metrics and dimensions (and optionally a time dimension + granularity)
4. Click **Compose SQL** — DQL generates dialect-correct SQL with the right aggregations and joins
5. Click **+ Insert as Cell** — the SQL cell appears in the notebook, ready to run

This gives you the generated SQL as a starting point that you can edit before running.

---

## Block Governance

### What `dql certify` checks

`dql certify` enforces these requirements before a block is considered production-ready:

| Check | Rule |
|---|---|
| `domain` | Must be a non-empty string |
| `owner` | Must be a non-empty string |
| `description` | Must be present and at least 20 characters |
| `tags` | Must have at least one tag |
| Tests | All `assert` statements must pass against live data |

### Making tests meaningful

Write assertions that would catch real data problems:

```dql
tests {
    assert row_count > 0           -- data exists
    assert revenue > 0             -- no negative or zero revenue totals
    assert row_count < 10000       -- guard against runaway queries
}
```

### Suggested governance workflow

1. Author the block (`dql new block`)
2. Validate syntax (`dql parse`)
3. Preview with live data (`dql preview --open`)
4. Run certify locally (`dql certify`)
5. Format (`dql fmt`)
6. Commit to git — PR review ensures a second set of eyes on ownership and test coverage
7. Merge to main — block is now the single source of truth for that metric

---

## Block File Conventions

| Convention | Why |
|---|---|
| One block per `.dql` file | Keeps history clean, makes review easy |
| File name matches block name (snake_case) | Easy to find by name |
| `blocks/` directory at project root | DQL CLI discovers blocks here by default |
| Always include at least one `assert` | Prevents silent empty-result failures |
| Use `${variable}` for anything date/filter related | Makes blocks reusable across time periods |

---

## Next Steps

- [Semantic Layer Guide](./semantic-layer-guide.md) — define your own metrics and dimensions in YAML
- [Notebook Guide](./notebook.md) — full reference for cells, params, variable substitution, and export
- [Language Spec](./dql-language-spec.md) — full `.dql` syntax reference: all chart types, param types, test operators
- [CLI Reference](./cli-reference.md) — `dql certify`, `dql fmt`, `dql build`, and all other commands
