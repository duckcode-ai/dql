# Analytical composition and transparent repair

## 1. Outcome

This phase turns a retrieved governed object into a complete, executable, and
explainable analytical answer. It covers questions that bind one or more
metrics to entity grain, dimension roles, member values, time semantics,
comparison periods, ranking, and result narration. It also defines how a user
inspects, repairs, reruns, and promotes a failed answer without overstating
trust.

The canonical acceptance IDs are `CONTRACT-002`, `SKILL-004`, `AGT-017` through
`AGT-020`, `API-007`, `UI-012`, `UI-013`, `SEC-004`, `E2E-013`, and `E2E-014`.

## 2. Scope and non-goals

### In scope

- metric-to-entity/dimension/time compatibility at the complete-plan level;
- explicit grouping, filter, display, ranking, and time-axis roles;
- exact member-to-dimension binding such as `Zoom` to a customer filter;
- governed time roles, business calendars, timezones, period completeness, and
  aligned comparison windows;
- multi-period, delta, percent-change, top/bottom-N, and deterministic tie
  behavior;
- capability-aware certified, semantic, governed-relational, exploratory, and
  clarification routing;
- deterministic insight facts and receipt-backed business narration;
- one inspectable failure and repair contract across Ask, Notebook, CLI, MCP,
  and Chat; and
- trust transitions for parameter changes, DQL edits, SQL edits, snapshot
  refreshes, and reviewed promotion.

### Out of scope

- inferring causality from observational data;
- bypassing warehouse permissions or domain/import policy;
- treating dbt lineage, matching names, repository text, or sampled values as
  relationship authority;
- silently adding a universal definition of `today`, `current`, fiscal year, or
  customer;
- making user-edited SQL certified without the ordinary review/certification
  workflow; and
- replacing the RFC 0004 route order or immutable-plan invariant.

## 3. Canonical architecture

```text
User question
  → AnalyticalQuestionFrameV2
  → snapshot-scoped candidate retrieval
  → deterministic analytical compatibility solver
  → ResolvedAnalyticalPlanV2
  → certified | semantic | governed relational | exploratory | clarify/refuse
  → executable graph + result contract
  → execution receipt + deterministic insight facts
  → business answer + How it answered
  → optional derived repair + new validation/receipt
```

Retrieval produces candidates and evidence. AI meaning resolution may choose
only supplied qualified IDs and may propose intent fields. The server validates
and completes those fields deterministically. No AI component authorizes a
join, chooses a compiler, changes metric meaning, stamps trust, or treats a
failed route as permission to broaden the search.

## 4. Versioned analytical contracts

The following shapes are normative in meaning. Exact TypeScript module
placement may vary, but all surfaces use one versioned serialized contract.

```ts
type DimensionRole =
  | "group_by"
  | "filter"
  | "display"
  | "rank_entity"
  | "time_axis";

interface AnalyticalQuestionFrameV2 {
  version: 2;
  interpretedQuestion: string;
  questionType:
    | "definition"
    | "scalar"
    | "ranking"
    | "trend"
    | "comparison"
    | "diagnosis"
    | "research";
  metricConceptIds: string[];
  entityGrainIds: string[];
  dimensions: Array<{
    dimensionId: string;
    role: DimensionRole;
    requestedLabel?: string;
  }>;
  memberBindings: Array<{
    dimensionId: string;
    canonicalValues: unknown[];
    source: "question" | "clarification" | "prior_result" | "parameter";
    confidence: "exact" | "high" | "medium";
    sourceTurnId?: string;
  }>;
  timeContext?: {
    timeDimensionId?: string;
    timeRole?: string;
    calendarId?: string;
    timezone?: string;
    grain?: string;
    completenessPolicy?:
      | "partial_current"
      | "latest_complete"
      | "closed_period";
    periods: Array<{
      id: string;
      kind: "absolute" | "current" | "previous_period" | "previous_year";
      start?: string;
      end?: string;
      alignToPeriodId?: string;
    }>;
  };
  comparison?: {
    basePeriodId: string;
    comparisonPeriodIds: string[];
    alignment?: "elapsed_period" | "calendar_period" | "fiscal_period";
    outputs: Array<"value" | "absolute_delta" | "percent_delta">;
    zeroDenominatorPolicy: "null" | "not_applicable";
  };
  ranking?: {
    entityDimensionId: string;
    byMetricId: string;
    byPeriodId?: string;
    direction: "asc" | "desc";
    limit: number;
    tiePolicy: "stable_secondary_key" | "include_ties";
  };
  requestedOutputs: Array<{
    id: string;
    kind: "dimension" | "metric_value" | "delta" | "percent_delta" | "rank";
    metricId?: string;
    periodId?: string;
  }>;
  ambiguity: Array<{
    field: string;
    candidateIds: string[];
    reasonCode: string;
  }>;
}
```

