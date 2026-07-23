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
| 2026-07-23 | W02/W04/W05/W07 | `CTX-005`, `AGT-014`, `API-006`, `API-007`, `UI-012`, `PERF-001`, `E2E-008`, `E2E-014` | Enterprise Snowflake testing exposed eager all-column materialization, missing compiler-target/execution-target identity, lost semantic trace/connector diagnostics, and cross-surface execution drift despite prior implementation evidence. | Specs 07/10 amended; target-bound execution, bounded schema search/streaming, canonical receipts, structured failures, adapter pinning, and built-CLI regression coverage implemented on `codex/target-bound-semantic-runtime`. Independent enterprise-fixture verification remains required. | implemented |
| 2026-07-23 | W03/W04/W05/W07 | `API-004`, `API-007`, `UI-009`, `UI-012`, `SEC-004`, `E2E-008`, `E2E-014` | Real dbt Cloud/local MetricFlow testing still allowed local semantic metadata to be paired with an unverified cloud environment, wrapped catalog drift as a generic setup error, lost physical binder evidence, and let rejected async handlers terminate the Notebook server; Snowflake also ran on unsupported Node 26. | `codex/semantic-runtime-stabilization` persists the complete paginated cloud metric inventory and catalog proof on explicit Test & Apply, fails closed with `SEMANTIC_SOURCE_DRIFT`, target-binds the cloud proof, preflights compiled SQL with identifier/excerpt evidence, preserves failures in Trust & Steps, catches every request rejection, and rejects unsupported Snowflake Node majors before startup. Focused runtime/agent/UI tests and production builds pass; designated enterprise fixture and built-CLI browser verification remain independent-verifier work. | implemented |
| 2026-07-23 | W01/W04/W06/W07 | `AGT-014`, `API-006`, `API-007`, `SEC-004`, `E2E-014` | Snowflake exposes one account as an immutable locator and as the preferred `organization-account_name` identifier. DQL compared those forms as unrelated strings (and dbt Cloud also required an obsolete exact target fingerprint), while failed `CURRENT_*` acquisition silently saved configured fallback data. This produced false account drift across dbt Cloud and local MetricFlow. | Warehouse identity now records canonical name, locator, account name, and organization; account comparison uses bounded aliases while database/schema/role/warehouse remain strict; legacy bindings migrate through field-aware comparison; and failed Snowflake identity observation blocks apply/execution. Core and CLI regression suites cover legacy locator compatibility, canonical identifiers, true account drift, and fail-closed acquisition. Independent enterprise Snowflake verification remains required. | implemented |
