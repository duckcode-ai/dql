# DQL

[![CI](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml/badge.svg)](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@duckcodeailabs/dql-cli?label=dql-cli)](https://www.npmjs.com/package/@duckcodeailabs/dql-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022-green)](https://nodejs.org)

**Analytics notebooks on your dbt models.** Git-native. Local-first. Open source.

DQL sits between **dbt** (modeling) and your BI tool (reporting). Every analytics answer — SQL, chart, params, tests, owner — lives in a single `.dql` file tracked in git. No more query sprawl, no more broken charts, no more lost work.

## Get started — under 2 minutes

```bash
npx create-dql-app my-project
cd my-project
npm install
npm run notebook
```

Your browser opens a notebook at `http://localhost:5173`. DuckDB is running in-memory. Drop a CSV into `data/`, query it, save a block, commit.

Already have a **dbt project**? Run `create-dql-app` next to it — the scaffolder auto-detects `dbt_project.yml` as a sibling and wires `dql.config.json` accordingly. Then `dql sync dbt` imports your manifest.

## Documentation

**📘 [docs.duckcode.ai](https://docs.duckcode.ai)** — the single source of truth.

Quick links:

- [Install](https://docs.duckcode.ai/get-started/install) · [Quickstart](https://docs.duckcode.ai/get-started/quickstart) · [Concepts](https://docs.duckcode.ai/get-started/concepts)
- [Jaffle Shop walkthrough](https://docs.duckcode.ai/guides/jaffle-shop) · [Import dbt](https://docs.duckcode.ai/guides/import-dbt) · [Author a block](https://docs.duckcode.ai/guides/authoring-blocks)
- [CLI reference](https://docs.duckcode.ai/reference/cli) · [Language reference](https://docs.duckcode.ai/reference/language) · [Connectors](https://docs.duckcode.ai/reference/connectors)
- [Architecture](https://docs.duckcode.ai/architecture/overview) · [Contributing](https://docs.duckcode.ai/contribute/repo-layout)

## What's in the box

- **Notebook** — SQL + DQL cells with live results, charts, and params
- **Block Studio** — governed, versioned analytics blocks with lint + certify
- **Semantic layer** — import dbt metrics/dimensions; author your own
- **Lineage DAG** — table · block · notebook granularity with impact analysis
- **Git-native format** — canonical `.dql` serialization, `dql diff`, in-app git panel
- **15 connectors** — Postgres, DuckDB, Snowflake, BigQuery, Redshift, MySQL, and more
- **VS Code extension** — syntax, snippets, LSP (`code --install-extension dql.dql-language-support`)

## What this repo does **not** include

Natural-language / agentic block generation, MCP runtime, hosted workspaces, RBAC, scheduled runs, and alerting all live in the closed DuckCode Cloud product.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [contribute section](https://docs.duckcode.ai/contribute/repo-layout) of the docs site. Bugs and feature requests: [open an issue](https://github.com/duckcode-ai/dql/issues).

## License

[Apache-2.0](./LICENSE).
