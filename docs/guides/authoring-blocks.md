# Author a certified block

> ~6 minutes · ends with a certified block linked from a notebook

A **block** is a named, versioned analytics artifact with SQL or semantic
intent, a chart spec, tests, lineage, and governance metadata. Blocks are the
unit of reuse in DQL and the thing reviewers actually review.

## 1. Open Block Studio

From the notebook UI, click **Blocks** in the left rail. Block Studio starts
with four paths:

- **Create SQL Block from dbt Model**
- **Create Semantic Block from dbt Metric**
- **Import SQL**
- **Ask AI to Generate Block**

Use the CLI when you want a file scaffold:

```bash
dql new block revenue_by_segment --domain finance
```

Block Studio keeps SQL blocks and semantic blocks separate so metric references
do not get mixed into raw SQL unless you explicitly choose the advanced path.

## 2. Pick the right block type

| Block type | Use when | Primary inputs |
| --- | --- | --- |
| SQL Block | You need explicit SQL against dbt models or warehouse tables | SQL, detected tables, parameters |
| Semantic Block | You want a dbt/DQL metric plus dimensions and grain | metric, dimensions, time dimension, filters |

## 3. Write the SQL

```sql
select
  segment,
  sum(amount) as revenue,
  count(distinct customer_id) as customers
from @table("orders")
group by 1
order by revenue desc
```

`@table("orders")` resolves via the semantic layer (dbt or DQL-local). The
editor shows lint warnings from `dql-governance` as you type.

For a semantic block, pick a metric and dimensions instead of editing a raw
`SELECT` statement.

## 4. Fill in governance

| Field | Example | Why it matters |
| --- | --- | --- |
| `domain` | `finance` | Lineage cross-domain detection |
| `owner` | `analytics@company.com` | Who answers questions |
| `tags` | `revenue`, `certified` | Discovery & filtering |
| `description` | "Revenue by customer segment…" | Shows in hover cards |
| `tests` | `row_count > 0` | Blocks the certify step if failing |

## 5. Preview

**⌘↵** runs the query. Results render inline; the chart spec auto-picks bar
for categorical-x/numeric-y. Override in the visualization panel.

## 6. Certify

Click **Run Certification** and then **Certify** after the checklist passes.
DQL:

- runs tests (`tests:` block)
- validates required metadata
- verifies the block can run
- validates chart config and lineage
- keeps AI-generated changes in review until approved

The certified tag appears in the block library; downstream notebooks see
the new version on next open.

## 7. Use it in a notebook

```dql
-- Notebook cell
@block("revenue_by_segment")
```

DQL inlines the compiled SQL, runs it, and renders the block's chart spec.

## Verify it worked

- Block appears in the **Block Library** sidebar with a green "certified" badge
- `git log -- blocks/finance/revenue_by_segment.dql` shows a clean commit
- Notebook cell referencing the block renders a bar chart with your data