### 4.1 Metric capability contract

Every executable metric candidate exposes one normalized capability contract:

```ts
interface MetricCapabilityContract {
  metricId: string;
  semanticModelId?: string;
  measureIds: string[];
  primaryEntityId: string;
  defaultResultGrainId: string;
  resultGrainIds: string[];
  aggregation: string;
  additivity: {
    entities: "additive" | "semi_additive" | "non_additive";
    time: "additive" | "semi_additive" | "non_additive";
    nonAdditiveDimensionIds?: string[];
  };
  dimensions: Array<{
    dimensionId: string;
    entityId: string;
    supportedRoles: DimensionRole[];
    relationshipPathIds?: string[];
  }>;
  timeDimensions: Array<{
    dimensionId: string;
    role: string;
    supportedGrains: string[];
    defaultFor?: Array<"scalar" | "trend" | "comparison">;
  }>;
  freshness?: {
    observedThroughFieldId?: string;
    defaultCompletenessPolicy?:
      | "partial_current"
      | "latest_complete"
      | "closed_period";
  };
  operations: Array<
    "filter" | "group" | "trend" | "compare" | "rank" | "window" | "having"
  >;
  supportedOutputKinds: Array<
    "dimension" | "metric_value" | "delta" | "percent_delta" | "rank"
  >;
  declaredOutputIds?: string[];
  executionCapabilities: Array<{
    route: "certified" | "semantic" | "governed_sql" | "exploratory";
    adapterId?: string;
  }>;
  sourceFingerprint: string;
}
```

The contract is normalized from certified block declarations, DQL analytical
overlays, dbt/MetricFlow metadata, semantic runtime capabilities, and validated
relationships. Missing facts stay missing; normalization cannot invent them.

### 4.2 Resolved plan v2

`ResolvedAnalyticalPlanV2` contains the validated question frame plus exact
qualified bindings, capability proof, temporal proof, relationship proof,
selected route/adapter, relational operations, result contract, KnowledgeLens,
snapshot ID, budgets, and content fingerprint. It retains an explicit
compatibility reader for v1 plans; a v1 plan cannot silently acquire comparison
or time semantics that it did not express.

## 5. Analytical resolution rules

### 5.1 Dimension roles

- `revenue from Zoom customer` binds `Zoom` as a customer member filter and
  returns scalar revenue unless the user also asks for a customer breakdown.
- `revenue by customer` binds customer as `group_by`.
- `top customers by revenue` binds customer as both grouping and ranking entity.
- A display label may be added only when its relationship and result-grain
  behavior are proven.
- A dimension compatible only as a filter cannot be promoted to grouping, and a
  grouping-only member cannot be assumed to support value filtering.

### 5.2 Member values

Member resolution follows `AGT-012`. A phrase maps to one qualified dimension
and canonical value set using approved vocabulary, semantic metadata, bounded
authorized runtime values, or prior-result provenance. Multiple plausible
customer dimensions or multiple canonical `Zoom` members produce one focused
clarification. The displayed table sample is never the member dictionary.

### 5.3 Time semantics

Time resolution uses this precedence:

1. explicit user period, timezone, calendar, and as-of meaning;
2. declared certified-asset parameter/time contract;
3. selected metric capability contract;
4. eligible domain analytical policy or selected Skill guidance;
5. configured project locale only for representational timezone/calendar
   defaults; then
6. clarification when a material ambiguity remains.

Column-name heuristics may retrieve candidates but cannot select the final time
dimension. The plan distinguishes event time, posting time, report-as-of time,
valid-from/to time, and compiler-required technical time such as
`metric_time`.

