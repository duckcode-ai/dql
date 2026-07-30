# Warehouse metadata sync and dialect repair delivery plan

Status: **foundation implemented; full acceptance verification remains**
Date: **2026-07-29**
Primary acceptance: `CTX-005`, `AGT-013`, `AGT-014`, `API-006`,
`API-007`, `PERF-001`, `PERF-002`, `SEC-003`, `SEC-004`, `E2E-005`,
`E2E-006`, and `E2E-014`
Primary workstreams: W02, W03, W04, W05, W06, W07, and W08

This plan closes the gap between the accepted DQL 2.0 runtime contract and the
connector/Ask implementation. It does not create another metadata system. The
implemented foundation uses the existing local SQLite catalog, adds an explicit
multi-database and multi-schema metadata scope, activates a scope-qualified
generation, routes warm schema/mapping reads through that generation, and makes
warehouse SQL correction structured, dialect-aware, and bounded.

Implemented in the first OSS milestone:

- versioned per-connection metadata scopes with dbt-exact, selected-scope, and
  combined modes;
- credential-free scope fingerprints and observed Snowflake target checks;
- bounded Snowflake/Databricks/database-scoped metadata SQL;
- fail-closed synchronization that retains the previous active generation on
  mismatch, truncation, empty results, or execution failure;
- generation, scope, dependency, target, count, and duration provenance in the
  existing local metadata SQLite catalog;
- active-generation reads for Ask, schema UI, and semantic table mapping;
- connection-panel Apply/Refresh controls and multiple
  database/catalog/schema entry;
- structured redacted warehouse failures and repair dispositions; and
- zero generative repair for permission, authentication, timeout, cancellation,
  unsafe, unknown-relation, and unclassified failures.

Remaining verification/delivery is explicit below. In particular, asynchronous
deduplicated sync jobs, paginated scope discovery, targeted single-relation
cache fill, richer Inspect UI, connector-specific classification beyond the
shared classifier, and real Snowflake/Databricks evidence are not claimed as
complete.

## 1. Outcome

After a connection is tested and its metadata scope is explicitly applied:

1. DQL synchronizes authorized relation metadata into ignored local SQLite.
2. dbt-referenced relations are the recommended default scope.
3. Users may explicitly add databases/catalogs and schemas.
4. Ask, Notebook, Block Studio, CLI, and MCP search the activated local index.
5. A warm analytical question issues zero live warehouse metadata queries.
6. The warehouse is contacted for bounded query execution, an explicit refresh,
   or one narrow authorized cache-miss lookup.
7. Every selected relation remains fully qualified and bound to the observed
   connection/role/scope identity.
8. Dialect and binder failures use one structured, bounded repair path without
   changing meaning, permissions, connection, route, or trust.

## 2. Verified current implementation

The current repository already provides:

- `.dql/cache/metadata.sqlite`, context packs, FTS-backed runtime-schema
  objects, and bounded metadata retrieval;
- dbt, semantic, Domain, Block, Skill, Hint Graph, and runtime metadata in the
  shared Ask context path;
- connection pooling keyed by the full connector configuration;
- a Snowflake connection that passes database and schema to the driver;
- active-dialect prompt guidance and dialect-aware SQL validation;
- conservative local qualification repair and one model-assisted execution
  repair;
- structured connector errors at the connector boundary; and
- immutable plan, execution, failure, trust, and receipt contracts.

The remaining gaps are:

- the Ask fallback can run a question-scoped `information_schema.columns`
  search whenever local retrieval has no usable relation;
- the stored runtime-schema snapshot is replaced by the most recent bounded
  question subset rather than maintained as one scope-qualified generation;
- the existing runtime-snapshot freshness helper is not wired into Ask
  retrieval;
- semantic table mapping can rescan every visible table in the current database
  on multiple execution surfaces;
- `/api/schema` performs live table introspection when the UI schema panel
  loads;
- Snowflake discovery is current-database scoped but not restricted to the
  configured schema, so all visible non-system schemas in that database may be
  searched;
- direct UI setup requires Snowflake database and schema, while the backend
  connection-test contract does not yet reject a missing or mismatched target;
- the connection model has one database/catalog and one schema field rather
  than an explicit metadata-scope allowlist;
