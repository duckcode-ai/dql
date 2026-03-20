# `@duckcodeailabs/dql-charts`

React chart and content component library for DQL.

It provides reusable chart renderers, themes, layout primitives, and notebook-style content blocks for building UI around compiled DQL results.

## Install

```bash
pnpm add @duckcodeailabs/dql-charts react react-dom
```

## Example

```tsx
import { BarChart } from '@duckcodeailabs/dql-charts';

export function RevenueChart() {
  return (
    <BarChart
      width={720}
      height={360}
      data={[
        { segment: 'Enterprise', revenue: 120000 },
        { segment: 'SMB', revenue: 64000 },
      ]}
      x="segment"
      y="revenue"
    />
  );
}
```

## Common Uses

- embed DQL chart components in React apps
- reuse theme primitives across analytics views
- render chart, table, note, and narrative blocks consistently

## Learn More

- Root docs: [`../../README.md`](../../README.md)