Every relative period is converted to bounded instants before execution and
records its timezone and calendar. `today` must also declare whether partial
data is allowed. When policy requires the latest complete day and warehouse
freshness ends yesterday, the answer says `latest complete day` and its actual
date rather than presenting zero or partial data as today.

### 5.4 Comparison and ranking

Comparison periods use the same compatible time role and entity grain unless an
explicit governed metric contract defines otherwise. Alignment records
calendar/fiscal semantics and handles leap days, partial periods, and unavailable
prior data deterministically.

Ranking is applied after period aggregation. The plan records the ranking
entity, metric, period or comparison expression, direction, limit, and tie
policy. `current revenue and last-year revenue for the top five customers`
defaults to ranking by current revenue only when that rule is declared by the
eligible domain/Skill policy or is unambiguous from the wording; the receipt
states the choice.

Percent change uses a decimal-safe operation and the declared zero-denominator
policy. It is never calculated from rounded display values.

## 6. Deterministic compatibility solver

The solver evaluates complete candidate tuples rather than independently
choosing the highest-scoring metric, dimension, and time field. A tuple is
executable only when it proves:

- exact metric identity and measure behavior;
- requested entity/result grain;
- every dimension role and member binding;
- time role, grain, period bounds, calendar, timezone, and completeness;
- additivity across requested entities and periods;
- every required relationship path and fanout guard;
- comparison, ranking, window, filter, and arithmetic capability;
- route/adapter availability and policy eligibility; and
- every requested output field.

The solver returns one of:

- a unique fully compatible tuple;
- a structured ambiguity containing the smallest material choice;
- an actionable modeling/runtime gap with failed proof IDs; or
- a policy/permission refusal.

Trust ranks routes only after meaning and compatibility are fixed. A certified
block that cannot emit prior-year revenue or customer grain is context-only for
that question.

## 7. Execution route behavior

### 7.1 Certified blocks

Certified assets declare an input/output capability contract including allowed
parameters, metrics, dimensions and roles, time semantics, comparisons,
ranking, grain, and outputs. Fit is one of:

- `exact`: executable without adaptation;
- `parameterized`: executable through declared values only;
- `adaptable`: executable through explicitly certified operations only;
- `context_only`: relevant but cannot answer the requested shape; or
- `incompatible`: conflicts with requested meaning or policy.

Only the first three can terminate, and the receipt records the fit class.

### 7.2 Semantic route

Native, MetricFlow CLI, and dbt Cloud adapters compile the same resolved tuple.
Compiler-required technical dimensions are explicit internal bindings. An
adapter cannot replace the chosen metric, select a same-named dimension from
another semantic model, or remove a requested output to make compilation pass.

### 7.3 Governed dbt relational route

Repository/FTS/lexical search discovers relation and column candidates inside
the eligible domain/model neighborhood. It cannot authorize execution. The
relational planner requires exact qualified relations/columns, declared or
proven grain, aggregation behavior, time role, relationship keys/cardinality,
fanout safety, and output aliases. DQL renders the SQL from constrained
operators.

### 7.4 Exploratory route

Exploration remains bounded, single-domain, review-required, and visibly less
trusted. Missing grain, time role, or join proof is a modeling gap, not an
invitation to guess.

## 8. Multi-period execution graph

The logical graph for current/prior top-N contains these typed operations:

1. resolve and bound current and comparison periods;
2. aggregate the selected metric at the requested entity grain for each period,
   or invoke an equivalent semantic offset metric with the same contract;
3. align period results at the proven entity key;
4. calculate absolute and percentage deltas with decimal-safe arithmetic;
5. rank by the declared metric/period/expression;
6. apply deterministic tie behavior and limit; and
7. validate projected columns, result grain, row bound, and fingerprints.

One SQL statement, multiple CTEs, or multiple adapter executions are equivalent
only when they produce the same executable-plan and result contract. Each
warehouse execution receives its own sub-receipt; the terminal receipt binds the
whole graph.

## 9. Insight and story contract

After result validation, the server may compute:

- requested values and period labels;
- absolute and percentage changes;
- top/bottom entities and contribution shares when mathematically supported;
- observed-through/as-of date and completeness state;
- missing comparison coverage and denominator caveats; and
- trust, lineage, grain, filter, and policy caveats.

