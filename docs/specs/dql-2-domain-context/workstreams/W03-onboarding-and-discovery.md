# W03 — dbt onboarding, discovery, and refresh

## Goal

Deliver the end-to-end connect → artifact → snapshot → domain proposal → apply
flow with deterministic manual behavior and evidence-bounded AI assistance.

Acceptance IDs: `CFG-001`, `CFG-002`, `CFG-004`, `AGT-002`, `API-001`.
Dependencies: verified W01 and W02.

## Required implementation

- Implement every onboarding endpoint and stable error code in spec 03.
- Add cancellable, structured jobs and atomic activation through the snapshot
  service; redact secrets and guard source/config fingerprints.
- Replace semantic-import behavior that copies dbt semantic definitions with
  read-only dbt-first provenance/MetricFlow references.
- Implement deterministic discovery from meta/group/path/tag/owner/exposure/
  MetricFlow/package evidence, with confidence/conflicts.
- Make AI output optional, cited, draft-only, previewable, and unable to set
  certified state.
- Make `dql sync dbt` refresh/diff/compile/reindex and retain report-only
  `--check`; implement discovery CLI commands.

## Suggested ownership

Owned: `apps/cli/src/**` onboarding/sync/model commands, relevant runtime server
routes/services, discovery modules/tests, onboarding UI only if assigned here.
Prohibited: agent answer routing, Domain Model canvas, theme tokens, migration
implementation other than shared dry-run primitives.

## Required tests/evidence

Missing project/manifest, invalid artifact, parse failure, cancellation,
source-change conflict, AI unavailable manual fallback, ambiguous domain,
idempotent apply, no semantic copies, new versus existing config behavior, and
refresh staleness. Include CLI/API transcripts against Jaffle and the dedicated
fixture.
