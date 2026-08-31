# Ask AI orchestration contract

Status: **implemented by the current worktree; independent verification pending**

This slice defines the unified Ask execution boundary for ordinary analytical
questions. It is additive to the existing governed-answer contracts and does not
change the Cloud theme, App, Block, or Modeling surfaces.

## Turn contract

## Ask Agent Runtime V2 amendment

`AskAgentRuntimeV2` supersedes deterministic **business-meaning authority**
for V2 free-text turns only. It does not weaken qualified identity, snapshot,
relationship, MetricFlow, SQL, authorization, or trust invariants.

1. A free-text turn first retrieves one immutable workspace: up to 128
   server-side candidates, 24 role-balanced initial cards, and at most two
   12-card same-snapshot expansions. The agent sees no raw credentials, paths,
   provider response, or hidden reasoning (`CTX-009`, `AGT-047`).
2. The bounded agent selects only the next canonical tool and qualified handles.
   It cannot recurse through `ask_dql`/`answer_question`, choose a trust label,
   invent IDs, or execute a wider snapshot. Canonical tools are certified,
   semantic, relational/DQL, exploratory-SQL, context, value-search,
   clarification, and finish tools (`AGT-048`, `API-017`).
   For `compile_and_run_semantic`, the agent selects only admitted metric,
   dimension, filter, time, and grain bindings. The local host resolves the one
   configured, target-ready semantic adapter before exposing an executable
   capability; adapter/engine is not a model-facing tool argument. A missing
   selected host engine is a pre-freeze `SEMANTIC_ENGINE_UNAVAILABLE`
   observation, while stale legacy `engine` arguments are ignored and cannot
   trigger a retry loop (`AGT-047`).
3. Pre-freeze misses are typed observations. The tool kernel enforces certified
   → semantic → governed relational → exploratory priority and refuses a later
   tier when an earlier complete tier exists. Once executable, a route freezes;
   one same-plan repair is allowed and no downgrade or re-interpretation is
   permitted (`AGT-049`, `AGT-050`).
4. General, definition, and business-context turns can answer from retrieved
   context without a warehouse. Result follow-ups retain typed plan/result/
   member handles; an ambiguous pronoun produces one stable clarification
   rather than a repeated reparse. A definition or business-context answer
   that claims governed context completes only through the host-issued
   `finish_answer` control with retained retrieved-evidence IDs; otherwise it
   remains an ungrounded conversational response (`AGT-047`, `AGT-051`).
5. Explicit Research uses the same kernel with separate 120-second/branch
   budgets and receipt-backed verdicts. It does not silently enter Research
   from ordinary analytical wording (`AGT-052`).
6. Default remote provider egress is facts, aggregates, schema, and
   fingerprints. Rows require an explicit project setting; local and opted-in
   remote rows are capped at 20×20/400 cells (`AGT-053`, `PERF-004`).

V1 remains readable and is available only through an explicit `legacy_v1`
operator mode. `shadow_v2` never serves a V2 result. Stage 1 exposes the
runtime/receipt contracts and host seam. The current implementation also
persists the V8 decision story into the existing local trace API and Notebook
trace detail, and projects the existing bounded Research ledger as V4. Those
additive readers do not make a trace, export, or Research projection an
execution authority. Built-CLI designated-fixture and independent verification
remain required (`AGT-054`, `OBS-017`, `E2E-025`).

1. Retrieval builds one immutable, bounded context pack. Certified blocks,
   semantic members/metrics, governed relational metadata, business context,
   runtime schema, and trusted conversation state are retrieved in parallel and
   fused by qualified identity. A failed lane contributes a typed diagnostic;
   it does not erase another lane or broaden scope (`CTX-007`).
2. A fresh natural-language analytical turn normally receives one bounded
   candidate-ID-only meaning/planning call. The call returns IDs and typed
   interpretation fields, never SQL or free-form trust. Explicit selections,
   reruns/Apply, structured clarification, and frozen Research children may
   use the zero-call path (`AGT-027`, `AGT-028`).
   The legacy/no-evidence category-only classifier, when it is needed for a
   non-analytical fallback, is recorded as the distinct `classification`
   provider phase and egress purpose. It cannot coexist with candidate-ID
   `meaning_resolution` in the same run and never proves a governed binding.
