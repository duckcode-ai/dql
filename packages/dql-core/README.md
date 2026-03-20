# `@duckcodeailabs/dql-core`

Core language package for DQL.

It contains the lexer, parser, AST, semantic analysis, diagnostics, and formatter used by the CLI, compiler, and editor tooling.

## Install

```bash
pnpm add @duckcodeailabs/dql-core
```

## Example

```ts
import { parse, analyze } from '@duckcodeailabs/dql-core';

const source = `
block revenue_by_segment {
  type = "custom"
  title = "Revenue by Segment"

  query = <<SQL
    select segment, sum(revenue) as revenue
    from revenue
    group by 1
  SQL
}
`;

const ast = parse(source, 'blocks/revenue_by_segment.dql');
const diagnostics = analyze(ast);

console.log(ast.statements.length);
console.log(diagnostics);
```

## Common Uses

- power editor tooling and syntax validation
- build custom DQL linters or formatters
- inspect DQL ASTs programmatically

## Learn More

- Language spec: [`../../docs/dql-language-spec.md`](../../docs/dql-language-spec.md)
- Root docs: [`../../README.md`](../../README.md)
