# Architecture overview

DQL is a pnpm + Turbo monorepo. The runtime is a small set of focused
packages; the two user-facing surfaces are the CLI and the notebook.

## Packages

| Package | Role |
| --- | --- |
| `@duckcodeailabs/dql-core` | Lexer, parser, AST, semantic resolution, lineage, canonical format |
| `@duckcodeailabs/dql-compiler` | IR + Vega-Lite / HTML emitters |
| `@duckcodeailabs/dql-runtime` | Query execution, param binding, result shaping |
| `@duckcodeailabs/dql-connectors` | 15 warehouse drivers with introspection |
| `@duckcodeailabs/dql-governance` | Lint rules, certification gates |
| `@duckcodeailabs/dql-project` | SQLite-backed project registry & manifest cache |
| `@duckcodeailabs/dql-lsp` | Language server for editor integrations |
| `@duckcodeailabs/dql-charts` | Chart spec resolution |
| `@duckcodeailabs/dql-ui` | Shared design tokens + primitives (v0.10) |

## Apps

| App | Role |
| --- | --- |
| `@duckcodeailabs/dql-cli` | Single `dql` binary — `init / compile / notebook / diff / …` |
| `dql-notebook` | Vite + React 18 browser-first notebook |
| `vscode-extension` | `.dql` syntax, validation, preview in VS Code |
| `docs` | Plain-markdown docs (this folder) |

## Data flow

```
user edits .dql file
        │
        ▼
  dql-core parser ─────────────▶ AST
        │                         │
        │                         ▼
        │                   dql-governance (lint)
        │                         │
        ▼                         ▼
   dql-compiler IR ────▶ dql-runtime ────▶ warehouse (via dql-connectors)
        │                    │
        ▼                    ▼
  HTML dashboard         notebook result
        │                    │
        └──────┬─────────────┘
               ▼
        lineage DAG (dql-core)
               │
               ▼
        OpenLineage events
```

## Where data lives

| Data | Storage |
| --- | --- |
| Source `.dql` files | Git |
| Project manifest cache | `.dql/cache/manifest.sqlite` (better-sqlite3) |
| Run snapshots | Sibling `<notebook>.run.json` (git-ignored) |
| Block registry | `.dql/registry.sqlite` |
| Query results | In-memory; never persisted unless snapshotted |

Nothing requires a hosted DB. DQL is fully local-first.