Each fact points to result columns and an execution receipt. The narrator may
order and verbalize these facts for the user's question and selected Skill, but
cannot add a number, redefine a period, imply causality, or hide a material
caveat. Deep Research continues through `AGT-016` typed deltas rather than a
free-form second interpretation.

## 10. How it answered

Every successful or failed executable run exposes one inspector with these
sections when available:

1. **Plan** — business interpretation, metric, entity grain, dimension roles,
   members, time policy/periods, comparison, ranking, outputs, and route reason.
2. **DQL** — exact artifact source, applied parameters, source fingerprint, and
   copy/derive controls.
3. **SQL** — exact compiled statement or statements, dialect, parameter
   placeholders, SQL fingerprint, and notebook-copy control.
4. **Lineage** — semantic/dbt objects, columns, relationships, domain/import
   evidence, and result lineage.
5. **Trust** — trust label, capability/compatibility proof, Skill/Domain
   guidance, receipt status, and review requirements.
6. **Steps** — actual retrieval, resolution, plan, compile, validate, execute,
   repair, and result-validation phases with bounded attempt counts.
7. **Failure** — stable code, failed phase, safe message, failed qualified
   bindings, recoverability, and allowed next actions.

For semantic runs, Plan/Lineage/Trust/Steps also expose the friendly label,
qualified authoring identity, exact runtime reference, selected adapter,
compiler target, redacted execution target, physical-preflight status,
warehouse query ID when available, and the actual post-repair runtime request.
These are projections of the canonical execution receipt rather than
independently reconstructed client state (`API-006`, `API-007`, `UI-012`).

The business answer remains primary. The inspector progressively discloses
technical detail and is available even when no result rows exist.

## 11. Failure and repair contract

```ts
interface AnalyticalFailureV1 {
  version: 1;
  runId: string;
  failureId: string;
  code:
    | "COLUMN_NOT_FOUND"
    | "RELATION_NOT_FOUND"
    | "PERMISSION_DENIED"
    | "AMBIGUOUS_COLUMN"
    | "DIALECT_ERROR"
    | "SNAPSHOT_DRIFT"
    | "TIMEOUT"
    | "RESULT_CONTRACT_MISMATCH"
    | "COMPILATION_FAILED"
    | "POLICY_DENIED";
  phase:
    | "planning"
    | "compilation"
    | "validation"
    | "execution"
    | "result_validation";
  message: string;
  recoverability:
    | "retry_same"
    | "refresh_snapshot"
    | "edit_dql"
    | "edit_sql"
    | "change_authorized_connection"
    | "request_access"
    | "modeling_change"
    | "none";
  failedBindings: Array<{
    qualifiedId?: string;
    role?: string;
    reasonCode: string;
  }>;
  snapshotId: string;
  planFingerprint?: string;
  dqlFingerprint?: string;
  sqlFingerprint?: string;
  safeActions: string[];
}
```

The compatible v2 failure contract adds target-bound semantic execution
failures without changing the meaning of v1 codes:

- `SEMANTIC_ADAPTER_NOT_READY`;
- `SEMANTIC_TARGET_BINDING_MISSING`;
- `EXECUTION_TARGET_MISMATCH`;
- `SEMANTIC_SOURCE_DRIFT`;
- `SEMANTIC_MEMBER_BINDING_FAILED`;
- `SEMANTIC_PATH_AMBIGUOUS`;
- `IDENTIFIER_SCOPE_INVALID`;
- `EXECUTION_CANCELLED`; and
- `SEMANTIC_COMPILATION_TIMEOUT`.

`EXECUTION_TARGET_MISMATCH` is distinct from `SNAPSHOT_DRIFT`: the governed
source may be unchanged while the active account, database/catalog, schema,
role, warehouse, dbt target, or dbt Cloud environment differs. It is emitted in
phase `validation`, submits zero analytical queries, and is recoverable only by
an explicit authorized connection change or setup reapplication. V1 payloads
remain readable; new runs write the latest contract (`API-007`, `SEC-004`,
`E2E-014`).

The server retains the original artifact/receipt and returns only diagnostics
the caller is authorized to inspect. Logs, telemetry, and streamed phase events
redact secrets, sensitive parameter values, raw provider prompts, and
unauthorized metadata.

### 11.1 Repair actions

- **Retry same plan:** appropriate for a transient connector failure; no
  retrieval or meaning call.
