# Ask AI orchestration contract

Status: **implemented by the current worktree; independent verification pending**

This slice defines the unified Ask execution boundary for ordinary analytical
questions. It is additive to the existing governed-answer contracts and does not
change the Cloud theme, App, Block, or Modeling surfaces.

## Turn contract

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
  research ledger: `packages/dql-agent/src/analytical-orchestration.ts` and
  `analytical-orchestration.test.ts`.
- Router meaning-call budget and ranking guard: `packages/dql-agent/src/router.ts`.
- Pre-freeze recovery and typed coverage gaps/research ledger: `packages/dql-agent/src/agent-run-engine.ts` and `apps/cli/src/local-runtime.ts`.
- Conversational member resolution and attribute generation: `apps/cli/src/llm/providers/dql-agent-provider.ts` and `packages/dql-agent/src/answer-loop.ts`.
- Canonical result rendering/persistence: `apps/dql-notebook/src/api/client.ts`,
  `UnifiedAgentRunPanel.tsx`, and `AgentAnswerCard.tsx`.

The focused package tests and production builds are implementer evidence. The
designated built-CLI fixture and independent verifier still own `verified` status.