- connector error structure is reduced to prose before the answer-loop repair
  decision; and
- safe deterministic repair and model-assisted execution repair share a narrow
  path that can stop after the first unsuccessful runtime correction.

## 3. Locked design decisions

These decisions apply throughout delivery.

### 3.1 Scope and identity

- A metadata scope is an allowlist, never an account-wide discovery request.
- One analytical run uses one authorized execution connection.
- A connection may index multiple databases/catalogs and schemas only when the
  user explicitly selects them or they are exact fully qualified relations in
  the active dbt artifacts.
- Cross-database SQL is allowed only within one connector when the warehouse
  supports it, the selected scope contains both relations, and existing
  relationship/contract guards authorize the composition.
- DQL does not automatically join or federate across named connections.
- Every runtime relation uses its full connector identity:
  `connection + catalog/database + schema/dataset + relation`.
- Cache identity includes driver, redacted account/workspace, observed role,
  warehouse when relevant, selected metadata scopes, dbt fingerprint, and
  connector/dialect version. It never includes a password, token, private key,
  or plaintext sampled value.
- A role, account/workspace, database/catalog, schema allowlist, or dbt target
  change creates a different scope fingerprint. Metadata from the old scope
  cannot satisfy the new request.

### 3.2 Sources and trust

- dbt and DQL source remain Git-owned governed truth.
- Live warehouse metadata is local, rebuildable evidence of physical existence,
  visibility, type, and drift. It never supplies business meaning or join
  authorization.
- `.dql/cache` remains the correct location for the generated metadata index.
- Runtime metadata never becomes a Domain, Skill, Block, certified asset, or
  approved hint automatically.
- Safe runtime-value grounding remains separately allowlisted and ephemeral.
  This plan does not turn column values into the metadata index.

### 3.3 Dialect correction

- Syntax correction belongs to code-owned dialect and connector adapters, not
  user-authored Domain Skills.
- Skills may describe business vocabulary, grain, calendar, and usage policy;
  they cannot authorize syntax, relations, permissions, or repairs.
- A repair must preserve the resolved-plan and executable-plan fingerprints.
- Permission, authentication, cancellation, unsafe SQL, and scope violations
  never trigger generative repair.
- The normal generated-answer path performs at most one warehouse re-execution
  after an eligible repair.
- Deterministic qualification and dialect normalization should happen during
  preflight whenever possible, before the first warehouse execution. A remaining
  execution error may receive one structured model-assisted repair.
- Repaired generated SQL remains review-required. Repair never certifies a
  result, writes source, approves a hint, or broadens the selected route.

## 4. Target contract

### 4.1 Connection metadata scope

Introduce a versioned server-owned contract equivalent to:

```ts
interface ConnectionMetadataScopeV1 {
  version: 1;
  connectionId: string;
  driver: string;
  mode: "dbt_relations" | "selected_scopes" | "dbt_plus_selected";
  // Effective union used by readers and provenance.
  scopes: Array<{
    catalogOrDatabase: string;
    schemas: string[];
  }>;
  // Explicit user selections; kept separate from exact dbt relations.
  selectedScopes: Array<{
    catalogOrDatabase: string;
    schemas: string[];
  }>;
  relations: string[];
  dbtFingerprint?: string;
  scopeFingerprint: string;
}
```

`observedTarget` is stored on the activated generation and comes from the
connected warehouse, not from browser claims. The persisted configuration
stores mode, redacted scope selections, derived dbt relation identities, and
the dbt fingerprint only; generated `scopeFingerprint` and observed identity
remain rebuildable runtime state.

Warehouse mapping:

| Driver | Scope hierarchy | Rule |
| ------ | --------------- | ---- |
| Snowflake | account → database → schema → relation | query each selected database's `information_schema`; never enumerate every database automatically |
| Databricks | workspace → catalog → schema → relation | query selected catalogs/schemas; preserve Unity Catalog qualification |
| PostgreSQL | connection/database → schema → relation | separate databases use separate named connections |
| BigQuery | project → dataset → relation | selected projects/datasets only |
| DuckDB/file | catalog/database → schema → relation | local scope; retain the same qualification model |

Existing single-database/single-schema configurations receive an implicit
version-1 scope. Loading them requires no source rewrite. The explicit scope is
persisted only after a successful Apply.

