# RFC 0001 — Implementation Plan: The Governed Answer Cascade

> Companion to [RFC 0001](./0001-governed-answer-cascade.md). This is the complete build plan:
> product pillars, target architecture, the full gap inventory with code anchors, the module
> structure, phased workstreams with acceptance criteria, metrics, and risks.
>
> Status: Draft · Created 2026-07-04 · Owner @KKranthi6881

---

## Part I — Product thesis

**The trust ladder is the product.** DQL does not compete on "an LLM that writes SQL" — it
competes on the governance scaffolding that turns agentic answers into certified, auditable,
Git-versioned analytics. Four pillars:

| # | Pillar | What it means | What it requires |
|---|--------|---------------|------------------|
| P1 | **Semantic blocks** | Build blocks from the semantic layer like any modern tool: metrics × dimensions × time grain, compiled deterministically | Agent must call the real compiler (`SemanticLayer.composeQuery`), emit semantic `.dql` blocks, and semantic objects must be certifiable |
| P2 | **Fast-lane SQL blocks** | Power users get quick insights as SQL blocks and certify them in seconds | Draft capture (exists) + 30-second review ergonomics + `asked_times` demand ranking (exists) |
| P3 | **Stakeholder-safe agentic SQL** | Any stakeholder asks; answers are honestly labeled certified / review-required; uncertified answers route back to analysts fast | Kill the "needs clarification" dead-ends; honest refusals with redirects; the label system (exists) |
| P4 | **Everything in Git** | Any agent — ours or external — understands the whole system end-to-end from the repo | Blocks/drafts/hints/skills are files (exists); semantic definitions get the same lifecycle; one tool registry so internal and external agents see the same world |

**Two-speed governance** is the operating model: the fast lane (P2) certifies specific answers;
the slow lane (P1) generalizes recurring certified answers into semantic definitions
("composting"). Coverage compounds: N fast-lane certifications → a few slow-lane metrics → a
combinatorial space of answerable questions. Neither lane requires the up-front semantic-modeling
project that kills adoption elsewhere, and staleness becomes a reviewable Git diff instead of an
annual rebuild.

---

## Part II — Target architecture

### The Governed Answer Cascade

```
                        ┌──────────────────────────────────────────────┐
 question ──► Lane 0    │ TRIAGE (hybrid router, exists)               │
                        │ conversational / capability → converse       │
                        │ genuinely ambiguous → ONE multiple-choice    │
                        │   clarify; else proceed with DISCLOSED       │
                        │   assumptions                                │
                        └──────────────┬───────────────────────────────┘
                                       ▼
              Lane 1    CERTIFIED BLOCKS ────────────── hit → execute VERBATIM
                        match: example-questions +      │    badge = execution
                        block-fit + grain gates         │    provenance
                        (exists, keep)                  │
                                       ▼ miss / unsafe fit
              Lane 2    SEMANTIC COMPILE ────────────── hit → composeQuery →
                        LLM selects MEMBERS ONLY:       │    deterministic SQL →
                        {metrics, dims, grain,          │    execute → emit
                        filters, orderBy, limit}        │    semantic .dql draft
                        compiler owns correctness       │    (promotable)
                                       ▼ loud refusal ("no such member")
              Lane 3    GOVERNED GENERATION ─────────── ok → execute → shape
                        schema-linked, literal-         │    gates → review-
                        grounded LLM SQL                │    required answer +
                        + RE-GROUNDING repair ladder    │    SQL .dql draft
                        (validator failure → targeted   │
                        catalog lookup → expand context │
                        → retry ≤2 → escalate)          │
                                       ▼ still failing
              Lane 4    HONEST REFUSAL + REDIRECT
                        name the missing object · suggest nearest certified
                        questions · log the coverage gap as modeling backlog
```

Cascade invariants:

1. **Short-circuit up, escalate down, never repeat.** A lane that answers terminates the run. A
   lane that refuses hands a *typed* refusal to the next lane. No lane re-does a higher lane's
   matching.
2. **Refusal is the last rung.** Every validator failure names the missing identifier; every
   named gap gets the cheap-first ladder (deterministic lookup → context expansion → LLM repair →
   tier escalation → refusal) before any user-facing "can't answer".
3. **Deterministic where possible, LLM where valuable.** Lanes 0–2 are 0–1 LLM calls. Lane 3 is
   bounded. Depth (`quick`/`deep`) — not question routing — decides how much compute Lane 3 may
   spend.
4. **Every answer carries provenance**: tier badge, source objects, assumptions, and the compiled
   SQL — the Cortex `verified_query_used` / Genie badge discipline.

### The supporting spine (one of each, not four)

