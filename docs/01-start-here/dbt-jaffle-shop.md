# dbt + Jaffle Shop Walkthrough

Use this path if you want to learn DQL with a dbt project that already includes semantic models and metrics.

## What You Will Do

1. Clone the Jaffle Shop semantic-layer course repo
2. Build it with dbt + DuckDB
3. Initialize DQL on top of that repo
4. Import the semantic layer
5. Open the notebook and lineage views

## Prerequisites

- Python 3.9+
- Node.js 18, 20, or 22
- Git

## Step 1: Clone The Course Project

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
```

## Step 2: Install dbt

```bash
pip install dbt-duckdb
```

## Step 3: Create A Local DuckDB Profile

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

## Step 4: Build The dbt Project

```bash
dbt deps
dbt build --profiles-dir .
```

## Step 5: Install DQL And Initialize The Repo

```bash
npm install -g @duckcodeailabs/dql-cli
dql init .
```

## Step 6: Import The dbt Semantic Layer

```bash
dql semantic import dbt .
```

## Step 7: Verify The Project

```bash
dql doctor
```

## Step 8: Open The Notebook

```bash
dql notebook
```

## Step 9: Copy The Demo Lineage Notebook

From the DQL repo, copy the demo notebook into your dbt project:

```bash
mkdir -p notebooks
cp /path/to/DQL/dql/docs/examples/jaffle-shop-lineage-demo.dqlnb notebooks/
```

This notebook is designed to show:

- dbt model lineage upstream
- DQL block lineage in the middle
- notebook consumption downstream
- domain boundaries across customer, finance, and executive flows

## Step 10: Import dbt Lineage

```bash
dql compile --dbt-manifest target/manifest.json
dql lineage
```

## Step 11: Verify In The UI

1. Open the `Lineage` sidebar and search for `revenue_by_customer_type`
2. Open `executive_revenue_rollup` in Block Studio
3. Use the `Lineage` tab in Block Studio to inspect the path summary
4. Open the fullscreen graph to inspect the broader dbt + DQL + notebook flow

## What To Read Next

- [Semantic Layer Workflow](../02-core-workflows/semantic-layer-workflow.md)
- [Lineage Workflow](../02-core-workflows/lineage-workflow.md)
- [Full detailed getting started guide](../getting-started.md)
