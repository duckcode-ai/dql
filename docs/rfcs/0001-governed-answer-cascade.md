# RFC 0001: The Governed Answer Cascade — re-grounding, a real semantic tier, and one context ledger for Ask AI

| Field | Value |
|---|---|
| **Author(s)** | @KKranthi6881 |
| **Status** | Draft |
| **Created** | 2026-07-04 |
| **Targets** | DQL `>= 1.7` |
| **Discussion** | TBD |
| **Implementation** | TBD |
| **Supersedes** | — |

## Summary

Ask AI already has the right skeleton — certified → semantic → generated tiers, gates, repair,
trust labels — but it dead-ends on retrieval misses, validates against a different context than it
prompts with, never calls the real semantic-layer compiler, and gives the LLM zero tools. This RFC
proposes a four-phase redesign: (1) **re-grounding repair** so a guard failure widens context
instead of refusing, (2) a **single tier cascade** whose semantic tier compiles through
`SemanticLayer.composeQuery`, (3) a **unified, bounded tool loop** with depth-conditioned context
budgets, and (4) a **certification flywheel + eval harness**. The design follows what Snowflake
Cortex Analyst, Databricks Genie, dbt's Semantic Layer benchmark, and 2025–26 text-to-SQL research
converge on, and it is positioned as *completing* the documented architecture in
`docs/architecture/agentic-loop/`, not replacing it.

## Motivation

### The observed failure class

On the jaffle_shop demo, multi-entity questions reliably abort:

- *"Complete supply chain with product and order details, top 10 value"* →
  `SQL references column "product_name" outside the inspected columns for jaffle_shop.dev.order_items`
  → **needs clarification** (no answer).
- Follow-up *"include product details with previous results"* →
  `SQL references relation(s) outside the inspected metadata context: dev.supplies` →
  **needs clarification**.
- Meanwhile *"give me the info of product and supply?"* succeeds — because those exact tokens
  lexically hit the `products`/`supplies` objects in FTS.

Whether a question is answerable currently depends on whether its literal tokens happen to match
table names in BM25 retrieval. That is a grounding-architecture problem, not a model problem.

### Root causes (verified, with anchors)

1. **Closed-world validation over open-world retrieval.**
   `buildLocalContextPack` selects top-k objects by FTS/BM25 (limit 80 → rank 120 →
   `allowedSqlContext` capped at 40 relations; `packages/dql-agent/src/metadata/catalog.ts:684-731`,
   `analysis-planner.ts:317-332`), then `validateSqlAgainstLocalContext`
   (`packages/dql-agent/src/metadata/sql-context-validation.ts:104-133`) treats that truncated set
   as the complete universe. `unknown_relation` is therefore a **retrieval miss reported as a
   truth violation** — the validator never asks "does this relation exist in the catalog at all?"
   even though `catalog.getObject()` would resolve it instantly.

2. **Split-brain grounding: prompted from one context, policed against another.**
   The prompt renders the runtime `schemaContext` (12 tables × 50 cols, sourced from
   catalog/information_schema; `answer-loop.ts:1388-1404`) and the loop even *qualifies* the
   model's relations from it (`answer-loop.ts:924-934`) — but the guard validates only against
   `contextPack.allowedSqlContext`, built from a **different** `buildLocalContextPack` call with
   different inputs (`apps/cli/src/local-runtime.ts:14356` vs
   `apps/cli/src/llm/providers/dql-agent-provider.ts:282`). The model can be punished for using a
   relation the prompt told it to use. Column sources are also disjoint: the pack reads dbt
   `manifest.json` YAML columns only (`catalog.ts:2106-2119`), while the parallel
   `sql-grounding` stack reads `catalog.json` warehouse columns
   (`propose/dbt-artifacts.ts:304-314`). A physically-real column that isn't YAML-documented
   (e.g. `order_items.product_price`) hard-fails as a hallucination.

3. **Repair cannot fix a retrieval miss — by construction.**
   The single self-repair (`answer-loop.ts:994-1032`) replays the same messages and instructs:
   *"Correct it using ONLY the relations and columns from the inspected context above"* — the exact
   context that was missing `dev.supplies`. Revalidation runs against the **same** pack
   (`:1013-1017`). The guard error even tells the model to "use inspect_metadata_context"
   (`sql-context-validation.ts:108`) — a tool this path cannot call. There is no re-inspection,
   no pack expansion, no targeted lookup of the offending identifier.

