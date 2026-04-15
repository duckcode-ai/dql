# Block Authoring Workflow

Blocks are the reusable answer units in DQL.

## Typical Flow

1. Create a block
2. Add SQL or semantic configuration
3. Add visualization settings
4. Add tests and ownership metadata
5. Validate and preview the block
6. Build or serve the result

## Commands

```bash
dql new block "Pipeline Health"
dql parse blocks/pipeline_health.dql
dql certify blocks/pipeline_health.dql
dql preview blocks/pipeline_health.dql --open
dql build blocks/pipeline_health.dql
```

## Use Blocks For

- reusable analytics answers
- governed SQL
- semantic metric views
- certified visual outputs

## Read Next

- [Authoring Blocks](../authoring-blocks.md)
- [DQL Language Spec](../dql-language-spec.md)
