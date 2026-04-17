# Version & diff notebooks

> ~4 minutes · ends with a clean PR-ready diff

Notebooks are plain text in git. DQL's job is to keep the diffs **readable**
and the history **meaningful** — not line-noise from whitespace churn.

## Canonical format

Every `.dql` file starts with a version header:

```dql
// dql-format: 1

block revenue_by_segment {
  …
}
```

`dql fmt` normalizes whitespace, key order, and SQL formatting into a
canonical form. Run it in a pre-commit hook (or enable notebook autosave —
the notebook writes canonical on save).

```bash
dql fmt blocks/**/*.dql            # format in place
dql fmt --check .                  # CI: non-zero exit if anything drifts
```

## Semantic diff

`git diff` works fine, but it's character-level. `dql diff` is
**AST-level** — it tells you *what changed semantically*, not *which bytes*.

```bash
dql diff blocks/finance/revenue_by_segment.dql@HEAD~1 blocks/finance/revenue_by_segment.dql
```

Output:

```
~ block revenue_by_segment
    tags: ["revenue"] → ["revenue", "certified"]
    query:
      - group by segment
      + group by segment, region
    visualization: bar → stacked-bar
```

Exits **1** on differences (scriptable like `git diff`).

## In-app git panel

Open the notebook sidebar → **Git** (⌘⇧G). You get three tabs:

- **Status** — porcelain view of the working tree, color-coded
- **Log** — last 30 commits on this branch, click to diff
- **Diff** — full or scoped to the active file

Read-only in v0.11; stage/commit/push lands in v0.12.

## Run snapshots

Executing cells writes a sibling `<notebook>.run.json` with the last
results. On re-open, DQL rehydrates status/result/error without re-running
queries.

Snapshots are **git-ignored by default** — `*.run.json` is appended to
`.gitignore` on first write. Un-ignore deliberately if you want to ship
executed state in git.

## Verify it worked

- `git diff` on a saved-but-unchanged notebook is empty (no whitespace churn)
- `dql fmt --check .` passes in CI
- `dql diff A B` produces a readable semantic report on two versions
