# RFC 0001 — Remediation Plan: finishing the Governed Answer Cascade

> Follow-up to [RFC 0001](./0001-governed-answer-cascade.md) and the
> [implementation plan](./0001-implementation-plan.md). The first implementation pass (2026-07-05,
> uncommitted) was audited workstream-by-workstream against live call paths: **~85% complete**
> (P1 95% · P2 75% · P3 90% · P4 78%), ~1,690 tests passing, jaffle regressions green and
> execution-verified. This document is the complete plan for the remainder: ship blockers,
> correctness fixes, half-wired consolidation, remaining features, and the deviations we
> explicitly accept.
>
> Status: Draft · Created 2026-07-05 · Owner @KKranthi6881

Conventions: every item has **Where** (file anchors from the audit), **Change** (what to do),
**Accept** (the check that proves it). Sizes: S (<1h), M (half-day), L (1-2 days).

---

## Wave R0 — Ship blockers (fix before committing the current tree)

### R0.1 (S) Notebook browser build is broken — node builtins in the browser bundle
- **Where**: `packages/dql-core/src/semantic/yaml-loader.ts` (new serializers import
  `node:fs`/`node:path`); failure surfaces in `@duckcodeailabs/dql-notebook-app#build`
  (vite/rollup: `"join" is not exported by "__vite-browser-external"`). Sibling warnings:
  `dist/repo-resolver.js` pulls `node:child_process`/`crypto`/`os` into the bundle.
- **Change**: split `yaml-loader.ts` into a browser-safe module (parse/serialize on strings — the
  serializers are pure string builders) and a node-only module (fs traversal:
  `loadSemanticLayerFromDir`, `_drafts` loading, file writes). Ensure the notebook app's import
  graph reaches only the browser-safe module. Audit `dql-core`'s package `exports` for a proper
  browser field or split entry points so this class of break is structural, not accidental.
- **Accept**: `pnpm build` = 20/20 tasks green; the rollup warning list for node builtins in
  dql-core shrinks rather than grows.

### R0.2 (S) `pnpm-workspace.yaml` contains literal placeholder text
- **Where**: new `allowBuilds:` block — `'@vscode/vsce-sign': set this to true or false` (same
  for `esbuild`, `keytar`).
- **Change**: replace with real booleans (`esbuild: true`; decide `keytar`/`@vscode/vsce-sign`
  by whether their postinstall builds are actually needed) or delete the block entirely.
- **Accept**: `pnpm install` runs clean with no prompt/warning; yaml parses; no placeholder
  strings in config.

### R0.3 (S) `eval.test.ts` fixture paths are cwd-dependent (2 failing tests)
- **Where**: `apps/cli/src/commands/eval.test.ts:495, 510` — `join(process.cwd(),
  'apps/cli/test/fixtures/...')` breaks when vitest runs with cwd = `apps/cli` (resolves to
  `apps/cli/apps/cli/...`, 0 cases collected).
- **Change**: resolve fixtures from the test file's own location
  (`new URL('../../test/fixtures/…', import.meta.url)` or `__dirname`-equivalent), never from
  `process.cwd()`.
- **Accept**: `pnpm --filter @duckcodeailabs/dql-cli test` passes from any cwd; the two
  golden-fixture tests count 7 and 14 cases respectively.

---

## Wave R1 — Correctness fixes (small, high-value, from audit "bugs spotted")

### R1.1 (S) Jaffle vocabulary hardcoded into the semantic bridge
- **Where**: `packages/dql-agent/src/semantic-bridge/compose.ts:335-341` —
  `businessFilterDimensionHint` matches `beverage|jaffle|food`. This is exactly the
  fixture-shaped logic W2.4 just deleted 3,000 lines of; it will misfire on every non-jaffle
  project.
- **Change**: replace with a generic mechanism — match candidate filter values against the value
  index / dimension `sampleValues` (the W4.4 value index already exists and is wired into pack
  builds), not against a hardcoded word list. If a heuristic remains, it must be derived from
  project metadata, never literals.
- **Accept**: grep for `jaffle|beverage` under `packages/` hits only test fixtures; jaffle
  regressions still 4/4 green (they must pass via the value index instead).

