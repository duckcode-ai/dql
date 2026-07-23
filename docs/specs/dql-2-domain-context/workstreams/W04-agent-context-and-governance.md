# W04 — Agent context, governance, and MCP

## Goal

Make the complete domain model—not only blocks or dbt lineage—available to Ask,
tools, MCP, and final SQL safety through one snapshot-scoped context path.

Acceptance IDs: `REL-001`, `REL-002`, `CONTRACT-001`, `SKILL-001`, `SKILL-002`,
`CTX-001`, `CTX-002`, `CTX-004`, `AGT-001`, `AGT-002`, `AGT-003`.
Also owns `CTX-005`, `AGT-009`, `AGT-010`, `API-003`, `PERF-002`, and
`SEC-003`, `CTX-006`, `REL-003`, `SKILL-003`, `AGT-013` through `AGT-016`,
and `API-006` for the Ask/Research path. Analytical composition and repair add
`CONTRACT-002`, `SKILL-004`, `AGT-017` through `AGT-020`, `API-007`, and
`SEC-004` according to spec 10.
Dependencies: verified W01/W02; W03 discovery contracts available.

## Required implementation

- Resolve the exact `DomainContextEnvelope` server-side for UI/API/CLI/MCP.
- Ingest skills, typed relationships/contracts/interfaces/evaluations, products,
  and provenance into the same snapshot/KG/search index.
- Filter by domain/import/lifecycle before ranking; fix exclusion token behavior
  and qualified-ID collisions.
- Retrieve certified, semantic, DQL modeling, dbt, and safe runtime-schema lanes
  in parallel; preserve relevance, trust, and compatibility as separate fields.
- Build bounded evidence cards and run one identifier-bound AI meaning resolver
  for natural-language ambiguity before deterministic compatibility checks.
- Bind the validated meaning result into one immutable `ResolvedAnalyticalPlan`;
  downstream routes and compilers may not rematch or substitute its members.
- Enforce cascade order block → MetricFlow → governed SQL → clarify/refuse.
- Replace heuristic candidate join paths with certified v3 relationship paths;
  retain final independent SQL validation.
- Revoke automatic joins for missing keys, changed validation, expired evidence,
  stale dependencies, unsafe fanout, or missing purpose/export/contract.
- Carry envelope/snapshot/structured reason/provenance through every tool and
  MCP route; keep hints approved-only and unable to override gates.
- Select structured skills from that immutable snapshot, hydrate only bounded
  prompt guidance, and persist the exact capsule/skill hashes in a per-turn
  `KnowledgeLens`. Domain affinity alone must not select an unrelated skill.
- Compile governed SQL from constrained relational operators over qualified IDs
  and make Research consume typed deltas to the same plan and receipts.
- Normalize metric/asset capability for entity/result grain, additivity,
  dimension roles, time roles/grains, freshness, operations, relationships,
  outputs, and adapters; missing capability remains a modeling gap.
- Bind a versioned analytical frame with dimension/member roles, governed time
  policy and periods, comparison, ranking, ties, and output fields, then solve
  the complete tuple deterministically before route selection.
- Compile multi-period comparisons and rank-after-aggregation as one typed
  executable graph with decimal-safe deltas and a complete result contract.
- Compute receipt-backed result facts for narration and reject unsupported
  numeric, causal, grain, filter, freshness, or partial-period claims.
- Emit the shared stable failure/repair contract, retain immutable failed
  artifacts/fingerprints, derive edits with explicit trust transitions, and
  preserve permission/policy failures without route broadening.

## Suggested ownership

Owned: `packages/dql-agent/src/**`, `packages/dql-mcp/src/**`, context/search/KG
adapters and focused tests. Coordinate shared snapshot types with W02.
Prohibited: UI layout, onboarding jobs, migrations, theme tokens.

## Required tests/evidence

Safe Commerce/Growth route, raw campaign refusal, missing/expired/changed proof,
cross-domain purpose/export mismatch, duplicate local IDs, global/domain skill
precedence, negative exclusions, limited-context Ask, snapshot race, correction
lifecycle, and equivalent CLI/MCP/API envelopes.
Add similar-name metric/block cases, a relevant semantic metric versus an
irrelevant certified block, low-confidence clarification, invented-ID rejection,
explicit-reference zero-resolver behavior, call budgets, cancellation, and
specific non-recoverable error preservation.
Add exact-plan cases for revenue-today, named-customer filtering, aligned
current/prior top-customer ranking, ambiguous time/member meaning,
non-additivity, missing relationship proof, and certified capability mismatch.
Add repair cases for missing column/relation, permission, dialect, drift,
timeout, result-contract mismatch, immutable derivation, and trust transitions.
