# Quickstart

> ~5 minutes · end with a working dashboard on the Jaffle Shop dataset

This is the demo gate for DQL. If anything below takes longer than expected or
doesn't work verbatim, [open an issue](https://github.com/duckcode-ai/dql/issues/new) —
we treat the quickstart as a contract.

### Scaffold a project with Jaffle Shop seed data

```bash
npx create-dql-app jaffle-demo
cd jaffle-demo
```

No global install required — `create-dql-app` scaffolds the project,
`npx @duckcodeailabs/dql-cli` runs the notebook. See
[Install](03-install.md) if you prefer a global `dql` binary.

You now have a DQL project wired to a DuckDB-backed Jaffle Shop — the same
demo dataset dbt ships. No external warehouse needed.

### Start the notebook

```bash
dql notebook
```

The CLI starts a local server on **http://localhost:5173** and opens it in
your browser.

### Run the example notebook

In the left sidebar, open `notebooks/jaffle-overview.dql`. Press **⌘↵** (or
**Ctrl+Enter**) on each cell, top to bottom. You'll see:

- a table of orders per customer
- a line chart of daily revenue
- a certified `revenue_by_segment` block
- the lineage DAG, showing how those artifacts connect

### Publish the dashboard

```bash
dql compile dashboards/overview.dql --out build/
```

Open `build/overview.html` — a fully static HTML dashboard, zero runtime
dependencies, ready to drop on any web host.


## Verify it worked

You should have:

- A running notebook at `http://localhost:5173`
- `build/overview.html` rendering three charts + a lineage panel
- `git status` showing only the files you touched (no churn)

## Where to go next

- [Concepts](02-concepts.md) — the five words to understand DQL
- [Connect your own warehouse](guides/connect-warehouse.md) — swap DuckDB for Postgres/Snowflake/BigQuery
- [Import your dbt project](guides/import-dbt.md) — bring your existing manifest
