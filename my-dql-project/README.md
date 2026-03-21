# my-dql-project

This starter gives you a local-first DQL project that is ready for parsing,
previewing, and experimentation.

```text
blocks/
dashboards/
data/
dql.config.json
workbooks/
semantic-layer/
  metrics/
  dimensions/
  hierarchies/
  blocks/
```

## Quick Start

```bash
dql doctor
dql new block "Pipeline Health"
dql new semantic-block "ARR Growth"
dql new dashboard "Revenue Overview"
dql new workbook "Quarterly Review"
dql parse blocks/pipeline_health.dql
dql preview blocks/pipeline_health.dql --open
dql build blocks/pipeline_health.dql
dql serve dist/pipeline_health
```

## What's Included

- `blocks/` — example charted and query-only DQL blocks
- `dashboards/` — empty folder for dashboard scaffolds
- `data/` — sample revenue CSV for local DuckDB/file preview flows
- `dql.config.json` — starter project configuration
- `workbooks/` — empty folder for workbook scaffolds
- `semantic-layer/` — example metrics, dimensions, hierarchies, and companion metadata

## Adopt the Starter Safely

- start in local file mode first
- keep sample datasets under `data/`
- run `dql doctor` before previewing if setup feels off
- add tests to every reusable block

## Learn More

- See the main DQL documentation for `project-config` and `data-sources` guidance.
