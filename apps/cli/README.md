# `@duckcodeailabs/dql-cli`

Official command-line interface for DQL.

Use the CLI to scaffold projects, validate blocks, preview charts locally, and build static bundles without DuckCode Studio.

## Install

For local preview with file/DuckDB-backed starter data, use Node 18, 20, or 22 LTS. If you change Node versions after installing dependencies, rerun `pnpm install` so native modules are rebuilt for the active runtime.

```bash
npm install -g @duckcodeailabs/dql-cli
```

Or run it without a global install:

```bash
npx @duckcodeailabs/dql-cli --help
```

From this repo, you can also run:

```bash
pnpm exec dql --help
```

## Quick Start

These commands assume `dql` is installed globally. From a source checkout, use `pnpm exec dql` from the repo root or `../node_modules/.bin/dql` from the generated project.

```bash
dql init my-dql-project
cd my-dql-project
dql doctor
dql notebook
```

If you want the dbt-integrated starter instead, use the Jaffle Shop semantic-layer course repo:

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
pip install dbt-duckdb && dbt deps && dbt build --profiles-dir .
npm install -g @duckcodeailabs/dql-cli
dql init .
dql notebook
```

## Core Commands

- `dql init [directory]` — create a starter DQL project
- `dql new block <name>` — scaffold a new DQL block in the current project
- `dql new semantic-block <name>` — scaffold a semantic block plus companion YAML files
- `dql new dashboard <name>` — scaffold a new dashboard in `dashboards/`
- `dql new workbook <name>` — scaffold a new workbook in `workbooks/`
- `dql doctor [path]` — check local setup, config, and starter folders
- `dql parse <file.dql>` — parse and validate a DQL block
- `dql fmt <file.dql>` — format a DQL file
- `dql test <file.dql>` — run DQL assertions
- `dql certify <file.dql>` — run certification checks
- `dql preview <file.dql>` — preview a block in the browser
- `dql build <file.dql>` — build a static bundle in `dist/`
- `dql serve [directory]` — serve a built bundle locally

## Learn More

- Root docs: [`../../README.md`](../../README.md)
- Getting started: [`../../docs/getting-started.md`](../../docs/getting-started.md)
- CLI reference: [`../../docs/cli-reference.md`](../../docs/cli-reference.md)
- Project config: [`../../docs/project-config.md`](../../docs/project-config.md)
