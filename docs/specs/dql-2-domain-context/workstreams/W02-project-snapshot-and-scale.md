# W02 — Project snapshot service and scale foundation

## Goal

Replace request-path reparsing and disconnected metadata/skill loaders with one
immutable, atomically activated `ProjectSnapshotService`.

Acceptance IDs: `CTX-002`, `API-001`, `PERF-001` (foundation).
Dependency: verified W01 contracts.

## Required implementation

- Build content-addressed candidate snapshots from dbt artifacts and all
  Git-tracked DQL sources; atomically activate only after validation.
- Index qualified objects, domain membership, skills, relationships, certified
  assets, products/backlinks, evaluations, provenance, and diagnostics.
- Provide reference-counted consistent handles for full request/run lifetime.
- Implement cheap warm fingerprint checks, incremental/domain invalidation, and
  no request-path dbt artifact reparse.
- Add bounded paginated inventory, batch node detail, and graph-neighborhood
  service contracts used by APIs/UI.
- Preserve rebuildability from a clean clone and keep snapshots/indexes ignored.

## Suggested ownership

Owned: core/compiler snapshot/index modules, metadata storage services, related
unit/integration tests. Coordinate before editing server routes or agent search.
Prohibited: Domain Studio presentation, routing behavior, migration writers,
theme tokens.

## Required tests/evidence

Atomic failure/cancel keeps old snapshot; concurrent requests stay on one
snapshot; changed source yields new ID; warm check avoids full build; node detail
does not parse artifact; skills/products appear in snapshot; pagination/bounds;
initial scale benchmark and memory profile. Run focused core/compiler/metadata
tests and build.
