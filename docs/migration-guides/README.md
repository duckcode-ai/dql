# Migration Guides

These guides help you move existing analytics assets into DQL using the current open-source workflow.

The OSS migration path today is intentionally practical and manual-first:

- use your existing SQL, metrics, or saved queries as source material
- scaffold a DQL block or semantic block
- validate it with `dql parse`
- preview it locally when applicable
- add tests and metadata before wider reuse

## Guides

- [Raw SQL to DQL](./raw-sql.md)
- [dbt Metric to Semantic Block](./dbt.md)
- [Saved BI Query to DQL Block](./saved-bi-query.md)

## Related CLI Command

You can also use:

```bash
dql migrate raw-sql
dql migrate dbt --input ./my-dbt-project
dql migrate metabase
```

In the open-source CLI, `dql migrate` is scaffold-only. It provides a starting point, not a full automatic migration.
