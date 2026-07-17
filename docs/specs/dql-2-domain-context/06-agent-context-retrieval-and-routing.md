# Agent context, retrieval, and routing

## Context resolution

Ask accepts optional `domain`, `purpose`, and focused `modelAreaId` hints. The server validates them
against the active snapshot and builds `DomainContextEnvelope`; clients never
send `ancestors` or `allowedImports` as trusted values. Explicit valid scope is
preferred. Inference is allowed only when evidence is unambiguous; otherwise
the envelope has low confidence and the agent asks a clarifying question.

The envelope, question, product context, and user/tool capabilities create one
context request. The same `snapshotId` is used by retrieval, prompt assembly,
tool selection, SQL generation, final guard, and provenance (`CTX-001`,
`CTX-002`). A snapshot change during a run causes retry or `SOURCE_CHANGED`,
never mixed-snapshot execution.

`modelAreaId` is resolved from the same server-owned manifest. It may prioritize
the Area's entities and matching skills only after active-domain/import/lifecycle
eligibility is established; it cannot authorize an import, relationship, tool,
or generated join.

The snapshot index represents each Area as a searchable node containing its
name, business scope, intent examples, owned entities/relationships, and
read-only boundary references. Explicit Area selection wins. Without an
explicit Area, retrieval may infer one only inside the already-resolved active
domain and only when its evidence is unambiguous; otherwise the whole domain
remains active. Area focus boosts its typed graph neighborhood but does not
replace whole-domain retrieval when other evidence is needed (`CTX-004`).

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

Before relationship planning, a no-domain question derives its candidate entity
set from lexical/semantic evidence in the question. Retrieved context may
complete that set only when the question has no direct entity evidence; it may
not introduce a second cross-domain entity solely because an unrelated block,
skill, or relationship ranked in the context window. A rejected candidate keeps
its exact policy code and is terminal for that candidate: it is neither a
generic grounding retry nor a misleading user clarification (`AGT-004`).

Before candidate routing, the question is normalized into a typed analytical
contract: requested measures, dimensions, entity grain, categorical/time
filters, ranking/limit, and unresolved ambiguity. Categorical value grounding
uses bounded runtime values plus dbt/MetricFlow/domain vocabulary; it must not
depend on a project-specific keyword list. Synonyms may map a phrase to a
semantic metric only with cited metadata evidence. Retrieval searches certified
assets, MetricFlow, domain context/skills, and dbt/warehouse context as parallel
candidate classes, then passes a compact ranked context pack to routing
(`AGT-005`).

## Governed answer cascade

The route order is mandatory (`AGT-001`):

1. compatible certified DQL block/business view;
2. compatible MetricFlow query;
3. governed SQL generation using certified relationship paths;
4. bounded exploratory DBT-grounded SQL when governed coverage is absent but
   safe discovery and execution are available; or
5. clarify or refuse.

Candidate join-path planning must use typed manifest-v3 relationship proof, not
dbt lineage or heuristic shared-column joins. The final SQL guard independently
checks every table/column/relationship/export/contract against the same
snapshot. Certified blocks do not bypass parameter, purpose, export, contract,
or freshness checks.

A certified asset terminates the cascade only when its declared or safely
inferred contract covers every requested measure, output, dimension, grain,
filter/value, ranking direction, and parameter. A request with a categorical
filter cannot be answered by an unparameterized block that aggregates across
that category. Unknown filter/grain capability is context-only for a shaped
analytical request, not evidence of compatibility (`AGT-006`).

## App composition and Business Story

App planning uses a dedicated requirement-first orchestrator. It shares the
same immutable `DomainContextEnvelope`, compatibility checks, semantic
compiler, trust vocabulary, and evidence records as Ask, but it optimizes for a
coherent reusable dashboard rather than one terminal answer (`AGT-007`). The
client may express intent and select proposal candidates; source discovery,
eligibility, preflight, and trust classification remain server-owned.

Every dashboard run computes a typed fact pack from all eligible governed
tiles: active filters and time scope, app goal/audience/domain, metric units and
definitions, tile roles and grain, full-result statistics, approved deltas,
shares, ranks, trends, driver evidence, freshness, lineage, trust, and exact
evidence references. The deterministic Business Story is produced immediately
from those facts. Optional provider output may verbalize only those facts; it
does not calculate. Validation rejects an unreferenced number, a comparison
without a baseline, causal language without validated driver evidence, and a
claim whose grain or filters differ from its evidence. Story trust is the
least-trusted contributing source (`AGT-008`, `SEC-002`).

`POST .../run` returns a server-owned `runId`, snapshot/filter/result
fingerprints, tile results, verified facts, and the deterministic story.
`POST .../story` accepts only `runId`; the server reads bounded run evidence.
Clients cache by app/dashboard/snapshot/filter/result/persona fingerprint and
ignore an older story response after a newer run (`API-002`).

The exploratory lane is distinct from governed SQL. It may use dbt catalog,
schema, tests, lineage, and descriptions to propose a bounded single-domain
join hypothesis, but none of those facts is relationship proof and it must not
infer a cross-domain path. Before an exploratory answer, the runtime validates
read-only SQL, enforces connector/project execution limits, runs bounded
source/join checks, and records the source models, inferred join evidence, SQL,
snapshot, result bounds, and warnings. Its answer is labeled
`Exploratory · DBT-grounded` and review-required; it is never presented as a
certified block, governed semantic query, or governed SQL answer (`EXP-001`).
An exploratory answer may offer an explicit draft-block action with that
provenance, but never writes, certifies, or promotes an asset automatically
(`EXP-002`).

When bounded exploration succeeds, the persisted conversation turn records the
executed exploratory outcome, result contract, context-pack/snapshot reference,
SQL provenance, row bound, and review-required trust state. It must not retain
an earlier refusal/no-answer terminal state after successful recovery
(`EXP-003`).

## Multi-turn analytical intent

Conversation continuation operates on the prior typed analytical contract and
the new turn's typed delta. It may carry forward a measure, dimension, filter,
timeframe, ranking, or selected result value only when the follow-up refers to
or corrects it. Prior answer prose, SQL text, DQL source, owners, paths, and
provider metadata are retrieval evidence only and cannot become requested
dimensions or filter values. A correction rebuilds the effective contract and
re-runs the full candidate cascade when compatibility changes (`CTX-003`).

## Ambiguity and unsafe questions

The agent asks a focused clarification when domain, metric meaning, grain,
attribution, purpose, or export choice would materially change the answer. It
refuses when requested use is forbidden, proof is stale, a cross-domain export
is absent, many-to-many fanout has no approved attribution, or the current
runtime cannot enforce a required policy. Structured reasons distinguish
`missing_domain`, `ambiguous_domain`, `missing_attribution`, `unsafe_fanout`,
`stale_proof`, `missing_export`, `contract_failed`, and `policy_unenforced`.
Missing governed relationship coverage is a `modeling_gap`, not a generic
repair loop: the agent may enter the exploratory lane only when its bounded
single-domain checks are available. Explicit policy denials, failed contracts,
restricted access, unsafe fanout, missing attribution, and missing exports do
not fall through to exploration.

## Progressive Ask

With no configured domain, Ask may answer from a certified globally compatible
block or MetricFlow. If neither fully expresses the request, it may run bounded
single-domain exploratory DBT-grounded SQL when source discovery and execution
limits are enforceable. Governed generated SQL is labeled limited-context and
review-required; unsafe multi-model/cross-domain generation clarifies or
refuses. The UI explains that domain setup unlocks trusted relationship and
business-context routing, while exploratory results remain explicitly
review-required (`AGT-003`, `EXP-001`).

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
