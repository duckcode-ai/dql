# @duckcodeailabs/dql-openlineage

OpenLineage event emitter for DQL block and notebook runs.

## Install

```bash
npm i @duckcodeailabs/dql-openlineage
```

## Usage

```ts
import { createEmitter } from '@duckcodeailabs/dql-openlineage';

const emitter = createEmitter({
  url: process.env.OPENLINEAGE_URL,      // http://marquez.internal:5000/api/v1/lineage
  namespace: 'analytics',
});

await emitter.wrap(
  { namespace: 'analytics', name: 'block.revenue_by_segment' },
  crypto.randomUUID(),
  {
    inputs:  [{ namespace: 'analytics', name: 'orders' }],
    outputs: [{ namespace: 'analytics', name: 'block.revenue_by_segment' }],
  },
  async () => {
    // ... run the block ...
  },
);
```

## Config

Resolves from, in order:

1. Explicit args to `createEmitter({ … })`
2. `OPENLINEAGE_URL`, `OPENLINEAGE_NAMESPACE` env vars
3. Disabled (no-op) default

Hard opt-out:

```bash
export DQL_OPENLINEAGE_DISABLED=1
```

## Error policy

Network failures are swallowed (routed to `onError`) so infra issues never
surface to end users. Wrap-mode re-throws *handler* errors after emitting
`FAIL`.

## Compatible receivers

Marquez · DataHub · Atlan · Monte Carlo — anything that speaks the OL spec.
See [docs.duckcode.ai/architecture/openlineage](https://docs.duckcode.ai/architecture/openlineage/).
