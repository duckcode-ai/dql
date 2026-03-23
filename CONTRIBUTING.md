# Contributing to DQL

Thank you for your interest in DQL. Contributions that improve the language, tooling, connectors, or documentation are welcome.

---

## Scope

This repository covers the open DQL layer:

- Language core: lexer, parser, AST, semantic analysis, formatter
- Compiler: IR lowering, HTML/React code generation
- Runtime: browser data fetching and hot-reload
- Connectors: database driver abstraction (DuckDB, Postgres, BigQuery, Snowflake, etc.)
- Governance: certification rules and cost estimation
- LSP: language server for VS Code and compatible editors
- Project: Git-backed block registry and project primitives
- CLI: `dql` commands
- Docs and examples

Please do **not** open issues here for DuckCode product behavior, closed notebook UX features, or agentic orchestration workflows. Those belong to the closed product repository.

---

## Development Setup

Requires Node.js 18, 20, or 22 and pnpm 9.

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
pnpm test
```

The repo uses [Turborepo](https://turbo.build/) for incremental builds. After the first full build, `pnpm build` only rebuilds changed packages.

### Running a single package

```bash
pnpm --filter @duckcodeailabs/dql-core build
pnpm --filter @duckcodeailabs/dql-core test
```

### Running the notebook dev server

```bash
pnpm --filter dql-notebook dev      # Vite dev server on port 5173
pnpm --filter @duckcodeailabs/dql-cli start  # CLI server on port 3000
```

---

## Project Structure

```
apps/
  cli/                   dql CLI entry point
  dql-notebook/          React notebook UI (Vite)
  vscode-extension/      VS Code extension package
packages/
  dql-core/              Lexer, parser, AST, semantic layer, formatter
  dql-compiler/          IR lowering and code generation
  dql-runtime/           Browser runtime
  dql-connectors/        Database driver layer
  dql-governance/        Certification and cost rules
  dql-lsp/               Language server
  dql-project/           Git-backed registry
  dql-notebook/          Notebook document model and execution helpers
  dql-charts/            React SVG chart components
docs/                    All documentation
```

---

## Pull Requests

- Keep changes focused on the public DQL surface.
- Add or update tests when behavior changes.
- Update docs or examples when syntax or CLI workflow changes.
- Run `pnpm build && pnpm test` before opening a PR.
- Fill out the PR template completely — especially the "Release Impact" section.

### Commit style

Use conventional commit prefixes:
- `feat:` — new feature or behavior
- `fix:` — bug fix
- `docs:` — documentation only
- `chore:` — build, release, or maintenance

---

## Good First Issues

Look for issues tagged [`good first issue`](https://github.com/duckcode-ai/dql/issues?q=label%3A%22good+first+issue%22) on GitHub. These are scoped tasks with clear acceptance criteria.

Common contribution areas:
- Adding a new database connector driver in `packages/dql-connectors/`
- Improving error messages from the parser (`packages/dql-core/src/parser/`)
- Extending test coverage for edge cases in governance rules
- Adding examples or improving existing documentation

---

## Versioning

DQL follows [Semantic Versioning](https://semver.org/):

- **Patch** (`0.x.Y`): bug fixes, documentation, internal improvements
- **Minor** (`0.X.0`): new features, new commands, new language constructs (backwards-compatible)
- **Major** (`X.0.0`): breaking changes to the language syntax, CLI flags, or public package APIs

All packages in this monorepo are released together on the same version cadence.

---

## Release Readiness

Before treating a change as OSS-ready, review the launch checklist:

- [`docs/oss-readiness-checklist.md`](./docs/oss-readiness-checklist.md)
- [`docs/publishing.md`](./docs/publishing.md)
