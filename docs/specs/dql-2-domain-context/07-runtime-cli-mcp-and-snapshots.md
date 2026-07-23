# Runtime, CLI, MCP, and project snapshots

## Plan-first runtime contract

Every governed surface acquires one `ProjectSearchSnapshotHandle` and invokes
the same versioned planning service. The public runtime boundary accepts a
`ResolvedAnalyticalPlan`, selects exactly one certified/semantic/governed/
exploratory adapter, and produces an `ExecutableQueryPlan`. The execution
gateway returns an `ExecutionReceipt` binding snapshot, resolved-plan,
executable-plan, parameters, projected field identities, result grain, and
result fingerprint (`AGT-013`, `AGT-014`, `API-006`).

Semantic adapters expose capability inspection and cancellable compilation with
an inherited deadline. Runtime-specific member spellings are adapter references,
not semantic identity. Authentication, availability, timeout, compiler, and
execution failures preserve stable redacted codes and never trigger another
adapter or free-SQL fallback after executable-plan selection.

All requested output fields are mandatory. The shared result guard validates
field identity, grain, filters, temporal receipt, parameters, ranking, and
bounds before an answer, reusable artifact, or successful UI state is emitted.
SQL repair may correct serialization/dialect syntax only when the resolved and
executable plan fingerprints remain unchanged.

## ProjectSnapshotService

All manifest, catalog, semantic, Domain Package, skill, block, product, and
evaluation reads are compiled into an immutable `ProjectSnapshot`. It contains
the v2/v3 manifest view, qualified object index, domain membership index,
relationship graph, search/KG index, product backlinks, diagnostics, and input
fingerprints. Consumers receive a snapshot handle instead of reparsing dbt
artifacts per request (`PERF-001`).

The Ask-facing handle is a `ProjectSearchSnapshotHandle` containing `snapshotId`,
source fingerprint, policy hash, target identity, optional connection identity,
and creation time. The immutable content-addressed search store contains
qualified DQL v3/modeling objects, certified assets, semantic metrics/members,
dbt unique IDs, complete column records, skill descriptors/bodies, aliases,
typed edges, payloads, FTS, and source diagnostics (`CTX-005`). A separate
working catalog contains safe runtime-schema records, approved hints, query
runs, and context-pack history. One request binds both through the immutable
snapshot ID; mutable observations cannot alter its governed evidence. Leaf
names are ambiguity-aware aliases; they never replace qualified identity.

Compact exact/alias maps, metric headers, and graph adjacency are memory-resident.
Verbose payloads, hundreds of thousands of columns, FTS, and graph records stay
in SQLite and are hydrated only for ranked candidates. The runtime opens the
last valid persisted snapshot before rebuilding; cheap fingerprint validation
runs without parsing every artifact. A warm Ask performs zero raw dbt, semantic,
or DQL source reads.

Build occurs in ignored `.dql/` state. Validated immutable SQLite files are
written to `.dql/cache/snapshots/<fingerprint>.sqlite`; activation atomically
renames `.dql/cache/active-snapshot.json`. Snapshot IDs are stable
content-derived fingerprints. Old snapshots remain available for active
requests until they are no longer retained, then are garbage-collected.

Manifest knowledge graph schema v2 is the compact control plane: counts,
domain-shard fingerprints, qualified object references, Domain Knowledge
Capsules, cross-domain route states, and the index fingerprint. Verbose object
payloads, graph edges, aliases, and compressed skill guidance live only in the
immutable SQLite snapshot and are hydrated in bounded ranked neighborhoods.

Warm status checks compare cheap file metadata/fingerprints before rebuilding;
they do not build a full metadata snapshot merely to decide whether it is warm.
Node details are served from indexed records, not a fresh manifest/catalog
parse.

