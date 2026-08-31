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

- `authoritative_v2` is the normal host-selected Ask runtime.
- `shadow_v2` records V2 state but serves the explicit V1 comparison result.
- `legacy_v1` is the explicit operator rollback.
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
