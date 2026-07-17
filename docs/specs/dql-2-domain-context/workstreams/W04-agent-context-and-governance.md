# W04 — Agent context, governance, and MCP

## Goal

Make the complete domain model—not only blocks or dbt lineage—available to Ask,
tools, MCP, and final SQL safety through one snapshot-scoped context path.

Acceptance IDs: `REL-001`, `REL-002`, `CONTRACT-001`, `SKILL-001`, `SKILL-002`,
`CTX-001`, `CTX-002`, `CTX-004`, `AGT-001`, `AGT-002`, `AGT-003`.
Dependencies: verified W01/W02; W03 discovery contracts available.

## Required implementation

- Resolve the exact `DomainContextEnvelope` server-side for UI/API/CLI/MCP.
- Ingest skills, typed relationships/contracts/interfaces/evaluations, products,
  and provenance into the same snapshot/KG/search index.
- Filter by domain/import/lifecycle before ranking; fix exclusion token behavior
  and qualified-ID collisions.
- Enforce cascade order block → MetricFlow → governed SQL → clarify/refuse.
- Replace heuristic candidate join paths with certified v3 relationship paths;
  retain final independent SQL validation.
- Revoke automatic joins for missing keys, changed validation, expired evidence,
  stale dependencies, unsafe fanout, or missing purpose/export/contract.
- Carry envelope/snapshot/structured reason/provenance through every tool and
  MCP route; keep hints approved-only and unable to override gates.

## Suggested ownership

Owned: `packages/dql-agent/src/**`, `packages/dql-mcp/src/**`, context/search/KG
adapters and focused tests. Coordinate shared snapshot types with W02.
Prohibited: UI layout, onboarding jobs, migrations, theme tokens.

## Required tests/evidence

Safe Commerce/Growth route, raw campaign refusal, missing/expired/changed proof,
cross-domain purpose/export mismatch, duplicate local IDs, global/domain skill
precedence, negative exclusions, limited-context Ask, snapshot race, correction
lifecycle, and equivalent CLI/MCP/API envelopes.
