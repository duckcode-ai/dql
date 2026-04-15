# Getting Started with DQL + Jaffle Shop

DQL is the **answer layer** on top of dbt. dbt transforms your data — DQL turns it into trusted, governed analytics answers with SQL blocks, notebooks, lineage, and a semantic layer.

This guide walks you through setting up DQL with the **Jaffle Shop** dbt project used in dbt's official Semantic Layer course.

> **Looking for the non-dbt path?** Run `dql init my-project && cd my-project && dql notebook` — see the [Quickstart](./quickstart.md).
>
> **Have your own dbt repo + database?** See [Enterprise Getting Started](./enterprise-getting-started.md).

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

We use this repo because it already includes dbt semantic models and metrics that DQL can import. It contains:
- Staging and mart models (customers, orders, order items, products, supplies)
- Semantic model definitions (metrics, dimensions, entities)
- A MetricFlow time spine

> **Important:** `dql init` does not download this repo. You must clone it yourself.

---

## Step 2: Install dbt and Build the Project

```bash
pip install dbt-duckdb
dbt deps                          # install dbt packages (dbt_utils, dbt_date)
dbt build --profiles-dir .        # seed, build models, run tests — all into DuckDB
```

The repo includes a `profiles.yml` that configures DuckDB as the target. After `dbt build` completes, you have a `jaffle_shop.duckdb` file with the full data model:

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

## Step 3: Install DQL

```bash
npm install -g @duckcodeailabs/dql-cli
dql --version    # verify install (should print 0.8.6 or later)
```

---

## Step 4: Initialize DQL in the Project

```bash
dql init .
```

DQL auto-detects everything in one step:

1. **dbt project** — finds `dbt_project.yml`, sets `semanticLayer.provider` to `dbt`
2. **DuckDB file** — finds `jaffle_shop.duckdb`, configures it as the default connection
3. **Semantic definitions** — scans `models/` for YAML files with `semantic_models:` or `metrics:`, auto-imports them into `semantic-layer/`

Created files:
- `dql.config.json` — project config pointing to `jaffle_shop.duckdb`
- `blocks/` — directory for your DQL analytics blocks
- `notebooks/welcome.dqlnb` — a starter notebook with DuckDB-aware SQL

> **Note:** If you see `dql semantic import dbt .` in older tutorials, you can skip it — `dql init` now handles this automatically when semantic definitions are detected.

---

## Step 5: Verify Setup

```bash
dql doctor
```

You should see all checks passing:

```
  DQL Doctor
    Project: /path/to/jaffle-shop

  ✓ Node.js                version=22.x.x (requires >= 18)
  ✓ Project root            /path/to/jaffle-shop
  ✓ dql.config.json         found
  ✓ blocks/                 found
  ✓ semantic-layer/         found
  ✓ Default connection      driver=duckdb
  ✓ Notebook app assets     found
  ✓ Semantic layer          provider=dbt, N metrics, N dimensions
  ✓ Local query runtime     driver=duckdb is available

  Summary: 9/9 checks passed
```

If any check fails, follow the hints. Common issues:
- `duckdb dependency` — run `npm install` in the project to get the native DuckDB module
- `Notebook app assets missing` — reinstall the CLI: `npm i -g @duckcodeailabs/dql-cli`

---

## Step 6: Open the Notebook

```bash
dql notebook
```

Your browser opens at `http://127.0.0.1:3474` with the welcome notebook connected to Jaffle Shop.

### What you see:

**Welcome notebook** with runnable SQL cells:
- `SHOW TABLES;` — lists all tables built by dbt
- A starter query to explore your data
- An example DQL block with governance metadata

**Left sidebar** has four panels:
1. **Files** — browse notebooks and blocks in your project
2. **Schema** — database tables and columns, click to expand. Columns show color-coded type badges (blue for strings, green for numbers, pink for booleans, gold for dates).
3. **Semantic** — imported dbt metrics and dimensions. Click any metric to see its SQL, type, table, and tags.
4. **Connection** — current database connection status and configuration

### Try it:

1. Click **Run** on the `SHOW TABLES;` cell — you'll see all the Jaffle Shop tables
2. Add a new SQL cell and query the data:
   ```sql
   SELECT customer_name, customer_type, lifetime_spend
   FROM dim_customers
   ORDER BY lifetime_spend DESC
   LIMIT 10
   ```
