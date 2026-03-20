# `@duckcodeailabs/dql-cli`

Official command-line interface for DQL.

Use the CLI to scaffold projects, validate blocks, preview charts locally, and build static bundles without DuckCode Studio.

## Install

```bash
npm install -g @duckcodeailabs/dql-cli
```

Or run it without a global install:

```bash
npx @duckcodeailabs/dql-cli --help
```

## Quick Start

```bash
dql init my-dql-project
cd my-dql-project
dql new block "Pipeline Health"
dql new semantic-block "ARR Growth"
dql new dashboard "Revenue Overview"
dql doctor
dql preview blocks/pipeline_health.dql --open
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
