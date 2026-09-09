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

V1 remains readable and is available only through an explicit, deprecated
`legacy_v1` operator mode for one release. `shadow_v2` no longer exists:
`authoritative_v2` is the default and the only serving runtime. Stage 1 exposes the
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

## Ask pipeline amendment (intent → prepare → execute)

Status: **implemented; the golden harness is the gate; independent
built-product verification pending**

The Ask pipeline (`packages/dql-agent/src/ask-pipeline/`, host
`apps/cli/src/ask-pipeline-host/`) supersedes the V2 tool kernel for every
ordinary Ask turn and for every analytical Research hypothesis. One rule:
**the LLM interprets, the host proves.** After interpretation no code reads
the question string again.

1. **One interpretation contract.** A turn produces exactly one
   `AnalyticalIntentV1` from one structured provider call over the snapshot's
   `VocabularyIndex` (every metric, dimension, entity, certified block,
   relation, column and business term the snapshot authorizes; fuzzy lookup
   proposes candidates, never authorizes a guessed id). Refs are validated
   against the vocabulary; an invented ref earns one bounded correction with
   the nearest authorized refs. Turn classification (conversation,
   definition, analytics) is a field of the same output. Every physical
   provider call, corrections included, is counted (`AGT-055`).
2. **Governed defaults and host proofs on the intent.** A metric whose name
   is the word the question uses is its meaning; a business term that
   defines a word is its meaning; a certified block that ranks the entity the
   question ranks fixes the measure of "top <entity>" (certified precedent).
   A word spent on the grain never names a measure. Identity is the entity
   key with the label displayed; a label finer than the grain is replaced by
   the grain's own label. Reachability and grain are never clarifications.
   A follow-up made only of the previous analysis's words cannot replace its
   measures on the first reading; a second reading that still replaces them
   becomes one clarification between the two (`AGT-056`).
3. **Prepare before commit.** Certified is entailment, not lexical fit: a
   block the intent names by ref is served as published (identity caveat on
   the proof); a block matched only through its measures must prove identity
   with a key column; an intent with no measures never entails. Semantic
   binds model-scoped names and keeps the compiler's verbatim message.
   Relational composes aggregate islands per fact grain over the semantic
   layer's entity joins and the relationships declared in Domain Studio
   (deprecated relationships never join). Exploration is an explicit one-run
   opt-in and never automatic; a policy denial is terminal. The highest
   trust that prepared is frozen as the executable; an execution proof
   failure (a silently dropped filter, fan-out) falls through to the next
   governed tier; an unchanged failed attempt is never repeated (`AGT-057`).
4. **Four outcomes, one receipt.** A turn ends `answered(tier, trust)`,
   `clarify(question, options)`, `gap(not_retrieved | not_modeled |
   ambiguous | unsupported | denied)` or `failed(stage, verbatim error)`.
   The pipeline receipt (intent, every prepared candidate and typed refusal,
   dispatches with replies, executed SQL fingerprint, verbatim failures,
   build identity) is persisted on the run as `diagnosticReceiptV9`, served
   by the trace API as `runtimeReceiptV9`, and rendered by the Notebook
   inspector; V1–V8 receipts stay readable for the runs that carry them
   (`AGT-058`, `OBS-018`).
5. **Conversation is intent edits.** The executed intent is persisted per
   turn as `contract.askIntentV1`; the next resolver call receives it and must
   account for every prior clause (inherited, changed, or removed with a
   reason) before anything runs (`AGT-059`).
6. **Request identity.** A submission carrying `Idempotency-Key` is claimed
   before any work; a replay attaches to the original run (`replayed: true`),
   a different question under the same key is `409 IDEMPOTENCY_CONFLICT`, an
   in-flight original streams to completion, and an unknown outcome is
   reported as such rather than re-executed (`API-018`).
7. **Runtime selection.** `pipeline_v3` is the only Ask runtime; the V2
   tool kernel is deleted. A configured `authoritative_v2` is served by the
   pipeline with a logged warning, and persisted V8 receipts stay readable.
