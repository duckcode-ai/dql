# `@duckcodeailabs/dql-cli`

Official command-line interface for DQL.

Use the CLI to scaffold projects, validate blocks, preview charts locally, and build static bundles without DuckCode Studio.

## Install

For local preview with file/DuckDB-backed starter data, use Node 20 or 22 LTS. Node 23 is not supported for native local drivers. If you change Node versions after installing dependencies, rerun `npm install` or `pnpm install` so native modules are rebuilt for the active runtime.

```bash
npm i -D @duckcodeailabs/dql-cli
```

Or run it without adding a dependency:

```bash
npx @duckcodeailabs/dql-cli --help
```

From this repo, you can also run:

```bash
pnpm exec dql --help
```

## Quick Start

These commands use the project-local CLI installed by the starter templates.

```bash
npx create-dql-app@latest my-dql-project
cd my-dql-project
npm install
npm run doctor
npm run notebook
```

If you want the dbt-integrated starter instead, use the Jaffle Shop semantic-layer course repo:

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
pip install dbt-duckdb && dbt deps && dbt build --profiles-dir .
npm i -D @duckcodeailabs/dql-cli
npx dql init .
npx dql semantic import dbt .
npm run notebook
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
- `dql validate [path]` — validate DQL files and semantic references
- `dql certify <file.dql>` — run certification checks
- `dql preview <file.dql>` — preview a block in the browser
- `dql build <file.dql>` — build a static bundle in `dist/`
- `dql serve [directory]` — serve a built bundle locally

## Learn More

- Root docs: [`../../README.md`](../../README.md)
- Quickstart: [`../../docs/01-quickstart.md`](../../docs/01-quickstart.md)
- CLI reference: [`../../docs/reference/cli.md`](../../docs/reference/cli.md)
- Project config: [`../../docs/reference/file-formats.md`](../../docs/reference/file-formats.md)
