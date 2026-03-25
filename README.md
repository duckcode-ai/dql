# DQL

[![CI](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml/badge.svg)](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@duckcodeailabs/dql-cli?label=dql-cli)](https://www.npmjs.com/package/@duckcodeailabs/dql-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022-green)](https://nodejs.org)

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
dql init .
dql doctor
dql notebook
```

→ **[Full getting started guide with the Jaffle Shop dbt project](./docs/getting-started.md)**

### 5-Minute Start

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
pip install dbt-duckdb && dbt deps && dbt build --profiles-dir .
npm install -g @duckcodeailabs/dql-cli
dql init . && dql notebook
```

→ **[Quickstart — zero to running notebook in 5 minutes](./docs/quickstart.md)**

### Library packages (for embedding in your app)

```bash
npm install @duckcodeailabs/dql-core@0.8.0 @duckcodeailabs/dql-compiler@0.8.0 @duckcodeailabs/dql-notebook@0.8.0
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

Use `ref("block_name")` to declare explicit dependencies between blocks:

```dql
block "Executive Summary" {
    domain = "executive"
    query  = """
        SELECT * FROM ref("revenue_by_segment")
        WHERE revenue > 10000
    """
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

## Lineage & Trust Chains

DQL tracks how data flows from source tables through blocks, semantic metrics, business domains, and charts — the full "trust chain" from raw data to rendered answer.

```bash
dql compile                                          # generate dql-manifest.json
dql compile --dbt-manifest path/to/manifest.json     # import dbt lineage as upstream
dql lineage                                          # full project lineage with data flow DAG
dql lineage raw_orders                               # upstream/downstream for a block
dql lineage orders                                   # smart lookup: resolves to table:orders
dql lineage --table orders                           # explicit table lookup
dql lineage --metric total_revenue                   # explicit metric lookup
dql lineage --domain finance                         # domain-scoped view
dql lineage --impact orders                          # what breaks if this table changes?
dql lineage --trust-chain raw_orders exec_dashboard  # certification at every hop
dql lineage --format json                            # export for CI/integrations
```

Cross-domain flow detection is built in — DQL shows when data crosses team boundaries:

```
  Cross-Domain Flows:
    data -> finance (1 edge(s))
    finance -> executive (1 edge(s))
```

→ **[Lineage guide — ref(), trust chains, impact analysis, cross-domain flows](./docs/lineage.md)**

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

Four provider modes are supported:

| Provider | Source | Use when |
|---|---|---|
| `dql` (default) | Local `semantic-layer/` YAML files | Standalone projects, getting started |
| `dbt` | dbt `models/**/*.yml` semantic models | You already use dbt for transformations |
| `cubejs` | Cube.js `model/` or `schema/` definitions | You already use Cube for your semantic layer |
| `snowflake` | Snowflake semantic views (live connection) | You use Snowflake as your semantic layer |

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

## Getting Started with dbt

DQL is the **answer layer for dbt**. The recommended getting-started path uses the [Jaffle Shop](https://github.com/dbt-labs/Semantic-Layer-Online-Course) dbt project — a real dataset with models, metrics, and a semantic layer.

`dql init` auto-detects dbt projects and DuckDB files, scaffolding a minimal DQL project on top of your existing data.

→ **[Getting started — full walkthrough with Jaffle Shop](./docs/getting-started.md)**

---

## CLI Reference

Every command has a clear job:

| Command | What it does |
|---|---|
| `dql init` | Initialize DQL in a project (auto-detects dbt) |
| `dql notebook` | Open the browser notebook for interactive SQL exploration |
| `dql new block` | Create a new `.dql` block file |
| `dql new notebook` | Create a new `.dqlnb` notebook file |
| `dql parse` | Validate syntax and run semantic analysis |
| `dql preview` | Compile and serve a block locally with live data |
| `dql build` | Compile to a static HTML bundle |
| `dql serve` | Serve a built bundle locally |
| `dql certify` | Check governance rules (owner, description, tags, domain) |
| `dql compile` | Generate project manifest (`dql-manifest.json`) with lineage and dependencies |
| `dql lineage` | Show data lineage, trust chains, impact analysis, cross-domain flows |
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

- **Explore a dbt project interactively** → `dql init` + `dql notebook`
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
| [Getting Started](./docs/getting-started.md) | Full walkthrough with Jaffle Shop dbt project |

### Core Workflows

| Guide | What it covers |
|---|---|
| [Notebook Guide](./docs/notebook.md) | Cell types, param widgets, variable refs, export |
| [Authoring Blocks](./docs/authoring-blocks.md) | Create, test, certify, and commit .dql blocks (custom + semantic) |
| [Lineage & Trust Chains](./docs/lineage.md) | ref() system, cross-domain flows, impact analysis, trust chains |
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
| [Use Cases](./docs/use-cases.md) | Recommended paths by goal |
| [Examples](./docs/examples.md) | Suggested learning path and block examples |
| [Why DQL](./docs/why-dql.md) | The problem, before/after, personas, DQL vs alternatives |

### Help & Compatibility

| Guide | What it covers |
|---|---|
| [FAQ](./docs/faq.md) | Common questions about scope, notebook, and compatibility |
| [Compatibility](./docs/compatibility.md) | Runtime, connector, and workflow support matrix |
| [Roadmap](./ROADMAP.md) | Planned features and known limitations |
| [Security](./SECURITY.md) | Vulnerability reporting and credential handling |

---

## Package Reference

All packages share a unified version number (`0.8.0`).

| Package | Description |
|---|---|
| `@duckcodeailabs/dql-cli` | Public CLI — `dql init`, `dql notebook`, `dql lineage`, `dql preview`, `dql parse`, … |
| `@duckcodeailabs/dql-core` | Lexer, parser, AST, semantic analysis, semantic layer, lineage engine, formatter |
| `@duckcodeailabs/dql-compiler` | IR lowering, ref() resolution, HTML/React/runtime code generation |
| `@duckcodeailabs/dql-governance` | Certification rules, cost estimation |
| `@duckcodeailabs/dql-project` | Git-backed block registry and project primitives |
| `@duckcodeailabs/dql-notebook` | Notebook document model and execution helpers |
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

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, code style, and PR guidelines.

Areas where help is most useful:
- New database connector drivers
- Additional semantic layer providers
- Language spec improvements and test coverage
- Documentation and examples

---

## Community and Support

- **Bugs and feature requests** — [open a GitHub issue](https://github.com/duckcode-ai/dql/issues)
- **Questions and discussion** — [GitHub Discussions](https://github.com/duckcode-ai/dql/discussions)
- **Roadmap** — see [ROADMAP.md](./ROADMAP.md) for planned work and known limitations

This project follows standard GitHub community norms. Please be respectful in all interactions.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).
