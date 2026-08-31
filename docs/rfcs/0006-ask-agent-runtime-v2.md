# RFC 0006 — Retrieval-first Ask Agent Runtime V2

Status: **accepted, staged implementation**

## Decision

Natural-language Ask turns retrieve one immutable, qualified context snapshot
before entering one bounded LLM-controlled tool runtime.  The LLM decides the
business interpretation and next safe tool; deterministic DQL services retain
authority for policy, snapshot membership, qualified identifiers, certified
completeness, semantic compilation, relationships, grain/fanout/additivity,
SQL validation, capability minting, execution, trust, and receipts.

The execution priority is certified → semantic → governed relational/DQL →
exploratory SQL (`review_required`).  Before a plan freezes, an ineligible,
unavailable, ambiguous, or compiler/validation observation goes back to the
same agent so it can choose the next safe tool.  Denial, unsafe joins, stale
snapshots, authorization failure, and post-freeze failures remain terminal.
One same-plan repair is permitted after a frozen execution failure.

## V2 ingress and compatibility

- `authoritative_v2` is the intended steady state for the Ask runtime.
- `shadow_v2` records V2 state but serves the explicit V1 comparison result.
  **It is the shipping default** until a canary justifies the flip; a rollout
  control that defaults to on is not a rollout control.
- `legacy_v1` is the explicit operator rollback.
- The mode is selected by `agent.askRuntimeMode` in `dql.config.json`, which
  every Ask surface honors (`dql notebook`, `serve`, `preview`, `agent ask`),
  or overridden per launch by `--ask-runtime-mode`. Precedence is CLI flag >
  project config > default, and an unrecognized value fails at startup rather
  than silently serving a different mode.
- `dql agent shadow-report` compares, per recorded run, what V1 answered
  against how V2 framed the same turn. Shadow never executes, so it compares
  framing and required objects — not results. This is the evidence the flip
  decision is made on.
- Explicit qualified artifacts, Apply/direct reruns, and frozen Research child
  executions remain zero-provider-call paths.  All other free-text turns first
  retrieve context and then use the bounded tool runtime.
- V2 supersedes **only** V1 deterministic business-meaning authority. Existing
  safety validation and persisted V1–V7 readers are unchanged.

## Initial implementation cut

The Stage 1 cut introduces the additive V2 contracts and retrieval/runtime
seam, canonical tool-kernel budget/priority checks, provider egress policy,
and host rollout wiring. It intentionally reuses the existing answer-loop,
analyst loop, MetricFlow compiler and execution guards while later stages add
the full trace UI and dedicated Research presentation.

## Acceptance

`CTX-009`, `AGT-047`–`AGT-054`, `API-017`, `OBS-017`, `PERF-004`, and
`E2E-025` are additive requirements. Implementers may report them
`implemented`; independent verification owns `verified` status.