### R1.2 (S) `provider_error` refusal code is dead
- **Where**: `answer-loop.ts:1004-1028` — the provider-failure `no_answer` omits `refusalCode`,
  so the executor misclassifies provider outages as `needs_clarification`.
- **Change**: set `refusalCode: 'provider_error'` on that path; executor maps it to a
  user-honest "provider unavailable" status (retryable, never "clarify").
- **Accept**: unit test: provider throws → answer carries `provider_error` → run status is not
  `needs_clarification`.

### R1.3 (S) Re-grounding completeness-merge can re-poison column validation
- **Where**: `grounding/regrounding.ts:197-203` — `mergeRelationCompleteness` defaults undefined
  to `'complete'`, opposite of `sql-context-validation.ts:364-367` (empty/unknown ⇒ partial). A
  merged expansion relation with an unknown-completeness partial column list gets stamped
  complete, re-enabling strict validation and producing a false `unknown_column` *after* a
  successful expansion.
- **Change**: default undefined to `'partial'` (advisory) in the merge; single shared helper for
  completeness derivation used by both files.
- **Accept**: test: expansion merges a relation with no completeness flag + short column list →
  column outside the list is advisory, not fatal.

### R1.4 (S) `expand_context` bookkeeping lies
- **Where**: `packages/dql-mcp/src/tools/expand-context.ts:88` hardcodes
  `regroundAttemptsUsed: 1`; `:124-133` fabricates synthetic rank scores into
  `retrievalDiagnostics`.
- **Change**: thread real attempt counts from the persisted pack's repair state; mark synthetic
  diagnostics as such or drop them.
- **Accept**: two consecutive `expand_context` calls report 1 then 2; diagnostics contain no
  fabricated scores.