8. **No partial answers; an empty result under a restriction is a gap.** A
   material unresolved clause with no vocabulary option is never demoted:
   the turn ends as `gap(not_modeled)` that names the clause and, when the
   intent still carries measures, the reading that was answerable, and
   nothing executes. Only a clause with exactly one option the intent
   already uses is a host-proven worry (reachability, grain). A result that
   holds nothing (no rows, or one row whose every cell is null) under a
   member literal, a time window, or any predicate is `gap(not_retrieved)`
   naming that cause (the literal, the window bounds, the predicate refs);
   an unrestricted empty result stays an answer. A time window is a
   restriction like any other: a window without an axis is bound to the
   measures' own time dimension when exactly one exists (recorded in
   provenance), otherwise every tier refuses it rather than dropping it, and
   execution proves both bounds are bound in the SQL or its parameters before
   anything runs. When the interpreter wrote down nothing but a clarification
   and the governed default supplied the only measure, question words the
   intent does not account for (a grain, a member) send the interpreter back
   once for the complete intent; a second bare reply becomes the
   clarification, never a scalar served for a breakdown (`AGT-060`).
9. **Browser submission identity.** The Notebook mints one identity per
   explicit submit, sends it as `Idempotency-Key`, persists the pending
   record before the request leaves, and pairs the answer with the question
   item of that submission by id, never by question text; identical
   questions are two runs. A reload before `agent-run-accepted` re-sends the
   stored request under the same key; `409 IDEMPOTENCY_CONFLICT` with a run
   id attaches to that run, without one it re-mints once; an unknown outcome
   names the run (`API-019`).
10. **Calendar values and receipt counts.** Date cells leave the host as ISO
   instants, and a UTC-midnight instant renders as the calendar day, never
   through the host timezone. The inspector's call counts, evidence label
   and the trace envelope's `selectedTier` come from `diagnosticReceiptV9`
   for a pipeline run; a question word is covered when a used measure's
   definition embodies it (a business term naming `is_drink_item` is covered
   by `drink_revenue`), so no false coverage warning is raised. A chat the
   user renamed keeps its title through later turns (`OBS-019`, `UI-024`).
