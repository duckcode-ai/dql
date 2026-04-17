# Semantic layer

The semantic layer is DQL's shared business vocabulary. It's a **superset**
of dbt's MetricFlow — DQL imports dbt's semantic models as-is and lets you
extend them with DQL-local definitions.

## Object types

| Object | Purpose | Example |
| --- | --- | --- |
| **Metric** | A measure with aggregation | `sum(orders.amount)` |
| **Dimension** | An attribute to slice by | `customers.segment` |
| **Hierarchy** | An ordered drill path | `year → quarter → month → day` |
| **Cube** | A pre-joined fact+dim set | `orders_by_customer_region` |
| **Segment** | A named boolean filter | `active_customers` |

## YAML shape (DQL-local)

```yaml
# semantic/finance.yaml
metrics:
  - name: revenue
    label: Revenue
    description: Gross revenue
    type: sum
    sql: amount
    table: orders
    domain: finance

dimensions:
  - name: segment
    label: Customer segment
    type: string
    sql: segment
    table: customers

hierarchies:
  - name: time
    levels:
      - { name: year, label: Year }
      - { name: quarter, label: Quarter }
      - { name: month, label: Month }
      - { name: day, label: Day }
```

## dbt import

DQL reads `target/manifest.json` directly — see
[Import a dbt project](../guides/import-dbt.md). Imported metrics and
dimensions appear in the **Semantic** panel alongside DQL-local ones.

## CLI

```bash
dql semantic list                 # list everything
dql semantic validate             # check all refs resolve
dql semantic query 'revenue by segment in 2024'   # NL → SQL preview
dql semantic pull                 # re-sync from dbt
```

## Referencing from cells

```dql
// In a DQL cell
@metric("revenue") by @dim("customer.segment") for 2024
```

The compiler resolves refs, joins the needed tables, and emits SQL for the
target warehouse dialect.
