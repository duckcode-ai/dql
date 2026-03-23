# DQL

- Your team copy-pastes the same query into 12 dashboards. They drift. Nobody knows which is right.
- Someone changes the SQL. The chart breaks. There was no review.
- AI generated a perfect query last Tuesday. It's gone now.
- "Is this metric still correct?" — nobody can answer that.

**DQL fixes that.**

**DQL is an open-source analytics language, CLI, and notebook UI** — each analytics answer lives in a single `.dql` file: SQL + visualization config + owner + tests + parameters, all Git-trackable. No more query sprawl. No more broken charts. No more lost work.

→ **[Why DQL exists and what problem it solves](./docs/why-dql.md)**

---

## Install

Requires Node 18, 20, or 22 (active LTS).

```bash
npm install -g @duckcodeailabs/dql-cli
dql init my-dql-project --template ecommerce
cd my-dql-project
dql doctor
dql notebook
```

→ **[Full installation guide — global, local, source, and library paths](./docs/getting-started.md)**

### 5-Minute Start

```bash
npm install -g @duckcodeailabs/dql-cli   # install CLI
dql init my-project --template starter   # scaffold project
cd my-project && dql doctor              # verify setup
dql notebook                             # open browser notebook
```

→ **[Quickstart — zero to running notebook in 5 minutes](./docs/quickstart.md)**

### Choose Your Path

