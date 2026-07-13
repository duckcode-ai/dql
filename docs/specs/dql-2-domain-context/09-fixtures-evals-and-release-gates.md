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
