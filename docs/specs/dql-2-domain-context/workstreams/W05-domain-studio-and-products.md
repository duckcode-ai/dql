# W05 — Domain Studio and shared products

## Goal

Ship the unified vertical Domain Studio and connect global Apps/Notebooks/Ask to
domain context without duplicating product storage.

Acceptance IDs: `PRD-001`, `PRD-002`, `PRD-003`, `AGT-003`, `UI-001`, `UI-002`, `UI-006`, `UI-007`, `UI-008`, `UI-012`, `UI-013`.
Dependencies: verified W01/W02 contracts and stable W03/W04 APIs.

## Required implementation

- Preserve the global rail and add the exact contextual sidebar/deep-link
  structure from spec 05.
- Build domain overview, Knowledge, Certified Assets, Readiness, Related
  Products, and paginated dbt Scope as real task surfaces.
- Complete the Domain Model canvas: adaptive/resizable/free nodes, bounded graph
  loading, auto-layout/fit, column constraint icons, column-drag relationships,
  edge/node inspector, closable/resizable panel, compact progressive editor,
  persisted visual-only layout, keyboard/accessibility behavior.
- Keep dbt-owned content read-only with previewed source patches; write DQL
  changes only to Domain Package source.
- Add `ProductDomainContext` authoring/display to global Apps/Notebooks and
  “Ask in domain” shortcuts; derive Related Products backlinks.
- Open shared Guided Setup before the product once per project on first install
  and each CLI version change; acknowledge locally without mutating connections.
- Preserve the Cloud embed design contract exactly.
- Expose Domain Knowledge 360 from the compiled snapshot, including capsule
  fingerprints, qualified object counts, provenance, selected skill refs, and
  observed/authorized/blocked/stale routes; do not rebuild a UI-only graph.
- Consolidate plan, DQL, SQL, lineage, trust/evidence, actual steps, and stable
  failure details into the progressively disclosed How it answered inspector
  for successful and failed runs.
- Render metric/entity/dimension-role/member/time/comparison/ranking/output
  interpretation and the exact failed phase without reconstructing it in the UI.
- Capability-gate parameter rerun, DQL repair, SQL notebook copy, snapshot
  refresh, connection/access, and draft-save actions; show the server-returned
  trust/review transition and never mutate the source artifact.

## Suggested ownership

Owned: `apps/dql-notebook/src/**`, narrowly required UI components/styles,
client types/tests. Coordinate server/API changes with W02/W03. Prohibited:
shared theme selector/token renames, core routing policy, snapshot internals,
migration writers.

## Required tests/evidence

Component tests plus CLI-backed browser proof against the dedicated fixture:
navigation/deep link, responsive sidebar, inspector close/resize, free move,
node resize/auto-fit, uncut handles/icons, column drag, relationship inspector,
dbt/DQL patch ownership, related products, limited Ask messaging, keyboard/a11y,
all themes, and Cloud embed-contract test. Vite alone is not accepted.
Also prove the complete How it answered and repair flows for success,
column-not-found, permission-denied, snapshot-drift, and edited-artifact trust
states in the built CLI.
