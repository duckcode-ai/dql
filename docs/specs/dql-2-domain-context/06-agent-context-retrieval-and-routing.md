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

Analytical natural language never reaches a general-knowledge decision before
this retrieval completes. Certified assets, semantic metadata, DQL
modeling/terms, dbt objects/columns, and safe cached runtime schema are searched
as parallel evidence lanes from the same snapshot (`CTX-005`, `AGT-009`). Each
candidate keeps three independent facts:

- relevance: lexical/semantic fit to the question and active context;
- trust: certified, semantic, governed-SQL, or exploratory evidence tier; and
- compatibility: whether the object can express the requested measures,
  dimensions, entity, grain, filters, ranking, parameters, and output.

Trust never compensates for poor meaning relevance. An unrelated certified
block cannot outrank the correct semantic metric merely because it is
certified. Trust selects the safest execution path only after the intended
business concept and compatibility are established (`AGT-010`).

## Evidence retrieval and AI meaning resolution

Retrieval uses independent exact-qualified-reference/approved-alias, normalized
phrase/token, FTS/BM25, semantic-vector, and typed-graph candidate lanes. Domain,
import, lifecycle, policy, and visibility eligibility is applied before ranking.
The OSS vector index is stored with the immutable project-search snapshot; a
hosted vector service is not required. Vector candidate generation covers
metrics, certified blocks, Domain Capsules, terms, semantic models, and compact
Skill descriptors. Warehouse columns are searched hierarchically only inside
retrieved model/entity neighborhoods rather than through one global column
vector index. Ranking occurs before lane quotas; file order, alphabetical order,
and arbitrary first-N artifact slices cannot determine visibility.

The initial bounded pool contains at most 25 candidates per lane. Eligibility
and compatibility filtering occur before graph expansion and payload hydration.
The final AI evidence package contains at most 8–12 complete candidate cards and
6,000–12,000 input tokens. A candidate card contains its qualified ID, kind,
aliases, definition, formula/aggregation when available, domain/semantic model,
primary entity, dimensions, time grains, parameters/filters, block input/output
contract, lifecycle, relevant source relations/columns, relationship evidence,
retrieval reasons, and known compatibility facts. It contains no secret, raw
sample value, arbitrary source text, or unauthorized metadata.

Except for an explicit qualified reference, a candidate already selected in the
same conversation, or one unique exact candidate with no competing name/alias or
materially related definition, a natural-language analytical request uses one
bounded AI meaning-resolution call. That call compares business meaning; it
does not search the project, execute SQL, invent identifiers, or decide policy.
Its structured result contains:

```ts
interface MeaningResolution {
  interpretedQuestion: string;
  questionType: "definition" | "value" | "ranking" | "trend" |
    "comparison" | "diagnosis" | "research";
  selectedConceptIds: string[];
  recommendedExecutionId?: string;
  queryIntent: {
    measures: string[];
    dimensions: string[];
    filters: Array<{ field: string; value: string }>;
    timeRange?: string;
    timeGrain?: string;
    order?: "asc" | "desc";
    limit?: number;
  };
  rejectedCandidates: Array<{ id: string; reason: string }>;
  confidence: "high" | "medium" | "low";
  missingInformation: string[];
  recommendedRoute: "certified" | "semantic" | "governed_sql" |
    "exploratory" | "clarify";
}
```

This shape remains the v1 compatibility projection for stored conversations and
simple callers. New value, ranking, trend, comparison, diagnosis, and research
planning uses the versioned `AnalyticalQuestionFrameV2` from spec 10. The frame
adds dimension roles, typed member bindings, time role/calendar/timezone/
completeness, bounded periods, comparison, ranking basis/ties, and requested
outputs. A downstream adapter may consume a v1 projection for compatibility,
but it cannot infer missing v2 semantics from prose, names, or generated SQL
(`AGT-017`).

Every returned ID must exist in the server-owned evidence package. Unknown IDs,
changed definitions, or a mismatched snapshot invalidate the resolution. High
confidence proceeds to deterministic validation. Medium confidence proceeds
only when compatibility leaves one unique executable candidate. Low confidence
asks one focused question that explains the competing business meanings. The
server, not the model, decides authorization, relationship authority, route
trust, compilation, SQL validation, and execution (`AGT-009`, `AGT-010`).

## Authoritative analytical plan