| Concern | Today | Target |
|---|---|---|
| Context | 2 packs built by 2 calls; prompt ⊄ validation set | **One context ledger** per run: single build, one source of physical columns (catalog.json + runtime scan + YAML docs merged with completeness flags), prompt and validator read the same object, expandable mid-run |
| Tools | 4 surfaces (MCP 23 / native 11 / claude-code 7 / answer loop 0) | **One registry**, ≤15 non-overlapping tools, per-surface filters; internal loop and external MCP agents see the same action space |
| Trust | 5 vocabularies with mapping shims | **One vocabulary** (`dql-core/src/trust/labels.ts`) stamped at one exit point |
| Repair | 3 disconnected budgets (in-loop 1+2, engine 2, MCP 0) | **One budget model**: per-lane {re-ground ≤2, execution ≤2}, engine escalations ≤2, all visible in the trace |
| Validation | 2 validators with different powers | **One validator** (context ledger + structured `offending` tokens); intent checks (`ambiguous_filter`, `missing_baseline`) as a second pass |
| Answer format | prose + ` ```sql ` fence (`parseProposal`, `answer-loop.ts:1818-1829`); DQL block only materialized later by draft capture | **DQL-first answer contract**: every lane materializes a DQL artifact *before* execution — Lane 1 the certified block itself, Lane 2 a semantic block draft, Lane 3 a SQL-backed block draft — assembled deterministically around the model's structured proposal; compiled SQL stays one click away; "save as block" = persisting the artifact that already exists |

---

## Part III — Complete gap inventory

Severity: 🔴 causes wrong/blocked answers today · 🟠 blocks a pillar · 🟡 quality/cost drag.
Every gap maps to a workstream (Part V).

### A. Grounding & retrieval

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| A1 🔴 | **Closed-world guard over top-k retrieval**: `unknown_relation` is a retrieval miss reported as a truth violation; validator never checks the full catalog | `sql-context-validation.ts:104-133`; pack caps: FTS 80 → rank 120 → 40 relations (`catalog.ts:684-731`, `analysis-planner.ts:317-332`) | W1.3, W1.5 |
| A2 🔴 | **Split-brain context**: prompt renders `schemaContext` (runtime), guard validates `allowedSqlContext` (different pack, different call, different column source) | prompt `answer-loop.ts:1388-1404` vs guard `:945`; two builds `local-runtime.ts:14356` vs `dql-agent-provider.ts:282` | W1.3 |
| A3 🔴 | **Partial column lists validated as complete**: relations entering via certified-block SQL shape / YAML docs hard-fail real physical columns (`product_price`) | `catalog.ts:3663-3691`; advisory only when `columns.length === 0` (`sql-context-validation.ts:116-118`) | W1.4 |
| A4 🔴 | **catalog.json never ingested** into the metadata catalog — physical warehouse columns only exist in the *other* grounding stack | `catalog.ts:2106-2119` (manifest.json only) vs `propose/dbt-artifacts.ts:304-314` | W1.4 |
| A5 🟠 | **Top-k feedback loop**: the persisted runtime snapshot is the *previous top-12* schemaContext, so never-selected tables can never re-enter | `local-runtime.ts:14361-14383` ← `:15170-15178` | W1.7 |
| A6 🟠 | **FTS recall is exact-token** (no prefix/stemming; 3 hard-coded singularizations); `dbt_column` objects flood rank budgets and evict whole tables | `catalog.ts:4845-4853`; `local-runtime.ts:15644-15650` | W1.7 |
| A7 🟠 | **Join knowledge fragmented**: pack join paths are name-pattern guesses; dbt-lineage join keys and DataLex guidance never reach the answer-loop prompt; `KGStore.findJoinPath` has zero production callers | `catalog.ts:3813-3922`; `sql-grounding.ts:198-234`; `kg/sqlite-fts.ts:238-297` | W2.6 |
| A8 🟡 | **Embeddings are dead code** (`alpha=0` at every metadata call site; hashed-token provider only) — paraphrase questions miss tiers 1–2 | `catalog.ts:803`; `sql-retrieval.ts:89`; `metric-match.ts:212` | W4.4 |
| A9 🟡 | **Value/literal grounding** exists only after a CLI runtime probe; no persistent value index; ranking substring-matches `JSON.stringify(payload)` | `local-runtime.ts:15420-15560`; `catalog.ts:4610` | W4.4 |

### B. Repair & control flow

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| B1 🔴 | **Repair cannot fix a retrieval miss by construction**: single repair replays the same pack and forbids stepping outside it; error text tells the model to use a tool this path can't call | `answer-loop.ts:994-1032` (esp. `:999`); `sql-context-validation.ts:108` | W1.5 |
| B2 🔴 | **Guard refusals bypass the engine**: `no_answer` → `needs_clarification` + empty artifacts → no gate fires → the engine repair path (which *does* rebuild retrieval) is unreachable for this failure class | `local-runtime.ts:929-989`; `agent-run-gates.ts:178-214` | W1.6 |
| B3 🔴 | **`no_answer` conflates four outcomes** (ambiguity / grounding gap / model declined / provider error) so callers can't tell "ask the user" from "retry wider" | `answer-loop.ts:684-722, 833-918, 1033-1081` | W1.6 |
| B4 🟠 | **Three disconnected repair budgets** (in-loop 1 validation + 2 execution; engine 2 run-global shared with escalations; MCP 0) | `answer-loop.ts:1104-1160`; `agent-run-engine.ts:716,750`; `query-via-metadata.ts:172-192` | W1.6, W3.7 |
| B5 🟠 | **Catalog `clarify` route hard-fails generation** even when runtime schema could answer; rescue exists only for the semantic-metric route | `sql-context-validation.ts:74-82`; `answer-loop.ts:965-986` | W2.3 |
| B6 🟡 | Execution-repaired SQL **bypasses the context guard** (validated pre-execution only) | `answer-loop.ts:1136-1149` | W1.5 |
| B7 🟡 | `extractSelectAliases` misses CTE output columns without `AS` → false-positive `unknown_column` | `sql-context-validation.ts:295-304` | W1.3 |

### C. The tier walker

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| C1 🔴 | **Semantic tier is a stub**: one measure family, no filters, no time grains, dimensions from the metric's own table only; recovers definitions by regex-parsing an `llmContext` text blob | `metric-match.ts:303-361, 231-237` | W2.1 |
| C2 🔴 | **`SemanticLayer.composeQuery` is never called by the agent** despite supporting multi-metric, join graph, dateTrunc grains, filters, orderBy, limit | `semantic-layer.ts:557-754`; compiler path exists for notebook semantic blocks (`dql-compiler/src/ir/lowering.ts:817-864`) | W2.1 |
| C3 🟠 | **Semantic objects hardcoded `ai_generated`** — no certification lifecycle for metrics/dimensions; dashboards/apps hardcoded `certified` | `kg/build.ts:407-547`; `:235,265` | W2.2 |
| C4 🟠 | **Two routing layers with different signals**: engine token-overlap `certifiedScore` vs answer-loop FTS+block-fit; both routes run the same executor; a false-positive `certified_answer` route still generates SQL | `local-runtime.ts:11998-12015`; `agent-run-engine.ts:1196-1219` | W2.3 |
| C5 🟠 | **~3,000 lines of dataset-specific regex proposal builders** pre-empt the LLM and compete with the semantic tier | `answer-loop.ts:1831-3467` | W2.4 |
| C6 🟡 | Manifest-native metrics carry no llmContext/table/sql → can never execute at tier 2 (only dbt/cube imports can) | `kg/build.ts:179-207` | W2.1 |
| C7 🟡 | **Five trust vocabularies** (BlockStatus, KGCertification, AnswerCertification/ReviewStatus, MetadataTrustLabel, TrustLabelId) with shims | `dql-project/types.ts:5`; `kg/build.ts:108`; `answer-loop.ts:69-70`; `catalog.ts:76`; `labels.ts:24-29` | W2.5 |

### D. Tool surface

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| D1 🔴 | **Default Ask AI LLM has zero tools** — one-shot text completion inside a deterministic pipeline; all tiering decided before the LLM sees anything | `providers/types.ts:4-7`; `answer-loop.ts:831` | W3.3 |
| D2 🟠 | **Four divergent surfaces** (MCP 23 / native SDK 11 / claude-code 7 / answer loop 0), hand-duplicated schemas, no shared policy; the tier contract (`ask_dql` → `nextTool`) exists only where the internal loop can't use it | `dql-mcp/src/server.ts:96-270`; `apps/cli/src/llm/tools.ts:112-165`; `claude-code.ts:37` | W3.1 |
| D3 🟠 | **Missing tools for the desired flow**: no `query_semantic_model` composer, no `expand_context(contextPackId, relations[])`; guard errors can't trigger re-inspection | tool inventory audit | W3.2 |
| D4 🟡 | **Token-heavy responses**: `query_via_metadata` embeds the full context pack even in rejections; `query_via_block` returns unbounded rows by default; `lineage_impact` dumps whole subgraphs; `wrap()` pretty-prints (+20–40%) | `query-via-metadata.ts:186-341`; `query-via-block.ts:178`; `server.ts:275-279` | W3.2 |
| D5 🟡 | **Broken paths found in passing**: unified ask route throws for `anthropic`/`openai` active providers (governed_answer envelope mismatch); claude-code allowlist omits `ask_dql` and both query tools (can discover, never answer) | `local-runtime.ts:882-893` vs `llm/index.ts:22-34`; `claude-code.ts:37` | W3.6 |
| D6 🟡 | UI "tools" in the evidence trace are pseudo-tools the LLM never calls — fine for display, but they mislead debugging | `answer-loop.ts:5282-5324` | W3.3 |

### E. Context budgets & deep research

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| E1 🟠 | **Prompt narrower than validation set**: model sees 12 relations × 32 cols, validator allows 40 × 120 — punished for the unseen, can't use the retrieved-but-truncated | `answer-loop.ts:1589-1612` vs pack caps | W1.7, W3.4 |
| E2 🟠 | **`depth`/`strictness` have no consumers** — same caps for a quick lookup and deep research; no "all context, agent decides" mode; research-mode ReAct steps are descriptive, never executed | `router.ts:37`; `catalog.ts:171`; `research-loop.ts:182-224` | W3.4 |
| E3 🟡 | The model is never told what else exists (relations 13–40 + `topRejected` invisible) → invents columns on visible tables | `renderContextPackForPrompt` `answer-loop.ts:1482-1539` | W1.7 |

### F. Trust, certification & flywheel (pillars P1/P2/P4)

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| F1 🟠 | **No composting**: nothing mines certified blocks for recurring expressions to propose as semantic definitions; the block→metric generalization loop (Cortex optimizer / Lightdash changesets pattern) is absent | — | W4.3 |
| F2 🟠 | **Review ergonomics unmeasured**: no telemetry on review latency; certify flow requires editor context-switch | — | W4.2 |
| F3 🟡 | Semantic-layer YAML has no draft/changeset lifecycle (blocks do) | `semantic/yaml-loader.ts` | W2.2, W4.3 |
| F4 🟡 | Drift: fingerprints/`pending_recertification` exist for blocks, but semantic definitions have no recert trigger | `certifier.ts`; `kg/build.ts` | W4.5 |

### G. Performance & cost

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| G1 🟠 | **Full KG reindex on every answer run**; full catalog fingerprint check per call; per-question sequential scan of all dbt/warehouse objects for shape scoring | `dql-agent-provider.ts:252`; `catalog.ts:622, 3437-3442` | W4.6 |
| G2 🟡 | Certified answers pay an extra synthesis LLM pass only when uncertified — correct — but generated answers pay reindex + retrieval + synthesis on every engine repair | `local-runtime.ts:764, 868, 937` | W4.6 |

### H. Conversation & memory

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| H1 🟠 | Follow-up classification is regex-based; prior-pack "refinement" reuse skips retrieval entirely (right idea, wrong trigger precision) — the second jaffle failure came from a follow-up misrouted here | `dql-agent-provider.ts:276-306`; `catalog.ts:643-673` | W3.5 |
| H2 🟡 | Prior results aren't carried as named refs (id + column schema + row count + query) — "include product details with previous results" can't resolve against the prior result shape | conversation state exists: `local-runtime.ts:422-529` | W3.5 |

### I. Evaluation

| # | Gap | Evidence | Fix |
|---|-----|----------|-----|
| I1 🟠 | **No eval harness**: no golden-question set, no execution-match scoring, no per-PR quality signal; regression tests are jaffle-shaped unit tests | `ask-ai-jaffle-regression.test.ts` | W4.1 |
| I2 🟡 | No structured traces of rewrites/tool calls for offline analysis (the OpenTelemetry-per-stage pattern) | — | W4.1 |

---

## Part IV — Product structure

**Strategy: strangler, not rewrite.** `answer-loop.ts` (5,770 lines) becomes a thin orchestrator;
logic moves into focused modules with the tests moving alongside. No big-bang.

```
packages/dql-agent/src/
├── cascade/                     # NEW — the tier walker (Part II diagram)
│   ├── cascade.ts               #   lane sequencing, short-circuit, typed refusals
│   ├── lane-certified.ts        #   moves from answer-loop.ts:542-672
│   ├── lane-semantic.ts         #   NEW: member selection → composeQuery bridge
│   ├── lane-generated.ts        #   moves from answer-loop.ts:760-1307
│   ├── lane-refusal.ts          #   NEW: honest refusal + nearest-certified redirect
│   └── budgets.ts               #   per-lane repair/escalation budgets, one place
├── grounding/                   # NEW — the context ledger
│   ├── context-ledger.ts        #   ONE build per run: pack + runtime schema unioned,
│   │                            #   column-completeness flags, prompt/validator share it
│   ├── retrieval.ts             #   moves from metadata/catalog.ts search/rank
│   ├── regrounding.ts           #   NEW: offending-token → targeted lookup → expand
│   └── value-index.ts           #   NEW (Phase 4): literal grounding
├── validate/
│   └── sql-validation.ts        #   unified validator: today's two, merged; structured
│                                #   `offending`; intent checks second-pass
├── tools/                       # NEW — canonical registry (Phase 3)
│   ├── registry.ts              #   single source of tool defs (zod), ≤15 tools
│   ├── surfaces.ts              #   per-surface filters: mcp | native | answer-loop | cli
│   └── defs/*.ts                #   handlers re-exported to dql-mcp (dependency stays
│                                #   dql-mcp → dql-agent)
├── semantic-bridge/             # NEW — agent ↔ dql-core semantic layer
│   ├── member-select.ts         #   LLM/deterministic member selection (JSON contract)
│   └── compose.ts               #   composeQuery invocation + semantic .dql draft emit
├── trust/
│   └── stamp.ts                 #   ONE exit point mapping lane → TrustLabelId
├── metadata/                    # SHRINKS: catalog build/index stays; search/validate move out
├── providers/                   # gains optional tool-calling capability (Phase 3)
├── conversation/                # exists; gains result-refs + follow-up rewriting
├── memory/ · hints/ · skills/   # unchanged
└── eval/                        # NEW (Phase 4)
    ├── golden/questions.yaml    #   ~20 real questions + gold results/SQL
    └── harness.ts               #   execution-match + single-call judge, CI-runnable
```

Deletions (net-negative diff is a goal, not a hope): the ~3,000-line regex proposal cascade
(`answer-loop.ts:1831-3467`), the duplicated engine-level certified scoring
(`local-runtime.ts:11998-12015`), the hand-duplicated tool schemas in `apps/cli/src/llm/tools.ts`,
and the metric-definition regex parser (`metric-match.ts:231-237`).

Docs: each phase updates `docs/architecture/agentic-loop/` in the same PR (the docs are good —
keep them honest). `graduated-trust.md`'s Tier 1/2/3 vocabulary gets unified with the cascade's
lane names.

---

## Part V — Phased workstreams

### Phase 1 — Kill the dead-ends (fixes the reported failures)

*Goal: a retrieval miss becomes a recovery, not a refusal. The three jaffle questions answer
end-to-end.*

| WS | Task | Key files | Notes |
|----|------|-----------|-------|
| W1.1 | **Regression tests first**: encode the three jaffle failures (supply-chain top-10, follow-up product details, product+supply control) as end-to-end expectations | `ask-ai-jaffle-regression.test.ts` | Written against the *desired* behavior; red until W1.5 lands |
| W1.2 | Structured `offending {relation?, column?}` on `SqlContextValidationResult` (port from `validateSqlAgainstGrounding`) | `sql-context-validation.ts:13-27`; donor `sql-grounding.ts:349-359` | Additive |
| W1.3 | **Context ledger v1**: validator accepts the runtime `schemaContext` and validates against the union; fix CTE alias false-positives (B7) | `sql-context-validation.ts:168-197`; call site `answer-loop.ts:945` | Kills A2. Verified blast radius: 3 runtime call sites (answer-loop ×2, `query-via-metadata.ts`, `apps/cli/src/commands/agent.ts`) — add the new argument as a trailing optional to keep them compiling |
| W1.4 | **Ingest catalog.json columns** into the metadata snapshot; per-relation `columnCompleteness: 'complete' \| 'partial'`; partial ⇒ advisory column validation | `catalog.ts:1806-1957, 3635-3725` | Kills A3/A4 (`product_price`-class failures) |
| W1.5 | **Re-grounding repair**: on `unknown_relation`/`unknown_column` — targeted catalog + runtime-schema lookup of the offending token → merge into ledger → delta in repair prompt ("`dev.supplies` exists with columns …, JOIN via `product_id`") → revalidate against the *enriched* ledger; budget 2; genuinely-absent ⇒ refuse naming what doesn't exist; re-validate execution-repaired SQL (B6) | `answer-loop.ts:994-1032`; new `grounding/regrounding.ts` | The core fix. Research: gains plateau at 2–3 iterations |
| W1.6 | **`refusalCode`** on `AgentAnswer` (`grounding_gap \| ambiguous \| model_declined \| provider_error`); executor maps `grounding_gap` → failing evaluation with `repairAction {kind:'retry', hint: offending}` so the engine's fresh-retrieval repair fires; `clarify` reserved for genuine ambiguity; same treatment in `query_via_metadata` (return offending + suggested expansion instead of bare rejection) | `answer-loop.ts:1033-1081`; `local-runtime.ts:929-989`; `query-via-metadata.ts:172-192` | Kills B2/B3; unifies budget visibility (B4 start) |
| W1.7 | **Retrieval hardening**: "Other available relations (names only)" prompt line from `allowedSqlContext[12..40]` + `topRejected`; FTS prefix matching; separate rank budgets for tables vs columns; persist the full information_schema scan as the runtime snapshot (not the previous top-12) | `answer-loop.ts:1589-1612`; `catalog.ts:4845-4853, 694-717`; `local-runtime.ts:14361-14383` | Kills A5/A6/E3 |

**Acceptance**: 3 jaffle regressions green; guard-refusal rate ≈ 0 for questions whose objects
exist in the catalog; remaining refusals name a concrete missing object; all existing tests green;
no new LLM calls on the certified path.

### Phase 2 — One cascade, real semantic tier (pillar P1)

*Goal: metric × dimension × time questions compile deterministically and come back as promotable
semantic `.dql` drafts — DQL, not raw SQL, is the default answer format for governed questions.*

| WS | Task | Key files | Notes |
|----|------|-----------|-------|
| W2.1 | **Semantic bridge**: member-selection step (LLM emits `{metrics[], dimensions[], timeGrain?, filters[], orderBy?, limit?}` as validated JSON; deterministic matcher shortcut for obvious cases) → `SemanticLayer.composeQuery` → execute → emit semantic `.dql` block draft (`metric/dimensions` refs, certifiable via the existing `metric_wrapper` contract). Structured `MetricDefinition`s replace the llmContext regex parser; manifest-native metrics get real definitions (C6) | new `semantic-bridge/`; retire `metric-match.ts:231-361` internals; `certifier.ts:247-262` | dbt benchmark: member selection is easy for cheap models; the compiler owns correctness. Loud refusal ("metric X has no dimension Y") on mismatch. Verified: `composeQuery(options) → {sql, joins, tables} \| null` supports multi-metric/join-BFS/dateTrunc grains/filters/orderBy/limit but **not** HAVING, window functions, or metric-level filters — those shapes refuse from Lane 2 and fall to Lane 3. The `SemanticLayer` instance is currently only constructed in `loadAgentSemanticLayer`; inject it via `AnswerLoopInput` |
| W2.2 | **Semantic trust lifecycle**: optional `status` on `MetricDefinition`/`DimensionDefinition` (+ YAML loader); `kg/build.ts` stops hardcoding `ai_generated` (and `certified` for dashboards); grain-gate consumes metric status | `semantic-layer.ts:17-52`; `yaml-loader.ts`; `kg/build.ts:179-207, 380-558` | Makes Lane 2 governable — pillar P1's certification story |
| W2.3 | **Single tier walker**: extract lanes into `cascade/`; engine `selectRoute` keeps thin intents and consumes the loop's `AiRoute`; drop the token-overlap certified scoring; remove the clarify hard-gate in validation (B5) — clarify becomes a Lane 0 decision, not a validator outcome | new `cascade/`; `agent-run-engine.ts:1196-1219`; `local-runtime.ts:11998-12015`; `sql-context-validation.ts:74-82` | `isTerminalSuccess` generalizes to any lane hit |
| W2.4 | **Retire the regex proposal cascade** behind a flag, then delete; its tests become cascade acceptance tests (Lane 2 must answer the metric-shaped ones, Lane 3 the rest) | `answer-loop.ts:1831-3467` | −3k lines; jaffle-shaped logic leaves the engine |
| W2.5 | **One trust vocabulary**: all stamping through `trust/stamp.ts` → `TrustLabelId`; shims removed from kg/catalog/answer-loop | `labels.ts:206-254` + call sites | |
| W2.6 | **Join knowledge into the ledger**: merge dbt-lineage join keys + DataLex guidance into pack join paths; wire `KGStore.findJoinPath` for cross-domain questions | `catalog.ts:3813-3922`; `sql-grounding.ts:198-234`; `kg/sqlite-fts.ts:238-297` | Multi-entity questions get real join paths, not name guesses |
| W2.7 | **DQL-first answer contract**: replace the `prose + sql-fence + Viz:` parse contract with a structured proposal schema (Lane 2: members JSON; Lane 3: `{sql, description, outputs, viz}`); deterministic assembler (generalize `drafts.ts:241-277`) materializes the DQL block draft *before* execution; execution compiles/runs the artifact; UI renders DQL source with compiled SQL one click away; "save as block" persists the existing artifact; follow-ups reference the prior turn's artifact (edit-chain) | `answer-loop.ts:1818-1829` (parseProposal); `metadata/drafts.ts`; `cascade/lane-*.ts` | One answer shape across all tiers — trust state lives in the artifact, not run metadata. NOT an accuracy fix (the SQL inside the `query` field still depends on Phase-1 grounding); the LLM never hand-writes envelope syntax, so DQL output is always syntactically valid regardless of model. Explicit SQL-cell authoring stays for users who ask for it |

**Acceptance**: metric+dimension+grain questions answer via Lane 2 with a semantic draft attached;
**every answer from every lane renders as a DQL artifact** (compiled SQL one click away) and
"save as block" is a persist, not a translation; `AiRoute` telemetry shows tier distribution;
regex-builder tests pass through the cascade; five vocabularies → one.

### Phase 3 — One tool registry, bounded agency, depth (pillars P3/P4)

*Goal: internal and external agents see the same governed action space; deep questions get more
context and compute; quick questions stay fast and cheap.*

| WS | Task | Key files | Notes |
|----|------|-----------|-------|
| W3.1 | **Canonical tool registry** with per-surface filters; dql-mcp re-exports from it (dependency direction unchanged); delete hand-duplicated schemas | new `tools/`; `dql-mcp/src/server.ts`; `apps/cli/src/llm/tools.ts` | ≤15 non-overlapping tools (OpenAI 40→13 lesson). Verified: dql-mcp handlers are plain exported functions and dql-mcp already depends on dql-agent — registry in `dql-agent/src/tools/` creates no cycle |
| W3.2 | **New tools + token discipline**: `query_semantic_model` (wraps W2.1), `expand_context(contextPackId, relations[])` (packs are persisted/addressable — `query-via-metadata.ts:619-639`); trim full-context-pack rejections, bound `query_via_block` rows, summarize `lineage_impact`, compact JSON | `tools/defs/`; `query-via-metadata.ts`; `query-via-block.ts:178` | ~25k-token tool budget; actionable errors |
| W3.3 | **Bounded tool loop for Lanes 2–3**: provider interface gains an *optional* `generateWithTools` capability; effort classes in-prompt (lookup ≤3 calls, multi-entity ≤8, research ≤15); deterministic one-shot remains the fallback for providers without tool support | `providers/types.ts` + implementations; `cascade/lane-generated.ts` | Docs already call this "the next increment" (`04-tools-and-executors.md:88-97`). Constraint verified: dql-agent is zero-dependency by design (raw `fetch`, no SDKs) and the native SDK loop lives in apps/cli — so implement tool-calling in dql-agent's own providers over the raw REST APIs (Anthropic/OpenAI tool-use is plain JSON), with the host injecting tool *handlers* from the registry; do NOT lift the SDK loop down |
| W3.4 | **Depth drives budgets**: `deep`/`exploratory` lifts render caps (12→40 relations, 32→120 cols, objects/edges included); small-catalog full-context mode; research mode executes its plan steps as tool calls with observation feedback | `answer-loop.ts:1482-1649` caps → `grounding/context-ledger.ts`; `research-loop.ts` | The "send everything, agent decides" mode — scoped to deep only |
| W3.5 | **Conversation upgrades**: rewrite follow-ups into self-contained questions (generalize the clarify-folding at `dql-agent-provider.ts:374-402`); carry prior results as named refs (id + column schema + row count + generating query); replace regex follow-up classification for the refinement-reuse trigger | `conversation/`; `dql-agent-provider.ts:276-306` | Fixes the H1 misroute behind jaffle failure #2 |
| W3.6 | **Fix broken paths**: governed_answer envelope for native runners (or route them through the cascade); claude-code allowlist gets `ask_dql` + query tools | `local-runtime.ts:882-893`; `claude-code.ts:37` | Found in audit; cheap |
| W3.7 | **One budget model**: per-lane budgets from `cascade/budgets.ts`; engine escalations separate from repairs; MCP tier-2 gets the same re-ground-once policy | `agent-run-engine.ts:336-337, 716` | Closes B4 |

**Acceptance**: same tool list (filtered) across MCP/native/answer-loop; a deep multi-entity
research question executes ≥2 tool-observed steps; quick certified lookups unchanged in latency;
tool responses within budget.

### Phase 4 — Flywheel, eval, performance (pillars P2/P4 + operations)

| WS | Task | Key files | Notes |
|----|------|-----------|-------|
| W4.1 | **Eval harness**: ~20 golden questions (seed: jaffle set + real user questions), execution-match + single-call LLM judge (0–1 + pass/fail); structured traces per stage (rewrites, tool calls, lane transitions); runs in CI per PR | new `eval/` + `scripts/bench/` | Measure before/after every phase; small sets are enough early (Anthropic finding). Verified precedent: CI already runs a gated stress bench (`.github/workflows/ci.yml:86-103`, 4k-model synthetic project) — the golden eval follows the same pattern as a separate job |
| W4.2 | **Review ergonomics + telemetry**: review-latency + certify-conversion metrics; one-screen review payload (question, SQL/members, result sample, diff vs nearest certified block, one-click certify) | draft/review API in `local-runtime.ts`; UI panel | The flywheel constant. Target: median review < 60s |
| W4.3 | **Composting**: mine certified blocks for recurring expressions/filters → propose semantic definitions as Git changesets (draft YAML + PR body explaining provenance), human-approved | new; donor patterns `propose/` | Cortex-optimizer / Lightdash-changeset pattern; closes the P1↔P2 loop. Verified net-new: no MetricDefinition→YAML serializer exists (loader is parse-only) — needs a serializer + a `semantic-layer/metrics/_drafts/` convention mirroring `blocks/_drafts/` |
| W4.4 | **Real embeddings + value index**: pluggable embedding provider actually wired (`alpha>0` for block example-questions and metric matching); LSH/ngram value index over low/medium-cardinality dimension columns, refreshed by the existing runtime probe | `embeddings/provider.ts`; `grounding/value-index.ts`; `local-runtime.ts:15420-15560` | Literal grounding ≈ +3pts (CHESS/CHASE); paraphrase certified-matching |
| W4.5 | **Drift & recertification**: manifest/lineage change → `pending_recertification` for affected semantic definitions (blocks already have fingerprints); surfaced in `list_proposals` | `certifier.ts`; `kg/build.ts` | The 8–12-month staleness answer, as Git diffs |
| W4.6 | **Performance**: incremental KG index (fingerprint-gated, no reindex per answer run); cache shape-scan results per catalog fingerprint; skip synthesis pass when the lane already produced final prose | `dql-agent-provider.ts:252`; `catalog.ts:565-599, 3437-3483` | Verified quick win: the fingerprint skip already exists in `ensureMetadataCatalogFresh` but `reindexProject` passes `force: true`, bypassing it every run — stop forcing and the catalog rebuild disappears from the hot path (KG rebuild needs its own fingerprint gate) |
| W4.7 | **Multi-candidate deep lane** (optional, last): 3–5 diverse generations + execution-equivalence grouping + selection judge — deep mode only | `cascade/lane-generated.ts` | +5–8pts on hard questions; cost-gated by depth |

**Acceptance**: eval score tracked per PR with tier distribution; a certified-block cluster
produces a metric changeset end-to-end; reindex removed from the answer hot path; review-latency
dashboard live.

### Sequencing & dependencies

```
Phase 1 (independent, ship first)
   └─► Phase 2 (needs W1.2/W1.3 validator work; W2.3 builds on W1.6 refusalCodes)
          └─► Phase 3 (W3.2 expand_context needs W1.5; W3.3 tool loop needs W3.1 registry;
   W4.1 eval harness can start ANY time — recommended alongside Phase 1)
          └─► Phase 4 (W4.3 composting needs W2.1/W2.2; W4.7 needs W3.4 depth)
```

Ship cadence: each phase is releasable alone; each phase updates the agentic-loop docs in the
same PR; every behavior change lands with an eval delta.

---

## Part VI — Metrics (the definition of "working")

| Metric | Today (observed) | Target |
|---|---|---|
| Guard-refusal rate on answerable questions | high (the reported failures) | ≈ 0 (refusals name genuinely-missing objects) |
| Answer rate (non-refusal on eval set) | — (no harness) | ≥ 90% |
| Execution-match accuracy (eval set) | — | ≥ 85% overall; ≥ 95% Lanes 1–2 |
| Tier distribution (repeat questions) | mostly Lane 3 | majority Lanes 1–2 within 30 days of use |
| Median latency: certified / semantic lanes | + reindex + synthesis overhead | < 2s / < 5s (no reindex, no extra passes) |
| Median review latency (`review_required` → certified) | unmeasured | < 60s |
| Certify conversions per week | unmeasured | trending up; `asked_times`-ranked queue drains |
| Token cost per answer by lane | unmeasured | Lane 1 ≈ 0 LLM; Lane 2 ≈ 1 call; Lane 3 bounded by effort class |

---

## Part VII — Risks & mitigations

| Risk | Mitigation |
|---|---|
| Strangler on a 5,770-line file regresses subtle behavior | W1.1 tests-first; move code with its tests; regex-builder tests preserved as cascade acceptance; eval harness from Phase 1 |
| Providers without tool-calling (ollama, custom) degrade in Phase 3 | Deterministic lanes and the one-shot path remain the floor; tool loop is an enhancement, never a requirement |
| Re-grounding loops on pathological questions | Hard budget (2), only on structured `offending` codes, only when the identifier resolves in the catalog; everything visible in the trace |
| Review bottleneck stalls the flywheel (the honest product risk) | W4.2 ergonomics + telemetry first-class; `asked_times` ranking; composting reduces review volume by generalizing |
| Cold start: day-1 project has no blocks, no semantic layer | Bootstrap story: `dql propose` (exists) + AskData-style warehouse profiling into the catalog (W4.4 groundwork); Lane 3 with Phase-1 grounding is a respectable floor |
| Widening context inflates cost/latency for quick questions | Budgets are depth-conditioned; quick path caps unchanged; certified path stays 0-LLM |
| Incumbents ship the same story (Genie Ontology etc.) | The Git-native moat (W2.2, W4.3, W4.5): certification as code with tests/invariants/CI is not retrofittable onto YAML-blob stores — ship it while the window is open |

---

## Part VIII — What each phase means for a user

- **After Phase 1**: "Complete supply chain with product and order details, top 10" — answers
  (review-required) instead of "needs clarification". When something truly doesn't exist, the
  refusal says *what* is missing and suggests the nearest certified questions.
- **After Phase 2**: "Monthly revenue by product category this year" comes back compiled from the
  governed metric — with a ready-to-certify semantic `.dql` block attached. Analysts certify
  *definitions*, not just queries.
- **After Phase 3**: "Research why margin dropped in Q2" runs a visible, bounded investigation —
  the agent inspects schemas, expands context, and executes steps; quick questions stay instant.
  External agents (Claude Desktop, Cursor) see the exact same governed tools.
- **After Phase 4**: The team's usage compounds — repeated questions get certified in under a
  minute, recurring logic graduates into certified metrics via reviewable PRs, drift shows up as
  recertification queues, and every release is gated on the golden-question eval.