- **Refresh/reapply snapshot:** explicit source-change flow; the original run
  stays immutable and the new run binds the new snapshot.
- **Edit DQL and rerun:** creates a derived DQL artifact, recompiles through all
  compatibility, policy, SQL, and output guards, and creates a new receipt.
- **Open SQL in Notebook:** creates an editable review-required SQL cell linked
  to the source run. It is an expert escape hatch, not governed equivalence.
- **Change authorized connection/request access:** explicit user action for
  permission failures; DQL never attempts an alternate unauthorized route.
- **Save as draft block:** persists a successful derived artifact as
  review-required. Ordinary evaluation/review is required before certification.

### 11.2 Trust transitions

| Change                                         | Required trust result                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Declared certified parameter value only        | retain certified asset identity; create a new execution receipt               |
| Display/chart preference only                  | analytical trust unchanged                                                    |
| DQL source or analytical operation             | remove certification; revalidate as governed or review-required               |
| Compiled SQL text                              | exploratory/review-required unless later rebuilt and reviewed as governed DQL |
| Snapshot refresh with unchanged logical source | recompile and issue a new receipt; do not reuse stale proof                   |
| Connection/role change                         | re-execute and issue a new receipt under the new redacted connection identity |
| Reviewed draft promotion                       | follow the existing evaluation and certification workflow; never auto-certify |

## 12. Security and permission behavior

- `PERMISSION_DENIED` is terminal for the selected route and preserves its
  original code across Ask, Research, repair, and every transport.
- DQL does not probe alternate relations, schemas, roles, or connections to
  evade access control.
- The UI may show SQL and governed identifiers already authorized for the
  workspace, but never expands the user's metadata visibility because the
  warehouse mentioned an inaccessible object.
- Compiled SQL prefers parameter placeholders. Parameter displays follow the
  same visibility/redaction policy as the executing surface.
- A manual SQL cell still passes connector safety, statement-count, mutation,
  row-bound, dialect, and cancellation guards. Manual editing never grants
  relationship or certification proof.

## 13. Delivery plan

Each phase names its primary acceptance IDs and must land with focused tests.
An implementer may report `implemented`; independent verification remains
separate.

### Phase AC0 — Freeze contracts and golden questions

Acceptance: `CONTRACT-002`, `AGT-017`, `API-007`, `E2E-013`, `E2E-014`.

- Freeze serialized v2 question/plan and v1 failure contracts.
- Add compatibility readers for v1 resolved plans and current answer payloads.
- Add golden plan fixtures before changing prompts or routing.
- Record exact expected IDs, roles, periods, rank basis, route, outputs, and
  failures for every canonical scenario.

Exit: all golden cases fail for the intended missing behavior rather than
because fixtures lack governed metadata.

### Phase AC1 — Metric capability and analytical-policy normalization

Acceptance: `CONTRACT-002`, `SKILL-004`.

- Normalize certified, DQL, dbt semantic/MetricFlow, and relationship metadata
  into `MetricCapabilityContract`.
- Add explicit time-role, supported-grain, additivity, entity, dimension-role,
  freshness, and operation capabilities.
- Compile eligible Domain/Skill policies for timezone, calendar, completeness,
  comparison alignment, ranking default, and story guidance.
- Add a readiness report showing which important metrics support scalar,
  filter, grouping, trend, comparison, and ranking questions and why not.

Exit: no capability is inferred from display-name text after normalization.

### Phase AC2 — Analytical frame v2 and deterministic tuple solver

Acceptance: `AGT-017`, `AGT-018`.

- Extend meaning resolution to propose dimension roles, periods, comparison,
  ranking, and outputs using only retrieved IDs.
- Deterministically bind members, time policy, complete tuples, and ambiguity.
- Preserve exact explicit-reference and prior-result paths without extra calls.
- Return focused clarification or modeling gaps for ambiguous/missing time,
  member, grain, additivity, relationship, or ranking proof.

Exit: the three canonical revenue questions resolve to exact plan fixtures with
zero SQL execution.

### Phase AC3 — Route capability and executable graphs

Acceptance: `AGT-018`, `AGT-019`.

- Upgrade certified-block fit to the complete analytical capability contract.
- Upgrade semantic adapters to consume periods/comparisons/ranking exactly.
- Add governed relational operators for aligned periods, comparison arithmetic,
  rank-after-aggregation, deterministic ties, and result validation.