### 4.2 Metadata generation

Add a `WarehouseMetadataGenerationV1` identified by:

```text
generationId =
  hash(scopeFingerprint + dbtFingerprint + normalized relation records)
```

Each generation records:

- scope fingerprint and redacted observed target;
- capture time and connector/dialect version;
- origin for each relation: `dbt_exact`, `selected_schema`, or
  `targeted_lookup`;
- fully qualified relation and column identities;
- physical type, ordinal, and visibility evidence;
- bounded row/byte/query counts and duration;
- incomplete/truncated/error state by selected scope; and
- activation and supersession state.

Generation rows may live in the existing metadata SQLite database, but they
must be generation-qualified and transactionally activated. Readers see either
the prior complete generation or the new complete generation, never a partially
rebuilt index.

Retain a small number of prior generations for active runs and rollback. Cache
cleanup may remove unreferenced older generations.

### 4.3 Synchronization lifecycle

```text
Save candidate connection
  → connect and observe target identity
  → validate configured target
  → preview dbt-derived and user-selected scopes
  → user applies scope
  → run one bounded metadata sync
  → stream/paginate bounded metadata
  → validate generation
  → atomically activate
  → rebuild/search the affected runtime-schema FTS lane
  → expose ready status and counts
```

States:

```text
missing → preview_ready → syncing → ready
                             ├── stale
                             └── failed_with_previous_generation
```

Rules:

- Testing a connection stays cheap and does not scan an account.
- Applying a connection/scope completes a bounded synchronization before the
  selection is persisted.
- Deduplicated asynchronous jobs remain a later scale enhancement.
- The last valid generation remains readable while a replacement builds.
- A failed refresh does not delete the prior generation.
- Manual refresh is always available.
- dbt artifact/scope/target changes mark the generation stale and queue or
  request a scoped refresh.
- Time-to-live is a secondary drift signal, not a reason for every question to
  scan the warehouse.

### 4.4 Retrieval and targeted fallback

Warm Ask behavior:

```text
immutable governed snapshot
  + active warehouse metadata generation
  + approved Hint Graph
  → bounded SQLite retrieval
  → resolved plan
  → one execution target
  → bounded warehouse execution
```

Warm Ask, Notebook open, Block Studio open, CLI context inspection, and MCP
context inspection perform zero live warehouse metadata calls.

If a required relation is missing:

1. Re-ground against the active SQLite generation.
2. If the plan names one fully qualified relation inside the authorized scope,
   permit one targeted relation-description request.
3. Bind that observation to the current run and asynchronously build a successor
   generation containing the merged evidence.
4. Never expand to another database, schema, role, or connection because an
   error message mentioned it.
5. If the relation remains unresolved, return the existing structured
   grounding/drift failure and explicit refresh action.

### 4.5 UI and API

Settings → Database adds a **Metadata scope** section after connection testing:

- recommended **Use dbt project relations** choice;
- searchable database/catalog and schema selector;
- explicit **Add selected schemas** action;
- effective account/workspace, role, warehouse, database/catalog, and schema;
- estimated relation count before Apply where cheaply available;
- last successful sync, duration, relation/column count, and scope fingerprint;
- `Ready`, `Syncing`, `Stale`, `Partial`, or `Failed` status;
- **Refresh metadata** and safe rollback to the prior scope; and
- a warning that selecting broad schemas increases sync cost.

The first UI page is bounded. Expanding a database/catalog loads only its
schemas; expanding a schema loads only a paginated table preview. It does not
materialize an account tree.

The implemented server endpoints provide stable, redacted contracts:

```text
POST /api/connections/:id/metadata-scope/preview
GET  /api/connections/:id/metadata-scope
PUT  /api/connections/:id/metadata-scope
POST /api/connections/:id/metadata-sync
```

The existing schema/table browser reads the active local generation. Table
columns are served from SQLite and may be loaded lazily by relation.

Ask's inspector records:

- governed snapshot ID;
- warehouse metadata generation ID;
- metadata source: governed snapshot, runtime cache, or targeted lookup;
- selected fully qualified relations;
- metadata query count and duration;
- cache freshness; and
- any explicit refresh or drift action.

No credentials or unauthorized inventory are returned to the browser.