4. **Guard refusals bypass the engine's repair/escalate machinery.**
   `kind:'no_answer'` maps to `status:'needs_clarification'` with `artifacts: []`
   (`local-runtime.ts:929-989`); the gates then see a non-empty answer (the refusal prose) and no
   execution error, so no `repairAction` fires and the engine — whose repair path *does* rebuild
   retrieval from scratch — never gets a chance (`agent-run-gates.ts:178-214`,
   `agent-run-engine.ts:344-348`). Four distinct outcomes (genuine ambiguity, grounding gap,
   model-declined SQL, provider error) collapse into one `no_answer` kind, so callers cannot
   distinguish "ask the user" from "retry with wider context".

5. **The semantic tier is a stub while the real compiler sits unused.**
   Tier 2 today is `matchSemanticMetric` + `buildGovernedMetricFirstSql`
   (`metadata/metric-match.ts:303-361`): one measure family, zero filters, no time-grain
   truncation, dimensions only from the metric's own table — and it recovers metric definitions by
   **regex-parsing the `llmContext` text blob** (`metric-match.ts:231-237`). Meanwhile
   `SemanticLayer.composeQuery` (`packages/dql-core/src/semantic/semantic-layer.ts:557-754`)
   already supports multi-metric composition, join-graph traversal, `dateTrunc` time grains,
   filters, orderBy and limit — **and the agent never calls it**. Semantic-layer KG nodes are also
   hardcoded `certification: 'ai_generated'` (`kg/build.ts:407-547`), so the governed tier the
   docs promise cannot actually be trusted or certified.

6. **The default Ask AI LLM has an empty action space.**
   The answer-loop provider contract is string-in/string-out
   (`packages/dql-agent/src/providers/types.ts:4-7`); the loop calls `provider.generate` once
   (`answer-loop.ts:831`). The 23 MCP tools — including `ask_dql` (a tier router with
   `nextTool`), `validate_sql` (returns the precise offending identifier), and
   `inspect_metadata_context` — live on a surface the internal loop never uses. Four divergent
   tool surfaces exist (MCP 23, native SDK 11, claude-code CLI 7, answer loop 0) with no shared
   registry or policy. The tool names shown in the UI evidence trace are pseudo-tools the LLM
   never sees (`answer-loop.ts:5282-5324`).

7. **Secondary structural issues.**
   ~3,000 lines of jaffle-shop-shaped regex proposal builders pre-empt the LLM
   (`answer-loop.ts:1831-3467`); prompt caps (12 relations × 32 cols) are narrower than the
   validation set (40 × 120), so the model can't use what it would be allowed to
   (`answer-loop.ts:1589-1612`); embeddings are dead code (`alpha=0` everywhere,
   `retrievalDiagnostics.strategy` hardcoded `'sqlite_fts'`, `catalog.ts:803`); there are five
   trust vocabularies with mapping shims; there is no deep-research "all context" mode
   (`strictness` exists on the request but has no consumer in routing or validation); and every
   answer run reindexes the whole project KG (`dql-agent-provider.ts:252`).

### What the strongest systems do (research, July 2026)

**Industry convergence — every leading product ships the same descending ladder:**

| Tier | Snowflake Cortex Analyst | Databricks Genie | dbt | DQL equivalent |
|---|---|---|---|---|
| Certified NL→query pairs | Verified Query Repository (`verified_by/at`, retrieved by semantic similarity, surfaced in `confidence.verified_query_used`) | Trusted Assets — parameterized queries/UDFs, **badge only when the exact asset text executes** | saved queries | certified `.dql` blocks |
| Semantic layer compile | YAML semantic model; generation against *logical* schema, compiled to physical | metric views + knowledge store | MetricFlow: LLM picks members, compiler emits SQL | `SemanticLayer.composeQuery` (unused) |
| Guardrailed generation | multi-LLM candidates + compiler-validated correction loop | SQL conditioned on curated context | `text_to_sql` escape hatch, logged as a coverage gap | Tier-3 generated SQL |

Key citable results:
- dbt's 2026 benchmark: semantic layer 98.2–100% vs text-to-SQL 84–90% on the same modeled data;
  *"The Semantic Layer tells you it can't answer. It never returns invalid data. Text-to-SQL will
  cheerfully give you a wrong number."* Recommended hybrid: SL-first, fall back to text-to-SQL,
  **log the gap as modeling backlog** ([source](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026)).
