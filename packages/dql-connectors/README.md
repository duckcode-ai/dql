# `@duckcodeailabs/dql-connectors`

Query execution and connector layer for DQL.

It provides connection management, driver normalization, SQL parameter handling, and query execution across supported databases and local engines.

## Install

```bash
pnpm add @duckcodeailabs/dql-connectors
```

## Example

```ts
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';

const executor = new QueryExecutor();

const result = await executor.executePositional(
  'select * from read_csv_auto(?) limit 5',
  ['./data/revenue.csv'],
  { driver: 'file', filepath: ':memory:' },
);

console.log(result.columns);
console.log(result.rows);

await executor.disconnect();
```

## Common Uses

- power local preview with CSV, Parquet, or DuckDB-backed flows
- execute compiled DQL SQL against warehouse connections
- normalize placeholders and parameter values across drivers

## Learn More

- Data sources: [`../../docs/data-sources.md`](../../docs/data-sources.md)
- Project config: [`../../docs/project-config.md`](../../docs/project-config.md)
