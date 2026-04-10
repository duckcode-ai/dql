# Quickstart

Go from zero to a running DQL notebook in 5 minutes using the Jaffle Shop dbt project with dbt semantic models already included.

---

## 1. Set Up the dbt Project

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
pip install dbt-duckdb
```

This guide uses `dbt-labs/Semantic-Layer-Online-Course` because it matches DQL's dbt-provider walkthrough out of the box: the repo already contains the semantic models and metrics that DQL will surface in the notebook.

Create a local DuckDB profile:

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

Build the project:

```bash
dbt deps && dbt build --profiles-dir .
```

## 2. Install and Initialize DQL

```bash
npm install -g @duckcodeailabs/dql-cli
dql init .
dql doctor
```

## 3. Open the Notebook

```bash
dql notebook
```

Your browser opens with a notebook connected to the Jaffle Shop DuckDB database. Query `dim_customers`, `fct_orders`, and `order_items` — write SQL cells, create governed DQL blocks, and visualize results.

## 4. Import dbt Lineage

```bash
dql compile --dbt-manifest target/manifest.json
dql lineage
```

See the full data flow from dbt's source tables through your DQL blocks.

---

> If you want the fastest non-dbt path instead, run `npm install -g @duckcodeailabs/dql-cli`, then `dql init my-dql-project && cd my-dql-project && dql notebook`.
>
> **[Full walkthrough with all steps](./getting-started.md)**