- Cortex Analyst: >90% real-world accuracy vs 51% for single-shot GPT-4o on the same eval;
  attribution order: semantic model > multi-LLM candidates > **literal retrieval** > verified
  queries > compiler-validated repair loop
  ([engineering blog](https://www.snowflake.com/en/engineering-blog/snowflake-cortex-analyst-behind-the-scenes/)).
- Schema-linking **recall** is the dominant enterprise failure: <40% strict recall at 3,000+
  columns for one-shot retrieval vs ~91% for iterative agentic linking (AutoLink, AAAI 2026,
  [arXiv:2511.17190](https://arxiv.org/html/2511.17190v1)); on small schemas, over-filtering
  *costs* 5–12 points — recall, not precision, is the objective
  ([arXiv:2408.07702](https://arxiv.org/html/2408.07702v1)).
- Execution-guided repair is worth +3–7 points and plateaus at 2–3 iterations; intrinsic
  self-critique without external feedback is worthless
  ([Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798); CHASE-SQL ablations,
  [ICLR 2025](https://arxiv.org/abs/2410.01943)).
- Value/literal grounding (matching "USA" → the value actually stored) is a first-class accuracy
  lever at every vendor (+~3 pts in CHESS/CHASE ablations).
- Clarification policy consensus: proceed with **disclosed default assumptions** for
  cooperative ambiguity; ask **one multiple-choice** question only when interpretations
  materially diverge (AmbiSQL: 42.5%→92.5% on ambiguous queries,
  [arXiv:2508.15276](https://www.arxiv.org/pdf/2508.15276)); refuse-and-redirect for
  unanswerable questions (Cortex classification agent).
- Tooling: ≤~15 non-overlapping tools (OpenAI's data agent cut 40 → 13 and reliability jumped);
  progressive disclosure beats one-shot RAG dumps; ~25k-token tool-response budget; actionable
  error strings ([Anthropic: writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).

## Detailed design

The redesign is one principle applied everywhere:

> **Every validator failure must name what is missing, and every named gap must be resolvable by a
> bounded, cheaper-first ladder: deterministic lookup → context expansion → LLM repair → tier
> escalation → honest refusal with the gap logged.** Refusal is the *last* rung, not the second.

### Phase 1 — Stop the dead-ends (fixes the reported failures; small diffs)

**1a. One context ledger.** Validate against the union of what the model was shown.
`validateSqlAgainstLocalContext` gains a `runtimeSchema` parameter (the same `schemaContext`
merged into the prompt at `answer-loop.ts:527`); `buildAllowedRelationLookup`
(`sql-context-validation.ts:168-197`) merges those tables in. Ingest dbt `catalog.json` columns
into the metadata snapshot alongside `manifest.json` YAML (extend
`addRawDbtManifestCatalogObjects`, `catalog.ts:1806`) so physical columns exist in one place.

**1b. Column-completeness honesty.** Track per-relation whether the column list is known-complete
(warehouse/catalog.json/runtime scan) or partial (certified-block SQL shape, YAML docs). Partial
lists validate **advisory-only** — exactly as `columns.length === 0` already does
(`sql-context-validation.ts:116-118`). This alone eliminates the `product_price` /
`product_name`-class false rejections.

**1c. Structured offending tokens.** Port the `offending {relation?, column?}` field from
`validateSqlAgainstGrounding` (`sql-grounding.ts:349-359`) into `SqlContextValidationResult` so
repair logic stops parsing prose.

**1d. Re-grounding repair (the core fix).** On `unknown_relation` / `unknown_column`, *before* the
LLM repair call at `answer-loop.ts:994`:
1. Look up the offending identifiers in the full catalog (`searchObjects` /
   `catalog.getObject`) and the runtime schema snapshot.
2. If found: merge the relation(s) + columns into `allowedSqlContext`, append a delta to the
   repair prompt — *"relation `dev.supplies` exists with columns …; you may JOIN it via
   `product_id`"* — and revalidate against the **enriched** pack.
3. If genuinely absent everywhere: refuse honestly, and say *what doesn't exist* rather than
   "needs more context".
Budget: 2 re-grounding rounds (research consensus: gains plateau at 2–3).

**1e. Make grounding gaps visible to the engine.** Add a `refusalCode` to `AgentAnswer`
(`grounding_gap | ambiguous | model_declined | provider_error`). `answerRunExecutor`
(`local-runtime.ts:929-989`) maps `grounding_gap` to a failing evaluation with
`repairAction: {kind:'retry', hint: <offending identifiers>}` instead of
`needs_clarification` — the engine's repair path already rebuilds retrieval from scratch and is
the natural owner of "retry wider". `clarify` remains reserved for genuine ambiguity.

**1f. Show the model the map's edges.** Append to the prompt one line of "Other available
relations (names only — join candidates): …" from `allowedSqlContext[12..40]` + `topRejected`
(`renderAllowedSqlRelationsForPrompt`, `answer-loop.ts:1589-1612`), so a multi-entity question
elicits a JOIN request instead of an invented column. Cheap-first retrieval hardening rides
along: FTS prefix matching in `sanitizeFtsQuery` (`catalog.ts:4845-4853`), separate rank budgets
for tables vs `dbt_column` objects so column floods can't evict whole tables, and persisting the
full information_schema scan (not the previous top-12) as the runtime snapshot
(`local-runtime.ts:14361-14383`).

### Phase 2 — One cascade, with a real semantic tier

**2a. Single tier walker.** Collapse the duplicated tier decisions (engine `selectRoute` token
overlap at `agent-run-engine.ts:1196-1219` vs answer-loop stages) into one cascade owned by the
answer loop; the engine keeps thin intents and consumes the loop's existing `AiRoute` tier badge.

```
question
  → Lane 0  triage: conversational / capability / genuinely-ambiguous (ONE multiple-choice
            clarify) / answerable-with-disclosed-assumptions [router.ts stays]
  → Lane 1  CERTIFIED: match against block example questions (BlockRecord.examples) with
            embeddings when available + block-fit/grain gates [exists]; execute verbatim →
            trust badge = execution provenance (Genie rule). Parameterized trim (top-N,
            filter substitution) keeps the badge; anything beyond → context for Lane 3.
  → Lane 2  SEMANTIC COMPILE: LLM (or deterministic matcher) selects members only —
            {metrics[], dimensions[], timeGrain?, filters[], orderBy?, limit?} →
            SemanticLayer.composeQuery compiles deterministically → execute.
            Failure mode = loud refusal ("metric X has no dimension Y"), never wrong SQL.
            Emit as a semantic .dql block draft (metric/dimensions refs) → directly
            promotable via the existing metric_wrapper certification contract.
  → Lane 3  GOVERNED GENERATION: schema-linked, literal-grounded LLM SQL with the Phase-1
            re-grounding repair ladder; execution repair ≤2; result-shape gate [exists].
  → Lane 4  honest refusal + redirect: nearest certified blocks / metrics as suggested
            questions (Cortex pattern), gap logged as modeling backlog (dbt pattern).
```

Each lane short-circuits on success (`isTerminalSuccess` extends beyond certified); each lane's
refusal reason is a typed value the next lane consumes. Lower lanes never re-do a higher lane's
work — the "smart escalation" the product needs falls out of the cascade shape.

**2b. Semantic objects get a trust lifecycle.** Add `status` to `MetricDefinition` /
`DimensionDefinition` (`semantic-layer.ts:17-52`); stop hardcoding `ai_generated` in
`kg/build.ts`; a certified metric makes Lane 2 a *governed* tier, exactly as
`docs/architecture/agentic-loop/03` promises. Unify the five trust vocabularies on
`dql-core/src/trust/labels.ts`.

**2c. Retire the regex proposal cascade.** The ~3,000 lines of dataset-specific builders
(`answer-loop.ts:1831-3467`) are replaced by Lane 2 (which handles metric+dimension questions
properly) and Lane 3 (which handles the rest with real grounding).
`ask-ai-jaffle-regression.test.ts` and `answer-loop.test.ts` encode the behaviors to preserve.

### Phase 3 — Unified tools, bounded agency, depth-conditioned context

**3a. One tool registry.** The MCP handlers are already plain functions
(`packages/dql-mcp/src/index.ts:12-34`). Create a single canonical registry with per-surface
filters (MCP / native SDK / answer loop), replacing the four hand-duplicated surfaces. Target
≤15 non-overlapping tools:

| Tool | Note |
|---|---|
| `search_catalog` | blocks + metrics + tables + terms, one search, ranked by trust |
| `get_table_schema` | full physical columns + join keys (exists in dql-mcp) |
| `peek_values` | DISTINCT/sample probe for literal grounding (value index when built) |
| `query_semantic_model` | **new** — `{metrics, dimensions, grain, filters}` → composeQuery SQL |
| `expand_context` | **new** — `(contextPackId, relations[])` widens a persisted pack |
| `validate_sql` | returns offending identifiers (exists) |
| `run_preview` | bounded read-only execution (exists) |
| `query_certified_block` | verbatim execution w/ badge (exists) |
| + lineage, hints, feedback, draft-capture | existing |

**3b. Bounded tool loop for Lanes 2–3.** Replace the one-shot `provider.generate` with a bounded
ReAct loop (the docs already call this "the documented next increment",
`04-tools-and-executors.md:88-97`). Effort scaling by complexity class in the prompt: simple
lookup ≤3 tool calls; multi-entity ≤8; research ≤15. Every reflect step gets external ground
truth (execution results, validator output) — never bare self-critique.

**3c. Depth drives context budgets.** The router's `depth: 'quick' | 'deep'` and the request's
`strictness` finally get consumers: `deep`/`exploratory` lifts the render caps
(12→40 relations, 32→120 columns, full `objects`/`edges`), and for small projects hands the
model the entire catalog — the "send everything, let the agent decide" deep-research mode.
Certified lane stays 0-LLM and cheap; only the hard lane may spend candidates
(3–5 diverse generations + execution-equivalence grouping + selection) when depth is `deep`.

**3d. Conversation carry-forward.** Rewrite follow-ups into self-contained questions (the
clarify-folding at `dql-agent-provider.ts:374-402` generalizes); carry prior results as named
refs (result id + column schema + row count + generating query) so "include product details
with previous results" resolves against the prior result schema instead of re-retrieving from
scratch.

### Phase 4 — The flywheel and the harness

- **Certification flywheel** (all pieces exist): draft capture → `list_proposals` ranked by
  `asked_times` → `dql certify --from-draft` → next ask hits Lane 1. Add the Cortex-style
  generalization step: mine certified blocks for reusable filters/definitions to propose as
  semantic-model candidates (human-approved, changeset-style).
- **Value index**: LSH/ngram index over low/medium-cardinality dimension values, refreshed with
  the runtime probe that already exists (`local-runtime.ts:15420-15560`).
- **Eval from day one**: ~20 real questions (the jaffle regression set is the seed) scored by
  execution match + a single-call LLM judge (0–1 + pass/fail); run per PR. Track: groundedness
  (guard-failure rate), answer rate (non-refusal on answerable), tier distribution, tokens and
  latency per lane.

## Backward compatibility

- No `.dql` grammar changes. New optional `status` field on semantic-layer YAML objects
  (default preserves current behavior).
- `AgentAnswer` gains `refusalCode` (additive). `SqlContextValidationResult` gains `offending`
  (additive). Context packs gain `columnCompleteness` per relation (additive).
- MCP: `expand_context` and `query_semantic_model` are new tools; existing tool contracts are
  unchanged (responses may shrink where full context packs are trimmed from rejections).
- Behavior change: questions that previously dead-ended in `needs_clarification` will answer
  (review-required) or refuse with a concrete missing-object message. Tests asserting the old
  refusals must be updated deliberately.

## Alternatives considered

- **Loosen the guard (warn-only).** Rejected: reintroduces silent hallucination, the exact
  failure mode the guard exists to prevent. The research is unambiguous that loud failure is the
  semantic layer's core value.
- **Pure agentic loop (no deterministic cascade).** Rejected: Spider 2.0 evidence favors
  *orchestrated pipelines whose stages are small bounded agent loops*, not free-form ReAct;
  deterministic lanes keep certified/semantic answers fast, cheap, and offline-testable.
- **Fix retrieval only (better FTS/embeddings), keep one-shot grounding.** Necessary but not
  sufficient: no ranking function guarantees recall on multi-entity questions; without
  error-directed re-grounding there is always a dead-end class. AutoLink's result (91% vs <40%
  strict recall) is precisely the iterative-vs-one-shot gap.
- **Multi-candidate generation everywhere.** Deferred to deep mode only: +5–8 points but 3–5×
  cost; the cascade means most questions never reach the lane where it pays.

## Unresolved questions

- Should Lane 2 member-selection be a fine-tunable structured output (JSON schema) or plain
  prompting first? (Start with prompting; the dbt benchmark says cheap models suffice.)
- Where does the value index live — metadata.sqlite or a separate store — and what is its
  refresh policy against large dimensions?
- Per-step vs run-global repair budgets (docs already flag run-global as a defect,
  `01-control-loop.md:82-85`) — proposed: per-lane budgets {re-ground 2, execution 2,
  tier-escalations 2}, engine cap unchanged.
- How far to trim `query_via_metadata`'s full-context-pack responses without breaking existing
  MCP clients.

## Adoption signal

- The three jaffle questions in Motivation answer correctly end-to-end (new regression tests).
- Guard-refusal rate on the eval set drops to ~0 for questions whose objects exist in the
  catalog; refusals that remain name a concrete missing object.
- Tier distribution shifts up: certified + semantic lanes answer the majority of repeat
  questions; `asked_times` → certification conversions increase.
- Median latency for certified/semantic answers stays flat or improves (no KG reindex per run,
  no synthesis pass on certified).
- Community: issues tagged `ask-ai` about "needs clarification" dead-ends stop arriving.
