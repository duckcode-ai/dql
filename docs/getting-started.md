# Getting Started with DQL

DQL is the **answer layer** on top of dbt. dbt transforms your data — DQL turns it into trusted, governed analytics answers with SQL blocks, notebooks, lineage, and a semantic layer.

This guide walks you through setting up DQL with the **Jaffle Shop** dbt project — the same dataset used in dbt's official Semantic Layer course.

---

## Prerequisites

- **Python 3.9+** (for dbt)
- **Node.js 18+** (for DQL)
- **Git**

---

## Step 1: Clone the Jaffle Shop dbt Project

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
```

This is dbt Labs' official Semantic Layer course project. It includes:
- Staging and mart models (customers, orders, order items, products, supplies)
- Semantic model definitions (metrics, dimensions, entities)
- A MetricFlow time spine

---

## Step 2: Install dbt with DuckDB

```bash
pip install dbt-duckdb
```

Create a `profiles.yml` in the project root so dbt uses a local DuckDB file:

```bash
cat > profiles.yml << 'EOF'
jaffle_shop:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: ./jaffle_shop.duckdb
      schema: main
      threads: 4
EOF
```

---

## Step 3: Run dbt

```bash
dbt deps                          # install dbt packages (dbt_utils, dbt_date)
dbt build --profiles-dir .        # seed, build models, run tests — all into DuckDB
```

After this completes, you have a `jaffle_shop.duckdb` file with the full data model:

| Table | Description |
|---|---|
| `dim_customers` | Customer dimension with lifetime spend, order counts, type (new/returning) |
| `fct_orders` | Fact table with order totals, tax, supply costs, item counts |
| `order_items` | Order line items with product prices and supply costs |
| `stg_customers` | Staging: cleaned customer records |
| `stg_orders` | Staging: cleaned orders with dollar conversion |
| `stg_order_items` | Staging: cleaned order items |
| `stg_products` | Staging: products with food/drink flags |
| `stg_supplies` | Staging: supplies with perishability flags |

---

## Step 4: Install DQL

```bash
npm install -g @duckcodeailabs/dql-cli
```

---

## Step 5: Initialize DQL in the Project

```bash
dql init .
```

DQL auto-detects the dbt project and creates:
- `dql.config.json` — points to `jaffle_shop.duckdb`, uses the `dbt` semantic layer provider
- `blocks/` — directory for your DQL analytics blocks
- `notebooks/welcome.dqlnb` — a starter notebook with queries against the mart tables

---

## Step 6: Verify Setup

```bash
dql doctor
```

This checks that `dql.config.json` exists, the DuckDB connection works, and the semantic layer loads.

---

## Step 7: Open the Notebook

```bash
dql notebook
```

This opens a browser-based notebook connected to your Jaffle Shop DuckDB database. The welcome notebook includes:
- `SHOW TABLES` — see all tables built by dbt
- Customer overview query against `dim_customers`
- A DQL block querying `fct_orders` with chart visualization
- Product analysis against `order_items`

---

## Step 8: Import dbt Lineage

```bash
dql compile --dbt-manifest target/manifest.json
```

This imports dbt's lineage graph as upstream context into DQL's manifest. Now run:

```bash
dql lineage
```

You'll see the full data flow from dbt's source tables through staging, marts, and into your DQL blocks — the complete answer-layer lineage.

---

## Step 9: Create Your Own Blocks

Create a file `blocks/top_customers.dql`:

```dql
block "Top Customers" {
    domain      = "finance"
    type        = "custom"
    owner       = "data-team"
    description = "Top 10 customers by lifetime spend"

    query = """
        SELECT
            customer_name,
            customer_type,
            count_lifetime_orders AS orders,
            lifetime_spend AS total_spend
        FROM dim_customers
        ORDER BY lifetime_spend DESC
        LIMIT 10
    """

    visualization {
        chart = "bar"
        x     = customer_name
        y     = total_spend
    }

    tests {
        assert row_count > 0
    }
}
```

Preview it:

```bash
dql preview blocks/top_customers.dql --open
```

---

## Step 10: Build and Serve

```bash
dql build blocks/top_customers.dql
dql serve
```

This compiles the block to a standalone HTML dashboard and serves it locally.

---

## What You Have Now

| Layer | Tool | What it does |
|---|---|---|
| **Transformation** | dbt | raw → staging → mart tables |
| **Answer** | DQL | mart tables → governed blocks → notebooks → charts |

DQL picks up where dbt stops. Every analytics answer is a `.dql` file with SQL + visualization + owner + tests — all Git-trackable.

---

## Next Steps

- [Notebook Guide](./notebook.md) — cell types, param widgets, variable refs, export
- [Authoring Blocks](./authoring-blocks.md) — create, test, certify, and commit DQL blocks
- [Semantic Layer](./semantic-layer-guide.md) — metrics, dimensions, dbt/Cube.js providers
- [Lineage](./lineage.md) — ref() system, trust chains, impact analysis
- [CLI Reference](./cli-reference.md) — all commands and flags
