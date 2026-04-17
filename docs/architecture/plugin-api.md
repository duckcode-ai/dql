# Plugin API

> Status: **stable in v1.0**

DQL exposes three stable extension points. Each is a plain npm package that
exports a well-typed entry. No build step hooks, no runtime monkey-patching.

## Custom connectors

Implement `Connector` from `@duckcodeailabs/dql-connectors`:

```ts
export const myConnector: Connector = {
  id: 'my-driver',
  async connect(config) { /* … */ },
  async query(sql, params) { /* … */ },
  async introspect() { /* … */ },
  async close() { /* … */ },
};
```

Register via `cdql.yaml`:

```yaml
plugins:
  connectors:
    - my-company/dql-connector-exasol
```

## Custom chart types

Implement `ChartRenderer` from `@duckcodeailabs/dql-charts`:

```ts
export const sankey: ChartRenderer = {
  id: 'sankey',
  schema: { /* JSON schema for config */ },
  render(result, config) { /* return Vega-Lite spec or React element */ },
};
```

## Governance rule packs

Implement `RulePack` from `@duckcodeailabs/dql-governance`:

```ts
export const hipaaPack: RulePack = {
  id: 'hipaa',
  rules: [
    {
      id: 'no-phi-columns',
      severity: 'error',
      check(block) { /* … */ },
    },
  ],
};
```

Register in `cdql.yaml`:

```yaml
governance:
  rule_packs: ['@my-company/dql-hipaa']
```

## Stability

The three plugin interfaces above are **frozen at v1.0**. Breaking changes
require a major version bump and a 6-month deprecation window.