### 4.6 Structured dialect repair

Preserve the connector error as a versioned redacted repair input:

```ts
interface WarehouseSqlFailureV1 {
  version: 1;
  driver: string;
  category:
    | "syntax"
    | "unknown_relation"
    | "unknown_column"
    | "ambiguous_column"
    | "unsupported_function"
    | "type_mismatch"
    | "permission"
    | "authentication"
    | "timeout"
    | "cancelled"
    | "unsafe"
    | "unknown";
  vendorCode?: string;
  sqlState?: string;
  line?: number;
  position?: number;
  queryId?: string;
  retryDisposition:
    | "deterministic_preflight"
    | "model_repair"
    | "explicit_retry"
    | "refresh_metadata"
    | "change_authorized_access"
    | "terminal";
  redactedMessage: string;
}
```

Add code-owned adapters for Snowflake, Databricks/Spark SQL, DuckDB/Postgres,
and other supported connector families. An adapter:

- normalizes vendor errors into the shared categories;
- supplies concise dialect constraints and safe correction hints;
- identifies terminal permission/access/timeout behavior;
- never chooses business meaning, another relation, or another connection; and
- retains query ID and safe position evidence for Inspect.

Repair sequence:

```text
compile and validate resolved plan
  → deterministic preflight qualification/dialect normalization
  → execute once
  → normalize structured connector failure
  → terminal/explicit action, OR one model repair
  → validate unchanged plan/scope/read-only contract
  → execute repaired SQL once
  → validate result contract
  → review-required answer or structured failure
```

The model repair receives only the resolved output contract, active dialect
profile, selected qualified relation cards, original SQL, structured redacted
failure, and exact constraints. It does not receive broad account metadata.

## 5. Delivery phases

### WM0 — Baseline and instrumentation

Scope: no behavioral expansion.

- Count and time every live metadata query by surface and reason.
- Tag calls as `connection_test`, `scope_preview`, `metadata_sync`,
  `targeted_lookup`, `schema_ui`, or `semantic_mapping`.
- Record cache hit/miss, scope fingerprint, rows/bytes, truncation, and duration.
- Add a deterministic test connector that fails if warm Ask performs metadata
  SQL.
- Capture Snowflake/Databricks baseline traces without credentials or SQL text.

Exit:

- current repeated paths are visible in one redacted run trace;
- tests can assert an exact metadata-query count; and
- no product behavior or trust state changes.

### WM1 — Scope contract and connection enforcement

- Add `ConnectionMetadataScopeV1` and migration from singular fields.
- Observe and strictly compare Snowflake database/schema/role/warehouse and
  Databricks catalog/schema after connection.
- Show the effective target in connection-test results.
- Add dbt-derived scope preview and explicit selected-scope Apply.
- Reject silent configured/observed target mismatch.
- Keep existing connections readable and rollback on failed Apply.

Primary code:

- `packages/dql-connectors/src/connector.ts`
- connector drivers under `packages/dql-connectors/src/drivers/`
- `apps/cli/src/semantic-execution/connection-identity.ts`
- `apps/cli/src/local-runtime.ts`
- `apps/dql-notebook/src/api/client.ts`
- `apps/dql-notebook/src/components/panels/ConnectionPanel.tsx`

Exit:

- one database/schema remains a zero-friction default;
- multiple selected scopes are explicit and fully qualified;
- account-wide discovery is impossible through the normal setup path; and
- target mismatch submits zero analytical SQL.

### WM2 — Activated local metadata generation

- Add generation-qualified metadata tables and transactional activation.
- Synchronize exact dbt relations by default.
- Add explicit schema discovery with pagination and bounds.
- Deduplicate concurrent synchronization by scope fingerprint.
- Preserve the prior valid generation on failure.
- Make runtime FTS read one active generation instead of replacing global rows
  with the latest question subset.
- Wire stale/scope/dbt fingerprints to refresh state.

Primary code:

- `packages/dql-agent/src/metadata/catalog.ts`
- `packages/dql-agent/src/metadata/health.ts`
- `apps/cli/src/local-runtime.ts`
- connector-specific table/column discovery

Exit:

- restart reopens the active generation without warehouse access;
- exact dbt and selected-schema objects coexist without identity collision; and
- a role/scope change cannot reuse an incompatible generation.

