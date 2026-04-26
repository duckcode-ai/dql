# DQL

[![CI](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml/badge.svg)](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@duckcodeailabs/dql-cli?label=dql-cli)](https://www.npmjs.com/package/@duckcodeailabs/dql-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022-green)](https://nodejs.org)

**Analytics notebooks on your dbt models.** Git-native. Local-first. Open source.

DQL sits between **dbt** (modeling) and your BI tool (reporting). Every analytics answer — SQL, chart, params, tests, owner — lives in a single `.dql` file tracked in git. No more query sprawl, no more broken charts, no more lost work.

## Get started — under 2 minutes

**Docker** *(recommended — zero local toolchain)*

```bash
git clone https://github.com/duckcode-ai/dql.git && cd dql
docker compose up
```

Notebook on **http://127.0.0.1:3474**. The working directory is mounted at
`/workspace` inside the container, so blocks, notebooks, and Apps you save
land in your repo and stay in git. Add `--profile slack` for the Slack bot
or `--profile ollama` for a local LLM daemon.

**npm** *(Node 20+ already installed)*

```bash
npx create-dql-app my-project
cd my-project
npm install
npm run notebook
```

Either way, DuckDB runs in-memory. Drop a CSV into `data/`, query it,
save a block, commit.

Already have a **dbt project**? Run `create-dql-app` next to it — the
scaffolder auto-detects `dbt_project.yml` as a sibling and wires
`dql.config.json` accordingly. Then `dql sync dbt` imports your manifest.

## Documentation

All docs live in [`docs/`](./docs/) — plain markdown, rendered on github.com.
Start with [docs/README.md](./docs/README.md).

Quick links:

- **[Tutorials — Acme Bank end-to-end](./docs/tutorials/README.md)** *(new in v1.4: Apps, RBAC, agentic analytics, Slack, fraud-spike walkthrough)*
- [Quickstart](./docs/01-quickstart.md) · [Concepts](./docs/02-concepts.md) · [Install](./docs/03-install.md)
- [Jaffle Shop walkthrough](./docs/guides/jaffle-shop.md) · [Import dbt](./docs/guides/import-dbt.md) · [Author a block](./docs/guides/authoring-blocks.md)
- [CLI reference](./docs/reference/cli.md) · [Language reference](./docs/reference/language.md) · [Connectors](./docs/reference/connectors.md)
- [Architecture](./docs/architecture/overview.md) · [Contributing](./docs/contribute/repo-layout.md)

## What's in the box

- **Notebook** — SQL + DQL cells with live results, charts, and params
- **Block Studio** — governed, versioned analytics blocks with lint + certify
- **Apps** *(new in v1.4)* — first-class consumption-layer artifact bundling
  dashboards, members, roles, access policies, RLS bindings, and schedules
  for a domain or team
- **Programmable RBAC + RLS** *(new in v1.4)* — declared in `dql.app.json`,
  enforced via the persona registry; `@rls("col", "{user.var}")` resolves
  at execution time from the active persona
- **Agentic analytics** *(new in v1.4)* — `@duckcodeailabs/dql-agent` ships a
  local SQLite + FTS5 knowledge graph, Skills, a block-first answer loop, and
  pluggable LLM providers (Claude / OpenAI / Gemini / local Ollama)
- **MCP server** — 10 tools (`search_blocks`, `get_block`, `query_via_block`,
  `list_metrics`, `list_dimensions`, `lineage_impact`, `certify`,
  `suggest_block`, `kg_search`, `feedback_record`)
- **Slack front-end** *(new in v1.4)* — `dql slack serve` runs a slash-command
  bot answering via the same block-first loop, with feedback buttons that
  feed self-learning
- **`dql verify`** *(new in v1.4)* — proves `dql-manifest.json` is reproducible
  from source for CI gates
- **Semantic layer** — import dbt metrics/dimensions; author your own
- **Lineage DAG** — Domain · App · Dashboard · Block · metric · dbt model · source granularity with impact analysis
- **Git-native format** — canonical `.dql` serialization, `dql diff`, in-app git panel
- **15 connectors** — Postgres, DuckDB, Snowflake, BigQuery, Redshift, MySQL, and more
- **VS Code extension** — syntax, snippets, LSP (`code --install-extension dql.dql-language-support`)

## What this repo does **not** include

Real authentication (login screens, OIDC, password storage), hosted/multi-tenant
deployment, and approval workflows as a managed service live in the closed
DuckCode Cloud product. *(Note: agentic block generation, MCP runtime, RBAC
declarations, and scheduled runs were previously closed-product — they're now
in OSS as of v1.4.)*

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/contribute/repo-layout.md](./docs/contribute/repo-layout.md). Bugs and feature requests: [open an issue](https://github.com/duckcode-ai/dql/issues).

## License

[Apache-2.0](./LICENSE).