dbt Apply and refresh eagerly start this versioned preparation in the
background. The preparation registry and governed Ask use the same in-process
promise for a source version, so the first question either reuses a completed
warm index or waits on the existing build; it never launches a second rebuild.
The onboarding status/job APIs report redacted phase state, object counts, and
durations. Generated SQLite/KG files remain rebuildable ignored state.

## Semantic execution capability

Semantic discovery responses include a redacted per-metric execution capability:
`ready` with `native|metricflow-cli|dbt-cloud`, `requires_setup`, or
`unsupported`. The dbt
adapter normalizes array/object artifacts, object measure references,
`node_relation`, and compiled `where_filters` without replacing derived, ratio,
cumulative, conversion, or non-additive meaning with one input measure. Query
and preview endpoints return `SEMANTIC_RUNTIME_REQUIRED` or
`SEMANTIC_FIELDS_INCOMPATIBLE` with identifier-bound details (`API-004`).

DQL packages all three adapter integrations. `native` has no external
dependency; `metricflow-cli` discovers a compatible local `mf` executable; and
`dbt-cloud` calls the configured regional Semantic Layer GraphQL endpoint with
an environment ID and service token. npm install does not install a Python dbt
runtime, create cloud credentials, or alter global PATH. Settings exposes the
redacted adapter matrix and test-before-save dbt Cloud editor. Blank secret
edits preserve a tested token and failed candidates never replace working
settings (`API-004`, `UI-007`, `E2E-005`).

One runtime selector and member contract serve semantic preview, Notebook cells,
Block Studio, and Ask. Ask may use AI to select among similarly named members,
but SQL is always produced by the selected semantic adapter. SQL compiled by
dbt Cloud or MetricFlow remains authoritative; a smaller local retrieval pack
must not replace it with a guessed leaf measure. Warehouse execution is still
the final dialect/binder check (`AGT-001`, `UI-009`, `E2E-008`).

The semantic compiler preserves model ownership for repeated dimension names.
Compatibility lookup and native composition choose the selected metric model's
member before traversing declared joins; they never use catalog load order.
Context, grounding, analytical-policy, and exploratory SQL parsers all receive
the active connector dialect (`API-004`, `AGT-001`).

## Parameterized certified-block invocation

Ask, Notebook, native agent tools, CLI, and MCP invoke certified blocks through
one typed values-only contract: original question, explicit parameter values,
and per-value provenance. The shared runtime owns policy/default resolution,
validation, SQL compilation, audit identity, and secret-safe results. Every
surface returns the same resolved parameter records, including `question` and
`prior_result` provenance; no surface accepts structural SQL as a parameter.
Blank or unresolved required values fail before execution (`API-005`).

Inline Ask results retain the executable DQL artifact rather than flattening it
to a table. They show the applied values and reuse the same parameter controls
as other Notebook DQL results, so changing an input reruns the saved artifact
directly without another metadata search or AI planning pass (`UI-011`).

The artifact is finalized before the displayed query executes. Initial Ask and
Apply use the same source, compiler, resolved values, and row bound. A redacted
execution receipt fingerprints that source, compiled SQL, parameter set, and
result; an unchanged Apply may refresh mutable data but must reproduce the same
source/parameter/compiled-SQL contract. Generated SQL is never parameterized or
translated into a second artifact after its result has already been produced,
and a transient artifact's supplied source is not silently replaced by a draft
file at its optional source path (`AGT-010`, `API-003`, `UI-011`).

Successful and failed executable runs retain the inspectable plan, DQL artifact,
compiled SQL when available, lineage/trust evidence, actual phase steps, and
receipt/failure fingerprints. Failures use the versioned contract in spec 10,
including stable code, failed phase/bindings, recoverability, and safe actions.
Equivalent Browser Ask, Notebook, CLI, MCP, and Chat requests expose the same
failure identity and trust transition (`API-007`).

Repair never mutates the source run. A parameter-only rerun, derived DQL edit,
SQL Notebook copy, snapshot refresh, or authorized connection change creates a
new run and receipt according to the trust-transition matrix in spec 10.
Permission/policy failure is terminal for the selected route and cannot trigger
an alternate-source probe (`SEC-004`).