3. Before the plan freezes, Ask evaluates the compatible cascade in order:
   certified block → semantic compile → governed relational composition →
   review-required generated SQL. A missing governed tier is not itself an
   error if a later eligible tier can produce a bounded answer (`AGT-029`).
4. Deterministic code validates identity, capability, members, joins, SQL,
   aggregation safety, execution, and result shape. Search/rank is evidence,
   not a substitute for interpretation. Bare rankings with a same-grain count
   use one typed measure clarification rather than looping (`AGT-030`).

## Conversation and output contract

- Prior rows and values are source-attributed typed state. Singular people
  pronouns resolve only against an unambiguous prior customer/member binding;
  ambiguity becomes a choice, never a first-row guess (`AGT-031`, `AGT-033`).
- Descriptive attribute lookups do not require a metric. The generated lane can
  select a region, segment, category, or other inspected attribute for a typed
  member. Missing relation/column/relationship facts become a precise typed
  gap with next actions, not a generic governed-query failure (`AGT-031`).
- Every successful result is normalized once to the canonical result contract:
  named columns, object rows, row count, execution timing/receipt, and source
  trust metadata. Narration, UI tables, Apply/rerun, and persisted conversation
  state consume that contract (`AGT-032`).
- Compound questions are represented as a bounded task graph. Independent
  clauses may partially succeed, while failed clauses retain their typed gap
  and evidence. Research records at most six receipt-backed branch entries,
  followed by an explicit synthesis/stopping reason (`AGT-033`).
- Each Research branch receives a fair share of the remaining run deadline
  after reserving finalization time. A timed-out branch records a terminal
  receipt and span; branches that cannot start within the remaining budget are
  recorded as `budget_exhausted`. If the reserve remains, synthesis returns a
  limited, receipt-grounded result rather than losing completed branch evidence
  (`AGT-016`, `AGT-033`).
- If the root deadline or an explicit user cancellation interrupts an active
  Research branch, the local runtime persists a redacted, blocked partial root
  artifact before terminal run finalization. It preserves the root and child
  IDs, branch receipt/ledger, and trace links for restart inspection; the
  interrupted branch is typed `run_deadline` or `cancelled`, while an ordinary
  child execution failure is typed `execution_failed`, never `completed`
  (`AGT-033`, `OBS-005`, `OBS-012`).
- `check_lineage` is a separate, zero-call structural Research program. It
  resolves only one exact ID, exact name, or canonical qualified alias in the
  frozen root snapshot, then traverses the already-local lineage graph with
  fixed depth, path, node, and edge caps. An unqualified exact display-name
  lookup is a cancellable, non-materializing bounded scan: it is accepted only
  after the scan proves uniqueness, and an exhausted work/candidate cap is
  typed `unavailable`, never a first-match selection. It never enters the analytical
  router, provider, SQL compiler, warehouse, or repair path. Missing,
  ambiguous, stale, truncated, and unavailable states are typed structural
  outcomes, not query failures or a reason to fall through to a broader
  search. A graph edge establishes dependency context only; it never supports
  a causal business claim (`AGT-016`, `AGT-033`, `AGT-040`).
- A qualified target is never widened to a bare leaf/display-name match in a
  different model or domain. The root captures both the graph and a
  `dql-manifest`-inclusive source signature; a changed signature makes each
  later lineage child stale before traversal. One shared bounded traversal
  budget owns its retained nodes, edges, terminal-route path count, predicates,
  and structural fingerprint across both directions; upstream and downstream
  routes draw from the same path allowance.
