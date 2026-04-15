# Lineage Workflow

Use lineage when you need to understand impact, trust, or data flow across blocks and source assets.

## Typical Flow

1. Compile the project manifest
2. Import dbt lineage if needed
3. Inspect upstream and downstream relationships
4. Run impact analysis before making changes

## Commands

```bash
dql compile
dql compile --dbt-manifest target/manifest.json
dql lineage
dql lineage raw_orders
dql lineage --impact orders
```

## Read Next

- [Lineage Guide](../lineage.md)