### WM3 — Remove warm-request metadata scans

- Make `getSchemaContextForAgent` local-index-first and remove broad
  question-scoped `information_schema` fallback.
- Replace repeated semantic table mapping scans with generation-backed lookup
  keyed by target/scope/semantic fingerprints.
- Make `/api/schema` and relation description read SQLite.
- Retain one fully qualified, scope-authorized targeted lookup for a genuine
  cache miss.
- Preserve current bounded value-grounding rules independently.

Primary code:

- `apps/cli/src/llm/providers/dql-agent-provider.ts`
- `apps/cli/src/local-runtime.ts`
- `packages/dql-agent/src/metadata/catalog.ts`
- `apps/dql-notebook/src/components/panels/SchemaPanel.tsx`
- Block Studio/semantic execution mapping call sites

Exit:

- warm Ask, Notebook mount, Block Studio mount, CLI, and MCP issue zero live
  metadata queries;
- all selected runtime relations cite the active generation; and
- a cache miss never becomes an all-schema scan.

### WM4 — Dialect-aware structured repair

- Preserve `ConnectorQueryError` fields through execution and failure APIs.
- Add dialect error classifiers and correction profiles.
- Move provable qualification/normalization into preflight.
- Give one eligible structured execution failure one model repair.
- Revalidate read-only SQL, relation/column scope, plan fingerprint, connection,
  snapshot, requested outputs, and result contract before accepting the retry.
- Expose the original and repaired SQL, error category, and attempt in Inspect.

Primary code:

- `packages/dql-connectors/src/result-types.ts`
- connector drivers
- `packages/dql-core/src/semantic/sql-dialect.ts`
- `packages/dql-agent/src/answer-loop.ts`
- `packages/dql-agent/src/analytical-failure-repair.ts`
- `packages/dql-agent/src/agent-run-engine.ts`
- CLI execution gateway and cross-surface serializers

Exit:

- Snowflake and Databricks syntax/binder fixtures repair when safe;
- permission, authentication, unsafe SQL, and scope failures do not generate;
- the repaired result remains review-required; and
- every surface exposes the same repair identity.

### WM5 — UI, migration, performance, and release verification

- Complete status/scope/refresh UI and inspector evidence.
- Add migration and rollback tests for existing saved connections.
- Run deterministic scale, cross-surface, browser, and connector suites.
- Perform opt-in real Snowflake and Databricks verification against explicitly
  selected non-production scopes.
- Update connector/reference/troubleshooting documentation.
- Verify the shared Cloud theme/token/embed contract remains unchanged.

Exit:

- every acceptance gate below passes against the built CLI;
- an independent verifier marks evidence; and
- no generated cache, connection, trace, or credential files enter Git.

## 6. Acceptance gates

### 6.1 Metadata behavior

1. A cold applied scope creates one activated generation with exact qualified
   target identity.
2. Ten distinct warm Ask questions produce zero `information_schema`, catalog,
   schema-list, or table-list calls.
3. Restarting the Notebook opens the last valid generation and produces zero
   live metadata calls.
4. Snowflake with two selected databases and three schemas retrieves only those
   scopes; an unselected dev/test database is absent from SQLite and prompts.
5. Databricks with two selected catalogs preserves
   `catalog.schema.relation` identity and never collapses same-named relations.
6. The default dbt mode indexes exact manifest relations without enumerating
   unrelated schemas.
7. Scope or observed-role change prevents old cache reuse.
8. A failed refresh retains the prior generation and displays a truthful stale
   or failed status.
9. UI schema browsing is paginated and makes no warehouse call after sync.
10. One authorized missing relation performs at most one targeted metadata
    lookup; no broad fallback follows.
11. Metadata contains no credentials or plaintext sampled values.
12. Browser Ask, Notebook, CLI, MCP, and Chat select equivalent qualified
    metadata under the same snapshot/scope.

### 6.2 Dialect and repair

1. Valid Snowflake `QUALIFY`, identifier quoting, date functions, and limits
   pass without repair.
2. Valid Databricks/Spark SQL passes without a Snowflake/Postgres rewrite.
3. Unknown/ambiguous columns retain driver, category, safe position/query ID,
   original SQL, and selected relation evidence.
