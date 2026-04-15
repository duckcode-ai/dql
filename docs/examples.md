# Examples

Three paths to get started — pick the one that fits your setup.

| Path | Time | What you need |
|------|------|---------------|
| [DQL-only](#dql-only) | 2 min | Node.js 18+ |
| [dbt + Jaffle Shop](#dbt--jaffle-shop) | 5 min | Node.js 18+, Python 3.9+, Git |
| [Enterprise (your own database)](#enterprise) | 10 min | Node.js 18+, database credentials |

---

## DQL-Only

No dbt, no database — just DQL + DuckDB in-memory.

```bash
npm install -g @duckcodeailabs/dql-cli
dql init my-project
cd my-project
dql doctor
dql notebook
```

Put CSV or Parquet files in a `data/` directory, then query them:

```sql
SELECT * FROM read_csv_auto('./data/orders.csv') LIMIT 10;
```

---

## dbt + Jaffle Shop

Full walkthrough with semantic metrics, lineage, and Block Studio.

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
pip install dbt-duckdb && dbt deps && dbt build --profiles-dir .
npm install -g @duckcodeailabs/dql-cli
dql init .
dql doctor
dql notebook
```

`dql init .` auto-detects the dbt project, finds `jaffle_shop.duckdb`, and imports semantic metrics — all in one step.

→ **[Full Jaffle Shop walkthrough](./getting-started.md)**

---

## Enterprise

Your own dbt repo + production database (Snowflake, Postgres, BigQuery, etc.).

```bash
cd your-dbt-project
npm install -g @duckcodeailabs/dql-cli
dql init .
dql notebook
# → Configure your database in the Connection Panel
# → Import semantic metrics from the notebook UI
# → Build blocks in Block Studio
```

→ **[Full enterprise walkthrough](./enterprise-getting-started.md)**

---

## Suggested Learning Path

### 1. Start with the notebook

```bash
dql notebook
```

Run the welcome notebook cells. Browse the Schema sidebar to see your tables. Browse the Semantic sidebar to see imported metrics.

### 2. Build a block in Block Studio

Open Block Studio from the sidebar. Use the Database Explorer to browse tables and the Semantic Panel to browse metrics. Write SQL, run it, test it, and save it.

Example block:

```sql
SELECT
    customer_name,
    customer_type,
    lifetime_spend
FROM dim_customers
ORDER BY lifetime_spend DESC
LIMIT 10
```

### 3. Parse and validate from the CLI

```bash
dql parse blocks/top_customers.dql --verbose
dql validate
```

### 4. Preview and build

```bash
dql preview blocks/top_customers.dql --open
dql build blocks/top_customers.dql
dql serve dist/top_customers --open
```

### 5. View lineage

```bash
dql compile --dbt-manifest target/manifest.json
dql lineage
dql lineage --domain finance
```

Or click the **Lineage** icon in the notebook sidebar.

### 6. Add block dependencies with ref()

Create a second block that references the first:

```dql
block "Top Segments" {
    domain = "executive"
    type   = "custom"
    owner  = "leadership"
    query  = """
        SELECT * FROM ref("top_customers")
        WHERE lifetime_spend > 100
    """
}
```

Run `dql lineage` to see the dependency graph and cross-domain flows.

### 7. Explore the semantic layer

Browse metrics and dimensions in the notebook sidebar. Click to insert references into SQL:

```sql
SELECT
    {{ dimension:customer_type }} AS segment,
    {{ metric:total_revenue }} AS revenue
FROM fct_orders
GROUP BY segment
```

---

## Block Examples

### Simple query block

```dql
block "Active Customers" {
    domain      = "growth"
    type        = "custom"
    owner       = "growth-team"
    description = "Customers who placed an order in the last 30 days"

    query = """
        SELECT customer_name, MAX(order_date) AS last_order
        FROM fct_orders
        JOIN dim_customers USING (customer_id)
        WHERE order_date >= CURRENT_DATE - INTERVAL 30 DAY
        GROUP BY customer_name
        ORDER BY last_order DESC
    """

    tests {
        assert row_count > 0
    }
}
```

### Parameterized block

```dql
block "Revenue by Period" {
    domain = "finance"
    type   = "custom"
    owner  = "finance-team"

    params {
        start_date = "2024-01-01"
        end_date   = "2024-12-31"
    }

    query = """
        SELECT DATE_TRUNC('month', order_date) AS month, SUM(amount) AS revenue
        FROM fct_orders
        WHERE order_date BETWEEN '${start_date}' AND '${end_date}'
        GROUP BY month
        ORDER BY month
    """

    visualization {
        chart = "line"
        x     = month
        y     = revenue
    }

    tests {
        assert row_count > 0
        assert revenue > 0
    }
}
```

### Block with ref() dependency

```dql
block "Executive Summary" {
    domain = "executive"
    type   = "custom"
    owner  = "leadership"

    query = """
        SELECT *
        FROM ref("revenue_by_period")
        WHERE revenue > 10000
    """
}
```

---

## Related Docs

- [Getting Started (Jaffle Shop)](./getting-started.md)
- [Enterprise Getting Started](./enterprise-getting-started.md)
- [Quickstart](./quickstart.md)
- [Notebook Guide](./notebook.md)
- [Authoring Blocks](./authoring-blocks.md)
- [Lineage & Trust Chains](./lineage.md)
- [Semantic Layer Guide](./semantic-layer-guide.md)
- [Data Sources](./data-sources.md)
- [Language Specification](./dql-language-spec.md)
