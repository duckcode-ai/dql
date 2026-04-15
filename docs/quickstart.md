# Quickstart

Two paths to a running DQL notebook. Pick the one that fits.

---

## Path A: DQL-Only (2 minutes, no dbt)

Best for: trying DQL quickly, local CSV/Parquet analysis, no Python required.

### 1. Install

```bash
npm install -g @duckcodeailabs/dql-cli
dql --version    # verify install
```

### 2. Create a project

```bash
dql init my-dql-project
cd my-dql-project
```

This creates:
- `dql.config.json` — project config (DuckDB in-memory by default)
- `blocks/` — directory for your DQL analytics blocks
- `notebooks/welcome.dqlnb` — a starter notebook

### 3. Verify setup

```bash
dql doctor
```

All checks should pass. If any fail, follow the hints in the output.

### 4. Open the notebook

```bash
dql notebook
```

Your browser opens at `http://127.0.0.1:3474` with the welcome notebook.

### 5. Explore

- **Run the first SQL cell** — it lists tables in your database
- **Add data** — drop CSV or Parquet files into a `data/` directory, then query them:
  ```sql
  SELECT * FROM read_csv_auto('./data/orders.csv') LIMIT 10;
  ```
- **Open Block Studio** — click the Block Studio icon in the sidebar to create your first governed block (SQL + owner + tests + visualization)

---

## Path B: dbt + Jaffle Shop (5 minutes)

Best for: seeing DQL's full power — semantic metrics, dbt lineage, Block Studio with real data.

> **Note:** `dql init` does **not** download the Jaffle Shop repo. You clone it yourself in Step 1.

### 1. Clone and build the dbt project

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
pip install dbt-duckdb
dbt deps
dbt build --profiles-dir .
```

This builds the full Jaffle Shop data model into `jaffle_shop.duckdb` — customers, orders, products, and supplies tables.

### 2. Install DQL

```bash
npm install -g @duckcodeailabs/dql-cli
dql --version
```

### 3. Initialize DQL

```bash
dql init .
```

DQL auto-detects everything:
- **dbt project** — finds `dbt_project.yml`, sets semantic layer provider to `dbt`
- **DuckDB file** — finds `jaffle_shop.duckdb`, configures it as the default connection
- **Semantic definitions** — finds metrics and dimensions in `models/*.yml`, auto-imports them into `semantic-layer/`

You do **not** need to run `dql semantic import dbt .` separately — `dql init` handles it when semantic definitions are detected.

### 4. Verify setup

```bash
dql doctor
```

You should see:
```
  ✓ dql.config.json         found
  ✓ Default connection       driver=duckdb
  ✓ Semantic layer           provider=dbt, N metrics, N dimensions
  ✓ Notebook app assets      found
  ✓ Local query runtime      driver=duckdb is available
```

### 5. Open the notebook

```bash
dql notebook
```

Your browser opens with the welcome notebook connected to Jaffle Shop.

### 6. Explore the notebook

- **Run `SHOW TABLES;`** — see all tables built by dbt (`dim_customers`, `fct_orders`, `order_items`, etc.)
- **Schema sidebar** (database icon) — browse tables and columns with type-colored badges. Click a column to insert it into your SQL.
- **Semantic sidebar** (layers icon) — browse the imported dbt metrics and dimensions. Click to see details (type, table, tags).

### 7. Build a block in Block Studio

1. Click **Block Studio** in the sidebar (or create a new block via the + button)
2. **Database panel** (left) — expand `dim_customers` to see columns. Click `lifetime_spend` to insert it.
3. **Semantic panel** — click a metric like `total_revenue` to insert `{{ metric:total_revenue }}` into your SQL
4. **Write SQL** in the editor:
   ```sql
   SELECT customer_name, lifetime_spend
   FROM dim_customers
   ORDER BY lifetime_spend DESC
   LIMIT 10
   ```
5. **Run** — click the Run button (or Ctrl/Cmd+Enter) to see results in the table below
6. **Test** — if your block has `tests { assert row_count > 0 }`, click Test to validate
7. **Save** — click Save. If this is a new block, you'll be prompted for a name, domain, and owner. The block is written to `blocks/` as a `.dql` file.

### 8. View lineage

```bash
dql compile --dbt-manifest target/manifest.json
dql lineage
```

See the full data flow: dbt source tables → staging → marts → DQL blocks.

---

## What's next

| Goal | Guide |
|------|-------|
| Full Jaffle Shop walkthrough | [Getting Started](./getting-started.md) |
| Connect Snowflake, Postgres, or other databases | [Enterprise Getting Started](./enterprise-getting-started.md) |
| Learn notebook features (params, charts, export) | [Notebook Guide](./notebook.md) |
| DQL block syntax reference | [Language Spec](./dql-language-spec.md) |
| Browse all 14 database connectors | [Data Sources](./data-sources.md) |
| Import semantic metrics from dbt/Cube.js | [Semantic Layer Guide](./semantic-layer-guide.md) |