11. **Contract v1.1: ratios, time roles, population.** A measure may be a
   `derived` ratio of two governed metrics or measures (`numerator /
   denominator`, never a column or block), synthesised as `ratio:<num>/<den>`
   and disclosed in the proof and the answer; the relational tier projects it
   from hidden per-island aggregates (`NULLIF` on zero), the semantic tier
   compiles both parts and divides after execution, and a block never serves
   one. Every metric card names its time role (`time <dim>`, from the metric's
   or measure's `agg_time_dimension` or the model default); measures under one
   window must share a role (same-named dimensions on different models are one
   role): one role is bound as the axis and recorded in provenance, several are
   one bounded clarification, and an axis the question named itself is kept
   with the difference disclosed. The relational tier binds the window to each
   island's own same-named time column and never joins a finer relation only
   to filter by time. `population: "all"` ("including locations with no
   orders") enumerates every member of the grain's entity from its own
   relation (the key is rewritten to the primary owner), left-joins the
   islands, zero-fills additive aggregates only, and is refused by the
   semantic and certified tiers. Legacy intents without these fields parse and
   fingerprint identically (`AGT-061`).
12. **Identity, units, and the certified caveat.** A singular label that
   names several members ("Jordan Lee" is two customers) is resolved on the
   same allowlist as literal grounding (`probeLabelKeys`): several keys make
   the answer one row per member, keyed, with the label displayed, an
   identity warning, and the sentence in the answer; never one merged number.
   Every executed result carries a units contract (`columnsMeta`: currency,
   percent as fraction or percentage points, count, date with grain, text)
   derived from the vocabulary, not from column names; the answer, the table
   and the card render by it, a table search matches the rendered text, and
   a result without it renders exactly as before. A certified block served
   with the "label, no identity key" caveat surfaces it as a warning, in the
   answer, and as a next action to recertify with the key (`AGT-062`,
   `OBS-020`).
13. **Inspector plan, physical spans, per-tab restore.** The Notebook
   inspector's plan for a pipeline run is the intent itself (reading,
   measures with ratio formulas and scopes, grain, display, filters, time
   axis and window, population, ordering, unresolved clauses), the tiers
   tried, the executed tier with its SQL fingerprint, the proofs and the
   grounding notes, read from `diagnosticReceiptV9`. The host opens one
   `sql.execute` span per warehouse statement (the answer and the fan-out
   probe, with tier and purpose) and one `tool.call` (`search_values`) span
   per value or key probe; spans carry fingerprints and outcomes only, never
   SQL or values. A browser tab reopens the chat it last had open (per-tab
   session storage) and a new tab falls back to the browser-wide last chat;
   two tabs never overwrite each other's place (`OBS-021`, `UI-025`).
14. **Fail-closed metric bindings and engine-aware semantics.** A derived or
   ratio metric binds to physical SQL only when SQL can express it: any input
   with an offset window, an offset grain, a cumulative window or an input
   filter, and any two inputs naming the same metric under different aliases,
   leave the metric to the semantic engine and the relational tier refuses it
   with that reason, never an approximation (month-over-month growth was
   being served as zero). A plain formula over inputs on several relations
   is composed as one island per input with the formula evaluated afterwards
   (`+ - * /` only, divisors guarded), so gross profit and margin answer
   relationally. The host tells the binder which engine will compile: on
   MetricFlow and dbt Cloud a host-chosen window is `metric_time`, on the
   native composer the concrete dimension; filter operators are emitted in
   the long form every engine accepts. A derived formula that multiplies by
   100 renders in percentage points (`AGT-063`).
15. **The name wins; the whole question must apply.** After interpretation a
   question word that exactly names a metric binds the intent to that metric
   unless the question qualifies it (gross, including tax, order total,
   lifetime), with provenance saying so; "revenue" is the pretax metric named
   revenue, "revenue including tax" the order total. A question that asks why
   or what to do (why, drivers, invest, recommend, should, forecast) ends as
   an `unsupported` gap that names the operation, the answerable reading and
   Research as the next step; a breakdown noun after by/per/across that
   nothing accounts for ends as a `not_modeled` gap; neither executes.
   Coverage of unused question words is a failed, non-repairing check. A
   grouping or filter dimension with a governed description (or the dbt
   column description) is defined in the answer. A certified block that
   groups by a label with no identity key is never entailed, even when the
   question names it: the interpreter re-expresses the analysis by entity and
   the keyed governed answer is served with the block as source evidence and
   a recertify action (`AGT-064`).
16. **A slow interpreter is retried once; no data is not a modeling gap.** The
   subscription CLI's deadline is a typed `provider_timeout` whose message is
   one reader sentence and whose configuration hint is detail. The interpreter
   retries such a timeout exactly once, on the same run and request, only when
   the turn's remaining budget holds another full dispatch; any other provider
   failure, a second timeout, or a cancellation ends the turn. The answer text
   says the model took too long and to retry; the receipt keeps the provider's
   words. A governed query that ran and matched no rows is headed "No matching
   data" with the `no_data` refusal code, never as a modeling gap or a failed
   run. A semantic-engine compile refusal reaches the reader as its first
   line; the receipt keeps the whole message (`AGT-065`).
17. **Units everywhere; a tab keeps its chat.** The result's units contract
   (`columnsMeta`) survives every projection in the Notebook: the answer
   table, the KPI card, chart axes and tooltips, the headline value, the
   dashboard formatter, Research sources, and persisted conversation turns,
   so a thread restored from the server renders by contract (`UI-027`). A
   browser tab's Ask identity is its URL, `/ask?thread=<id>`: a reload
   resolves the URL thread first, then the tab's own pointer, then the
   browser-wide one; a tab that had a chat never falls back to the newest
   chat, and reconciliation follows the server thread when a conversation id
   was rewritten. A thread-less pending run is adopted only by the tab that
   submitted it. Leaving Ask drops the thread from the URL (`UI-026`).
18. **Corrections the retest gates forced.** A question word is spent by a
   measure whose own name carries it ("beverage revenue" read as drink revenue
   has used "revenue"); an entity noun ("customers") never names a metric; a
   ratio or derived metric the question names never rebinds the parts of a
   composed ratio; the reading line says when a measure was rebound. A
   restriction on the only measure restricts the population ("beverage
   revenue by product" lists the products that sold beverages, not every
   product with a zero) unless the population is explicitly `all`. Every
   unserved clause is named in a gap, and a time grouping never stands for a
   categorical breakdown noun. A dimension with no expression is its own
   column, so the dbt column description defines it.
19. **The structured reply is the answer.** With a response schema, Claude
   Code may return the validated object in `structured_output` and leave
   `result` empty or as prose (2.1.87 does; 2.1.227 repeats the JSON in
   `result`). The adapter returns the structured object whenever the wrapper
   carries one and `result` otherwise; an error wrapper is an error whatever
   else it carries. A readiness probe that does not answer within 8 s reports
   the CLI as installed but not ready, never as missing. A certified block
   served as published for a question it cannot answer with identity carries
   governed trust with the block as its source, never the certified badge
   (`AGT-066`).
20. **The question is preserved through every repair.** The first analytics
   reading of the original question writes an immutable ledger: its material
   unresolved clauses, its time grain and its measures. Every later reading
   (a schema correction, a guard's re-ask, the pipeline's repair after a
   refused preparation) is audited against it: a clause is discharged only by
   refs that account for its words (a block only through its own contract,
   never through its description), kept when still listed as unresolved, and
   otherwise dropped; a first drop is sent back once, a second restores the
   clause as material so the turn ends in the gap the question deserved.
   "Closest available" is never an answer to a different question. The ledger
   and each reading's disposition are in the receipt (`AGT-067`).
21. **Blocks compile like blocks; contradictory metadata is not certified.**
   The certified tier and the served-as-evidence fallback obtain a block from
   the same prepared-block contract every other surface uses: values from the
   shared invocation (declared defaults, values the question states, explicit
   inputs), SQL lowered by the DQL compiler to positional placeholders, bound
   values in placeholder order; unbound parameters refuse before SQL and no
   template placeholder survives. A block whose status says certified while
   its description or tags say review-required is not certified evidence.
   A dbt-inventory model names each column once (`dimension:<model>.<column>`),
   never `<model>.<model>.<column>` (`AGT-068`).
22. **Ratios and thresholds without a semantic layer.** A ratio part may be a
   physical column with an explicit aggregation (`numeratorAggregation`,
   `denominatorAggregation`: sum, avg, count, count_distinct, min, max) when
   the project has no metric for it; the interpreter never mints a measure
   name. The relational composer aggregates both parts as islands at one
   proven grain and divides with `NULLIF`. A threshold on an aggregate
   ("at least 20 games") is a filter on `measure:<index>` applied after
   aggregation, rendered over the composed result by alias, never as a row
   filter. An aggregated numeric column exposed as a dimension is read as its
   column; counting is a measure over any column; ordering by a measure's
   alias names that measure. A why/should question over the previous analysis
   is never answered conversationally: it ends as the unsupported gap that
   names what the previous reading can still answer (`AGT-069`).

23. **A period survives the follow-up, and parameters bind in text order.** A
   follow-up inherits the previous analysis's time window unless its own
   message names a period; the inheritance is recorded in provenance, so
   "rank them by points per game" after "only 2017" stays inside 2017. Every
   composed program binds its positional parameters in the order they appear
   in the SQL text: per-measure scopes are in the projection and bind before
   the WHERE clause's filters and window bounds. A scoped aggregate beside a
   member filter and a window therefore compares the values it was given, and
   an empty aggregate means the data is empty, never that the binding slipped
   (`AGT-070`).

24. **A warehouse failure says which kind it was.** The driver's message is
   classified into a suspended warehouse, a relation the connection cannot
   see, a relation it may not read, a relation already known to be missing,
   or a SQL fault; the answer names the class and the next action and still
   quotes the warehouse verbatim, and the receipt carries the class and the
   relations. A relation one query proved missing is refused before the next
   query on that connection, and a later success forgets it. The receipt
   counts what the host sent to the warehouse (attempted, failed, succeeded),
   so a run that reached the warehouse and got nothing back never reads as a
   run that tried nothing (`AGT-071`).

25. **A tab's identity survives hydration, and a badge is a rollup.** A URL
   that names a thread the browser cache does not hold is a pending identity:
   the tab seeds a placeholder chat carrying that thread, and the URL is not
   rewritten until the server maps the thread or denies it. An app's header
   badge says "All certified" only when every tile that carries evidence is a
   certified block with no review outstanding; a saved insight, a draft
   analysis, an unapproved semantic tile or a pending draft makes it a count
   (`UI-027`).

26. **A semantic layer binds through whatever it declares.** A metric that
   names a dbt cube and measure binds through them; a metric that declares
   its own `table`, `sql` and `type` binds through those, and its dimensions
   bind to that relation. The aggregate is read out of the expression when
   the author wrote one and taken from the declared type when they wrote the
   bare column; a formula of aggregates stays with the semantic engine. A
   predicate compiles against the column's declared type: case folding is for
   text, a numeric literal written as a string binds as a number, and
   containment casts. A period named on a field that is not a date is a value
   on that field, not a window (`AGT-072`).

27. **A blocked turn keeps its question and loses its result.** The previous
   turn's typed reading carries forward even when it executed nothing, marked
   as an unexecuted plan: the next turn may keep its restrictions, period,
   ranking and limit, and may never describe its rows. A follow-up that
   restricts strictly less than the analysis it edits is corrected once and
   then ends by asking which population was meant, so a lost cohort never
   becomes an answer for every row. A gap names the deepest governed refusal,
   not the certified tier's standing absence of blocks. A ratio is a percent
   only from a display contract or a vetted alias; a "per" ratio is a number
   in the numerator's unit (`AGT-073`).

28. **Meaning is proven before a query is accepted.** A calendar period is
   the dates, never a season, fiscal or cohort field that holds the same
   number: a reading that restricts such a field for a question that says
   "calendar" is corrected once, naming the date dimensions and the columns
   of their relations that carry the same facts, and then asks which basis
   was meant. A material clause whose options include one date dimension is
   resolved to it when the question names the calendar basis. A share of the
   whole period divides by the same aggregate over every row of the period
   (`denominatorScope: 'overall'`, an ungrouped island cross-joined and
   summed before any ranking or limit); a measure divided by itself at the
   same grouping is sent back, and a name that says share, percent or
   concentration takes the overall denominator as a governed default. A
   currency unit needs a display contract or a name that says money; a name
   that says percent is a fraction; anything else is a number (`AGT-074`).

29. **The warehouse completes what the metadata left out.** A relation the
   vocabulary names without columns, or with untyped columns, is filled in
   by one bounded `information_schema` lookup per snapshot and connection,
   so a table the semantic layer references but no manifest documented still
   offers its columns and types, and a partial description is never read as
   evidence that the other columns are absent. A native metric written as a
   formula of aggregates over its own table binds as a derived aggregate and
   is emitted as written. A column of unknown type compares by what the
   literal is. The same-grain suggestion names, for a measure defined on
   another relation, the column of the date's relation that carries the same
   fact, and the join-path refusal is repairable with it (`AGT-075`).

30. **A definition owns the rows it counts.** A metric may declare which rows
   it counts (a participation flag, a soft delete, a test order). That scope
   binds inside the aggregate at the relational tier — a sum reads zero for an
   excluded row, a count and a distinct count read nothing — and a scope this
   cannot read refuses the physical binding instead of dropping it. A measure
   written as a raw column aggregation is replaced by the metric that defines
   exactly that aggregate of that column on that relation, with the
   substitution in the provenance and, when the definition excludes rows, in
   the reading. A relation's documented boolean columns reach its card, so a
   reader can see which rows a definition counts (`AGT-076`).

31. **Three obligations are typed, not lexical.** A relative period ("this
   season", "the current quarter") names one anchor every row must share: a
   reading that selects the period beside each row restricts nothing, so the
   interpreter is corrected once and the turn then says why the period cannot
   be resolved here, with zero SQL. A clause that asks WHICH ones is
   discharged only by an identity — a grouping, a displayed label, a filtered
   member — never by a measure that counts them. A requested label a repair
   dropped because no governed relationship reaches it is recorded as an
   unmet obligation: the answer is served with the omission named, the check
   does not pass, and the next action is to declare the relationship with its
   uniqueness and coverage proof (`AGT-077`, `UI-028`).

32. **A semantic filter is bound or the composition refuses.** A filter
   dimension the selected metrics cannot resolve refuses the whole native
   composition, as a group-by already did; the registry name is never emitted
   where a column belongs. A native dimension resolves by the table-qualified
   spelling its own vocabulary uses. The pipeline then prepares the relational
   candidate, which owns the physical column (`AGT-078`).

33. **The choice the user made is carried.** A clarification option is a
   governed ref: the analytical question stays the user's own, the interpreter
   is told the meaning is already chosen, and the reading is bound to it
   deterministically, so a picked option cannot be ignored and asked again. A
   selection that comes back a second time is reported as a continuation
   failure, never as a modeling gap nobody proved (`AGT-079`, `UI-029`).

34. **A result says what it covers.** A series over an absolute window covers
   every period of that window: the periods the warehouse returned no rows for
   are added in order, additive measures reading zero and anything else
   staying empty, and the proof says how many were added. A ranked share over
   a whole-period denominator says what the shown rows are together. A chart
   may plot only what the result's contract calls a measurement, so an
   identifier never becomes a series; and the SQL inspector says whether the
   warehouse executed the statement, rejected it, or never saw it, with the
   values its placeholders stand for (`AGT-080`, `UI-030`).

The gate is `apps/cli/src/ask-golden.test.ts` with
`apps/cli/test/ask-golden/`: ~30 jaffle questions plus the five-turn
conversation, hand-reviewed reference SQL executed against a seeded SQLite
copy of the jaffle warehouse, row-set equality with numeric tolerance,
expected tier/trust, build identity on every report, cassette replay in CI,
live nightly on the subscription CLI, a repeat lane for stability. The new
pipeline's suite carries no known-failure exemptions; the legacy baseline
(17/34) is documented, not prescribed (`E2E-026`).
