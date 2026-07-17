# W01 — Core contracts and qualified identity

## Goal

Create the canonical types, parsers, validators, configuration defaults, domain
membership resolver, and deterministic qualified identities used by every later
workstream.

Acceptance IDs: `CFG-001`, `CFG-002`, `ID-001`, `DOM-001`, `DOM-002`,
`DOM-003`, `PRD-003`, `CTX-004`.

## Required implementation

- Add the exact `ProductDomainContext`, `QualifiedDomainObject`, and
  `DomainContextEnvelope` contracts from `02-object-model-and-project-layout.md`.
- Parse/validate product metadata without breaking legacy documents.
- Compile `<domain>::<kind>::<localId>` IDs, preserve source `localId`, reject
  normalized collisions, and resolve package-local references deterministically.
- Execute domain selectors centrally with explicit precedence and unresolved
  ambiguity diagnostics.
- Make v3/dbt-first the new dbt-init default while leaving existing config
  loading/defaults unchanged.
- Preserve sparse-overlay/no-dbt-copy manifest invariants and v2 discriminants.

## Suggested ownership

Owned: `packages/dql-core/src/**`, compiler configuration/manifest/domain tests,
and narrowly required shared types. Prohibited: agent routing, server endpoints,
notebook UI, theme tokens, migrations, fixture applications.

## Required tests/evidence

Round-trip exact public shapes; two domains with same local IDs; selector
precedence and ambiguity; parent gives no import; v2 config unchanged; new init
default fixture; deterministic manifest; assertion that dbt schema/description/
test/formula payloads are absent. Run focused core/compiler tests, builds, and
`git diff --check`.

## Handoff output

Document exported modules, compatibility behavior, diagnostics, test commands,
commit SHA, and any API fixture needed by W02–W05. Status is `implemented` until
separately verified.
