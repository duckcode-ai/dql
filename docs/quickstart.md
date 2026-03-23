# Quickstart

Get from zero to a running notebook in under 5 minutes.

---

## Step 1 — Install the CLI

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

> **Note:** Requires Node.js 18 or newer. Use Node 18, 20, or 22 LTS for best DuckDB compatibility.

---

## Step 2 — Initialize a project

```bash
dql init my-dql-project --template starter
cd my-dql-project
```

This creates `blocks/`, `notebooks/`, `data/revenue.csv`, and `dql.config.json`.

---

## Step 3 — Open the notebook

```bash
dql notebook
```

The browser opens at `http://127.0.0.1:3474`. The welcome notebook loads automatically.

---

## Step 4 — Run your first query

Click **+ SQL** to add a SQL cell. Paste this query and press `Shift+Enter`:

```sql
SELECT segment_tier, SUM(amount) AS total_revenue
FROM read_csv_auto('data/revenue.csv')
GROUP BY segment_tier
ORDER BY total_revenue DESC
```

Results appear as a table. Name the cell `revenue_by_segment` using the label field at the top of the cell.

---

## Step 5 — Add a param cell

Click **+ Param** and configure:

- **Name:** `segment`
- **Type:** `select`
- **Options:** `All, Enterprise, Mid-Market, SMB`
- **Default:** `All`

Add a new SQL cell and run:

```sql
SELECT * FROM {{revenue_by_segment}}
WHERE {{segment}} = 'All' OR segment_tier = {{segment}}
```

Change the dropdown and re-run to filter results by segment.

---

## Step 6 — Export a dashboard

Click **Export HTML** in the header bar. You get a standalone HTML file — shareable without any DQL runtime.

---

## What to read next

- [Getting Started](./getting-started.md) — choose your path: sample data, dbt, Cube.js, own DB, or own repo
- [Authoring Blocks](./authoring-blocks.md) — create, test, certify, and commit custom and semantic `.dql` blocks
- [Notebook Guide](./notebook.md) — cell types, variable substitution, keyboard shortcuts, and export formats
- [CLI Reference](./cli-reference.md) — all commands and flags
- [Data Sources](./data-sources.md) — connecting to remote databases