| Starting point | Tutorial |
|---|---|
| Brand new, no database | [Tutorial 1: Sample Data](./docs/getting-started.md#tutorial-1-start-with-sample-data) |
| Existing dbt project | [Tutorial 2: dbt Integration](./docs/getting-started.md#tutorial-2-existing-dbt-project) |
| Existing Cube.js project | [Tutorial 3: Cube.js Integration](./docs/getting-started.md#tutorial-3-existing-cubejs-project) |
| Own database, no semantic layer | [Tutorial 4: Cloud Database](./docs/getting-started.md#tutorial-4-connect-to-a-cloud-database) |
| Adding DQL to an existing repo | [Tutorial 5: Own Repo (no template)](./docs/getting-started.md#tutorial-5-add-dql-to-your-own-repo) |

### Library packages (for embedding in your app)

```bash
npm install @duckcodeailabs/dql-core@0.3.2 @duckcodeailabs/dql-compiler@0.2.3 @duckcodeailabs/dql-notebook@0.2.3
```

---

## The Notebook

`dql notebook` opens a local browser UI — no cloud, no Python, no setup beyond the CLI.

- **SQL cells** — write and run SQL against local files, powered by DuckDB
- **Param cells** — live widgets (text, number, date, select) wired to `{{variable}}` references in SQL
- **Markdown cells** — annotate your analysis
- **Auto-charting** — bar and line charts detected from query shape, table/chart toggle
- **Export** — standalone HTML dashboard or `.dql` workbook file

```bash
dql notebook                      # open notebook for current project
dql notebook ./my-dql-project     # specify project path
dql new notebook "Revenue Analysis"  # scaffold a new .dqlnb file
```

→ **[Notebook guide — cells, param widgets, variable substitution, export](./docs/notebook.md)**

---

## DQL Blocks

A DQL block is the core reusable unit — one file that holds everything needed to produce a trusted analytics answer.

```dql
block "Revenue by Segment" {
    domain      = "revenue"
    owner       = "data-team"
    tags        = ["revenue", "segment", "quarterly"]

    params {
        period = "current_quarter"
    }

    query = """
        SELECT segment_tier AS segment, SUM(amount) AS revenue
        FROM fct_revenue
        WHERE fiscal_period = ${period}
        GROUP BY segment_tier
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

Scaffold, validate, preview, and build blocks with the CLI:

```bash
dql new block "Pipeline Health"
dql parse blocks/pipeline_health.dql
dql preview blocks/pipeline_health.dql --open
dql build blocks/pipeline_health.dql
```

→ **[Authoring blocks — create, test, certify, and commit custom and semantic blocks](./docs/authoring-blocks.md)**

→ **[Full language reference — block syntax, chart types, params, tests, workbooks](./docs/dql-language-spec.md)**

---

## Semantic Layer

DQL includes a built-in semantic layer — define metrics, dimensions, hierarchies, and cubes in YAML files, then reference them in your notebooks and blocks.

```
semantic-layer/
  metrics/revenue.yaml
  dimensions/segment.yaml
  hierarchies/revenue_time.yaml
  cubes/revenue_cube.yaml
```

Three provider modes are supported:

| Provider | Source | Use when |
|---|---|---|
| `dql` (default) | Local `semantic-layer/` YAML files | Standalone projects, getting started |
| `dbt` | dbt `models/**/*.yml` semantic models | You already use dbt for transformations |
| `cubejs` | Cube.js `model/` or `schema/` definitions | You already use Cube for your semantic layer |

Configure in `dql.config.json`:

```json
{
  "semanticLayer": {
    "provider": "dql"
  }
}
```

The notebook sidebar shows your semantic layer live — browse metrics, dimensions, and hierarchies, click to insert into SQL cells.

→ **[Semantic layer guide — setup, providers, YAML format, notebook integration](./docs/semantic-layer-guide.md)**

---

## Data Sources

DQL works without a cloud warehouse. The default runtime uses DuckDB to query local CSV and Parquet files directly.

```json
{
  "connections": {
    "default": {
      "driver": "duckdb",
      "path": ":memory:"
    }
  }
}
```

Connect to Postgres, BigQuery, or Snowflake the same way — swap the driver in `dql.config.json`.

→ **[Data sources guide — local files, DuckDB, Postgres, and remote connectors](./docs/data-sources.md)**

---

## Project Templates

Pick a template when running `dql init` to get a working project immediately:

| Template | Best for | What you get |
|---|---|---|
| `starter` | Smallest local-first flow | Revenue CSV, starter blocks, semantic layer tutorial, welcome notebook |
| `ecommerce` | Strongest OSS demo | Channel revenue, funnel analysis, semantic cubes, commerce dataset |
| `saas` | Revenue + retention | MRR, churn pressure, cohort analysis, semantic metrics |
| `taxi` | Time-series and ops | Trip volume, fare trends, borough analysis, semantic dimensions |

```bash
dql init my-project --template ecommerce
```

→ **[Getting started — full project walkthrough](./docs/getting-started.md)**

---

## CLI Reference

Every command has a clear job:

| Command | What it does |
|---|---|
| `dql init` | Scaffold a new DQL project with sample data and starter blocks |
| `dql notebook` | Open the browser notebook for interactive SQL exploration |
| `dql new block` | Create a new `.dql` block file |
| `dql new notebook` | Create a new `.dqlnb` notebook file |
| `dql parse` | Validate syntax and run semantic analysis |
| `dql preview` | Compile and serve a block locally with live data |
| `dql build` | Compile to a static HTML bundle |
| `dql serve` | Serve a built bundle locally |
| `dql certify` | Check governance rules (owner, description, tags, domain) |
| `dql fmt` | Format a `.dql` file in place |
| `dql doctor` | Diagnose project setup, config, and runtime readiness |

→ **[Full CLI reference — all commands, flags, and exit codes](./docs/cli-reference.md)**

---

## Migration

Coming from raw SQL, dbt, or a saved BI query?

```bash
dql migrate raw-sql
dql migrate dbt
dql migrate looker
```

→ **[Migration guides — from raw SQL, dbt, and BI tools](./docs/migration-guides/README.md)**

---

## VS Code Extension

Search **DQL Language Support** in the Extensions panel, or:

```bash
code --install-extension dql.dql-language-support
```

Provides syntax highlighting, snippets, format-on-save, and LSP support (completions, hover, diagnostics).

---

## Use Cases

Not sure where to start? Pick your goal:

- **Explore a CSV interactively** → `dql init` + `dql notebook`
- **Author a reusable block** → `dql new block` + `dql preview`
- **Build a shareable dashboard** → `dql build` + `dql serve`
- **Migrate from raw SQL or dbt** → `dql migrate`
- **Embed the parser in Node.js** → `@duckcodeailabs/dql-core`

→ **[Use cases — recommended paths by goal](./docs/use-cases.md)**

---

## Documentation

### Start Here

| Guide | What it covers |
|---|---|
| [Quickstart](./docs/quickstart.md) | 5-minute path from install to running notebook |
| [Getting Started](./docs/getting-started.md) | Choose your path: sample data, dbt, Cube.js, own DB, own repo |

### Core Workflows

| Guide | What it covers |
|---|---|
| [Notebook Guide](./docs/notebook.md) | Cell types, param widgets, variable refs, export |
| [Authoring Blocks](./docs/authoring-blocks.md) | Create, test, certify, and commit .dql blocks (custom + semantic) |
| [Semantic Layer](./docs/semantic-layer-guide.md) | Metrics, dimensions, cubes, dbt/Cube.js providers |

### Reference

| Guide | What it covers |
|---|---|
| [CLI Reference](./docs/cli-reference.md) | Every command, flag, and exit code |
| [Data Sources](./docs/data-sources.md) | All 14 database drivers with config fields |
| [Language Spec](./docs/dql-language-spec.md) | Full .dql syntax: blocks, charts, params, workbooks |
| [Project Config](./docs/project-config.md) | dql.config.json — connections, ports, defaults |

### Migrate & Examples

| Guide | What it covers |
|---|---|
| [Migration Guides](./docs/migration-guides/README.md) | From raw SQL, dbt, Looker, Tableau |
| [Examples](./docs/examples.md) | Walkthrough of ecommerce, SaaS, NYC taxi example projects |
| [Use Cases](./docs/use-cases.md) | Recommended paths by goal |
| [Why DQL](./docs/why-dql.md) | The problem, before/after, personas, DQL vs alternatives |

### Help & Compatibility

| Guide | What it covers |
|---|---|
| [FAQ](./docs/faq.md) | Common questions about scope, notebook, and compatibility |
| [Compatibility](./docs/compatibility.md) | Runtime, connector, and workflow support matrix |

---

## Package Reference

| Package | Description |
|---|---|
| `@duckcodeailabs/dql-cli` `0.5.2` | Public CLI — `dql init`, `dql notebook`, `dql preview`, `dql parse`, … |
| `@duckcodeailabs/dql-core` `0.3.2` | Lexer, parser, AST, semantic analysis, semantic layer, formatter |
| `@duckcodeailabs/dql-compiler` `0.2.3` | IR lowering, HTML/React/runtime code generation |
| `@duckcodeailabs/dql-governance` | Certification rules, cost estimation |
| `@duckcodeailabs/dql-project` | Git-backed block registry and project primitives |
| `@duckcodeailabs/dql-notebook` `0.2.3` | Notebook document model and execution helpers |
| `@duckcodeailabs/dql-lsp` | Language Server Protocol implementation |
| `@duckcodeailabs/dql-runtime` | Browser runtime: data fetching, hot-reload |
| `@duckcodeailabs/dql-charts` | React SVG chart components |
| `@duckcodeailabs/dql-connectors` | Database connector layer |

---

## What This Repo Does Not Include

- Natural-language / agentic block generation
- MCP runtime
- Approvals, run history, or product orchestration

Those remain part of the closed DuckCode product.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).