- Keep exploratory routing bounded and review-required.

Exit: certified, semantic, and governed-relational variants of the canonical
questions produce equivalent logical results and honest distinct trust labels.

### Phase AC4 — Result facts and business story

Acceptance: `AGT-020`.

- Compute scalar, comparison, contributor, freshness, and caveat facts from
  validated results.
- Bind every numeric fact to columns and receipts.
- Make selected Skills influence presentation/policy only within their recorded
  scope.
- Reject unsupported numbers, causal wording, grain drift, filter drift, and
  hidden partial-period claims.

Exit: deterministic no-provider narration remains useful and provider-backed
narration contains no unsupported claim.

### Phase AC5 — Stable diagnostics and repair APIs

Acceptance: `API-007`, `SEC-004`.

- Emit the versioned failure contract from compilation, validation, connector,
  execution, and result validation.
- Preserve original DQL/SQL/plan/receipt fingerprints on failure.
- Implement derive/recompile/rerun actions without another meaning search.
- Enforce trust transitions, redaction, path confinement, budgets, and terminal
  permission behavior.

Exit: every supported failure has one stable code and the same repair behavior
through direct API, CLI, MCP, and Chat.

### Phase AC6 — How it answered UI

Acceptance: `UI-012`, `UI-013`.

- Consolidate existing DQL, SQL, lineage, trust, and step fragments into the
  seven-section inspector.
- Add plan/time/member/comparison/ranking summaries and failed-phase focus.
- Add `Repair DQL and rerun`, `Open SQL in Notebook`, `Refresh and retry`,
  `Change connection/request access`, and `Save as draft block` as capability-
  gated actions.
- Preserve the shared Cloud theme/token/persistence contract.

Exit: successful and failed runs are inspectable and repairable in the built
`dql notebook` CLI; Vite-only evidence is not accepted.

### Phase AC7 — Cross-surface, negative-path, and scale verification

Acceptance: `E2E-013`, `E2E-014`, plus regression of `E2E-006`, `E2E-010`,
`E2E-011`, and `E2E-012`.

- Run the complete scenario matrix through browser Ask, Notebook, direct CLI,
  MCP, and Chat over one snapshot.
- Assert plan and receipt fingerprints, not prose or SQL formatting.
- Exercise certified, semantic, governed-relational, exploratory, clarification,
  and refusal paths.
- Prove budgets on the enterprise-scale fixture and preserve existing retrieval
  recall and route/trust accuracy.
- Run CLI-backed browser, accessibility, security, migration, compatibility,
  and Cloud embed-contract gates.

Exit: all new acceptance rows are independently verified and no existing
release gate regresses.

### Phase AC8 — OSS documentation and release readiness

Acceptance: final verification of all phase IDs under W08.

- Document modeling requirements for metric/dimension/entity/time connectivity,
  capability readiness, repair, trust transitions, and safe SQL editing.
- Update examples, quickstart, troubleshooting, and release notes.
- Verify clean npm install/upgrade and the existing required Guided Setup dbt
  reapply flow without changing saved connections or secrets.
- Audit the staged diff for snapshots, traces, local connections, Playwright
  output, generated evidence, and private data.

Exit: a new OSS user can model, ask, inspect, repair, and rerun the canonical
questions from public documentation.

## 14. Canonical scenario matrix

### 14.1 Analytical composition (`E2E-013`)

1. **Revenue today:** binds the governed revenue metric, scalar grain,
   authoritative reporting-time dimension, business timezone, completeness
   policy, concrete bounded period, as-of date, and one value output.
2. **Revenue from Zoom customer:** binds `Zoom` to exactly one governed customer
   dimension as a filter, does not add grouping, and proves the metric/customer
   relationship.
3. **Current and last-year revenue for top five customers:** binds customer as
   grouping/rank entity, two aligned periods, current-period descending rank,
   limit five, stable ties, and current/prior/delta/percent-delta outputs.
4. **Ambiguous time role:** two compatible report dates without a governed
   default produce a focused time-role clarification and no execution.
5. **Incomplete today:** latest-complete policy returns the actual latest date
   and labels it; partial-current policy returns partial data with a caveat.
