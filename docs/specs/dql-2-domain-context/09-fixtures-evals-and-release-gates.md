# Fixtures, evaluations, and release gates

## Functional Commerce/Growth fixture

```text
Commerce
├── Orders       fct_orders                 grain order_id
└── Customers    dim_customers              grain customer_id

Growth
├── Marketing    fct_campaign_touches       grain touch_id; deliberate fanout
└── Acquisition  dim_customer_acquisition   grain customer_id
```

The dbt project includes MetricFlow `gross_revenue`. DQL includes certified
`Order → Customer` and `Customer Acquisition → Customer` relationships, a
Commerce customer export imported by Growth for an explicit purpose, and a
Growth-owned certified block/business view for revenue by acquisition channel.
Raw Campaign Touches has many-touch attribution-required policy.

Required scenarios (`E2E-001`):

1. `gross_revenue by acquisition_channel` succeeds via the certified safe path
   and emits complete typed lineage.
2. The same question through raw Campaign Touches asks for an attribution
   policy or refuses and never executes a multiplying join.
3. Changing a dbt key/grain invalidates dependency fingerprints and makes
   affected relationships/contracts stale.
4. A correction creates draft → required evaluation → review → approved hint;
   retrieval cannot see it early.
5. A global stakeholder app consumes the certified block, declares
   `ProductDomainContext`, and exposes full lineage/backlinks.
6. A global notebook using both domains appears in both Related Products views
   and reports required export compatibility.

Required App scenarios (`E2E-002`):

1. A beverage-customer stakeholder request reuses compatible certified blocks,
   fills only uncovered requirements with governed semantic queries, and shows
   any remaining gap without raw AI SQL as a primary tile.
2. Proposal makes no product writes; source preflight failures are unselectable;
   snapshot drift rejects commit; a successful commit writes all product files
   atomically with derived domain/export context and no local AI-pin identity.
3. The built `dql notebook` renders filters first and a Business Story second.
   Applying category and period filters updates every tile and story from the
   same fingerprints.
4. Rapid filter run A then B never renders A's late story. With no AI provider,
   the deterministic multi-tile story remains available and meaningful.
5. Invented numeric claims, unsupported causality, mismatched grain/filter
   claims, and app-scoped persona mismatches fail closed.

Required dbt connection scenarios (`E2E-003`):

1. A DQL workspace colocated with dbt and one pointing at an external local or
   Git checkout both discover profiles and compile the configured manifest.
2. `profiles.yml`, `profiles.yaml`, `profile.yml`, and `profile.yaml` resolve the
   matching dbt project profile; relative DuckDB paths resolve from the dbt
   project, not the DQL workspace.
3. With no saved DQL connection, a complete default dbt target supplies the
   runtime connection. Existing saved database and AI-provider configuration
   remains byte-for-byte present after dbt-first onboarding apply.
4. Artifact generation passes the discovered profiles directory to `dbt parse`,
   and the built CLI opens Domain Studio from the resulting manifest-v3 snapshot.

Required unified configuration scenarios (`E2E-005`):

1. The built `dql notebook` exposes one Govern → Settings destination with
   Overview, Project & dbt, Database, AI provider, Agent memory, and Advanced;
   Guided Setup launches from Overview and has no separate rail item.
2. Settings and Guided Setup render the same dbt, profile/database, and provider
   capabilities, reload the same project-local values, and report Missing,
   Configured, Test passed, and Test failed without calling untested values ready.
3. OpenAI and Anthropic enterprise URLs and unsaved keys/models traverse the
   governed runtime adapters. Native Gemini enterprise routing, Ollama,
   subscriptions, and custom OpenAI-compatible requirements remain selectable.
4. Blank provider keys retain saved secrets; APIs never return raw secrets; a
   failing dbt apply, connection test, or provider test preserves the prior
   working configuration. Relative DuckDB and enterprise Snowflake/Databricks
   profile behavior from `E2E-003` remains unchanged.
5. AI can be skipped with limited-AI guidance and without blocking deterministic
   or non-AI paths. Browser verification has no console errors and the Cloud
   embed theme/token/persistence contract remains unchanged.
6. A clean published-package smoke proves project-local installation exposes
   `npx dql`, global installation exposes bare `dql`, both report the requested
   version, and connector installation resolves npm beside the running Node
   executable even when an interactive-shell PATH is unavailable.
7. A clean project opens Guided Setup before the product on first launch. After
   acknowledgement it stays closed for the same CLI version, then reopens once
   when the installed version changes. The project-local acknowledgement keeps
   existing favorites, recent items, dbt/database/provider settings, and secrets
   unchanged.

## Scale fixture

Generate deterministic artifacts representing 10,000 dbt models, 30 columns
per model, 100 domains, 1,000 entities, 2,000 relationships, 1,000 skills,
2,000 blocks/views, and 500 Apps/Notebooks.

Budgets on the documented reference developer machine:

| Operation | Budget |
| --------- | ------ |
| cold compile | `< 5s`, `< 1GB` peak RSS |
| cold index/snapshot | `< 30s`, `< 1.5GB` peak RSS |
| warm context build | p95 `< 500ms`, zero dbt artifact reads |
| warm Domain Workspace summary | p95 `< 250ms` |
| inventory first page | `< 500KB` uncompressed response |
| node detail | p95 `< 100ms`, no full artifact parse |
| one-domain refresh | `< 2s` when dependency boundary permits |
| default canvas graph | `<= 200` nodes before expansion |

Performance tests record hardware, commit, fixture seed, samples, p50/p95,
peak RSS, response bytes, and dbt artifact read count. Budgets are release gates,
not aspirational documentation (`PERF-001`).

## Test layers

- unit: parsers, identities, selectors, fingerprints, skills, policies;
- compiler: deterministic v2/v3 manifests and no dbt fact duplication;
- integration: snapshot atomicity, APIs, CLI, MCP, migration, source patches;
- agent evaluations: route selection, ambiguity, fanout, exports, stale proof,
  corrections, and limited-context Ask;
- browser: real built `dql notebook` against the functional fixture;
- compatibility: v2 and legacy product/split-model paths;
- security: non-loopback fail-closed, CORS/auth, path traversal, redaction;
- Cloud contract: `node scripts/embed-contract.test.mjs` in the Cloud repo after
  UI integration.

## Final release gates

- all acceptance-matrix requirements are independently verified;
- `pnpm test`, focused package tests/builds, and `git diff --check` pass;
- manifest/snapshot rebuild is deterministic and source contains no copied dbt
  schema, descriptions, tests, compiled SQL, or MetricFlow formulas;
- DataLex/modeling migrations are idempotent and explicitly report loss;
- CLI-backed browser scenarios and accessibility checks pass;
- scale/security budgets pass with saved evidence;
- generated `.dql`, connector, SQLite, Playwright, and runtime artifacts are not
  staged;
- the shared Cloud theme/token/persistence contract passes unchanged; and
- incomplete DQL 2.0 work never lands on `main`.
