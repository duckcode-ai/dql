# W06 — Migration, compatibility, and runtime security

## Goal

Provide safe explicit adoption for existing DQL/DataLex projects and fail-closed
serving outside loopback.

Acceptance IDs: `CFG-002`, `MIG-001`, `MIG-002`, `SEC-001`, `SEC-003`, `SEC-004`.
Dependencies: verified W01–W03 source/config/snapshot contracts.

## Required implementation

- Implement modeling migration dry-run/apply for v3 config, qualified IDs,
  unified model sources, and domain-local product relocation/context metadata.
- Implement deterministic DataLex matching, omission/patch/draft conversion,
  explicit loss report, lifecycle preservation, and idempotency.
- Keep v2 consumers/config/API and legacy product/modeling readers tested
  through DQL 3.x; new authoring uses canonical paths.
- Enforce non-loopback authentication and origin allowlist at startup; remove
  wildcard CORS there while retaining documented loopback local mode.
- Add path confinement, source fingerprint/CSRF protections as applicable,
  secret redaction, and structured audit events for mutations.
- Constrain repair search, runtime-value grounding, evidence packaging, traces,
  and optional embeddings to the allowlist/redaction/persistence rules in spec
  08; remove legacy plaintext derived-value caches on index-version upgrade.
- Apply the same redaction, metadata-visibility, path, connector, mutation,
  statement-count, row-bound, dialect, timeout, and cancellation guards to the
  failure inspector and every derived DQL/SQL repair.
- Make permission and policy failures terminal for the selected route; no
  repair may probe alternate relations, roles, connections, or routes to evade
  access control.

## Suggested ownership

Owned: migration modules/CLI/tests, compatibility readers/fixtures, runtime
server security/config tests. Coordinate shared source writers with W01 and API
routes with W03. Prohibited: Domain Studio layout, agent ranking/routing, theme
tokens.

## Required tests/evidence

Dry-run no writes; apply twice no changes; complete loss report; ambiguous
mapping refusal; no lifecycle upgrade; v2 fixture compile/run; legacy paths;
non-loopback no-auth/invalid-origin failure; authenticated allowlist success;
path traversal/symlink escape rejection; `.dql`/provider/credential repair-search
exclusion; secret/PII field-name rejection; no plaintext sampled-value
persistence; ambient provider keys do not activate embeddings; secrets absent
from cards, traces, logs, and responses.
Add permission-terminal, unauthorized-metadata, SQL-derivation, parameter-
redaction, and cross-surface failure-payload cases from `E2E-014`.
