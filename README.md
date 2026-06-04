# DQL

[![CI](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml/badge.svg)](https://github.com/duckcode-ai/dql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@duckcodeailabs/dql-cli?label=dql-cli)](https://www.npmjs.com/package/@duckcodeailabs/dql-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022-green)](https://nodejs.org)

**A local-first dbt analytics workspace.** Git-native. Certified blocks, Apps,
lineage, and governed agent answers run on your laptop.

DQL sits between **dbt** (modeling) and your BI tool (reporting). Every analytics answer — SQL, chart, params, tests, owner — lives in a single `.dql` file tracked in git. No more query sprawl, no more broken charts, no more lost work.

## Highlights

**OSS Apps for decision work** — package dashboard pages, notebooks, AI pins,
drafts, and certified blocks into local-first App folders that stay in git.

![Apps + persona switching](./docs/media/apps.gif)

**Block Studio with certified blocks** — every block carries owner / domain / tags / `llmContext` / tests, and shows its certification status inline.

![Block Studio + certified flags](./docs/media/studio.gif)

**Full-stack lineage** — `Domain → App → Dashboard → Block → metric → dbt model → source`, rendered as an interactive React Flow + dagre graph.

![Lineage DAG](./docs/media/lineage.gif)

**AI chat + provider setup** — configure OpenAI, Gemini, local Ollama, custom OpenAI-compatible endpoints, Slack, and schedule delivery keys from one Settings surface; missing keys stay optional until selected.

![AI provider settings](./docs/media/agent.gif)

## Get started — under 2 minutes

**Docker** *(recommended — zero local toolchain)*

```bash
git clone https://github.com/duckcode-ai/dql.git && cd dql
docker compose up
```

Notebook on **http://127.0.0.1:3474**. The working directory is mounted at
`/workspace` inside the container. When you run this from the DQL framework
repo, Docker automatically creates and opens the bundled Acme Bank starter at
`.dql/docker-starter/acme-bank`; real DQL project folders with `dql.config.json`
open directly. Add `--profile slack` for the Slack bot or `--profile ollama`
for a local LLM daemon.

**npm** *(Node 20+ already installed)*

```bash
npx create-dql-app@latest acme-bank --template acme-bank
cd acme-bank
npm install
npm run doctor
npm run notebook
```

The starter installs the DQL CLI locally as a dev dependency, so `npm run
notebook`, `npm run compile`, and other scripts work without a global `dql`
binary. Acme Bank is the flagship OSS demo for certified blocks, Apps,
notebooks, lineage, schedules, and local agent context.

Either way, DuckDB runs in-memory. Drop a CSV into `data/`, query it, save a
block, commit.

Already have a **dbt project**? Keep dbt as the modeling source of truth and
keep DQL isolated under `./dql` inside that repo:

```bash
npm i -D @duckcodeailabs/dql-cli
npx dql init ./dql
dbt build
npx dql compile ./dql
npx dql sync dbt ./dql
npx dql notebook ./dql
```

The generated `dql/dql.config.json` points back to the parent dbt project, so
lineage can connect dbt sources/models to DQL blocks, dashboards, and Apps.
In Block Studio, start from a dbt model for SQL blocks, a dbt semantic metric
for semantic blocks, or a one-time SQL import wizard for legacy queries.

## Official demos

- **Acme Bank** — bundled OSS workflow demo for certified blocks, Apps,
  dashboard pages, notebooks, lineage, agent answers, and local schedules.
- **Jaffle Shop DQL** — step-by-step dbt/MetricFlow demo for manifest
  ingestion, semantic metrics, lineage, certified blocks, Apps, tutorials, and
  agent routing:
  [github.com/duckcode-ai/jaffle-shop-dql](https://github.com/duckcode-ai/jaffle-shop-dql).

DQL OSS is a single-user local workspace. Hosted multi-user governance,
managed secrets, audit logs, approval workflows, and permissions-aware team
retrieval belong to the commercial product.

## Documentation

All docs live in [`docs/`](./docs/) — plain markdown, rendered on github.com.
Start with [docs/README.md](./docs/README.md).

Quick links:

- **[Tutorials — Acme Bank end-to-end](./docs/tutorials/README.md)** *(Apps, certified blocks, agentic analytics, Slack, fraud-spike walkthrough)*
- [Quickstart](./docs/01-quickstart.md) · [Concepts](./docs/02-concepts.md) · [Install](./docs/03-install.md)
- [Jaffle Shop walkthrough](./docs/guides/jaffle-shop.md) · [Import dbt](./docs/guides/import-dbt.md) · [Block Studio](./docs/guides/block-studio.md) · [Author a block](./docs/guides/authoring-blocks.md)
- [CLI reference](./docs/reference/cli.md) · [Language reference](./docs/reference/language.md) · [Connectors](./docs/reference/connectors.md)
- [Architecture](./docs/architecture/overview.md) · [Contributing](./docs/contribute/repo-layout.md)

## What's in the box

- **Notebook** — SQL + DQL cells with live results, charts, and params
- **Block Studio** — governed, versioned analytics blocks with lint + certify
- **Apps** — first-class consumption-layer artifact bundling dashboard pages,
  notebooks, AI pins, drafts, local metadata, and schedules for a domain or use
  case
- **Local policy + RLS preview** — optional single-user preview path for
  commercial governance patterns; `@rls("col", "{user.var}")` resolves at
  execution time from the active local persona when configured
- **Agentic analytics** — `@duckcodeailabs/dql-agent` ships a
  local SQLite + FTS5 knowledge graph, Skills, a block-first answer loop, and
  pluggable LLM providers (Claude / OpenAI / Gemini / local Ollama)
- **MCP server** — 10 tools (`search_blocks`, `get_block`, `query_via_block`,
  `list_metrics`, `list_dimensions`, `lineage_impact`, `certify`,
  `suggest_block`, `kg_search`, `feedback_record`)
- **Slack front-end** — `dql slack serve` runs a slash-command
  bot answering via the same block-first loop, with feedback buttons that
  feed self-learning
- **`dql verify`** — proves `dql-manifest.json` is reproducible
  from source for CI gates
- **Semantic layer** — import dbt metrics/dimensions; author your own
- **Lineage DAG** — Domain · App · Dashboard · Block · metric · dbt model · source granularity with impact analysis
- **Git-native format** — canonical `.dql` serialization, `dql diff`, in-app git panel
- **15 connectors** — Postgres, DuckDB, Snowflake, BigQuery, Redshift, MySQL, and more
- **VS Code extension** — syntax, snippets, LSP (`code --install-extension dql.dql-language-support`)

## What this repo does **not** include

Real authentication (login screens, OIDC, password storage), hosted/multi-tenant
deployment, enforced organization RBAC, governed secrets, audit logs, and
managed approval workflows live outside OSS. Local persona/policy preview,
agentic block generation, MCP runtime, and scheduled runs are included in OSS.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/contribute/repo-layout.md](./docs/contribute/repo-layout.md). Bugs and feature requests: [open an issue](https://github.com/duckcode-ai/dql/issues).

## License

[Apache-2.0](./LICENSE).
