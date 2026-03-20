# Semantic Block Example

This example shows the structure of a semantic DQL block paired with semantic-layer YAML.

## What it demonstrates

- `type = "semantic"`
- metric references instead of inline SQL
- companion semantic-layer metadata files

## Recommended commands

```bash
cd dql/examples/semantic-block
dql doctor
dql parse blocks/arr_growth.dql
dql info blocks/arr_growth.dql
```

## Note

This example is designed to explain the semantic contract and project layout. For the easiest runnable preview experience, start with `finance-kpi`, `dashboard-local`, or `duckdb-local` first.