- `ResearchEvidenceLedgerV3` adds a content-safe lineage-receipt entry beside
  V1/V2 analytical-result entries. The lineage entry has bounded counts and
  opaque fingerprints, but no SQL, rows, result fingerprint, provider payload,
  graph labels, paths, or target text. Existing V1/V2 readers continue to
  receive analytical-result entries only, so a graph walk cannot be mistaken
  for a data execution (`AGT-033`, `OBS-012`).
- A Research root containing any V3 lineage entry remains
  `review_required`/`needs_review`, including when another child has a
  successful analytical result. Structural evidence is never sufficient to
  promote the root to `grounded`.

## Trust and repair boundary

Generated SQL and generated narration remain review-required. A frozen resolved
analytical plan is immutable; one same-target repair may correct a validation or
warehouse syntax issue, but repair cannot reselect meaning, widen relations, or
certify the result. Pre-freeze modeling gaps may continue through the relational
or generated lane; post-freeze failures remain fail-closed with the attempted
plan, SQL/DQL, typed gap, and safe next actions preserved.

The migration switch `requireMeaningCallForNaturalLanguage` is default-on. It is
only a rollback/testing control for hosts that must temporarily compare the
legacy deterministic routing behavior; explicit identity binding remains the
only normal zero-call exception.

## Evidence in this implementation

- Core orchestration types, canonicalization, context fusion, task graph, and
  V1/V2/V3 research ledgers: `packages/dql-agent/src/analytical-orchestration.ts`
  and `analytical-orchestration.test.ts`.
- Router meaning-call budget and ranking guard: `packages/dql-agent/src/router.ts`.
- Pre-freeze recovery and typed coverage gaps/research ledger: `packages/dql-agent/src/agent-run-engine.ts` and `apps/cli/src/local-runtime.ts`.
- Conversational member resolution and attribute generation: `apps/cli/src/llm/providers/dql-agent-provider.ts` and `packages/dql-agent/src/answer-loop.ts`.
- Canonical result rendering/persistence: `apps/dql-notebook/src/api/client.ts`,
  `UnifiedAgentRunPanel.tsx`, and `AgentAnswerCard.tsx`.
- Bounded local lineage Research program and zero-call contract:
  `apps/cli/src/research-lineage-program.ts`, its focused tests, and the
  `research.lineage` branch in `apps/cli/src/local-runtime.ts`.

The focused package tests and production builds are implementer evidence. The
designated built-CLI fixture and independent verifier still own `verified` status.

## Ask Analyst Runtime V1.15 amendment

`AskAnalystRuntimeV1` is the authoritative entrypoint for Ask and explicit
Research. It creates one `BusinessQuestionFrameV3`, bounded
`AnalyticalMissionV1`, same-snapshot `EvidenceWorkspaceV1`, and route-neutral
`AnalyticalProgramV1` before invoking a compiler. Certified blocks, MetricFlow,
governed relational execution, and review-required exploratory SQL are compiler
choices for that one program; they are not independent routers. The previous
hybrid router remains a compiler broker and execution adapter only. It receives
the runtime-owned evidence snapshot, so it cannot retrieve a second snapshot or
reparse the business question.

- `AGT-035`: exact stable qualified metric/block references, structured
  selections, reruns, and frozen Research children are zero-provider meaning
  paths. A normal fresh Ask gets at most two planning continuations.
- `AGT-036`: ordinary Ask has at most three tasks, twelve runtime tools, one
  execution per task, and one repair total under the existing 45-second ceiling.
- `AGT-037`: pre-freeze unavailable/ineligible compilers advance in canonical
  order; policy denial remains terminal and a frozen compiler never downgrades.
- `AGT-038`: clarification is reserved for two or more validated executable
  business meanings that would change the result. Technical/retrieval/provider
  failures are typed incident states, never clarification prompts.
- `AGT-039`: results produce `BusinessAnswerV1` from validated fact IDs. The
  default narration is facts-only; deterministic narration is labelled when no
  fact set exists. An unspecified ranking limit defaults to 10 and is retained
  in the typed frame for presentation.
- `AGT-040`: Research uses the same runtime for each bounded child program and
  labels fewer than three groundable branches as limited scope. Row presence is
  not causal evidence.
