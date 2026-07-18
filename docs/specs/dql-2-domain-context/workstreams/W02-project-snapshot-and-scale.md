# W02 — Project snapshot service and scale foundation

## Goal

Replace request-path reparsing and disconnected metadata/skill loaders with one
immutable, atomically activated `ProjectSnapshotService`.

Acceptance IDs: `CTX-002`, `CTX-005`, `API-001`, `PERF-001`, `PERF-002`
(snapshot/search foundation).
Dependency: verified W01 contracts.

## Required implementation

- Build content-addressed candidate snapshots from dbt artifacts and all
  Git-tracked DQL sources; atomically activate only after validation.
- Index qualified objects, domain membership, skills, relationships, certified
  assets, products/backlinks, evaluations, provenance, and diagnostics.
- Ingest semantic metrics/members, dbt unique IDs and complete column metadata,
  DQL v3/modeling aliases, and safe connection-qualified runtime schema into one
  canonical search store without leaf-name collisions or file-order cutoffs.
- Keep compact exact/alias maps and graph adjacency in memory while verbose
  payloads, FTS, columns, edges, and fingerprints remain in the persisted index.
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
target objects at positions 24, 60, 200, 500, and 6,999 remain discoverable;
duplicate qualified names do not overwrite; initial scale benchmark and memory
profile. Run focused core/compiler/metadata tests and build.
