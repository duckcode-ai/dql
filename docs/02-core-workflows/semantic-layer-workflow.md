# Semantic Layer Workflow

Use the semantic layer when you want governed metrics and dimensions instead of rewriting logic in every query.

## Typical Flow

1. Choose the provider mode
2. Import or define semantic assets
3. Validate the semantic catalog
4. Browse metrics and dimensions in the notebook
5. Compose blocks and queries from semantic selections

## Provider Modes

- `dql` for local YAML assets
- `dbt` for dbt semantic models
- `cubejs` for Cube.js models
- `snowflake` for Snowflake semantic views

## Common Commands

```bash
dql semantic import dbt .
dql doctor
```

## Read Next

- [Semantic Layer Guide](../semantic-layer-guide.md)
- [dbt + Jaffle Shop Walkthrough](../01-start-here/dbt-jaffle-shop.md)
