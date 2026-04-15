# Enterprise Getting Started

This guide is for teams with an **existing dbt project** and a **production database** (Snowflake, PostgreSQL, BigQuery, Databricks, or any of the 14 supported connectors). You'll connect DQL to your real data, import your semantic metrics, and build governed blocks — all from the notebook UI.

> **Looking for the quick demo path?** Use the [Jaffle Shop walkthrough](./getting-started.md) instead.
>
> **Just want DQL-only, no dbt?** See the [Quickstart](./quickstart.md).

---

## Prerequisites

- **Node.js 18+**
- **An existing dbt project** (with `dbt_project.yml`)
- **Database credentials** for your warehouse (Snowflake, Postgres, BigQuery, etc.)

---

## Step 1: Install DQL

```bash
npm install -g @duckcodeailabs/dql-cli
dql --version
```

---

## Step 2: Initialize DQL in Your dbt Project

```bash
cd /path/to/your-dbt-project
dql init .
```

DQL auto-detects:
- **dbt project** — finds `dbt_project.yml`, sets `semanticLayer.provider` to `dbt`
- **DuckDB file** — if your dbt project uses `dbt-duckdb`, finds the `.duckdb` file
- **Semantic definitions** — if your `models/` directory contains `semantic_models:` or `metrics:` in YAML files, auto-imports them

Created files:
```
dql.config.json          ← project config
blocks/                  ← your DQL blocks will go here
notebooks/welcome.dqlnb  ← starter notebook
semantic-layer/          ← imported metrics/dimensions (if detected)
```

---

## Step 3: Configure Your Database Connection

Your dbt project likely uses a production warehouse, not DuckDB. You have two options:

### Option A: Edit `dql.config.json` directly

Open `dql.config.json` and update the connection to match your warehouse:

**Snowflake:**
```json
{
  "connections": {
    "default": {
      "driver": "snowflake",
      "account": "your-account.snowflakecomputing.com",
      "username": "your_user",
      "password": "${SNOWFLAKE_PASSWORD}",
      "database": "ANALYTICS",
      "schema": "PUBLIC",
      "warehouse": "COMPUTE_WH"
    }
  }
}
```

**PostgreSQL:**
```json
{
  "connections": {
    "default": {
      "driver": "postgres",
      "host": "your-host.example.com",
      "port": 5432,
      "database": "analytics",
      "username": "analyst",
      "password": "${POSTGRES_PASSWORD}"
    }
  }
}
```

**BigQuery:**
```json
{
  "connections": {
    "default": {
      "driver": "bigquery",
      "project": "your-gcp-project-id",
      "dataset": "analytics",
      "keyFilename": "./service-account.json"
    }
  }
}
```

> Use `${ENV_VAR}` for passwords — DQL resolves them from your shell environment. Never hardcode secrets. See [Data Sources](./data-sources.md) for all 14 driver configs.

Set the environment variable before running DQL:

```bash
export SNOWFLAKE_PASSWORD="your-password"
```

### Option B: Use the notebook Connection Panel (Step 5)

Skip editing `dql.config.json` — configure the connection from the notebook UI instead.

---

## Step 4: Verify Setup

```bash
dql doctor
```

Check that the connection and semantic layer resolve correctly:

```
  ✓ dql.config.json         found
  ✓ Default connection      driver=snowflake
  ✓ Semantic layer          provider=dbt, 12 metrics, 8 dimensions
  ✓ Notebook app assets     found
  ✓ Local query runtime     driver=snowflake is available
```

If `Local query runtime` fails, verify your credentials and that the database is reachable from your machine.

---

## Step 5: Open the Notebook

```bash
dql notebook
```

Your browser opens at `http://127.0.0.1:3474`.

---

## Step 6: Configure Connection from the Notebook (if needed)

If you skipped Step 3 or need to change the database:

1. Click the **Connection** icon in the left sidebar (plug icon)
2. You'll see the current connection config and status indicator
3. **Quick Connect** — click a preset (PostgreSQL, Snowflake, etc.) to pre-fill the form
4. **Fill in your credentials** — host, database, username, password, etc.
5. Click **Save**

**What happens on Save:**
- DQL writes the connection to `dql.config.json`
- The server **hot-swaps** the database connection at runtime — no restart needed
- The schema sidebar refreshes with your real tables and columns
- The status indicator updates to show connection health

6. Click **Test Connection** to verify the connection works

> You can change connections at any time. Each save hot-swaps the active connection immediately.

---

## Step 7: Browse Your Database Schema

After connecting, the **Schema** sidebar (database icon) shows your tables:

- Tables organized by schema (e.g., `public.dim_customers`, `analytics.fct_orders`)
- Click a table to expand and see all columns
- Columns show color-coded type badges:
  - Blue — string/varchar/text
  - Green — int/bigint/float/decimal
  - Pink — boolean
  - Gold — date/timestamp
  - Purple — json/array/variant
- Click a column to insert it into the current SQL cell

DQL uses a 3-tier introspection strategy that works across all 14 connectors:
1. `information_schema` queries (Postgres, Snowflake, MySQL, MSSQL, DuckDB, etc.)
2. Connector-specific methods (SQLite `PRAGMA`, BigQuery API, Athena `DESCRIBE`)
3. Lazy column loading on expand (fallback)

---

## Step 8: Import Semantic Metrics

If `dql init` didn't auto-import your semantic definitions (or you want to re-import), you have two options:

### Option A: From the CLI

```bash
dql semantic import dbt .
```

This scans your `models/` directory for `semantic_models:` and `metrics:` blocks, extracts all metrics, dimensions, hierarchies, and writes them as YAML files into `semantic-layer/`.

### Option B: From the Notebook UI

1. Click the **Semantic** icon in the left sidebar (layers icon)
2. If no metrics are loaded, you'll see an import prompt
3. Select your provider:
   - **dbt** — reads from your dbt project's `models/*.yml` files
   - **Cube.js** — reads from your Cube.js `model/` or `schema/` directory
   - **Snowflake** — queries Snowflake semantic views via the live connection
4. Click **Import**

**What gets imported:**
- **Metrics** — sum, count, avg, min, max, count_distinct, custom
- **Dimensions** — string, number, date, boolean
- **Hierarchies** — drill paths (e.g., year → quarter → month)
- **Cubes** — grouped measures + dimensions + joins

Each object becomes a YAML file in `semantic-layer/`:
```
semantic-layer/
  metrics/total_revenue.yaml
  metrics/order_count.yaml
  dimensions/customer_type.yaml
  dimensions/order_date.yaml
  hierarchies/fiscal_time.yaml
```

After import, the semantic sidebar shows all metrics and dimensions. Changes to the YAML files are hot-reloaded automatically.

### Snowflake Semantic Layer

If your team uses Snowflake's native semantic views:

```json
{
  "semanticLayer": {
    "provider": "snowflake"
  }
}
```

DQL queries the live Snowflake connection to discover semantic views, metrics, and dimensions. This requires an active Snowflake connection (Step 6).

---

## Step 9: Build Blocks in Block Studio

Block Studio is where you turn SQL into governed, testable, Git-trackable analytics blocks.

### Open Block Studio

Click **Block Studio** in the sidebar, or click any `.dql` file.

### The Block Studio layout

| Panel | Location | What it shows |
|-------|----------|---------------|
| **Database Explorer** | Left sidebar, Database tab | Your tables and columns from the connected database |
| **Semantic Panel** | Left sidebar, Semantic tab | Imported metrics, dimensions, hierarchies |
| **SQL Editor** | Center | Write your block's SQL |
| **Results/Chart** | Bottom | Query results table with chart toggle |
| **Validation** | Inline | Live syntax and semantic errors |

### Write SQL with database + semantic references

1. **From the Database panel** — click a table or column to insert it into the editor
2. **From the Semantic panel** — click a metric to insert `{{ metric:total_revenue }}`, or a dimension to insert `{{ dimension:customer_type }}`
3. **Write SQL directly** — standard SQL against your connected database

Example block:

```sql
SELECT
    {{ dimension:customer_type }} AS segment,
    {{ metric:total_revenue }} AS revenue,
    {{ metric:order_count }} AS orders
FROM fct_orders
GROUP BY segment
ORDER BY revenue DESC
```

### Run

Click **Run** (or Ctrl/Cmd+Enter). DQL executes the SQL against your connected database and shows results in the table below. Toggle **Chart** to see automatic visualization.

### Test

If your block defines test assertions:

```dql
tests {
    assert row_count > 0
    assert revenue > 0
}
```

Click **Test** to run all assertions. Each shows pass/fail status.

### Save

Click **Save**. If this is a new block, a dialog collects:
- **Name** — block identifier (e.g., "Revenue by Segment")
- **Domain** — business domain (e.g., "finance", "marketing")
- **Owner** — responsible team or person
- **Description** — what this block answers

The block is saved to `blocks/{domain}/{name}.dql` — a Git-trackable file.

If a block with the same name already exists, you'll see an error with the option to rename.

---

## Step 10: View Lineage

```bash
dql compile --dbt-manifest target/manifest.json
dql lineage
```

