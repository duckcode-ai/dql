# Getting Started

## Prerequisites

- **Node.js 18+** (LTS 18, 20, or 22 recommended)
- No database required — DQL runs locally with DuckDB out of the box

---

## Install

```bash
npx @duckcodeailabs/dql-cli --help
```

Or install globally:

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

---

## Choose Your Path

| You are... | Start here |
|---|---|
| Brand new, want to explore DQL | [Tutorial 1: Sample Data](#tutorial-1-start-with-sample-data) |
| Have an existing dbt project | [Tutorial 2: Existing dbt Project](#tutorial-2-existing-dbt-project) |
| Have an existing Cube.js project | [Tutorial 3: Existing Cube.js Project](#tutorial-3-existing-cubejs-project) |
| Connecting to a cloud warehouse | [Tutorial 4: Cloud Database](#tutorial-4-connect-to-a-cloud-database) |
| Adding DQL to your existing repo | [Tutorial 5: Own Repo (no template)](#tutorial-5-add-dql-to-your-own-repo) |

---

## Tutorial 1: Start with Sample Data

**Time:** 3 minutes. No database needed.

### Step 1 — Scaffold a project

```bash
npx @duckcodeailabs/dql-cli init my-analytics --template ecommerce
cd my-analytics
```

This creates a complete project with:
- `data/orders.csv` — 50 sample ecommerce orders
- `semantic-layer/` — 5 metrics (GMV, order count, avg order value, etc.) and 4 dimensions
- `blocks/` — pre-built DQL analysis blocks
- `notebooks/welcome.dqlnb` — interactive welcome notebook

Other templates: `--template saas`, `--template taxi`, `--template starter`

### Step 2 — Verify the project

```bash
npx @duckcodeailabs/dql-cli doctor
```

Expected output:

```
  DQL Doctor
  ✓ Node.js                 version=22.x (requires >= 18)
  ✓ Project root             found
  ✓ dql.config.json          found
  ✓ blocks/                  found
  ✓ semantic-layer/          found
  ✓ data/                    found
  ✓ Default connection       driver=file
  ✓ Semantic layer           provider=configured, 5 metrics, 4 dimensions
  ✓ Local query runtime      driver=file is available
  Summary: 10/10 checks passed
```

### Step 3 — Open the notebook

```bash
npx @duckcodeailabs/dql-cli notebook
```

Your browser opens to `http://127.0.0.1:3474`. You'll see:
- **Left sidebar** — Files, Schema, Semantic Layer, Outline, Connection panels
- **Cell area** — the welcome notebook with guided examples

### Step 4 — Run a SQL cell

Click **+ SQL** to add a cell. Type:

```sql
SELECT segment, SUM(order_total) AS revenue, COUNT(*) AS orders
FROM read_csv_auto('./data/orders.csv')
GROUP BY segment
ORDER BY revenue DESC
```

Press **Shift+Enter** to run. Results appear as a table. Click the chart icon to see a bar chart.

### Step 5 — Use the Semantic Layer

Click the **Semantic Layer** icon in the left sidebar (the diamond icon). You'll see:
- **Metrics:** GMV, Order Count, Avg Order Value, Gross Margin %, Repeat Rate
- **Dimensions:** Segment, Region, Channel, Order Date

**Compose a query without writing SQL:**

1. Expand **Compose Query**
2. Check **GMV** and **Order Count** metrics
3. Check **Region** dimension
4. Click **Compose SQL**
5. Click **+ Insert as Cell** — a new SQL cell appears with the generated query
6. Press **Shift+Enter** to run it

### Step 6 — Mix semantic + custom SQL

You can use both approaches in the same notebook:

```sql
-- Cell 1: semantic-generated (inserted from Compose Query)
SELECT region, SUM(order_total) AS gmv, COUNT(*) AS order_count
FROM read_csv_auto('./data/orders.csv')
GROUP BY region ORDER BY gmv DESC
```

```sql
-- Cell 2: your own custom SQL referencing the same data
SELECT
    segment,
    channel,
    AVG(order_total) AS avg_order,
    COUNT(CASE WHEN is_repeat = true THEN 1 END) AS repeat_orders
FROM read_csv_auto('./data/orders.csv')
GROUP BY segment, channel
ORDER BY avg_order DESC
```

Both work side by side. The semantic layer helps you discover what metrics exist; custom SQL lets you go deeper.

### Step 7 — List semantic definitions from CLI

```bash
npx @duckcodeailabs/dql-cli semantic list
```

Output:

```
  Semantic Layer (configured)
  Metrics (5):
    • gmv           [sum]   Gross Merchandise Value
    • order_count   [count] Order Count
    • avg_order_value [avg] Average Order Value
    ...
  Dimensions (4):
    • segment  [string]  Segment
    • region   [string]  Region
    ...
```

### Step 8 — From notebook to a committed block file

Once you've found a query worth keeping, promote it to a reusable `.dql` block:

**1. Create a block file:**

```bash
npx @duckcodeailabs/dql-cli new block "Revenue by Segment"
# Creates blocks/revenue_by_segment.dql
```

**2. Open the file and fill in the block:**

```dql
block "Revenue by Segment" {
    domain      = "revenue"
    type        = "custom"
    owner       = "data-team"
    description = "GMV and order count broken out by customer segment"
    tags        = ["revenue", "segment"]

    query = """
        SELECT segment, SUM(order_total) AS revenue, COUNT(*) AS orders
        FROM read_csv_auto('./data/orders.csv')
        GROUP BY segment
        ORDER BY revenue DESC
    """

    visualization {
        chart = "bar"
        x     = segment
        y     = revenue
    }

    tests {
        assert row_count > 0
    }
}
```

**3. Validate and preview:**

```bash
npx @duckcodeailabs/dql-cli parse blocks/revenue_by_segment.dql
npx @duckcodeailabs/dql-cli preview blocks/revenue_by_segment.dql --open
```

**4. Certify and commit:**

```bash
npx @duckcodeailabs/dql-cli certify blocks/revenue_by_segment.dql
git add blocks/revenue_by_segment.dql
git commit -m "feat: add revenue by segment block"
```

→ **[Full block authoring guide — custom blocks, semantic blocks, tests, certify](./authoring-blocks.md)**

---

## Tutorial 2: Existing dbt Project

**Time:** 5 minutes. Requires a dbt project with `semantic_models` (dbt 1.6+).

### Step 1 — Create a DQL project in your dbt repo

```bash
cd ~/code/my-dbt-project
npx @duckcodeailabs/dql-cli init . --template starter
```

This adds `dql.config.json`, `blocks/`, and `notebooks/` without overwriting your existing files.

### Step 2 — Configure the semantic layer

Edit `dql.config.json`:

```json
{
  "project": "my-dbt-project",
  "defaultConnection": {
    "driver": "snowflake",
    "account": "your-account.snowflakecomputing.com",
    "username": "your_user",
    "password": "${SNOWFLAKE_PASSWORD}",
    "database": "ANALYTICS",
    "schema": "PUBLIC",
    "warehouse": "COMPUTE_WH",
    "role": "ANALYST"
  },
  "semanticLayer": {
    "provider": "dbt",
    "projectPath": "."
  }
}
```

**Key:** `"provider": "dbt"` tells DQL to scan your `models/**/*.yml` for `semantic_models` and `metrics` blocks.

**Using environment variables:** Wrap secrets in `${VAR_NAME}` — DQL resolves them from your shell environment at runtime.

### Step 3 — Verify DQL sees your dbt metrics

```bash
npx @duckcodeailabs/dql-cli doctor
npx @duckcodeailabs/dql-cli semantic list
```

You should see your dbt metrics and dimensions listed.

### Step 4 — Open the notebook and query

```bash
npx @duckcodeailabs/dql-cli notebook
```

In the notebook:
1. The **Semantic Panel** shows your dbt metrics and dimensions
2. Use **Compose Query** to generate SQL from your dbt semantic models
3. Click **+ Insert as Cell** to add it to the notebook
4. Press **Shift+Enter** — the query runs against your Snowflake (or other) database

### Step 5 — Write custom SQL alongside dbt metrics

You can write any SQL that your database supports:

```sql
-- Custom SQL against your Snowflake tables
SELECT
    c.customer_segment,
    SUM(o.amount) AS revenue,
    COUNT(DISTINCT o.customer_id) AS customers
FROM analytics.public.fct_orders o
JOIN analytics.public.dim_customers c ON o.customer_id = c.id
WHERE o.order_date >= '2024-01-01'
GROUP BY 1
ORDER BY revenue DESC
```

The notebook runs both semantic-composed and custom SQL queries against the same database connection.

### What your dbt YAML should look like

```yaml
# models/staging/_schema.yml
semantic_models:
  - name: orders
    model: ref('stg_orders')
    defaults:
      agg_time_dimension: order_date
    entities:
      - name: customer
        type: foreign
        expr: customer_id
    dimensions:
      - name: status
        type: categorical
      - name: order_date
        type: time
        type_params:
          time_granularity: day
    measures:
      - name: total_revenue
        agg: sum
        expr: amount
      - name: order_count
        agg: count
        expr: id

metrics:
  - name: revenue
    label: Total Revenue
    type: simple
    type_params:
      measure: total_revenue
```

### dbt aggregation type mapping

| dbt `agg` | DQL `type` |
|-----------|------------|
| `sum` | `sum` |
| `count` | `count` |
| `count_distinct` | `count_distinct` |
| `average` / `avg` | `avg` |
| `min` | `min` |
| `max` | `max` |

---

## Tutorial 3: Existing Cube.js Project

**Time:** 5 minutes. Requires a Cube.js project with YAML cube definitions.

### Step 1 — Create a DQL project in your Cube repo

```bash
cd ~/code/my-cube-project
npx @duckcodeailabs/dql-cli init . --template starter
```

### Step 2 — Configure the semantic layer

Edit `dql.config.json`:

```json
{
  "project": "my-cube-project",
  "defaultConnection": {
    "driver": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "analytics",
    "username": "analyst",
    "password": "${POSTGRES_PASSWORD}"
  },
  "semanticLayer": {
    "provider": "cubejs",
    "projectPath": "."
  }
}
```

DQL scans `model/` or `schema/` for YAML files containing `cubes:` blocks.

### Step 3 — Verify and launch

```bash
npx @duckcodeailabs/dql-cli doctor
npx @duckcodeailabs/dql-cli semantic list
npx @duckcodeailabs/dql-cli notebook
```

### Step 4 — Use Compose Query + custom SQL

Same as the dbt workflow:
1. **Semantic Panel** → **Compose Query** → select measures/dimensions → **Compose SQL**
2. Click **+ Insert as Cell** to add the generated SQL
3. Write additional custom SQL cells for ad-hoc analysis

### What your Cube.js YAML should look like

```yaml
# model/Orders.yml
cubes:
  - name: Orders
    sql_table: public.orders
    measures:
      - name: count
        type: count
      - name: totalAmount
        type: sum
        sql: amount
    dimensions:
      - name: status
        type: string
        sql: status
      - name: createdAt
        type: time
        sql: created_at
    joins:
      - name: Users
        sql: "{CUBE}.user_id = {Users}.id"
        relationship: many_to_one
```

---

## Tutorial 4: Connect to a Cloud Database

If you don't have a semantic layer but want to use DQL's notebook against your database:

### Step 1 — Create a project

```bash
npx @duckcodeailabs/dql-cli init my-project --template starter
cd my-project
```

### Step 2 — Configure your connection

Edit `dql.config.json` with your database driver. See [Connector Config Reference](./data-sources.md#connector-config-reference) for all 14 supported drivers.

Example for PostgreSQL:

```json
{
  "project": "my-project",
  "defaultConnection": {
    "driver": "postgres",
    "host": "your-db-host.com",
    "port": 5432,
    "database": "analytics",
    "username": "analyst",
    "password": "${DB_PASSWORD}",
    "ssl": true
  }
}
```

### Step 3 — Test the connection

```bash
npx @duckcodeailabs/dql-cli doctor
npx @duckcodeailabs/dql-cli notebook
```

In the notebook, click the **Connection** panel (plug icon) in the sidebar and click **Test Connection** to verify.

### Step 4 — Query your tables

```sql
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name
```

### Step 5 — Add semantic definitions (optional)

Create YAML files to define reusable metrics:

```bash
mkdir -p semantic-layer/metrics semantic-layer/dimensions
```

`semantic-layer/metrics/revenue.yaml`:

```yaml
name: total_revenue
label: Total Revenue
description: Sum of all order amounts
sql: SUM(amount)
type: sum
table: public.orders
tags:
  - revenue
  - kpi
```

`semantic-layer/dimensions/status.yaml`:

```yaml
name: order_status
label: Order Status
sql: status
type: string
table: public.orders
```

Add the provider to `dql.config.json`:

```json
{
  "semanticLayer": {
    "provider": "dql"
  }
}
```

Restart the notebook — your metrics appear in the Semantic Panel.

---

## Tutorial 5: Add DQL to Your Own Repo

**Time:** 5 minutes. Works with any existing project — no semantic layer required.

This path is for teams adding DQL to an existing repo without adopting a full template. You get the DQL notebook, block authoring, and CLI tooling while keeping your existing project structure untouched.

### Step 1 — Run init in your existing project directory

```bash
cd ~/code/my-existing-project
npx @duckcodeailabs/dql-cli init . --template starter
```

**What this adds** (minimal footprint):
- `dql.config.json` — project config (edit this to point at your database)
- `blocks/` — empty folder for your DQL blocks
- `notebooks/` — empty folder for notebook files
- `data/revenue.csv` — sample data for local testing (safe to delete)
- `semantic-layer/` — example YAML files (safe to delete or ignore)

**What this does NOT touch:**
- Your existing source files, models, or configurations
- `package.json`, `.gitignore`, or any other existing file
- Your database, warehouse, or any external system

### Step 2 — Remove sample assets you don't need

If you're pointing at your own database and don't want the sample data:

```bash
rm -rf data/                    # remove sample CSV files
rm -rf semantic-layer/          # remove if you don't have a semantic layer yet
```

Or keep them — they won't interfere with anything.

### Step 3 — Point at your real database

Edit `dql.config.json` to use your warehouse. Examples:

**Snowflake:**
```json
{
  "project": "my-existing-project",
  "defaultConnection": {
    "driver": "snowflake",
    "account": "your-account.snowflakecomputing.com",
    "username": "${SNOWFLAKE_USER}",
    "password": "${SNOWFLAKE_PASSWORD}",
    "database": "ANALYTICS",
    "schema": "PUBLIC",
    "warehouse": "COMPUTE_WH"
  }
}
```

**BigQuery:**
```json
{
  "project": "my-existing-project",
  "defaultConnection": {
    "driver": "bigquery",
    "projectId": "my-gcp-project",
    "keyFilename": "${GOOGLE_APPLICATION_CREDENTIALS}",
    "dataset": "analytics"
  }
}
```

See [Data Sources](./data-sources.md) for all 14 supported drivers.

### Step 4 — Verify the setup

```bash
npx @duckcodeailabs/dql-cli doctor
```

This checks your Node version, config file, and database connection. Fix any reported issues before proceeding.

### Step 5 — Open the notebook against your real tables

```bash
npx @duckcodeailabs/dql-cli notebook
```

Click the **Schema** panel in the sidebar to browse your actual tables and columns. Run SQL against your database just like any query tool.

### Step 6 — Write your first block against real tables

```bash
npx @duckcodeailabs/dql-cli new block "Daily Active Users"
```

Edit `blocks/daily_active_users.dql`:

```dql
block "Daily Active Users" {
    domain      = "product"
    type        = "custom"
    owner       = "analytics-team"
    description = "Daily unique users by product area"
    tags        = ["dau", "product", "engagement"]

    params {
        days_back = "30"
    }

    query = """
        SELECT
            event_date,
            product_area,
            COUNT(DISTINCT user_id) AS dau
        FROM analytics.public.events
        WHERE event_date >= CURRENT_DATE - INTERVAL '${days_back} days'
        GROUP BY event_date, product_area
        ORDER BY event_date DESC
    """

    visualization {
        chart = "line"
        x     = event_date
        y     = dau
    }

    tests {
        assert row_count > 0
    }
}
```

### Step 7 — Validate, preview, and commit

```bash
npx @duckcodeailabs/dql-cli parse blocks/daily_active_users.dql
npx @duckcodeailabs/dql-cli preview blocks/daily_active_users.dql --open
npx @duckcodeailabs/dql-cli certify blocks/daily_active_users.dql
git add blocks/daily_active_users.dql dql.config.json
git commit -m "feat: add DQL notebook and daily active users block"
```

### Ignoring DQL artifacts in git

If you want to exclude the sample data from version control:

```bash
echo "data/" >> .gitignore
```

The `blocks/`, `notebooks/`, and `dql.config.json` should be committed — they are the value.

---

## How the Notebook Works with DQL

### Three ways to query

| Method | When to use | How |
|---|---|---|
| **Compose Query** (point-and-click) | Explore semantic metrics without writing SQL | Sidebar → Semantic → Compose Query → Insert as Cell |
| **Custom SQL** | Ad-hoc analysis, complex joins, window functions | Add a SQL cell → write SQL → Shift+Enter |
| **DQL Block** | Governed, reusable, chartable queries | Add a DQL cell → write block syntax |

### They work together

```
┌─────────────────────────────────────────────────────┐
│  Notebook                                           │
│                                                     │
│  [Markdown] ## Revenue Analysis                     │
│                                                     │
│  [SQL - from Compose Query]                         │
│  SELECT region, SUM(order_total) AS gmv             │
│  FROM orders GROUP BY region                        │
│  → Table + Bar Chart                                │
│                                                     │
│  [SQL - custom]                                     │
│  SELECT region, channel,                            │
│    AVG(order_total) AS avg_order                    │
│  FROM orders GROUP BY 1, 2                          │
│  → Table                                            │
│                                                     │
│  [DQL Block]                                        │
│  block "Top Segments" { ... }                       │
│  → Governed chart with metadata                     │
│                                                     │
│  [Param] segment = [All ▾]                          │
│                                                     │
│  [SQL] SELECT * FROM {{top_segments}}               │
│        WHERE segment = {{segment}}                  │
│  → Filtered results                                 │
└─────────────────────────────────────────────────────┘
```

### Cell reference chaining

Name any SQL cell (e.g., `revenue_data`), then reference it downstream:

```sql
-- This injects revenue_data as a CTE automatically
SELECT * FROM {{revenue_data}}
WHERE revenue > 10000
```

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Shift+Enter` | Run cell |
| `Cmd+S` | Save notebook |
| `a` | Add cell above (command mode) |
| `b` | Add cell below (command mode) |
| `d d` | Delete cell (command mode) |

---

## Verify Your Setup

Run these commands from your project directory:

```bash
npx @duckcodeailabs/dql-cli doctor         # Check project health
npx @duckcodeailabs/dql-cli semantic list   # List semantic definitions
npx @duckcodeailabs/dql-cli parse blocks/   # Validate all blocks
npx @duckcodeailabs/dql-cli notebook        # Launch the notebook
```

---

## Next Steps

- [Authoring Blocks](./authoring-blocks.md) — full lifecycle: create, test, certify, and commit custom and semantic blocks
- [Semantic Layer Guide](./semantic-layer-guide.md) — deep dive into metrics, dimensions, hierarchies, cubes
- [Notebook Guide](./notebook.md) — cell types, variable substitution, export
- [Data Sources & Connector Reference](./data-sources.md) — all 14 database drivers with config fields
- [CLI Reference](./cli-reference.md) — all commands and flags
- [Examples](./examples.md) — ecommerce, NYC taxi, SaaS metrics walkthroughs
- [FAQ](./faq.md) — common questions and troubleshooting
