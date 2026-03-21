# FAQ

## What is DQL?

DQL is an open language for defining durable analytics assets in Git. A DQL block can combine metadata, SQL, parameters, visualization settings, and test assertions in one reusable file.

## Does DQL require DuckCode Studio?

No. DQL works standalone.

You can scaffold a local project, validate blocks, preview charts, and build bundles directly with the DQL CLI.

## Does DQL have a notebook UI?

Yes. Run `dql notebook` from any DQL project root and it opens a local browser notebook.

The notebook supports:
- **SQL cells** — run queries against local CSV/Parquet files via DuckDB
- **Markdown cells** — prose, headers, callouts
- **Param widgets** — adjust query parameters interactively without editing SQL
- **Auto-charting** — results render as charts based on visualization config in your `.dql` files
- **Export** — save results or share notebook files (`.dqlnb`)

```bash
dql init my-project --template ecommerce
cd my-project
dql notebook
```

## Can I use DQL for just the notebook, without writing .dql files?

Yes. The notebook works with plain SQL cells. You do not need to author `.dql` block files to explore data.

Drop a CSV in the `data/` folder of your project, open `dql notebook`, and start writing SQL. `.dql` block files are the durable output you create when you want to commit a query as a reusable, testable asset — but they are not required to use the notebook.

## How is DQL different from a Jupyter notebook?

Jupyter is Python-first and requires a kernel runtime. DQL notebook is SQL-first with no Python runtime needed.

Key differences:

| | Jupyter | DQL Notebook |
|---|---|---|
| Primary language | Python | SQL |
| Execution runtime | Python kernel | DuckDB (in-browser) |
| Chart setup | matplotlib / Plotly code | Declarative config, auto-rendered |
| File format | `.ipynb` JSON | `.dqlnb` JSON |
| Git diff | Noisy (cell outputs embedded) | Clean (no embedded outputs) |
| Local data | Manual file loading | Drop CSV in `data/`, query immediately |

Both are Git-trackable. DQL notebook is purpose-built for SQL analytics without writing any Python.

## I just want to explore a CSV file. Can DQL help?

Yes. This is the fastest DQL workflow:

```bash
npm install -g @duckcodeailabs/dql-cli
dql init myproject && cd myproject
dql notebook
```

Drop your CSV into the `data/` folder. In the notebook, query it immediately:

```sql
SELECT * FROM read_csv_auto('data/yourfile.csv') LIMIT 20
```

No warehouse, no credentials, no configuration. DuckDB reads the file directly.

## Can I preview visualizations locally?

Yes. The recommended local flow is:

```bash
dql init my-dql-project
cd my-dql-project
dql new block "Pipeline Health"
dql preview blocks/pipeline_health.dql --open
```

This uses local sample data and the built-in preview server.

## Do I need a cloud warehouse to try DQL?

No.

The easiest first-run experience uses local CSV or Parquet data with the `file` or `duckdb` connector path. That is the recommended open-source evaluation flow.

## What is the difference between `custom` and `semantic` blocks?

- `type = "custom"` means the block executes SQL declared in the block itself.
- `type = "semantic"` means the block references a semantic-layer metric and should not contain its own SQL query.

If you are starting fresh, use `custom` blocks first.

## What syntax should I start with?

For open-source adoption, start with the reusable block syntax shown in the starter template.

DQL also supports dashboard and chart-call syntax, but the easiest first path is:

- `block { ... }`
- local data
- `dql preview`

## Can DQL be used from code, not just the CLI?

Yes.

The repo provides reusable packages for parsing, compiling, rendering, registry management, connectors, governance, and editor integration.

Good entry points:

- `@duckcodeailabs/dql-core`
- `@duckcodeailabs/dql-compiler`
- `@duckcodeailabs/dql-runtime`
- `@duckcodeailabs/dql-connectors`

## What commands are most important for a new user?

Start with these:

- `dql init`
- `dql doctor`
- `dql notebook`
- `dql parse`
- `dql preview`
- `dql build`
- `dql serve`

These cover setup, validation, interactive exploration, and sharing.

## Does `dql test` execute assertions against a real database?

It can, but only when a working execution path is configured.

Without a runnable database connection, test flows are limited to structural discovery or dry-run behavior. For first-time local exploration, focus on `parse`, `preview`, `build`, and `serve` first.

## What is not included in the open DQL repo?

This repo does not include:

- Natural-language or agentic block generation
- MCP runtime
- Approval workflows and product orchestration

Those are separate from the standalone open-source DQL language/tooling layer. The notebook UI (`dql notebook`) is fully included.

## How is DQL different from dbt?

dbt is primarily a transformation workflow and semantic modeling system.

DQL is focused on durable analytics answer assets: blocks that package query logic, parameters, visualization, and tests into reusable artifacts.

Many teams can use both together rather than choosing one over the other.

## How do I get started fastest?

```bash
npm install -g @duckcodeailabs/dql-cli
dql init my-dql-project --template ecommerce
cd my-dql-project
dql doctor
dql notebook
```

Then read:

- [Getting Started](./getting-started.md)
- [Examples](./examples.md)
- [Project Config](./project-config.md)
- [Data Sources](./data-sources.md)