- `API-015`: `AskAnalystStateV1` and the typed conversation delta persist with
  `AgentRunDiagnosticReceiptV5`; V1–V4 stay readable.
- `OBS-015`: the default inspector story is What happened, Why, Impact, and
  How to proceed. Raw/noisy local spans remain available only in the Advanced
  trace view.
- `E2E-023`: browser/CLI/MCP parity compares the same program IDs, compiler
  selection, frozen-plan state, fact/result fingerprints, and terminal cause.

This amendment is implemented, not independently verified. The designated
built-CLI fixture and independent verifier still own verification status.

## Retrieval-first adaptive Ask amendment

`AskAnalystRuntimeV1` now uses a retrieval-first adaptive loop for ordinary
Ask. It keeps the same governed cascade and immutable-plan safety boundary,
but makes interpretation and recovery explicit rather than treating a narrow
planner package as proof that the snapshot is absent.

1. One immutable source snapshot is prequalified into at most 32 qualified
   workspace candidates. A role-balanced package releases at most 16 cards to
   the planner: explicit measures, entity key/display, each requested
   categorical dimension, time, filter/member, and relationship roles are
   reserved before correlated candidates fill spare capacity. Excluded cards
   are recorded as `not_admitted`, never as missing (`CTX-008`, `AGT-041`).
2. A normal analytical Ask receives one provider-neutral structured planning
   call unless an exact, server-proven fast path applies. The planner returns
   supplied IDs, typed operations, assumptions, and an optional one-role
   recovery request; it cannot emit SQL, joins, trust, policy, compiler
   eligibility, or a frozen plan (`AGT-042`).
3. The verifier proves every selected ID against the supplied package and
   every explicit requested measure, entity/display, dimension, member/filter,
   time, ranking, and output requirement. Parser/retrieval guesses are
   advisory; current-question filter literals, time/calendar, ranking, and
   output constraints remain host-owned. Qualified planner bindings may correct
   a stale inferred metric or display field, but cannot weaken those explicit
   constraints (`AGT-044`).
4. If exactly one verifier-proven role is missing, the host performs one
   same-snapshot, role/term-targeted search over the immutable 32-card
   workspace, admits at most four cards and three existing relationship paths,
   and permits exactly one constrained revision. The revision receives the
   prior proposal, prior selected IDs, verification feedback, and only the
   released target cards. Hidden/invented IDs, unmatched terms, unsafe joins,
   multiple unresolved roles, and all recovery after freeze are typed gaps,
   not another planning loop (`AGT-042`, `AGT-045`).
5. The verified route-neutral program then evaluates certified → MetricFlow →
   governed relational → review-required exploratory SQL. Pre-freeze
   unavailable/ineligible tiers advance; denied remains terminal; a frozen
   plan does not downgrade. Ordinary Ask never becomes Research from wording
   alone. A planner may merge only semantically compatible ingress clauses;
   otherwise every accepted one of at most three task programs gets its own
   frozen/executed receipt, or the whole Ask returns a pre-freeze scope gap
   without partial-success presentation (`AGT-043`, `AGT-046`).

Planner readiness is checked and traced before planner dispatch. A real
preflight cause is retained; an unconfigured or bare-unavailable provider is
an `unknown` configuration-safe incident, not an authentication claim. A
connection message is legal only after a frozen plan has actually attempted a
connection/compiler/execution boundary. Result facts are built from the final
executed answer artifact only, then constrain `BusinessAnswerV2` narration;
deterministic factual narration remains available when the narration call
fails.

`AskAnalystStateV2`, `AnalyticalProgramV2`, the typed conversation delta, and
`AgentRunDiagnosticReceiptV6` are additive JSON persistence. V1 state/program
and V1–V5 receipts remain readable. The default trace is one compact decision
story—interpretation, role coverage, planner, verifier/recovery, cascade,
freeze/connection, execution, facts, and safe next action—while raw spans and
candidate lifecycle remain Advanced local evidence (`API-016`, `OBS-016`,
`E2E-024`).
