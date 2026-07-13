# Integration execution tracker

The integration owner is the sole editor of status in this file during active
delivery. Do not use this tracker to change requirements; amend the relevant
spec and acceptance matrix first.

| Checkpoint | Branch/worktree | Base SHA | Head SHA | Owner | Status | Verified by | Evidence/notes |
| ---------- | --------------- | -------- | -------- | ----- | ------ | ----------- | -------------- |
| Spec freeze | `codex/dql-2-dbt-first-modeling` | `00570007019c055a4000cd1069262fa9d053a52d` | TBD | integration owner | in progress | TBD | RFC 0003 + this pack; head filled after checkpoint commit |
| W01 core contracts and identity | `codex/dql2-w01-core-contracts` | TBD | — | unassigned | pending | — | — |
| W02 snapshot and scale | `codex/dql2-w02-snapshot` | TBD | — | unassigned | pending | — | — |
| W03 onboarding and discovery | `codex/dql2-w03-onboarding` | TBD | — | unassigned | pending | — | — |
| W04 agent context and governance | `codex/dql2-w04-agent-context` | TBD | — | unassigned | pending | — | — |
| W05 Domain Studio and products | `codex/dql2-w05-domain-studio` | TBD | — | unassigned | pending | — | — |
| W06 migration and security | `codex/dql2-w06-migration-security` | TBD | — | unassigned | pending | — | — |
| W07 integration/evals/performance | `codex/dql2-w07-integration` | TBD | — | unassigned | pending | — | — |
| W08 OSS release/docs | `codex/dql2-w08-release` | TBD | — | unassigned | pending | — | — |

## Integration protocol

1. Freeze specs and record the actual integration base SHA.
2. Create isolated workstream branches/worktrees from the recorded dependency
   commit. Never let concurrent agents edit the same worktree.
3. Provide assignments using `agent-handoff-template.md`, including owned and
   prohibited globs.
4. Implementer runs focused tests, records evidence, and marks requirements
   `implemented` only.
5. A different verifier performs read-only review/tests and reports pass/fail.
6. Integration owner applies the verified commit, resolves conflicts, updates
   this tracker/matrix, and reruns affected package gates.
7. After every UI/runtime integration, restart the built CLI-backed Jaffle or
   dedicated fixture and verify visible behavior.
8. Before final release, run all gates in `09-fixtures-evals-and-release-gates.md`.

## Conflict/blocker log

| Date | Workstream | Requirement | Conflict/blocker | Decision/reference | Status |
| ---- | ---------- | ----------- | ---------------- | ------------------ | ------ |
| — | — | — | — | — | — |
