# Project Structure

The public DQL workflow is Git-native. A minimal project should look like this:

```text
my-dql-project/
  blocks/
    revenue_by_segment.dql
    revenue_trend_query_only.dql
  semantic-layer/
    metrics/
      revenue.yaml
    dimensions/
      segment.yaml
    hierarchies/
      revenue_time.yaml
    blocks/
      revenue_by_segment.yaml
  notebooks/
    README.md
```

## Conventions

- `blocks/` holds durable reusable DQL blocks.
- DQL blocks may be charted or query-only. Query-only blocks keep SQL and tests without requiring a `visualization` section.
- `semantic-layer/metrics/`, `semantic-layer/dimensions/`, and `semantic-layer/hierarchies/` define reusable semantic assets.
- `semantic-layer/blocks/` can hold companion business metadata for blocks such as glossary terms, lineage notes, and semantic mappings.
- `notebooks/` can store rendered outputs or human-authored analysis, but notebook orchestration is not part of this OSS repo.

## Recommended workflow

1. Author or update a block in `blocks/`.
2. Validate it with the CLI.
3. Add or update semantic definitions in `semantic-layer/`.
4. Add or update block companion metadata when business context needs to live beside the executable asset.
5. Commit changes through normal Git review.
