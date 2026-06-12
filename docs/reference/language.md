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
  dimensions = ["region"]

  visualization {
    chart = "bar"
    x = region
    y = approval_rate
  }
}
```

Use `metric = "name"` for one metric, or `metrics = ["metric_a", "metric_b"]`
for a multi-metric semantic block. `dimensions = [...]` groups the semantic
query by one or more semantic dimensions.

## Business Term

A `term` defines business vocabulary in DQL core. It does not require SQL.
Blocks and business views reference terms with `terms = [...]` so lineage can
connect business meaning to implementation and consumption.

```dql
term "Customer" {
  domain = "Customer"
  type = "entity"
  status = "draft"
  description = "A person or account that can place orders or receive service."
  owner = "customer-analytics"
  tags = ["customer", "glossary"]
  identifiers = ["customer_id"]
  synonyms = ["Account"]
  businessOwner = "Customer Success"
  businessRules = ["One row per customer_id"]
  caveats = ["Merged accounts may appear under a surviving customer_id."]
}
```

Attach terms to a block:

```dql
block "Customer Orders Rollup" {
  domain = "Customer"
  type = "custom"
  terms = ["Customer", "Lifetime Revenue", "Total Orders"]

  query = """
    SELECT customer_id, COUNT(*) AS total_orders, SUM(amount) AS lifetime_revenue
    FROM fct_orders
    GROUP BY 1
  """
}
```

## Business View

A `business_view` composes trusted blocks and other business views into a
git-versioned business lineage artifact. It does not run SQL itself. Use it to
model business capabilities such as Customer 360, Customer Health Review, or
Revenue Operations Review.

```dql
business_view "Customer 360" {
  domain = "Customer"
  status = "draft"
  description = "Complete customer view for retention and account review."
  owner = "customer-analytics"
  tags = ["customer", "360", "retention"]
  terms = ["Customer", "Customer Health"]
  businessOutcome = "Understand customer value, activity, and service risk."
  decisionUse = "Account planning, churn review, and expansion targeting."
  reviewCadence = "weekly"

  includes {
    block "Customer Identity"
    block "Customer Orders Rollup"
    business_view "Customer Service Summary"
  }
}
```

Canonical business-view fields:

| Field | Purpose |
| --- | --- |
| `domain` | Business domain used for cataloging and lineage |
| `status` | Local trust state: `draft`, `review`, `certified`, `deprecated`, `pending_recertification` |
| `description` | Human-facing summary |
| `owner` | Person or team responsible for the business view |
| `tags` | Discovery and filtering labels |
| `terms` | Business term references represented by this view |
| `businessOutcome` | Outcome this view supports |
| `businessOwner` | Business stakeholder for the decision |
| `decisionUse` | How the view should be used in decisions |
| `reviewCadence` | Expected review interval |
| `businessRules` | Business rules the view encodes |
| `caveats` | Known limitations or interpretation notes |
| `includes` | `block` and `business_view` references composed into this view |

Compile validates term refs and included refs. It reports unresolved terms,
unresolved blocks, unresolved business views, and business-view cycles as
manifest diagnostics.

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

Apps and dashboard pages are JSON artifacts, not `.dql` block fields. Business
views are `.dql` composition artifacts that sit between blocks and consumption
surfaces. App `lifecycle` belongs in `apps/<app-id>/dql.app.json`; block and
business-view trust belongs in `status`.

Run:

```bash
dql compile
```

to generate `dql-manifest.json`, the dbt-like compiled artifact that records
blocks, business views, notebooks, Apps, dashboard pages, metrics, dimensions,
sources, dbt imports, and lineage edges.