## Domain/modeling APIs

| Method | Path | Contract |
| ------ | ---- | -------- |
| `GET` | `/api/domain-workspaces` | paginated domain summaries/readiness |
| `GET` | `/api/domain-workspaces/:domainId` | one snapshot-backed workspace summary |
| `GET` | `/api/domain-workspaces/:domainId/related-products` | global product backlinks and export diagnostics |
| `GET` | `/api/modeling/dbt-first/inventory` | paginated/filterable dbt/model inventory |
| `POST` | `/api/modeling/dbt-first/nodes/batch` | bounded batch node details by unique ID |
| `GET` | `/api/modeling/dbt-first/neighborhood` | bounded graph around roots/depth/limit |

Existing relationship preview/apply/validate endpoints remain, but must accept
an expected `snapshotId`/source fingerprint and return qualified IDs. Inventory
never returns the full artifact by default. Batch/neighborhood limits are
server-enforced (`API-001`).

## CLI contract

- `dql sync dbt` — build/refresh artifacts as needed, diff, compile, and reindex.
- `dql sync dbt --check` — report-only compatibility behavior; no writes.
- `dql migrate modeling --to dbt-first --dry-run|--apply` — explicit v2/layout
  migration with loss/conflict report.
- `dql model discover` — deterministic/AI-assisted proposal report; no writes.
- `dql model apply-discovery` — preview/apply selected proposals.
- `dql model list|validate|explain` — inspect qualified model/readiness state.
- `dql agent ask --domain <id> --purpose <text>` — invoke the same server
  context/cascade contract used by UI.

All mutating CLI commands support machine-readable JSON, deterministic exit
codes, dry-run where applicable, and non-interactive CI use. They print active
manifest mode and snapshot ID. `--check` is side-effect-free.

## MCP resources/tools

MCP exposes snapshot summary, domain list/workspace, context search, entity and
relationship explanation, certified asset search, lineage, and governed query.
Every response contains `snapshotId` and qualified IDs. Requests may specify
domain/purpose but the server resolves allowed imports. MCP must use the same
context pack and final guards as Ask; it is not an alternate permissive route.

## Cache/source boundary

`.dql/cache`, `.dql/local`, `.dql/imports`, `.dql/connectors`, snapshots,
SQLite indexes, Playwright output, and runtime logs are generated ignored state.
Domain Packages, product documents, evaluations, configuration, migrations,
and specs are Git-tracked source. A clean clone with dbt artifacts can rebuild
the same deterministic manifest/snapshot content.

## Observability

Compile, snapshot, context, route, tool, guard, and answer events share a
request/run ID and snapshot ID. Logs record qualified object IDs and structured
decision reasons, redact question data/secrets according to local policy, and
never treat telemetry as certification evidence.

The agent-run API and stream add redacted `snapshotId`, current phase, cache-hit
state, candidate counts, selected qualified IDs, per-phase duration,
provider/tool/SQL call counts and durations, stable error code, recoverability,
and terminal `cancelled`/`timed_out` states (`API-003`, `PERF-002`). They never
return prompts, secrets, raw runtime values, unauthorized metadata, or SQL
literals that can contain sensitive input. Progress text is emitted from actual
backend phases; elapsed-time UI guesses cannot claim retrieval work that did not
run.

Structured clarification submissions add `selectedEvidenceId` to the same agent
run request. The runtime treats it as identity input, rebuilds context with that
object as focus, and keeps the original analytical question for planning and
artifact naming. Unknown or stale IDs cannot authorize a relation (`AGT-011`).

UI, direct CLI, MCP, and Chat acquire the same immutable handle and invoke the
same retrieval/meaning/route service. Transport-specific adapters may format the
answer differently, but cannot change candidate eligibility, interpretation,
trust, stable errors, or execution guards (`API-003`).