The validated meaning result is input to a deterministic plan resolver; it is
never reduced to prompt guidance or a preferred-ID hint. The resolver returns
either one immutable `ResolvedAnalyticalPlan` or one typed clarification/refusal
outcome. A valid plan contains no unresolved bare metric, measure, dimension,
member, entity grain, time role/grain, filter, relationship path, capability, or
required output (`AGT-013`).

The plan records the project-search snapshot, Domain envelope and KnowledgeLens
fingerprints; selected evidence and qualified semantic IDs; typed filters/member
bindings; separate entity and temporal contracts; exact compatibility and
relationship proofs; required operations; selected execution asset/adapter;
result contract; budgets; and a deterministic content fingerprint. Compiler-
required members such as `metric_time` are explicit technical bindings and may
coexist with the user time axis without changing the requested output contract.

For analytical composition, each metric/asset first normalizes to the
capability contract in spec 10. The deterministic resolver proves the complete
metric/entity/dimension-role/member/time/period/comparison/ranking/output tuple;
individually compatible members are insufficient. Multi-period comparisons and
top/bottom-N compile as typed executable graphs that aggregate at the declared
grain before alignment, arithmetic, and ranking (`CONTRACT-002`, `AGT-018`,
`AGT-019`).

Once the plan exists, no downstream component may re-search or reinterpret
business meaning. It may only prove capability, compile, execute, validate the
result contract, or return a stable error. A selected metric cannot be replaced
because another metric is easier to join or compile (`AGT-014`).

After successful result-contract validation, server-computed facts bind values,
comparisons, contributors, freshness, and caveats to exact result fields and
receipts. Business narration may verbalize only those facts and cannot hide
partial-period state or introduce unsupported numeric/causal claims
(`AGT-020`).

Clarification is a structured continuation, not another natural-language search.
Each rendered choice contains a stable candidate ID, business label, definition,
and kind. Selecting it restores the original analytical question, binds the exact
candidate, and rebuilds the immutable context pack with that candidate as focus.
For semantic evidence this must include its governed `table` binding plus matched
dbt/runtime columns before SQL preview validation. Display labels and generated
clarification prose are never used as evidence identity (`AGT-011`).

Data members use the same identity-preserving rule. A value resolved from the
question, a prior result, or a clarification becomes a typed member binding:
dimension, canonical value(s), source, match confidence, and optional source-turn
ID. That binding is immutable request state, not another metadata search token.
Every terminal route must prove that it exposes the bound dimension/filter or is
statically scoped to the canonical value. An asset that matches the surrounding
business words but cannot honor the binding is context-only. Generated SQL
receives the binding and already-selected join evidence directly; it must not run
a second discovery/planning loop to rediscover the member. The bounded member
memory is derived independently from the UI row preview, so a named value does
not disappear merely because it was outside the displayed sample. Metadata
re-grounding, SQL-contract correction, and execution repair have distinct
one-attempt budgets; using one cannot silently consume another. When one
canonical member resolves to exactly one inspected dimension column already on
the proposed query path, the runtime applies that predicate deterministically
before AI repair. Ambiguous or already-misbound predicates are never rewritten
automatically (`AGT-012`).

When the compatible terminal asset is a parameterized certified block, the
planner maps each typed member binding only through that block's declared
parameter/filter contract. The invocation preserves whether the value came from
the current question or a prior result, and the returned DQL artifact preserves
the parameter definitions plus resolved values. The model does not reconstruct
the block SQL. A value that cannot be mapped to exactly one declared parameter
cannot silently make the block compatible (`AGT-005`, `AGT-006`, `AGT-012`).

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
filter/value/member binding, ranking direction, and parameter. A request with a categorical
filter cannot be answered by an unparameterized block that aggregates across
that category. Unknown filter/grain capability is context-only for a shaped
analytical request, not evidence of compatibility (`AGT-006`).

For a meaning-compatible certified block, the runtime executes the block's
existing query and the AI does not rebuild it. For a meaning-compatible semantic
metric/saved query, the semantic compiler owns SQL construction. Only when
neither direct route covers the selected meaning may a bounded SQL-generation
call receive the selected relations, columns, and authorized relationship proof.
The execution gateway independently validates and runs the result. Insufficient
evidence produces a typed modeling gap or focused clarification, never a model
invitation to invent schema or joins (`AGT-010`).