3. Click **Run** — results appear in a table. Toggle to **Chart** view for automatic visualization.

---

## Step 7: Build a Block in Block Studio

Block Studio is the notebook's built-in IDE for creating governed DQL blocks.

### Open Block Studio

Click the **Block Studio** icon in the sidebar (or click `+ New Block` in the Files panel).

### Write your first block

The editor opens with a blank DQL file. You have three panels:

**Left: Database Explorer**
- Expand `dim_customers` to see all columns (`customer_name`, `lifetime_spend`, etc.)
- Click a column name to insert it into your SQL
- Click a table name to insert the full table reference

**Left: Semantic Panel** (tab)
- Browse imported metrics (`total_revenue`, `order_count`, etc.)
- Click a metric to insert `{{ metric:total_revenue }}` into your SQL
- Browse dimensions and hierarchies

**Center: SQL Editor**

Write a block:

```sql
SELECT
    customer_name,
    customer_type,
    count_lifetime_orders AS orders,
    lifetime_spend AS total_spend
FROM dim_customers
ORDER BY lifetime_spend DESC
LIMIT 10
```

### Run, test, save

1. **Run** (Ctrl/Cmd+Enter) — executes the SQL against `jaffle_shop.duckdb`. Results appear below in a table, with a Chart toggle for visualization.

2. **Test** — if your block has test assertions like `assert row_count > 0`, click Test to run them. Each assertion shows pass/fail.

3. **Save** — click Save. Since this is a new block, a dialog asks for:
   - **Name** — e.g., "Top Customers"
   - **Domain** — e.g., "finance"
   - **Owner** — e.g., "data-team"
   - **Description** — e.g., "Top 10 customers by lifetime spend"

   The block is saved to `blocks/finance/top_customers.dql` — a Git-trackable file with SQL + governance metadata.

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

```bash
dql lineage --domain finance           # blocks in the finance domain
dql lineage --impact dim_customers     # what breaks if this table changes?
dql lineage --trust-chain top_customers  # certification at every hop
```

---

## Step 9: Create More Blocks

Create blocks that reference each other using `ref()`:

```dql
block "Revenue by Segment" {
    domain      = "finance"
    type        = "custom"
    owner       = "data-team"
    description = "Revenue breakdown by customer segment"

    query = """
        SELECT
            customer_type AS segment,
            COUNT(*) AS customers,
            SUM(lifetime_spend) AS total_revenue
        FROM dim_customers
        GROUP BY customer_type
        ORDER BY total_revenue DESC
    """

    visualization {
        chart = "bar"
        x     = segment
        y     = total_revenue
    }

    tests {
        assert row_count > 0
    }
}
```

Then reference it from another block:

```dql
block "Executive Summary" {
    domain = "executive"
    type   = "custom"
    owner  = "leadership"
    query  = """
        SELECT * FROM ref("revenue_by_segment")
        WHERE total_revenue > 1000
    """
}
```

Run `dql lineage` to see cross-domain flows (`finance -> executive`).

---

## What You Have Now

| Layer | Tool | What it does |
|---|---|---|
| **Transformation** | dbt | raw → staging → mart tables in DuckDB |
| **Semantic** | DQL | metrics + dimensions imported from dbt, browsable in notebook |
| **Answer** | DQL | mart tables → governed blocks → notebooks → charts |
| **Lineage** | DQL | full trust chain from dbt sources through blocks |

DQL picks up where dbt stops. Every analytics answer is a `.dql` file with SQL + visualization + owner + tests — all Git-trackable.

---

## Next Steps

| Goal | Guide |
|------|-------|
| Connect your own database (Snowflake, Postgres, etc.) | [Enterprise Getting Started](./enterprise-getting-started.md) |
| Learn notebook features (params, charts, export) | [Notebook Guide](./notebook.md) |
| Block syntax deep dive | [Language Spec](./dql-language-spec.md) |
| Import metrics from Cube.js or Snowflake | [Semantic Layer Guide](./semantic-layer-guide.md) |
| All 14 database connectors | [Data Sources](./data-sources.md) |
| CLI commands and flags | [CLI Reference](./cli-reference.md) |
