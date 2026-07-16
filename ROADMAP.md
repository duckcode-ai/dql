# DQL Roadmap

DQL OSS is a local-first, single-user analytics-as-code workspace. The near-term
goal is adoption: make it easy for one analyst or analytics engineer to create
certified reusable blocks, package them into Apps, compile a dbt-like manifest,
and inspect lineage from source data to dashboard pages.

For completed changes, see [CHANGELOG.md](./CHANGELOG.md).

## Current State (v1.7.0)

DQL OSS is ready for local-first use cases:

- Author `.dql` blocks with SQL or semantic intent, metadata, chart specs, and
  tests.
- Mark blocks with local trust states: `draft`, `review`, `certified`,
  `deprecated`, or `pending_recertification`.
- Run the notebook locally against DuckDB/file data and supported warehouse
  connectors.
- Use Block Studio to create SQL blocks, semantic blocks, imported SQL drafts,
  and locally certified blocks.
- Compile `dql-manifest.json`, the dbt-like project artifact for blocks,
  notebooks, Apps, dashboards, metrics, dimensions, sources, dbt imports, and
  lineage.
- View answer-layer lineage across source tables, dbt models, semantic metrics,
  DQL blocks, dashboard pages, and Apps.
- Adopt on an existing dbt repo as the primary path, with
  [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb) as
  the example dbt project for users without one.
- Use local agent/MCP/Slack surfaces that prefer certified blocks and label
  fallback generated SQL as uncertified.

## OSS Boundaries

The OSS release is intentionally local and single-user:

- Certification is a local trust label, not an organization-wide approval
  workflow.
- Local personas, access policies, and RLS bindings are preview tools for
  testing consumption experiences, not hosted identity or enterprise RBAC.
- Secrets, auth, SSO, audit logs, multi-tenant hosting, managed approvals, and
  permissions-aware team retrieval are outside OSS.

## Known Limitations

- Block Studio metadata editing still has some regex-backed paths. Canonical
  file parsing, formatting, and compilation use the DQL parser/AST, but richer
  round-trip AST editing is still planned.
- `dql migrate` is scaffold-first. SQL import is active; Tableau and Power BI
  helpers remain planned migration helpers.
- Very large query results are loaded into memory before rendering. Streaming
  and pagination are not yet implemented.
- Snowflake semantic views require a live Snowflake connection at notebook
  startup; offline cache and clearer unavailable-state messaging are planned.
- dbt semantic model discovery reads local project artifacts/files. dbt Cloud
  API integration is not part of the current OSS path.
- The notebook browser happy path needs a hard-gated Playwright suite before the
  project should be called GA.

## Next Priorities

- First-run polish: keep `create-dql-app`, `dql doctor`, Block Studio, compile,
  certify, and lineage flows aligned around the 10-minute dbt-repo path.
- Documentation accuracy: keep every code sample parser-valid and keep release,
  testing, and OSS boundary docs in sync with CI.
- Browser E2E: add a required notebook/Block Studio/lineage happy-path test for
  public GA confidence.
- Better DQL authoring: complete AST round-trip metadata editing and improve LSP
  completions/diagnostics for block metadata, `@metric()`, and `@dim()` refs.
- Lineage depth: continue improving column-level lineage and dbt/OpenLineage
  interop.
- Local scale: add pagination/streaming for large result sets and keep the
  manifest stress gate healthy.

## Not Planned for OSS

- Hosted cloud notebook or multi-tenant deployment
- Real authentication, OIDC, SSO, or password storage
- Managed secrets
- Organization RBAC enforcement
- Centralized audit logs
- Managed approval workflows

Have a feature request or found a bug? Open a GitHub issue or start a
Discussion in the public repo.
