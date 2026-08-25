# Ask AI observability contract

Status: **accepted for implementation**
Scope: local Ask AI, Ask conversation, and Ask Research only

This contract adds diagnostic evidence around the authoritative Ask
orchestration. It does not create another planner, trust evaluator, router, or
execution path. The cascade, frozen plan, provider/warehouse guards, trust
state, and deadline remain authoritative when the trace store is unavailable,
full, stale, or corrupt.

## OBS-001 — purpose and boundary

Every valid Ask or Ask Research run may receive one local `AskTraceEnvelopeV1`
after the server assigns its run ID. The trace is fail-open and non-authoritative:
it cannot select a route, authorize a tool or relation, alter a budget, change a
trust label, retry a provider, or turn a review-required result into a governed
result. A run keeps working when tracing is disabled or unavailable.

`AgentRunTraceReferenceV1` is the only trace material allowed in an AgentRun,
run list, thread, or SSE payload. It contains a trace ID, status, schema version,
and optional fingerprint; it never embeds spans, question text, SQL, rows, or
provider messages.

## OBS-002 — identifiers and typed records

Trace IDs are 32 lower-case hexadecimal characters and span IDs are 16
lower-case hexadecimal characters. A trace consists of a root envelope, typed
spans, candidate lifecycle decisions, and links. Span payloads are a closed
discriminated union: callers cannot attach arbitrary objects or raw errors.

Allowed evidence is limited to qualified identifiers, stable reason codes,
counts, source coverage, harmless timestamps/durations, redacted provider
metadata, and one-way fingerprints. Prompt/question text, response text, SQL,
literals, rows, member values, physical paths, headers, secrets, and raw
provider errors are prohibited at the persistence boundary.

## OBS-003 — local storage, lifecycle, and retention

The local-only store is `.dql/local/ask-observability.sqlite`, separate from
the AgentRun store. It uses WAL and `user_version = 1` with the tables
`ask_traces`, `ask_spans`, `ask_span_events`, `ask_candidate_decisions`,
`ask_trace_links`, and `ask_export_receipts`.

On startup, recording traces are marked `interrupted` and `partial`. A newer
schema is read-only/unavailable to older binaries. Store failure, capacity, or
redaction failure changes only trace status; it never changes the Ask outcome.

The default local limits are deliberately finite:

| Limit | Value |
| --- | ---: |
| detailed traces / detailed retention | 500 / 30 days |
| summary traces / summary retention | 2,000 / 180 days |
| SQLite file | 256 MiB |
| one trace detail | 1 MiB |
| spans / candidate decisions | 512 / 1,024 |
| producer queue / batch / cadence | 4,096 / 128 / 25 ms |

Expired detail leaves a summary and returns `TRACE_DETAIL_EXPIRED`; it is not a
claim that a source or candidate did not exist.

## OBS-004 — candidate lifecycle and authority

Each retrieval lane records candidates before narrowing, then records fusion,
role reservation, admission, exclusion, same-snapshot extension, and model
selection/rejection using qualified IDs and reasons. A candidate excluded for a
package bound is reported as excluded, never as missing or unmodeled.

The authoritative meaning/cascade/freeze receipt is projected into a safe trace
shape. Trace readers may explain that decision but may not rebuild it from
prose, retrieval scores, or a later database state.

## OBS-005 — physical boundaries

Spans cover conversation hydration/persistence, snapshot and retrieval lanes,
meaning selection, cascade attempts, plan freeze, provider preflight and
physical attempts, tool calls, SQL generation/validation/authorization/
execution/repair, result normalization, narration, and run persistence. A
provider-attempt span opens at admission/dispatch and closes only when that
physical attempt settles; an admission denial is `denied`, not a synthetic
provider success. SQL authorization denial records `sql.authorize: denied` and
does not create an execution-success stage after the fact.

Research adds a root trace, receipt-linked child branches, validator/verdict
events, and synthesis evidence. A branch has a typed verdict of `supported`,
`contradicted`, `inconclusive`, `failed`, or `skipped`; rows or correlation do
not by themselves prove causality.

## OBS-006 — provider diagnostics

Provider spans preserve only redacted provider/model/base-origin fingerprints,
phase, HTTP class, retryability, safe action, and one of the stable causes:
`authentication`, `model_not_found`, `rate_limited`, `gateway`, `network`,
`provider_timeout`, `run_deadline`, `admission_denied`, `dispatch_budget`,
`cancelled`, or `unknown`. They do not retain request or response bodies.

## OBS-007 — export and replay

`strict` exports pseudonymize identifiers. `support` exports retain qualified
identifiers only after an operator explicitly confirms reviewed identifiers;
any reviewed question is separate operator input, not recovered from the run.
Both profiles scan for secrets, SQL, URLs, paths, and other prohibited content.