6. **Ambiguous member:** multiple authorized `Zoom` members or customer
   dimensions produce a focused member clarification.
7. **Missing relationship:** a retrieved customer column without relationship
   proof returns a modeling gap; repository search cannot authorize the join.
8. **Non-additive metric:** an unsupported time/customer aggregation fails
   compatibility before SQL.
9. **Certified mismatch:** a relevant certified revenue block missing comparison
   outputs remains context-only; a fully compatible block wins.
10. **Route equivalence:** certified, semantic, and governed relational fixture
    variants satisfy the same output contract with route-appropriate trust.
11. **Story grounding:** every narrated number and comparison points to a result
    fact and receipt; unsupported causality is rejected.
12. **Surface parity:** equivalent requests return identical frame, resolved
    plan, route, trust, result contract, stable error, and receipt identity.

### 14.2 Transparent repair (`E2E-014`)

1. `COLUMN_NOT_FOUND` identifies the execution phase and failed governed
   binding, preserves DQL/SQL, offers refresh/DQL/SQL repair, and never displays
   a successful answer.
2. `RELATION_NOT_FOUND` distinguishes snapshot drift from an invalid derived
   edit and preserves the original run.
3. `PERMISSION_DENIED` preserves its code, offers request-access or explicit
   authorized-connection actions, and performs zero route-broadening attempts.
4. `AMBIGUOUS_COLUMN` and `DIALECT_ERROR` show the compiled statement and safe
   repair path without leaking raw parser traces into business chat.
5. `TIMEOUT` remains timeout, supports bounded retry/cancellation, and does not
   start Research or change metric identity.
6. `RESULT_CONTRACT_MISMATCH` names missing outputs and blocks narration/pinning
   as a complete answer.
7. A certified parameter-only rerun retains asset certification and receives a
   new execution receipt.
8. Editing DQL removes certification, recompiles through every guard, and may
   become governed/review-required only according to validation evidence.
9. Editing SQL creates an exploratory/review-required notebook cell linked to
   the source run; the prior receipt remains immutable.
10. A successful derived repair may be saved as a draft block but never becomes
    an approved hint or certified block automatically.
11. Logs, streamed steps, API payloads, screenshots, and stored traces contain
    no secrets, unauthorized metadata, or disallowed plaintext values.
12. Browser, CLI, MCP, Chat, and Notebook expose the same failure code,
    fingerprints, recoverability, and trust transition.

## 15. Ownership and integration order

| Phase | Primary workstream | Owned areas                                         | Depends on                   |
| ----- | ------------------ | --------------------------------------------------- | ---------------------------- |
| AC0   | W04/W07            | versioned contracts and fixtures                    | current plan-first contracts |
| AC1   | W01/W04            | capability normalization and policy compilation     | AC0                          |
| AC2   | W04                | meaning frame and tuple solver                      | AC1                          |
| AC3   | W04                | block fit, adapters, relational operators, receipts | AC2                          |
| AC4   | W04                | deterministic facts and narration guards            | AC3                          |
| AC5   | W04/W06            | error/repair APIs, redaction, security              | AC3                          |
| AC6   | W05                | inspector and repair UI                             | stable AC4/AC5 APIs          |
| AC7   | W07                | integration, browser, parity, performance           | AC1–AC6                      |
| AC8   | W08                | OSS docs and release evidence                       | verified AC7                 |

Shared type changes are reviewed under W01/API ownership before agent or UI
integration. W04 does not change UI layout; W05 does not reimplement routing,
trust, or repair policy in the browser. W07 may repair integration defects but
cannot weaken assertions or normative contracts.

## 16. Release gates

- The three canonical revenue questions pass with exact plan assertions, not
  keyword-only route assertions.
- No ambiguous time role, member, relationship, or non-additive operation
  executes.
- Zero wrong certified answers and zero invented-ID executions.
- Every numeric narrative claim is receipt-backed.
- Every supported failure preserves its original stable code across surfaces.
- Permission failures perform zero alternate-source attempts.
- User edits follow the trust-transition matrix and preserve the source run.
- Existing retrieval/scale, parameter binding, plan-first, migration, security,
  built-CLI browser, npm upgrade/reapply, and Cloud embed gates pass unchanged.
- No generated evidence, snapshots, traces, connection state, secrets, or
  Playwright artifacts are committed.
