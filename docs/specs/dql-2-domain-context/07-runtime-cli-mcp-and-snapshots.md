# Runtime, CLI, MCP, and project snapshots

## ProjectSnapshotService

All manifest, catalog, semantic, Domain Package, skill, block, product, and
evaluation reads are compiled into an immutable `ProjectSnapshot`. It contains
the v2/v3 manifest view, qualified object index, domain membership index,
relationship graph, search/KG index, product backlinks, diagnostics, and input
fingerprints. Consumers receive a snapshot handle instead of reparsing dbt
artifacts per request (`PERF-001`).

The Ask-facing handle is a `ProjectSearchSnapshotHandle` containing `snapshotId`,
source fingerprint, policy hash, target identity, optional connection identity,
and creation time. The canonical persisted search store contains qualified DQL
v3/modeling objects, certified assets, semantic metrics/members, dbt unique IDs,
complete column records, safe runtime-schema records, approved hints, aliases,
typed edges, payloads, FTS, and source diagnostics (`CTX-005`). Leaf names are
ambiguity-aware aliases; they never replace qualified identity.

Compact exact/alias maps, metric headers, and graph adjacency are memory-resident.
Verbose payloads, hundreds of thousands of columns, FTS, and graph records stay
in SQLite and are hydrated only for ranked candidates. The runtime opens the
last valid persisted snapshot before rebuilding; cheap fingerprint validation
runs without parsing every artifact. A warm Ask performs zero raw dbt, semantic,
or DQL source reads.

Build occurs in a candidate directory under ignored `.dql/` state. Validation
must complete before an atomic active-pointer swap. Snapshot IDs are stable
content-derived fingerprints. Old snapshots remain available for active
requests until reference counts reach zero, then are garbage-collected.

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

UI, direct CLI, MCP, and Chat acquire the same immutable handle and invoke the
same retrieval/meaning/route service. Transport-specific adapters may format the
answer differently, but cannot change candidate eligibility, interpretation,
trust, stable errors, or execution guards (`API-003`).
