# __PROJECT_NAME__

This starter gives you a local-first DQL project that is ready for parsing,
previewing, notebook exploration, and experimentation.

```text
blocks/
data/
dql.config.json
notebooks/
semantic-layer/
  metrics/
  dimensions/
  hierarchies/
```

## Quick Start

```bash
dql doctor
dql notebook
dql new block "Pipeline Health"
dql parse blocks/pipeline_health.dql
dql preview blocks/pipeline_health.dql --open
dql build blocks/pipeline_health.dql
dql serve dist/pipeline_health
```

## What's Included

- `blocks/` — example charted and query-only DQL blocks
- `data/` — sample revenue CSV for local DuckDB/file preview flows
- `dql.config.json` — starter project configuration
- `notebooks/welcome.dqlnb` — guided notebook walkthrough for the browser notebook
- `semantic-layer/` — example metrics, dimensions, hierarchies, and companion metadata

## Adopt the Starter Safely

- start in local file mode first
- keep sample datasets under `data/`
- run `dql doctor` before previewing if setup feels off
- add tests to every reusable block

## Next Steps

- [Getting Started](https://github.com/duckcodeailabs/dql/blob/main/docs/getting-started.md) — full install options, tutorials, and your first block
- [Authoring Blocks](https://github.com/duckcodeailabs/dql/blob/main/docs/authoring-blocks.md) — create, validate, certify, and commit custom and semantic blocks
- [Semantic Layer Guide](https://github.com/duckcodeailabs/dql/blob/main/docs/semantic-layer-guide.md) — define metrics, dimensions, and cubes in YAML
