# Quickstart

This guide gets you from zero to a working DQL chart preview in a few minutes.

## Goal

By the end of this quickstart you will be able to:

- create a local DQL project
- validate a block
- preview a chart in the browser
- build a static bundle
- serve that bundle locally

## Prerequisites

- Node.js 18+.
- For local preview with the default file/DuckDB runtime, prefer Node 18, 20, or 22 LTS.
- npm or pnpm

## Install the CLI

If you are using a published CLI package:

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

If you are working from source instead:

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
pnpm exec dql --help
```

If you switch Node versions after installing dependencies, rerun `pnpm install` before using `preview` or `serve` so DuckDB native bindings are rebuilt for the active runtime.

## Create a Starter Project

The commands below assume a global `dql` install. If you are working from a source checkout, run `pnpm exec dql` from the repo root, or use `../node_modules/.bin/dql` from inside the generated project.

```bash
dql init my-dql-project
cd my-dql-project
```

The starter project includes:

- `blocks/` with example DQL blocks
- `dashboards/` for dashboard scaffolds
- `data/` with local CSV sample data
- `semantic-layer/` for shared definitions
- `dql.config.json` for preview and connection settings
- `workbooks/` for workbook scaffolds

## Check Your Setup

```bash
dql doctor
```

`dql doctor` verifies the project structure, config file, and local preview assumptions.

## Create a New Block

```bash
dql new block "Pipeline Health"
dql new semantic-block "ARR Growth"
dql new dashboard "Revenue Overview"
dql new workbook "Quarterly Review"
```

Inside a starter project, these create previewable assets in `blocks/`, `dashboards/`, and `workbooks/`, plus semantic-layer starter files for semantic blocks.

## Parse a Block

```bash
dql parse blocks/pipeline_health.dql
```

This validates syntax and semantic structure before you try to render anything.

## Preview a Chart

```bash
dql preview blocks/pipeline_health.dql --open
```

This starts a local preview server, runs the block against the starter data, and opens the rendered chart in your browser.

If port `3474` is already in use, override it explicitly:

```bash
dql preview blocks/pipeline_health.dql --open --port 4474
```

## Build a Static Bundle

```bash
dql build blocks/pipeline_health.dql
```

By default this writes output into:

```text
dist/pipeline_health/
```

## Serve the Built Bundle

```bash
dql serve dist/pipeline_health --open
```

This serves the generated bundle locally so you can test the output outside the preview flow.

## Troubleshooting

- If `zsh: command not found: dql`, either install the CLI globally or run it via `pnpm exec dql` from the repo root or `../node_modules/.bin/dql` from the generated project.
- If `dql doctor` reports that the local query runtime is unavailable for `file` or `duckdb`, switch to Node 18, 20, or 22 and rerun `pnpm install`.
- If `preview` or `serve` fails because the default port is busy, pass `--port <number>`.

## What to Try Next

- edit `blocks/pipeline_health.dql` and change the chart type
- open `blocks/revenue_trend_query_only.dql` and preview a query-only block
- inspect `dql.config.json` and change the preview port
- read [Project Config](./project-config.md)
- read [Data Sources](./data-sources.md)
- browse [Examples](./examples.md)

## Related Docs

- [Getting Started](./getting-started.md)
- [CLI Reference](./cli-reference.md)
- [Project Config](./project-config.md)
- [Data Sources](./data-sources.md)
- [Examples](./examples.md)
