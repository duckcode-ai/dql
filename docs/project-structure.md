# Project Structure

The public DQL workflow is Git-native. A minimal project should look like this:

```text
my-dql-project/
  blocks/
    revenue_by_segment.dql
  semantic-layer/
    revenue.yaml
  notebooks/
    README.md
```

## Conventions

- `blocks/` holds durable reusable DQL blocks.
- `semantic-layer/` defines metrics, dimensions, and hierarchies.
- `notebooks/` can store rendered outputs or human-authored analysis, but notebook orchestration is not part of this OSS repo.

## Recommended workflow

1. Author or update a block in `blocks/`.
2. Validate it with the CLI.
3. Add or update semantic definitions in `semantic-layer/`.
4. Commit changes through normal Git review.