See the full data flow:
```
dbt source tables → staging models → mart tables → DQL blocks → downstream consumers
```

Useful lineage commands:

```bash
dql lineage --domain finance            # blocks in the finance domain
dql lineage --impact fct_orders         # what breaks if this table changes?
dql lineage --trust-chain revenue_block # certification status at every hop
dql lineage --format json               # export for CI/CD integrations
```

---

## Step 11: Validate and Certify

Run validation across all blocks:

```bash
dql validate
```

Certify individual blocks for governance compliance:

```bash
dql certify blocks/finance/revenue_by_segment.dql
```

Certification checks: owner is set, description exists, domain is assigned, tests pass.

---

## Project Structure

After setup, your project looks like:

```
your-dbt-project/
├── dbt_project.yml              ← existing dbt project
├── models/                      ← existing dbt models
│   └── staging/_schema.yml      ← semantic_models + metrics definitions
├── target/
│   └── manifest.json            ← dbt manifest (for lineage import)
├── dql.config.json              ← DQL project config
├── blocks/                      ← DQL blocks (Git-tracked)
│   └── finance/
│       └── revenue_by_segment.dql
├── notebooks/                   ← DQL notebooks
│   └── welcome.dqlnb
├── semantic-layer/              ← imported semantic definitions
│   ├── metrics/
│   ├── dimensions/
│   └── imports/manifest.json
└── .gitignore                   ← includes dql-manifest.json, *.duckdb
```

---

## Supported Database Connectors

| Driver | Config value | Typical use |
|--------|-------------|-------------|
| DuckDB (in-memory) | `file` | Local CSV/Parquet analysis |
| DuckDB (file) | `duckdb` | Persistent local warehouse |
| SQLite | `sqlite` | Lightweight embedded DB |
| PostgreSQL | `postgres` | Supabase, RDS, Aurora, Neon |
| MySQL | `mysql` | MariaDB, PlanetScale, TiDB |
| SQL Server | `mssql` | Azure SQL, on-prem MSSQL |
| Snowflake | `snowflake` | Cloud data warehouse |
| BigQuery | `bigquery` | Google Cloud analytics |
| Redshift | `redshift` | AWS data warehouse |
| Databricks | `databricks` | Lakehouse analytics |
| ClickHouse | `clickhouse` | Real-time analytics |
| Athena | `athena` | S3-based serverless queries |
| Trino | `trino` | Federated queries, Starburst |
| Fabric | `fabric` | Microsoft Fabric lakehouse |

Full config details for each driver: [Data Sources](./data-sources.md)

---

## Security Best Practices

- **Never hardcode secrets** in `dql.config.json`. Use `${ENV_VAR}` syntax:
  ```json
  { "password": "${SNOWFLAKE_PASSWORD}" }
  ```
- **Add `.env` to `.gitignore`** if you use a `.env` file for local development
- **`dql init` adds to `.gitignore`** automatically: `dql-manifest.json`, `*.duckdb`, `*.duckdb.wal`
- **Connection Panel** in the notebook stores credentials in `dql.config.json` — ensure this file is not committed if it contains plain-text passwords

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `dql doctor` — connection fails | Wrong credentials or host unreachable | Verify host, port, username, password in `dql.config.json` |
| Schema sidebar is empty | Connection not configured or test failed | Open Connection Panel, verify connection, click Test |
| Semantic sidebar shows 0 metrics | No semantic definitions in dbt YAML | Ensure your `models/*.yml` files have `semantic_models:` blocks (requires dbt 1.6+) |
| `dql semantic import dbt .` fails | No `dbt_project.yml` found | Run from your dbt project root |
| Save returns 409 conflict | Block name already exists | Choose a different name or rename the existing block |
| Catalog load failed (error banner) | Database connection dropped | Click Retry in the error banner, or check the Connection Panel |
| `${ENV_VAR}` not resolved | Variable not set in shell | Run `export ENV_VAR=value` before `dql notebook` |

---

## Next Steps

| Goal | Guide |
|------|-------|
| Notebook features (params, charts, export, dashboard mode) | [Notebook Guide](./notebook.md) |
| Block syntax deep dive (params, ref(), visualization, tests) | [Language Spec](./dql-language-spec.md) |
| Semantic layer YAML format and providers | [Semantic Layer Guide](./semantic-layer-guide.md) |
| Lineage, trust chains, impact analysis | [Lineage Guide](./lineage.md) |
| CI/CD integration and validation | [CLI Reference](./cli-reference.md) |
| All 14 connector configs with examples | [Data Sources](./data-sources.md) |
