# Contributing to DQL

Thank you for your interest in contributing. This guide covers everything you need to go from a fresh clone to an open pull request.

DQL is the open-source language and tooling layer for declarative analytics blocks. Contributions should improve authoring, parsing, compilation, project structure, governance, connectors, or editor support. Please do not open issues here for DuckCode Studio product behavior, notebook UX, or agentic workflows — those belong to the closed product repository.

---

## Dev setup

**Requirements:** Node.js 18+, pnpm 9+.

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install      # install all workspace dependencies
pnpm build        # compile all packages and apps (tsc + esbuild)
pnpm test         # run the full test suite
```

The build order is managed by Turborepo (`turbo.json`). `pnpm build` resolves package-level dependencies automatically.

Verify the CLI is working:

```bash
pnpm exec dql --help
```

---

## Repo structure

```
apps/
  cli/                    Public DQL CLI (@duckcodeailabs/dql-cli)
    src/
      commands/           One file per command: parse.ts, certify.ts, fmt.ts, test.ts, ...
      args.ts             Shared argument parsing (yargs)
      index.ts            CLI entry point

  vscode-extension/       DQL Language Support VS Code extension

packages/
  dql-core/               Lexer, parser, AST, semantic analyser, formatter
    src/
      lexer/              Tokeniser (token.ts, lexer.ts)
      parser/             Recursive-descent parser (parser.ts)
      ast/                AST node types (nodes.ts)
      semantic/           Semantic analysis and diagnostics (analyzer.ts)
      formatter/          Canonical formatter

  dql-compiler/           IR lowering and code generation
    src/
      ir/                 Intermediate representation (ir-nodes.ts, lowering.ts)
      charts/             Per-chart-type IR handlers
      codegen/            Emitters: html-emitter.ts, react-emitter.ts, runtime-emitter.ts

  dql-governance/         Block testing and certification
    src/
      certifier.ts        Certification rule engine
      test-runner.ts      Assertion execution against DuckDB

  dql-project/            Git-backed block registry and project primitives
  dql-lsp/                Language Server Protocol implementation
  dql-runtime/            Browser runtime (DuckDB-WASM, Vega rendering, hot-reload)
  dql-charts/             visx-powered React chart components

examples/                 Annotated example .dql files
templates/                Starter project template
docs/                     Public documentation
```

---

## Running tests

Run the full test suite from the root:

```bash
pnpm test
```

Run tests for a specific package using Turborepo's `--filter` flag:

```bash
pnpm test --filter @duckcodeailabs/dql-compiler
pnpm test --filter @duckcodeailabs/dql-core
pnpm test --filter @duckcodeailabs/dql-governance
```

Run a single test file directly with Vitest:

```bash
cd packages/dql-compiler
pnpm exec vitest run src/charts/charts.test.ts

cd packages/dql-core
pnpm exec vitest run src/parser/parser.test.ts
```

Watch mode during development:

```bash
cd packages/dql-core
pnpm exec vitest
```

---

## How to add a new chart type

Adding a new chart type requires changes in three places.

**Step 1 — Add the chart handler file**

Create `packages/dql-compiler/src/charts/<name>.ts`. Follow the pattern of an existing simple chart such as `sparkline.ts`:

```typescript
import type { ChartBlock } from '../ir/ir-nodes.js';

export function lowerMyChart(block: ChartBlock): VegaLiteSpec {
    return {
        $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
        mark: { type: 'point' },   // replace with the appropriate mark type
        encoding: {
            x: { field: block.visualization?.x, type: 'temporal' },
            y: { field: block.visualization?.y, type: 'quantitative' },
        },
    };
}
```

**Step 2 — Export from the charts index**

Open `packages/dql-compiler/src/charts/index.ts` and add the export:

```typescript
export { lowerMyChart } from './my-chart.js';
```

**Step 3 — Register in `registerAllCharts()`**

Open `packages/dql-compiler/src/charts/index.ts` and add your type to the `registerAllCharts` registry map:

```typescript
registry.set('chart.my-chart', lowerMyChart);
```

Then add the new type string to the semantic analyser's known chart types list in `packages/dql-core/src/semantic/analyzer.ts` so that `dql parse` recognises it instead of emitting an "unrecognised chart type" warning.

Finally, add tests in `packages/dql-compiler/src/charts/charts.test.ts` and update the chart type table in `README.md` and `docs/dql-language-reference.md`.

---

## Code style

- **TypeScript strict mode** — all packages use `"strict": true`. No `any` types; use `unknown` and narrow explicitly.
- **ESM imports** — use `.js` extensions on all relative imports (TypeScript's ESM convention). Example: `import { parse } from './parser.js'`.
- **No barrel re-exports that import side effects** — keep `index.ts` files to explicit named re-exports.
- **Test file convention** — test files live next to the source they test and are named `<module>.test.ts`. Use Vitest.
- **Formatting** — run `pnpm exec prettier --write .` before committing. A CI check enforces formatting on pull requests.

---

## PR process

### Branch naming

```
feat/<short-description>        New feature
fix/<short-description>         Bug fix
docs/<short-description>        Documentation only
refactor/<short-description>    Code change with no behaviour change
test/<short-description>        Test additions or fixes
```

Examples: `feat/sankey-chart`, `fix/certifier-empty-tags`, `docs/cli-reference-test-flag`.

### Before opening a PR

```bash
pnpm build                        # must pass
pnpm test                         # must pass
pnpm exec prettier --check .      # must pass
dql parse examples/blocks/*.dql   # must pass
```

### PR description template

```markdown
## What does this PR do?

<!-- One paragraph summary. -->

## Why?

<!-- Motivation. Link to an issue if one exists. -->

## How to test

<!-- Steps for a reviewer to verify the change. -->

## Checklist

- [ ] Tests added or updated
- [ ] Docs updated if syntax or CLI behavior changed
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
```

### Review expectations

- All PRs require at least one approving review.
- CI must be green (build, test, format check).
- Keep PRs focused — one logical change per PR makes review faster.
- If a PR changes public API surface (AST node shapes, CLI flags, package exports), note it clearly in the description.

---

## Adding a CLI command

Commands live in `apps/cli/src/commands/`. Each command is a module that exports a Yargs command object. Register it in `apps/cli/src/index.ts`.

Follow the pattern in `apps/cli/src/commands/parse.ts`. Every command should:
1. Accept `--format json|text` (use the shared `addGlobalFlags` helper from `args.ts`).
2. Exit `0` on success, `1` on any error or failed check.
3. Have a corresponding integration test in `apps/cli/tests/` if it produces observable output.

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.
