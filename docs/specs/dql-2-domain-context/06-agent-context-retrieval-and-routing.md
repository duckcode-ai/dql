# Agent context, retrieval, and routing

## Context resolution

Ask accepts optional `domain` and `purpose` hints. The server validates them
against the active snapshot and builds `DomainContextEnvelope`; clients never
send `ancestors` or `allowedImports` as trusted values. Explicit valid scope is
preferred. Inference is allowed only when evidence is unambiguous; otherwise
the envelope has low confidence and the agent asks a clarifying question.

The envelope, question, product context, and user/tool capabilities create one
context request. The same `snapshotId` is used by retrieval, prompt assembly,
tool selection, SQL generation, final guard, and provenance (`CTX-001`,
`CTX-002`). A snapshot change during a run causes retry or `SOURCE_CHANGED`,
never mixed-snapshot execution.

## Context pack contents

Context packs are compact, ranked, and source-attributed. They may include:

- active domain summary, ancestors, exact allowed imports and purpose;
- matching terms, domain skills, and applicable global workflow skills;
- certified blocks/views and MetricFlow references;
- entity bindings and only relevant relationship paths;
- contracts, interfaces, conformance, evaluations, and lifecycle;
- dbt provenance references and typed lineage, not copied artifacts;
- approved fresh hints and prior answer context when allowed; and
- exclusions, unresolved conflicts, stale proof, and required clarifications.

Skills are indexed in the same snapshot as metadata/KG and are available to
CLI, server, MCP, and Ask. Missing skill ingestion is a snapshot build error,
not a silent separate loader path.

## Retrieval policy

Retrieval first filters by domain/import eligibility and lifecycle, then ranks
semantic/lexical fit, certified asset compatibility, evaluation quality,
freshness, and source confidence. Cross-domain candidates not present in
`allowedImports` are excluded. Negative constraints and skill exclusions lower
or veto rank (`SKILL-002`). Candidate records retain qualified IDs to prevent
same-local-ID collisions.

## Governed answer cascade

The route order is mandatory (`AGT-001`):

1. compatible certified DQL block/business view;
2. compatible MetricFlow query;
3. governed SQL generation using certified relationship paths;
4. clarify or refuse.

Candidate join-path planning must use typed manifest-v3 relationship proof, not
dbt lineage or heuristic shared-column joins. The final SQL guard independently
checks every table/column/relationship/export/contract against the same
snapshot. Certified blocks do not bypass parameter, purpose, export, contract,
or freshness checks.

## Ambiguity and unsafe questions

The agent asks a focused clarification when domain, metric meaning, grain,
attribution, purpose, or export choice would materially change the answer. It
refuses when requested use is forbidden, proof is stale, a cross-domain export
is absent, many-to-many fanout has no approved attribution, or the current
runtime cannot enforce a required policy. Structured reasons distinguish
`missing_domain`, `ambiguous_domain`, `missing_attribution`, `unsafe_fanout`,
`stale_proof`, `missing_export`, `contract_failed`, and `policy_unenforced`.

## Progressive Ask

With no configured domain, Ask may answer from a certified globally compatible
block or MetricFlow. Governed generated SQL is labeled limited-context and
review-required; unsafe multi-model/cross-domain generation clarifies or
refuses. The UI explains that domain setup unlocks trusted relationship and
business-context routing (`AGT-003`).

## Learning and corrections

A correction records the question, failed route, proposed change, evidence,
snapshot, and required evaluation as a draft. Only evaluated and reviewed hints
become approved. Retrieval is approved-only and rechecks staleness. Hints can
improve ranking or wording but never override relationship, export, contract,
classification, or final SQL gates.

## Tool and MCP behavior

All metadata/search/query tools accept or inherit the context envelope and
return `snapshotId`, qualified source IDs, lifecycle, and provenance. Tool
results from a different snapshot are rejected. MCP exposes the same domain
workspace, context search, relationship explain, and governed query semantics;
it cannot expose an unscoped raw SQL bypass as a trusted DQL answer.
