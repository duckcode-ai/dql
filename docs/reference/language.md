# DQL language

This page is the canonical OSS language reference for the stable local-first
surface. The formatter emits this style and the parser accepts these examples.

## Block

A block is the reusable analytics unit. Blocks live in `blocks/**/*.dql` and
compile into `dql-manifest.json`.

```dql
// dql-format: 1

block "Revenue by segment" {
  domain = "finance"
  type = "custom"
  status = "draft"
  description = "Gross revenue grouped by customer segment."
  owner = "analytics@company.com"
  tags = ["revenue", "sample"]
  llmContext = "Use this block when people ask for revenue by customer segment."

  query = """
    SELECT
      c.customer_segment AS segment,
      SUM(o.amount) AS revenue
    FROM orders o
    JOIN customers c ON c.customer_id = o.customer_id
    GROUP BY 1
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

Canonical block fields:

| Field | Purpose |
| --- | --- |
| `domain` | Business domain used for cataloging and lineage |
| `type` | `"custom"` for SQL blocks, `"semantic"` for metric-backed blocks |
| `status` | Local trust state: `draft`, `review`, `certified`, `deprecated`, `pending_recertification` |
| `description` | Human-facing summary |
| `owner` | Person or team responsible for the block |
| `tags` | Discovery and filtering labels |
| `llmContext` | Agent-facing natural-language context |
| `businessOutcome` | Outcome this block supports |
| `businessOwner` | Business stakeholder for the metric or decision |
| `decisionUse` | How the block should be used in decisions |
| `reviewCadence` | Expected review interval |
| `query` | SQL for `type = "custom"` blocks |
| `metric` / `metrics` | Metric refs for `type = "semantic"` blocks |
| `visualization` | Chart configuration |
| `tests` | Local certification assertions |

## Certified Block

Certification is a local OSS trust label. A certifiable block has enough
metadata, runs successfully, and passes local test assertions.

```dql
block "Card approval rate" {
  domain = "cards"
  type = "custom"
  status = "certified"
  description = "Card approval rate across the transaction stream."
  owner = "cards-analytics@company.com"
  tags = ["cards", "kpi"]
  llmContext = "Use this KPI when stakeholders ask about card approval rate."

  query = """
    SELECT
      ROUND(100.0 * SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) / COUNT(*), 2) AS approval_rate_pct
    FROM read_csv_auto('./data/transactions.csv')
  """

  visualization {
    chart = "single_value"
  }

  tests {
    assert row_count == 1
  }
}
```

## Semantic Block

Semantic blocks use metric metadata instead of hand-written SQL.

```dql
block "Approval rate by region" {
  domain = "cards"
  type = "semantic"
  status = "draft"
  description = "Approval rate by region from the semantic layer."
  owner = "analytics"
  tags = ["cards", "approval"]

  metric = "approval_rate"

  visualization {
    chart = "single_value"
    y = approval_rate
  }
}
```

## References

Inside `query` strings, DQL recognizes these analytics references:

| Syntax | Resolves to |
| --- | --- |
| `@table("name")` | A semantic table, dbt model, or DQL-local table |
| `@metric("name")` | A semantic metric |
| `@dim("cube.name")` | A semantic dimension |
| `@block("name")` | A certified or draft DQL block |
| `@param("name")` | A notebook parameter value |

## Apps and Manifest

Apps and dashboard pages are JSON artifacts, not `.dql` block fields. App
`lifecycle` belongs in `apps/<app-id>/dql.app.json`; block trust belongs in
`status`.

Run:

```bash
dql compile
```

to generate `dql-manifest.json`, the dbt-like compiled artifact that records
blocks, notebooks, Apps, dashboard pages, metrics, dimensions, sources, dbt
imports, and lineage edges.
