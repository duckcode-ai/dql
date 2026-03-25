# Semantic Layer — Getting Started Guide

The semantic layer lets you define reusable metrics, dimensions, and hierarchies that appear in the DQL Notebook sidebar and can be queried from DQL blocks.

## Quick Start (2 minutes)

### 1. Create a project (if you don't have one)

```bash
dql init .
```

This creates a DQL project. If a dbt project is detected, the semantic layer provider is set to `dbt` automatically.

### 2. Open the notebook

```bash
dql notebook
```

### 3. Click the Semantic Layer icon in the left sidebar (3rd icon from top)

You'll see your metrics, dimensions, and hierarchies.

---

## How It Works

DQL reads semantic definitions from YAML files and exposes them in the notebook UI. There are **3 providers** — pick the one that matches your setup:

| Provider | Source | Best for |
|----------|--------|----------|
| `dql` | YAML files in `semantic-layer/` | New projects, standalone analytics |
| `dbt` | Your existing dbt project | Teams already using dbt semantic models |
| `cubejs` | Your existing Cube.js project | Teams already using Cube.js |

---

## Option A: DQL Native (YAML files)

This is the simplest option. You write YAML files directly in your project.

### Directory structure

```
my-project/
├── dql.config.json
├── data/
│   └── revenue.csv
└── semantic-layer/
    ├── metrics/          ← one YAML file per metric
    │   └── total_revenue.yaml
    ├── dimensions/       ← one YAML file per dimension
    │   └── segment.yaml
    ├── hierarchies/      ← one YAML file per hierarchy (optional)
    │   └── time_hierarchy.yaml
    └── cubes/            ← one YAML file per cube (optional, advanced)
        └── revenue_cube.yaml
```

### dql.config.json

```json
{
  "project": "my-project",
  "defaultConnection": {
    "driver": "file",
    "filepath": ":memory:"
  },
  "dataDir": "./data",
  "semanticLayer": {
    "provider": "dql"
  },
  "preview": {
    "port": 3474,
    "open": true
  }
}
```

### Metric YAML — `semantic-layer/metrics/total_revenue.yaml`

```yaml
name: total_revenue
label: Total Revenue
description: Sum of all recognized revenue.
domain: finance
sql: SUM(amount)
type: sum
table: fct_revenue
tags:
  - revenue
  - kpi
owner: analytics-team
```

**Required fields:** `name`, `sql`, `type`, `table`

**Supported types:** `sum`, `count`, `count_distinct`, `avg`, `min`, `max`, `custom`

### Dimension YAML — `semantic-layer/dimensions/segment.yaml`

```yaml
name: segment
label: Customer Segment
description: Customer segment tier (Enterprise, Mid-Market, SMB).
sql: segment_tier
type: string
table: fct_revenue
tags:
  - customer
```

**Required fields:** `name`, `sql`, `type`, `table`

**Supported types:** `string`, `number`, `date`, `boolean`

### Hierarchy YAML — `semantic-layer/hierarchies/time_hierarchy.yaml`

```yaml
name: fiscal_time
label: Fiscal Time
description: Drill from year to quarter.
domain: finance
levels:
  - name: fiscal_year
    label: Fiscal Year
    dimension: fiscal_year
    order: 1
  - name: fiscal_quarter
    label: Fiscal Quarter
    dimension: fiscal_quarter
    order: 2
defaultRollup: sum
```

### Cube YAML — `semantic-layer/cubes/revenue_cube.yaml` (advanced)

Cubes group measures, dimensions, time dimensions, and joins into a single definition. Use cubes when you have multi-table models.

```yaml
name: revenue
label: Revenue Cube
description: Core revenue analysis cube.
table: fct_revenue
domain: finance

measures:
  - name: total_revenue
    sql: SUM(amount)
    type: sum
  - name: deal_count
    sql: COUNT(*)
    type: count

dimensions:
  - name: segment_tier
    sql: segment_tier
    type: string

time_dimensions:
  - name: recognized_at
    sql: recognized_at
    primary_time: true
    granularities:
      - day
      - month
      - quarter
      - year

# Connect to other cubes for cross-table queries
joins:
  - name: customers
    type: left
    sql: "${left}.customer_id = ${right}.id"
```

---

## Option B: Connect to a dbt Project

If you already have a dbt project with `semantic_models` (dbt 1.6+), DQL can read directly from it.

### dql.config.json

```json
{
  "project": "my-project",
  "defaultConnection": {
    "driver": "snowflake",
    "account": "your-account.snowflakecomputing.com",
    "username": "your_user",
    "password": "${SNOWFLAKE_PASSWORD}",
    "database": "ANALYTICS",
    "schema": "PUBLIC",
    "warehouse": "COMPUTE_WH"
  },
  "semanticLayer": {
    "provider": "dbt",
    "projectPath": "/Users/you/code/my-dbt-project"
  }
}
```

**`projectPath`** — absolute or relative path to your dbt project root (the directory containing `dbt_project.yml`).

DQL scans `models/**/*.yml` for:
- `semantic_models` blocks (measures, dimensions, entities)
- `metrics` blocks (simple, derived, cumulative)

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
    description: Sum of order amounts
    type: simple
    type_params:
      measure: total_revenue
```

### dbt aggregation types supported

| dbt `agg` | DQL `type` |
|-----------|------------|
| `sum` | `sum` |
| `count` | `count` |
| `count_distinct` | `count_distinct` |
| `average` / `avg` | `avg` |
| `min` | `min` |
| `max` | `max` |

---

## Option C: Connect to a Cube.js Project

If you use Cube.js (or Cube Cloud), DQL can read your cube definitions.

### dql.config.json

```json
{
  "project": "my-project",
  "defaultConnection": {
    "driver": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "analytics"
  },
  "semanticLayer": {
    "provider": "cubejs",
    "projectPath": "/Users/you/code/my-cube-project"
  }
}
```

DQL scans `model/` or `schema/` directory for YAML files containing `cubes:` blocks.

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

## Verify Your Setup

### From the CLI

```bash
dql doctor
```

Look for the `semantic-layer` check — it should show `found`.

### From the API

With the notebook server running:

```bash
curl http://127.0.0.1:3474/api/semantic-layer | python3 -m json.tool
```

You should see your metrics, dimensions, and hierarchies in the JSON response.

### From the Notebook UI

1. Open the notebook (`dql notebook`)
2. Click the **Semantic Layer icon** (3rd icon in the left activity bar)
3. You should see your metrics and dimensions listed
4. Click any metric to see its details (table, type, tags)
5. Use the search box to filter

---

## Hot Reload

When the notebook server is running, any changes to files in `semantic-layer/` are automatically detected. The UI will refresh when you click the refresh button in the semantic panel toolbar.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No semantic layer configured" | Missing `semantic-layer/` directory or `semanticLayer` in config | Create the directory and add YAML files |
| Panel shows 0 metrics | YAML files missing required `sql`/`type`/`table` fields | Check each YAML has all required fields |
| dbt metrics not appearing | `semantic_models` not defined in your dbt YAML | Requires dbt 1.6+ semantic model format |
| API returns 404 | Old CLI version without the endpoint | Rebuild: `cd apps/cli && npm install -g .` |

---

## Reference: dql.config.json

See `templates/dql.config.reference.json` for a complete reference of all connection and semantic layer options.
