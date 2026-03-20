# FAQ

## What is DQL?

DQL is an open language for defining durable analytics assets in Git. A DQL block can combine metadata, SQL, parameters, visualization settings, and test assertions in one reusable file.

## Does DQL require DuckCode Studio?

No. DQL works standalone.

You can scaffold a local project, validate blocks, preview charts, and build bundles directly with the DQL CLI.

## Can I preview visualizations locally?

Yes.

The recommended local flow is:

```bash
dql init my-dql-project
cd my-dql-project
dql new block "Pipeline Health"
dql preview blocks/pipeline_health.dql --open
```

This uses local sample data and the built-in preview server.

## Do I need a cloud warehouse to try DQL?

No.

The easiest first-run experience uses local CSV or Parquet data with the `file` or `duckdb` connector path. That is the recommended open-source evaluation flow.

## What is the difference between `custom` and `semantic` blocks?

- `type = "custom"` means the block executes SQL declared in the block itself.
- `type = "semantic"` means the block references a semantic-layer metric and should not contain its own SQL query.

If you are starting fresh, use `custom` blocks first.

## What syntax should I start with?

For open-source adoption, start with the reusable block syntax shown in the starter template.

DQL also supports dashboard and chart-call syntax, but the easiest first path is:

- `block { ... }`
- local data
- `dql preview`

## Can DQL be used from code, not just the CLI?

Yes.

The repo provides reusable packages for parsing, compiling, rendering, registry management, connectors, governance, and editor integration.

Good entry points:

- `@duckcodeailabs/dql-core`
- `@duckcodeailabs/dql-compiler`
- `@duckcodeailabs/dql-runtime`
- `@duckcodeailabs/dql-connectors`

## What commands are most important for a new user?

Start with these:

- `dql init`
- `dql doctor`
- `dql parse`
- `dql preview`
- `dql build`
- `dql serve`

These cover setup, validation, experimentation, and sharing.

## Does `dql test` execute assertions against a real database?

It can, but only when a working execution path is configured.

Without a runnable database connection, test flows are limited to structural discovery or dry-run behavior. For first-time local exploration, focus on `parse`, `preview`, `build`, and `serve` first.

## What is not included in the open DQL repo?

This repo does not include:

- notebook coworker UI
- natural-language or agentic product flows
- MCP runtime
- approval workflows and product orchestration

Those are separate from the standalone open-source DQL language/tooling layer.

## How is DQL different from dbt?

dbt is primarily a transformation workflow and semantic modeling system.

DQL is focused on durable analytics answer assets: blocks that package query logic, parameters, visualization, and tests into reusable artifacts.

Many teams can use both together rather than choosing one over the other.

## How do I get started fastest?

Use this sequence:

```bash
dql init my-dql-project
cd my-dql-project
dql doctor
dql new block "Pipeline Health"
dql preview blocks/pipeline_health.dql --open
```

Then read:

- [Getting Started](./getting-started.md)
- [Examples](./examples.md)
- [Project Config](./project-config.md)
- [Data Sources](./data-sources.md)