The semantic step uses the same runtime selector as Notebook and Block Studio:
bundled native composition for supported metrics, then a configured local
MetricFlow or tested dbt Cloud Semantic Layer adapter. An exact scalar metric is
compiled without an AI planning call. When several metric or dimension meanings
are plausible, bounded member selection may choose identifiers, after which the
adapter—not the model—constructs SQL. A known semantic metric that requires an
unavailable runtime returns `semantic_runtime_required`; it does not fall through
to hand-written generated SQL or a guessed backing measure (`AGT-001`, `API-004`).
Repeated physical member names are not treated as globally interchangeable. A
dimension such as `report_date` is resolved from the selected metric's owning
semantic model (or an explicit model-scoped identity), and compiled SQL qualifies
the corresponding relation alias. When the selected MetricFlow member has more
than one valid metric-relative entity path, the selected semantic route stops
before compilation and returns stable path choices. The chosen path is rebound
to the same authoring identity on retry; it is not a new dimension match and it
does not broaden to generated SQL. The semantic execution trace records the
authoring request, exact runtime request, member/path bindings, selected adapter,
compilation status, and execution status for Trust & Steps (`AGT-013`,
`AGT-014`, `API-006`, `API-007`, `UI-012`, `UI-013`). Generated SQL validation uses the active
warehouse dialect before any repair or refusal, so valid Snowflake/Databricks
syntax is not rejected by a DuckDB/PostgreSQL parser (`AGT-001`, `AGT-012`).

For ranked grouped questions, validation requires every real grouping dimension
from the answer contract in the projection before execution. Compound measure
phrases such as "product revenue" remain measures, not invented dimensions. A
bounded correction receives the exact answer contract and must preserve already
correct dimensions and measures.

Amount and financial calculations preserve the selected metric's aggregation
contract, native grain, and warehouse `DECIMAL`/`NUMERIC` precision. Generated
SQL may not round, truncate, format, or cast to an approximate floating type
before `SUM`, `AVG`, deduplication, or native-grain pre-aggregation. Null/default
handling applies to the aggregate and display rounding applies only to the outer
final projection. A dbt-key-proven one-to-many fanout, hand aggregation of a
declared non-additive semantic measure, or premature rounding/casting fails the
deterministic SQL guard before any preview execution. The bounded repair receives
the exact violation; a failed repair remains terminal and review-required
(`AGT-005`, `AGT-010`, `REL-002`).

A failed grounding, compiler, policy, provider, or deadline outcome is terminal
for that run. It may expose redacted diagnostics and a targeted research/modeling
action, but it cannot retain an invalid reusable draft, passed-answer badge, or
automatic deeper retry. Provider failures and request deadlines retain distinct
codes and presentation (`AGT-011`, `PERF-002`).

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

Authentication, authorization, connector, configuration, rate-limit, policy,
cancellation, timeout, and modeling-gap failures are non-recoverable unless
their structured error explicitly declares one bounded action such as snapshot
refresh or SQL identifier repair. They retain their original code and cannot be
reclassified as research, generic clarification, or provider refusal.

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

Browser Ask, direct CLI, MCP, and Chat call the same governed Ask service. They
may expose role-appropriate tool subsets, but equivalent requests over the same
snapshot and policy must produce the same normalized contract, evidence IDs,
meaning resolution, route, trust label, and stable error (`API-003`). Ordinary
Ask excludes authoring, certification, proposal, and hint-mutation tools.

## Call and execution budgets

Simple routes are deliberately shallow (`PERF-002`):

| Route | Meaning calls | Planning/generation calls | SQL | Repair | Narration |
| ----- | ------------- | ------------------------- | --- | ------ | --------- |
| explicit qualified definition | 0 | 0 | 0 | 0 | 0 |
| explicit qualified data | 0 | 0 | 1 | 0 | 0 |
| natural-language certified/semantic | <= 1 | 0 | <= 1 | 0 | 0 |
| governed/exploratory generated SQL | <= 1 | <= 1 | 1 initial | <= 1 | 0 |
| explicit research/diagnosis | <= 1 | <= 1 plan | <= 6 | <= 1 total | <= 1 |

Definition and simple-result rendering are deterministic. A successful direct
certified or semantic route never pays a generic planner, open-ended provider
tool loop, or answer-synthesis call. Cancellation and inherited deadlines
propagate through retrieval, meaning resolution, generation, validation,
database execution, repair, and research.
