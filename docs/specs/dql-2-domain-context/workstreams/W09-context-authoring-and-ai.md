# W09 — Context authoring and authoring AI

## Goal

Deliver one write-free proposal lifecycle across manual Modeling, dbt discovery,
YAML import, Modeling AI, Skills AI, and correction revisions.

Acceptance IDs: `UI-019`, `API-011`, `MIG-003`, `MIG-004`, `REL-004`,
`SKILL-005`, `CTX-008`, `AGT-024`, `API-012`, `SKILL-006`, `UI-020`,
`UI-021`, `E2E-018`, and `E2E-019`.

Dependencies: W01 identity/contracts, W02 snapshots, W03 dbt discovery, W04
retrieval/AgentRun, and W05 Domain Studio UI.

## Required implementation

- Implement immutable proposal creation, repreview, exact-hash commit, conflict
  codes, dependency closure, full candidate compile, rollback, and index refresh.
- Preserve singular Modeling APIs as adapters while routing new clients through
  the shared proposal service.
- Add confined DQL/dbt YAML discovery, classification, sparse overlays, conflict
  review, and CLI parity.
- Simplify Modeling entry, batch model binding, and relationship review without
  elevating dbt suggestions to proof.
- Add Modeling/Skills AgentRun modes, write-free artifacts, typed review actions,
  immutable revisions, correction handoffs, and guarded Skills partial patches.
- Persist canonical skill/modeling references and `guided_by` graph edges; keep
  Domain scope, one-shot focus, retrieval ranking, and authorization separate.

## Required tests and evidence

Package/API tests must prove every negative and rollback gate in spec 11.
Implementer browser evidence must use the built `dql notebook` CLI and the
designated fixture in paper and obsidian themes, including remount and stale
proposal behavior. A separate verifier records final acceptance.