4. A safe dialect/binder failure performs no more than one model repair and one
   warehouse re-execution.
5. Repaired SQL cannot add an unselected relation, database, schema, output, or
   mutation.
6. Permission/authentication failures perform zero generative repair and offer
   only explicit access/connection actions.
7. Timeout/cancellation does not change route or start Research.
8. Result-contract failure remains failure even when repaired SQL executes.
9. Original and repaired artifacts have stable linked fingerprints and correct
   trust transitions.
10. Cross-surface failure and repair contracts are identical.

### 6.3 Performance targets

| Measurement | Gate |
| ----------- | ---- |
| warm metadata warehouse calls | `0` |
| warm context build | p95 `< 500ms` |
| exact runtime-schema retrieval | p95 `< 100ms` |
| Notebook/Block schema first page | `< 500KB`, no warehouse call when ready |
| scope preview | paginated; bounded rows/bytes/time |
| metadata sync | cancellable; bounded; duration and counts reported separately |
| generated-answer model repair | `<= 1` |
| generated-answer warehouse retry | `<= 1` |
| unauthorized-scope metadata/results | `0` |
| plaintext sampled values in metadata cache/logs | `0` |

## 7. Test matrix

Unit:

- scope normalization, hashing, redaction, migration, and target comparison;
- identifier qualification and duplicate-name handling;
- generation activation, rollback, pruning, and FTS isolation;
- dialect error classification and retry disposition;
- deterministic preflight and repaired-SQL scope/result guards.

Connector:

- Snowflake selected-database/schema SQL generation and bounds;
- Databricks selected-catalog/schema request payloads and pagination;
- connector error field preservation;
- cancellation, timeout, row, and byte bounds.

Agent/runtime:

- local-index-only warm Ask;
- exact one targeted miss;
- semantic mapping from active generation;
- no route/permission/scope broadening during repair;
- immutable plan and receipt fingerprints.

UI:

- scope selection, Apply, rollback, progress, stale, partial, and failure states;
- effective target display;
- cached schema browser;
- Inspect metadata source/generation and structured repair details.

End to end:

- built CLI with the designated fixture;
- synthetic multi-database Snowflake and multi-catalog Databricks adapters;
- existing single-target dbt repositories;
- opt-in real Snowflake/Databricks smoke with explicit safe scopes;
- Browser Ask, Notebook, Block Studio, CLI, MCP, and Chat parity.

## 8. Compatibility and rollback

- Existing connection files remain readable.
- Singular `database`/`catalog` and `schema` become an implicit one-scope
  allowlist in memory; no automatic Git or connection-file rewrite occurs.
- Existing `.dql/cache/metadata.sqlite` may be migrated in place when safe or
  rebuilt because it is generated state.
- If the new generation cannot build, the prior valid index remains active.
- Disabling/removing an explicit scope prevents future retrieval immediately;
  cleanup may delete the old generated records afterward.
- Product source, dbt source, domains, skills, blocks, notebooks, apps, Hint
  Graph artifacts, and private chat history are not migrated by this work.

## 9. Explicit non-goals

- account-wide or workspace-wide automatic discovery;
- scanning every database/catalog at application startup;
- cross-connection federation or automatic cross-warehouse joins;
- automatic role switching or permission escalation;
- persisting arbitrary warehouse values or query result rows in metadata;
- using Domain Skills as executable SQL syntax plugins;
- unlimited repair, Research fallback, or autonomous trial-and-error;
- automatic certification, hint approval, or source writes after repair; and
- hosted management, multi-tenancy, SSO/RBAC, centralized audit, managed
  secrets, or approval workflow.

## 10. Definition of done

The work is complete only when:

- the built CLI visibly supports explicit scoped synchronization;
- a warm run makes zero warehouse metadata calls on every surface;
- multi-database/catalog identities stay qualified and collision-free;
- existing single-target repositories continue without source changes;
- Snowflake and Databricks repair fixtures prove structured bounded recovery;
- permissions, scope, meaning, trust, and result guards remain fail-closed;
- performance evidence records query counts, p50/p95, rows, bytes, and hardware;
- an independent verifier confirms the acceptance gates; and
- Git contains only source, tests, specs, and docs—never generated metadata,
  credentials, runtime traces, or local connection state.