### R1.5 (S) Tool-output truncation produces malformed JSON
- **Where**: `providers/claude.ts:315-317` — `compactToolOutput` truncates mid-JSON at 12k chars.
- **Change**: truncate structurally: drop whole array items/fields with an explicit
  `"truncated": true` marker (mirror the registry's summary discipline), never cut a JSON string
  mid-token. Apply the same helper in the openai provider loop.
- **Accept**: test: oversized tool result → output parses as JSON and carries the truncation
  marker.

### R1.6 (S) Turbo pipeline couples CLI tests to the notebook browser build
- **Where**: `@duckcodeailabs/dql-cli#test` was blocked by `dql-notebook-app#build` via
  `test → build → ^build` (found during the audit build run).
- **Change**: after R0.1 this unblocks; still, decide whether cli tests need the notebook app
  *built* (likely not) and narrow the dependency in `turbo.json` if so.
- **Accept**: `pnpm test` runs cli tests even when the notebook app build is broken.

---

## Wave R2 — Finish the half-wired (consolidation with user-visible payoff)

Ordered by pillar impact: trust visibility and review speed first (pillars P3/P2), engine
consolidation after.

### R2.1 (M) Make the UI consume the canonical trust label (finish W2.5)
- **Where**: `trust/stamp.ts` stamps `trustLabelInfo` at the single exit
  (`answer-loop.ts:550`) but **zero grep hits under `apps/`** — the notebook still renders
  legacy labels; `AgentAnswer` still carries `kind`/`certification`/`reviewStatus`/`trustLabel`
  in parallel; catalog keeps its private 5-value `MetadataTrustLabel`
  (`catalog.ts:5283-5296`).
- **Change**: (a) `UnifiedAgentRunPanel`/`AgentAnswerCard` render badge text/color from
  `trustLabelInfo` only; (b) mark the legacy fields `@deprecated` on `AgentAnswer` and migrate
  hosts to read the stamp; (c) collapse `MetadataTrustLabel` onto `TrustLabelId` via the existing
  shims; (d) delete shims once no consumer reads legacy fields.
- **Accept**: one grep finds every badge string sourced from `labels.ts`; UI tests assert
  `Certified · stale data`-style composed labels; legacy fields unused outside serialization
  compat.

### R2.2 (M) Review dashboard + real result sample + one-click certify (finish W4.2)
- **Where**: metrics exist and are served — `reviewTelemetry`
  (`local-runtime.ts:8570-8724`), `certifyConversionRate`/`medianTimeToCertificationMs`
  (`dql-project/src/local-notebook-research-storage.ts:489-542`), one-screen
  `ReviewableProposalResult.review.payload` with `nearestCertifiedBlock`
  (`local-runtime.ts:8586-8620`) — but no UI consumes any of it, `payload.resultSample` is
  hardcoded `{status:'not_run', rows:[]}`, and "one-click certify" is a copy-paste CLI string.
- **Change**: (a) notebook review panel rendering the payload (question, SQL/members, sample
  rows, nearest-certified diff, certify button); (b) populate `resultSample` from the answer's
  bounded preview (it already executed — carry the first N rows); (c) a
  `POST /api/certify-draft` endpoint wrapping `dql certify --from-draft` so the button is real;
  (d) surface `reviewTelemetry` + conversion metrics on the propose/review screen.
- **Accept**: from a review-required answer to a certified block in one screen and one click;
  median-review-latency metric visibly rendered; e2e test covers the API certify path.

### R2.3 (M) Truthful cascade trace + engine short-circuit (finish W2.3)
- **Where**: `createCascadeTrace` (`cascade/cascade.ts:124-147`) *synthesizes* checked/skipped
  lane statuses post-hoc from the terminal lane — it can misreport what actually ran.
  `isTerminalSuccess` still only short-circuits `conversation`/`certified_answer`
  (`agent-run-engine.ts:1131-1138`).
- **Change**: (a) record real lane-entry/exit events during `runAnswerLoop` (a small
  `laneEvents[]` on the loop state) and build the trace from them; (b) generalize
  `isTerminalSuccess` to any lane-completed answer meeting its gate (a passed semantic or
  generated answer ends the run — no residual planned steps).
- **Accept**: trace assertions in cascade tests match actual execution order (e.g. semantic
  attempted-and-refused shows `attempted`, not `skipped`); engine test: a passed
  `generated_answer` step drains the queue.

### R2.4 (S) Grain gate consumes metric status; Lane-2 trust from status (finish W2.2)
- **Where**: `metadata/grain-gate.ts` has zero status references; Lane-2 answers are always
  stamped `ai_generated` regardless of the metric's `status` (`answer-loop.ts:1593`).
- **Change**: certified metric + compatible grain ⇒ Lane-2 answer stamps `reviewed`/`certified`
  trust per the ladder (still never auto-`certified` unless the *metric itself* is certified —
  that's the human act, so this respects the invariant); grain-gate rejects finer-than-declared
  grains for certified metrics.
- **Accept**: test matrix: certified/draft metric × matching/finer grain → expected trust label
  and gate outcome.

### R2.5 (M) DQL artifact *before* execution + artifact coverage (finish W2.7)
- **Where**: generated lane executes raw `parsed.sql` (~`answer-loop.ts:1445`) and wraps the
  artifact after (`:1538`); `business_context` answers and certified blocks lacking stored SQL
  carry no artifact.
- **Change**: (a) materialize `buildGeneratedSqlDqlArtifact` immediately after validation passes
  and execute *its* query text (one source of truth; semantic lane already does this);
  (b) business-context answers emit a `term`/`business_view` reference artifact; (c) certified
  blocks without stored SQL emit a reference-only artifact (name/path/hash).
- **Accept**: every `AgentAnswer` with `kind !== 'no_answer'` has `dqlArtifact`; executed SQL
  string-equals the artifact's `query` body in tests.

### R2.6 (S) Retire the llmContext regex parser fallback (finish W2.1)
- **Where**: `resolveGovernedMetricSql`/`buildGovernedMetricFirstSql` still regex-parse
  `llmContext` (`metric-match.ts:239`) as live fallbacks (`answer-loop.ts:954-965, 1070-1080`)
  when the bridge returns undefined.
- **Change**: route those fallbacks through structured `MetricDefinition`s (the semantic layer is
  now injected — `AnswerLoopInput.semanticLayer`); keep a single deterministic
  metric-SQL builder in `semantic-bridge/`; delete the regex parser.
- **Accept**: `parseMetricDefinition`-from-text has zero callers; metric fallback tests pass via
  structured definitions.

### R2.7 (S) Semantic dialect plumbing is dead
- **Where**: `AnswerLoopInput.semanticDriver`/`semanticTableMapping`
  (`answer-loop.ts:475-476`) are never passed by any host — non-DuckDB runtimes compile Lane-2
  SQL with the default dialect.
- **Change**: hosts pass the active connector's dialect + table mapping
  (`dql-agent-provider.ts`, `commands/agent.ts`); compose passes them to `composeQuery`
  (already in its options).
- **Accept**: test with a snowflake-dialect layer asserts dialect-correct `DATE_TRUNC`/quoting.

### R2.8 (M) DataLex join guidance into the ledger (finish W2.6)
- **Where**: `'datalex'` join source exists only as a type member and rank slot
  (`catalog.ts:469, 4178-4186`) — no code path produces one; DataLex guidance today lives only
  in `query_via_metadata` responses.
- **Change**: at pack build, translate DataLex canonical-key/fan-out guidance into
  `selectedJoinPaths` entries with `source: 'datalex'` (rank above `metadata_guess`, below
  `dbt_lineage`), rendered by the existing `renderCandidateJoinsForPrompt`.
- **Accept**: fixture with DataLex contract produces a datalex-sourced join in the pack and the
  prompt; rank order asserted.

### R2.9 (S) Tier-distribution surface (finish P2 acceptance)
- **Where**: `terminalLane`/`routeTier` persisted per turn in SQLite (session-store) but no
  aggregation exists.
- **Change**: small aggregation endpoint + a distribution strip on the eval/telemetry screen
  (lane counts over last N runs); reuse `distributions.actualRoutes` shape from the eval report.
- **Accept**: after a mixed eval run, the endpoint reports certified/semantic/generated counts.

---

## Wave R3 — Remaining features (the last planned capabilities)

### R3.1 (M) Small-catalog full-context mode (finish W3.4)
- **Where**: absent — only fixed deep caps exist (`cascade/budgets.ts:93-129`).
- **Change**: when total catalog size ≤ threshold (e.g. ≤40 relations & ≤2,000 columns), deep
  mode skips retrieval-selection and hands the model the entire relation set (full columns,
  joins, edges) — the "send everything, let the agent decide" mode from the plan. Threshold in
  `budgets.ts`, decision logged in `retrievalDiagnostics.strategy` (new literal
  `'full_catalog'`).
- **Accept**: jaffle-sized fixture in deep mode renders every relation; strategy recorded;
  quick mode unchanged.

### R3.2 (M) LLM judge + credentialed execution-match CI (finish W4.1)
- **Where**: no judge anywhere (`grep -ri judge` clean); execution-match exists in
  `dql agent eval --execute` but not in CI.
- **Change**: (a) single-call judge (0–1 + pass/fail; rubric: correct objects, correct
  aggregation, honest trust label) as an *optional* eval stage behind an API-key env check;
  (b) a scheduled/manual CI job (`workflow_dispatch` + weekly cron) running
  `--execute` + judge against the fixtures with credentials, separate from the required
  offline `golden-eval` job.
- **Accept**: `dql eval --judge` produces per-case scores; scheduled job uploads the JSON report
  as an artifact; required PR job remains offline-deterministic.

### R3.3 (L) Real embedding provider + paraphrase certified matching (finish W4.4)
- **Where**: only `HashedTokenEmbeddingProvider` exists (`embeddings/provider.ts` untouched);
  alpha=0.18 blends hashed tokens; certified example-question matching is still exact-string
  (`hasExactExampleQuestion`, `catalog.ts:3338`).
- **Change**: (a) pluggable embedder honoring the existing `EmbeddingProvider` interface —
  config-selected: `ollama` (local, default-off), `openai`, or hashed fallback; embed + cache
  block `examples`, metric names/labels, and object descriptions at index time
  (SQLite blob table keyed by content hash); (b) certified matching: cosine similarity over
  example questions feeding `certifiedHitFromContextPack` alongside FTS (hybrid, alpha
  config); (c) paraphrase tests ("who are our best customers" → matches "top customers by
  revenue" block).
- **Accept**: with embedder configured, paraphrase test passes tier-1; with no embedder, all
  current tests still green (hashed fallback); index time bounded (cache hit on unchanged
  content).

### R3.4 (M) Deep-lane candidates: always-on, 3–5, diverse (finish W4.7)
- **Where**: capped at 3 (`answer-loop.ts:3516`), only 2 alternative prompts, and alternatives
  generate **only when the first candidate fails** (`:3502-3504`) — hard questions whose first
  SQL merely validates never get compared.
- **Change**: in deep mode, always generate 3–5 candidates (add a query-plan-CoT and a
  decomposition prompt style to the existing 2), group by execution-result equivalence
  (exists), keep the deterministic scorer as selector (accepted deviation), and record the
  disagreement rate in evidence. Quick mode unchanged (single candidate + repair).
- **Accept**: deep-mode test shows ≥3 candidates generated on a *clean* first candidate;
  agreement/disagreement surfaced in evidence; token budget respected.

### R3.5 (M) LLM member-selection fallback for Lane 2
- **Where**: member selection is deterministic token-overlap only (accepted as primary); when it
  finds no members, questions drop straight to Lane 3 even when the semantic layer could answer.
- **Change**: before falling through, if the semantic layer covers the question's entities, make
  one LLM call emitting the `query_semantic_model` JSON contract (validated, zod), compile via
  `composeQuery`. This is the plan's original "LLM emits validated JSON" step, now as a
  fallback tier inside Lane 2.
- **Accept**: paraphrased metric question that the token matcher misses answers via Lane 2 with
  one provider call (asserted call count), not Lane 3.

### R3.6 (L) Lane extraction — make `cascade/` own the walk (finish W2.3 structurally)
- **Where**: lane logic still inline in the 4,474-line `runAnswerLoop`; `cascade/` holds
  policy/triage/budgets/trace only.
- **Change**: three sequential PRs, tests moving with code, zero behavior change:
  (1) `lane-certified.ts` (from `answer-loop.ts:~700-780`), (2) `lane-semantic.ts`
  (`:935-1032` + bridge glue), (3) `lane-generated.ts` (validation/re-grounding/repair/execution
  block). `runAnswerLoop` becomes sequencing + shared state. Do this *after* R2.3 so the trace
  is event-based first (extraction then can't silently change trace semantics).
- **Accept**: answer-loop.ts < 1,500 lines; each lane unit-testable without the full loop; full
  suite green after each PR.

---

## Wave R4 — Accepted deviations (no code change; update docs instead)

These audit findings are deliberate accepts — record them in the implementation plan and
`docs/architecture/agentic-loop/` so nobody "fixes" them later:

1. **Deterministic member selection as Lane-2 primary** (R3.5 adds the LLM fallback) — cheaper
   and more predictable than LLM-JSON-first; dbt benchmark supports it.
2. **Research mode = generic deep tool loop**, not executed plan-steps from `research-loop.ts`.
   Action: delete or clearly mark the dead descriptive plan-step code path.
3. **Deterministic candidate scorer** instead of a selection-judge LLM (R3.4 keeps it).
4. **Cap-based rank interleave** (35% column budget) instead of two literal budgets.
5. **JSON Schema as canonical tool schema** with zod derived at the MCP edge.
6. **Composting mining lives in `local-runtime.ts`** instead of `propose/` — optional refactor,
   not required.
7. **`mcp` "full" profile exposes 25 tools** while the default LLM-facing `mcp_agentic` profile
   is 13 — the ≤15 rule applies to LLM-facing surfaces.

Also fold into the docs: the trust-labeling changes Codex made in passing (`kg/build.ts`
notebook nodes → `ai_generated`, dashboards → lifecycle-derived) — correct behavior, currently
undocumented.

---

## Suggested sequencing

```
PR 1  R0.1 + R0.2 + R0.3 + R1.6        → tree ships: build 20/20, tests green from any cwd
PR 2  R1.1–R1.5                        → correctness fixes, all S-sized
PR 3  R2.1 + R2.2                      → trust + review UX (pillars P3/P2 visible payoff)
PR 4  R2.3 + R2.4 + R2.5               → truthful trace, status-aware trust, artifact-first execution
PR 5  R2.6 + R2.7 + R2.8 + R2.9        → semantic-tier polish + telemetry surface
PR 6  R3.1 + R3.2                      → full-context mode + judged/credentialed eval
PR 7  R3.3                             → embeddings + paraphrase certified matching
PR 8  R3.4 + R3.5                      → deep candidates + Lane-2 LLM fallback
PR 9  R3.6 (three sub-PRs)             → lane extraction
PR 10 R4                               → docs truth-up
```

Every PR: existing suite green, jaffle regressions green, golden eval at strict thresholds, and
the relevant new Accept checks encoded as tests. After PR 5 the implementation plan's Phases 1–2
are 100%; after PR 8, Phases 3–4 are 100% minus explicitly-accepted deviations.

## Progress log

**2026-07-05 — Waves R0 + R1 landed** (branch `feat/governed-answer-cascade`).

Committed and verified (build 22/22, dql-agent 577/577, dql-mcp 100/100, cli 110/110):

- **R0.1** ✅ Split `semantic/yaml-loader.ts` (browser-safe) from `yaml-loader.node.ts` (fs);
  added a pure `@duckcodeailabs/dql-core/artifacts` subpath export and routed the notebook's
  `normalizeDqlArtifactReference`/`DqlArtifactReference` imports through it. Notebook browser
  bundle builds again (22/22, was 19/20).
- **R0.2** ✅ Removed the invalid `allowBuilds` placeholder block from `pnpm-workspace.yaml`.
- **R0.3** ✅ `eval.test.ts` resolves golden fixtures from the test-file location; passes from
  any cwd.
- **R1.1** ✅ Replaced the hardcoded `beverage|jaffle|food → category` map with a generic
  sample-value matcher (`resolveFilterValueColumns` over `schemaContext`, threaded as
  `filterValueColumns`). No fixture vocabulary in the engine.
- **R1.2** ✅ `provider_error` refusal code set + mapped to `blocked` (retryable), not
  `needs_clarification`. Test added.
- **R1.3** ✅ Re-grounding completeness merge only marks `complete` on an explicit side; unknown
  stays advisory. Test added.
- **R1.4** ✅ `expand_context` reports a real incremented reground count (threaded via
  `retrievalDiagnostics.regroundAttempts`) and preserves real retrieval scores. Test asserts 1→2.
- **R1.5** ✅ Shared `compactToolOutput` truncates to valid JSON with a marker; used by both
  provider tool loops. Test added.

Findings that revise the remaining plan (sizes were optimistic):

- **R2.5** — the *core* ("executed SQL == artifact query body") is **already satisfied**: both are
  the same `parsed.sql` value embedded verbatim by `buildGeneratedSqlDqlArtifact`. Only artifact
  *coverage* for `business_context` and SQL-less certified answers remains (real, small).
- **R2.4** — couples to the trust-vocabulary/`AI-never-auto-certifies` invariant (whether a
  certified-metric answer may stamp `certified`); needs a decision, do alongside R2.5/W2.5.
- **R2.7** — the host has `activeConnection.driver`/`tableMapping`, but threading them to the loop
  spans the runner-request interface; medium, low user-visible value (non-DuckDB only).

Next-up (safe, testable, no decision needed): R2.5 coverage, R2.6 (retire llmContext regex
parser), R2.3 (event-based cascade trace + engine short-circuit), R3.1 (small-catalog
full-context), R3.4 (always-on deep candidates), R3.5 (LLM member-selection fallback).

Needs a decision or preview verification: R2.1/R2.2 (trust-label + review-dashboard UI),
R2.4 (trust invariant), R3.2 (LLM judge + credentialed CI), R3.3 (embedding provider choice),
R3.6 (lane-extraction refactor — large).

## Definition of done for RFC 0001

- `pnpm build` 20/20; full test suite green from any cwd; golden eval required-in-CI at strict
  thresholds; scheduled credentialed eval reporting execution-match + judge scores.
- The three jaffle questions and their paraphrases answer end-to-end with honest labels.
- Every answer carries a DQL artifact and a canonical trust label rendered in the UI.
- Review-required → certified is one click; review latency and certify conversions visible.
- Tier distribution observable; no fixture-shaped vocabulary anywhere outside fixtures.
