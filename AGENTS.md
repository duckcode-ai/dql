# Agent guide — DQL

Guidance for AI agents (and humans) making changes here. Most of DQL is yours to
evolve freely. The one thing to be careful about is the **shared design
contract** below.

## ⚠️ Shared design contract with Governed Analytics Cloud — do not break

DQL is embedded inside the **Governed Analytics Cloud**, which reskins the
embedded surface to the global theme. DQL already conforms to the shared
contract — keep it that way. The canonical source is the cloud's
`@duckcodeai/design-tokens` package (and `docs/adr/ADR-0002` in the cloud repo).
**Renaming or removing any of the following silently breaks the cloud embed** —
and the cloud's sync runs a contract check (`scripts/embed-contract.test.mjs`)
that will **fail the build** if you do:

1. **Theme selector** — `data-theme` on `<html>`, values **`paper` | `white` |
   `obsidian`**. Keep these blocks in `packages/dql-ui/src/styles/tokens.css`.
2. **Token vocabulary** — the shared semantic vars every surface reads:
   `--bg-0..4`, `--bg-canvas`, `--text-primary/secondary/tertiary/muted`,
   `--accent`/`--accent-hover`/`--accent-dim`/`--accent-fg`,
   `--border-subtle/default/strong`. **No app-prefixed colour vars** (no
   `--dql-color-*`). Rename a token → rename it in the cloud's design-tokens too.
3. **Theme persistence key** — `dql-theme` (the `NotebookStore` key). It is read
   on boot and the store listens for a cross-tab `storage` event on it; the cloud
   writes the key and dispatches that event to drive the embedded theme. Don't
   rename it or remove the `storage` listener.

DQL hides its own nav in cloud mode via the `AppShell` cloud branches
(`apps/dql-notebook/src/cloud/cloud-mode.ts`), not via cloud CSS — so there is no
layout-class dependency to preserve (unlike DataLex).

If you must change any of the above, **coordinate with the cloud repo**
(`governed-analytics-cloud`): update `packages/design-tokens`, and run
`node scripts/embed-contract.test.mjs` there. Standalone DQL is unaffected by the
cloud — these are just stability guarantees on the names the cloud depends on.

## General
- Notebook app: `apps/dql-notebook`. Build:
  `pnpm --filter @duckcodeailabs/dql-notebook-app build`.
- See `CONTRIBUTING.md` for setup, tests, and the OSS-readiness checklist.
