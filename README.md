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

All docs live in [`docs/`](./docs/) — plain markdown, rendered on github.com.
Start with [docs/README.md](./docs/README.md).

Quick links:

- [Quickstart](./docs/01-quickstart.md) · [Concepts](./docs/02-concepts.md) · [Install](./docs/03-install.md)
- [Jaffle Shop walkthrough](./docs/guides/jaffle-shop.md) · [Import dbt](./docs/guides/import-dbt.md) · [Author a block](./docs/guides/authoring-blocks.md)
- [CLI reference](./docs/reference/cli.md) · [Language reference](./docs/reference/language.md) · [Connectors](./docs/reference/connectors.md)
- [Architecture](./docs/architecture/overview.md) · [Contributing](./docs/contribute/repo-layout.md)

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

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/contribute/repo-layout.md](./docs/contribute/repo-layout.md). Bugs and feature requests: [open an issue](https://github.com/duckcode-ai/dql/issues).

## License

[Apache-2.0](./LICENSE).