A portable export contains `manifest.json`, `trace.json`, `run-receipt.json`,
and `redaction-receipt.json`, all checksum-bound. Validation and receipt replay
are offline-only: they must make zero provider, tool, SQL, or network calls.
The OTLP/OpenInference shape is a local JSON mapping only; DQL ships no network
trace exporter.

## OBS-008 — bounded API and CLI

The local runtime exposes status, bounded trace list/detail, run-ID lookup, and
strict export. Full trace details never enter ordinary run lists, threads, or
SSE. Stable errors are `TRACE_NOT_FOUND`, `TRACE_DETAIL_EXPIRED`,
`TRACE_STORE_UNAVAILABLE`, `TRACE_SCHEMA_UNSUPPORTED`, and
`TRACE_EXPORT_REDACTION_FAILED`.

`dql agent trace list|show|export|validate|replay --mode receipt|compare`
opens the store read-only for inspection. Export refuses a non-empty output
directory. Comparison is structural (stages, roles, route, trust, and counts),
not a comparison of prose.

## OBS-009 — Ask trace UI

`/ask/traces/:runId` stores only a run ID in browser navigation state and
hydrates details from the local runtime. The main Ask inspector links to it.
The page starts with an answer-first incident summary — **What happened**,
**Why**, **Impact on answer**, and **How to fix** — derived only from typed
provider cause/safe action, source coverage, cascade stop, or SQL/tool denial.
It links to the relevant typed stage, then provides a searchable
keyboard-accessible tree, graph, and timeline, and a shared detail pane. The
graph includes typed continuation and Research relationships as dashed edges,
not just span-parent edges. Source/candidate exclusion evidence is grouped and
paginated rather than silently discarded. It uses the existing `paper`,
`white`, and `obsidian` theme contract without changing theme tokens or
`dql-theme` persistence.

## OBS-010 — evaluation and performance evidence

Ask evaluation evidence may assert compact trace recording state and trace
fingerprints, but it cannot use trace details as routing guidance. Gold SQL,
rows, and unredacted office data remain outside runtime prompt/context guidance.
The implementation target is enqueue p95 at or below 1 ms, added Ask overhead
at or below 10 ms, and at or below 2% CPU. Those targets require independent
measurement before a `verified` acceptance status.

## OBS-011 — office reproduction workflow

For an office failure, collect the running binary/version/commit, redacted
provider readiness, snapshot/index fingerprints, compact trace reference,
trace bundle, diagnostic receipt, and a sanitized reproduction. Never copy an
office prompt, SQL, rows, provider body, API key, local path, or database value
into an OSS issue or trace export.

## OBS-012 — compatibility

Existing V1–V3 AgentRun receipts remain readable. Ask observability is additive,
local-first, and has no hosted tenancy, managed secret, SSO/RBAC, centralized
audit, cloud export, or approval-workflow dependency.

## OBS-013 — local catalog and trace navigation

`/ask/traces` is a Govern-side catalog for the local Ask and Research traces.
It filters and paginates only typed envelope fields: outcome, mode, trust state,
and selected cascade tier. The catalog obtains a short, redacted question
preview and scenario label by joining the local AgentRun store when it reads a
page; neither value is written to the trace SQLite store, trace transport, or
Notebook state.

Each catalog row and the existing Ask answer/How-it-answered links open the
same `/ask/traces/:runId` detail page. Browser reload, Back, and Forward retain
only the route and run ID. Direct detail loads return to the local catalog when
there is no prior DQL route. The catalog and detail use the existing shared
`paper`, `white`, and `obsidian` theme selector and `dql-theme` persistence
contract unchanged.

## OBS-014 — canonical Ask decision story

At terminal persistence, Ask writes one additive `AgentRunDiagnosticReceiptV4`
containing `AskDecisionSummaryV1` and, when applicable, a typed
`AskTerminalIncidentV1`. The summary is content-safe: it records counts and
qualified lifecycle/tier state, plan/freeze/review state, a stable fingerprint,
and one safe next action; it does not retain prompts, SQL, result rows,
provider bodies, credentials, paths, or values.

The compact **How it was answered** inspector and the full run-ID trace detail
render the same stored `summaryFingerprint`. They do not reconstruct a second
generic incident from spans. The full trace keeps span tree, graph, timeline,
and candidate detail behind **Advanced evidence**. A V1–V3 run remains
readable and explicitly says that a canonical decision summary is unavailable.

`INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH` is an
`sql.authorize` / `internal_invariant` incident with
`execution_not_attempted` impact and the only safe action
`export_redacted_trace`; it is never labeled `unknown` or
`retry-after-connection`.
