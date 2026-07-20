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

1. Applying a valid dbt project automatically starts one shared project-index
   preparation job, exposes truthful progress/timings in Settings and Guided
   Setup, produces ignored metadata/KG caches, and leaves the first governed Ask
   with no duplicate cold rebuild.
2. The built `dql notebook` exposes one Govern → Settings destination with
   Overview, Project & dbt, Database, AI provider, Agent memory, and Advanced;
   Guided Setup launches from Overview and has no separate rail item.
3. Settings and Guided Setup render the same dbt, profile/database, and provider
   capabilities, reload the same project-local values, and report Missing,
   Configured, Test passed, and Test failed without calling untested values ready.
4. OpenAI and Anthropic enterprise URLs and unsaved keys/models traverse the
   governed runtime adapters. Native Gemini enterprise routing, Ollama,
   subscriptions, and custom OpenAI-compatible requirements remain selectable.
5. Blank provider keys retain saved secrets; APIs never return raw secrets; a
   failing dbt apply, connection test, or provider test preserves the prior
   working configuration. Relative DuckDB and enterprise Snowflake/Databricks
   profile behavior from `E2E-003` remains unchanged.
6. AI can be skipped with limited-AI guidance and without blocking deterministic
   or non-AI paths. Browser verification has no console errors and the Cloud
   embed theme/token/persistence contract remains unchanged.
7. A clean published-package smoke proves project-local installation exposes
   `npx dql`, global installation exposes bare `dql`, both report the requested
   version, and connector installation resolves npm beside the running Node
   executable even when an interactive-shell PATH is unavailable.
8. A clean project opens Guided Setup before the product on first launch. After
   acknowledgement it stays closed for the same CLI version, then reopens once
   when the installed version changes. The project-local acknowledgement keeps
   existing favorites, recent items, dbt/database/provider settings, and secrets
   unchanged.

## Retrieval-first evidence fixture

The deterministic retrieval fixture contains 7,000 semantic metrics, including
targets at positions 24, 60, 200, 500, 6,789, and 6,999; duplicate display names
across domains and packages; 10,000 dbt models; and 300,000 described columns.
Its rollover family deliberately separates:

- actual ending `rollover_balance_amount`;
- new `monthly_rollover_amount` flow;
- forecast `rollover_risk_amount`;
- contractual `rollover_allowance`; and
- a certified `customer_rollover_report` block whose compatibility varies by
  entity, time grain, filter, and output contract.

Required retrieval/meaning scenarios (`E2E-006`):

1. `What is monthly rollover balance amount?` retrieves the late-position actual
   balance definition and never routes to general knowledge.
2. `Who are the top customers by monthly rollover balance amount?` resolves
   actual balance, customer, month, descending order, and limit; it rejects risk,
   allowance, and new-flow metrics with explicit reasons.
3. `What amount was newly rolled over this month?` selects the flow metric,
   while `Which customers have the highest rollover risk?` selects the forecast
   risk metric despite overlapping tokens.
4. A related but output-incompatible certified block does not defeat the correct
   semantic metric. A meaning-compatible certified block wins only when its
   complete contract covers the request.
5. Identical names with materially different formulas/domains produce one
   focused clarification unless active domain/notebook/conversation context
   resolves them unambiguously.
6. An explicit qualified metric/block reference bypasses AI resolution. A model
   response containing an ID absent from the server evidence package is rejected
   before compilation or execution.
7. If only safe table/column evidence exists, one bounded generation may use the
   selected objects and typed relationship proof. Missing relationship/schema
   evidence returns a modeling gap and never invites invented SQL.
8. Equivalent browser, direct CLI, MCP, and Chat requests over one snapshot have
   identical interpreted meaning, selected qualified IDs, route, trust label,
   stable error, and call budget.
9. Cancellation at retrieval, resolver, generation, SQL, or research stops the
   inherited run. Authentication, authorization, policy, connector, timeout, and
   modeling errors retain their original codes and never become research or a
   generic clarification.
10. Evidence cards and redacted traces contain no provider/connector secrets,
    source-repair leakage, unauthorized metadata, or plaintext sampled values.

## Notebook semantic composition fixture

Required semantic-notebook scenarios (`E2E-008`):

1. A modern array-shaped `semantic_manifest.json` resolves object measure
   references, `node_relation`, and compiled `where_filters` without losing the
   dbt relation or predicate.
2. Safe simple metrics report native readiness when full semantic runtimes are unavailable;
   derived, ratio, cumulative, conversion, median/non-additive metrics remain
   discoverable but report that dbt Cloud Semantic Layer or local MetricFlow
   setup is required.
3. The built notebook searches metrics, selects multiple metrics, exposes only
   common governed dimensions, and reports incompatibility before insertion.
4. Preview executes through the canonical semantic endpoint and shows compiled
   SQL plus bounded row count. Provider/runtime and compatibility failures keep
   their stable codes and actionable messages.
5. Add to notebook creates a semantic DQL cell containing metric/dimension
   identities; it never degrades the selection into anonymous raw SQL.
6. The same unsaved member selection compiles through a tested regional dbt
   Cloud endpoint in Preview, Notebook execution, Block Studio, and Ask; service
   tokens are redacted and a failed candidate preserves the last tested config.
7. At least 3,000 warehouse tables are considered for logical-to-physical
   semantic relation mapping; no fixed prefix cutoff may hide a valid model.
8. Settings and Guided Setup offer the same explicit local MetricFlow install
   action after dbt connection. The install stays under `.dql/runtimes`, never
   uses sudo or system Python, reports bounded progress/redacted errors, becomes
   active without a server restart, and a disabled metric links to that setup.
9. Two joined semantic models may both declare `report_date`; compatibility and
   composition bind the selected metric's model and emit a qualified column.
10. Valid warehouse-specific generated SQL (including Snowflake `QUALIFY`) passes
   every validation gate with the active dialect, while malformed SQL is never
   executed and raw parser traces remain in Inspect rather than chat.

## Structured clarification and grounding fixture

Required Ask scenarios (`E2E-009`):

1. Two similarly named semantic metrics produce governed choice cards containing
   stable IDs, labels, definitions, and kinds; raw IDs are not required user text.
2. Selecting a choice sends its ID, restores the original analytical question,
   bypasses a second meaning-model call, and keeps clean artifact naming.
3. The selected semantic object's backing table and available dbt/runtime columns
   enter the inspected SQL context before preview validation and execution.
4. Unknown/stale IDs, out-of-context relations, compiler failures, and SQL guard
   failures do not leave an Add-to-app action or successful-check presentation.
5. A request deadline terminates once with a timeout state; it is not relabeled as
   a provider outage and does not start Research automatically.

The canonical case design is tracked in
[`fixtures/retrieval-first-evidence.agent-evals.yml`](fixtures/retrieval-first-evidence.agent-evals.yml).
The executable harness must report retrieval recall, meaning-selection accuracy,
clarification precision/recall, route/trust accuracy, invented-ID rejection,
surface parity, provider/tool/SQL/repair counts, evidence tokens, latency, and
source-artifact reads. Release thresholds are 1.0 for the named high-trust cases,
zero invented-ID executions, zero wrong certified answers, and zero surface
parity drift.

## Typed member-binding continuation fixture

Required Ask scenarios (`E2E-010`):

1. A prior product-by-region result contains multiple real product and region
   members, including a product outside the UI's displayed row sample; the next
   question explicitly names that product in ordinary English.
2. Conversation resolution emits one exact typed product binding before
   retrieval. The analytical plan, fit gate, prompt, SQL guard, and execution
   preserve the same canonical value and source-turn ID (`AGT-012`).
3. A broad certified customer profile is rejected because it exposes neither a
   product dimension nor a product filter, even when its customer terms rank
   highly. A product/customer block may terminate only when its contract proves
   the bound product can be applied.
4. When no direct certified or semantic route covers the customer/product join,
   the generated lane receives the selected relations, relationship evidence,
   and binding in one bounded call. Returned rows all satisfy the product filter;
   provider/repair counts remain within the request budget.
   If that generated SQL omits the filter but the canonical product member maps
   to exactly one inspected product column on the query path, the runtime injects
   the predicate without another provider call. Ambiguous or wrong-column
   bindings still fail closed.
5. A top-product-by-region answer cannot execute when either product or region is
   omitted from the SQL projection. One validation correction receives the full
   requested shape, while metadata re-grounding and execution repair retain
   their own bounded attempts.

## Parameterized Ask result fixture

Required cross-surface scenarios (`E2E-011`):

1. A user question containing one uniquely resolved product member executes a
   compatible certified block through its declared string parameter without an
   AI SQL-generation call.
2. A follow-up carries the same canonical member with `prior_result` provenance;
   the block fit gate, invocation audit, result payload, and DQL artifact retain
   that value and source.
3. Browser Ask displays the applied input and the shared editable DQL controls.
   Apply reruns the saved artifact directly and preserves its certified identity.
4. Native tools, CLI, and MCP accept the same question/parameter contract and
   return equivalent resolved values and redacted audit identity.
5. Ambiguous members, unmapped parameters, structural SQL input, and unresolved
   required values fail closed before certified execution.

## Scale fixture

Generate deterministic artifacts representing 10,000 dbt models, 30 columns
per model, 7,000 semantic metrics, 100 domains, 1,000 entities, 2,000
relationships, 1,000 skills, 2,000 blocks/views, and 500 Apps/Notebooks.

Budgets on the documented reference developer machine:

| Operation | Budget |
| --------- | ------ |
| cold compile | `< 5s`, `< 1GB` peak RSS |
| cold index/snapshot | `< 30s`, `< 1.5GB` peak RSS |
| warm context build | p95 `< 500ms`, zero dbt artifact reads |
| exact/qualified retrieval | p95 `< 100ms` |
| evidence package assembly | p95 `< 250ms` after retrieval; `8–12` cards; `<= 12,000` tokens |
| natural-language meaning resolution | `<= 1` call; `<= 15s`; `<= 600` output tokens |
| direct certified/semantic dispatch | `< 1s` excluding warehouse; no planner/tool-loop/synthesis |
| generated lookup | `<= 1` meaning + `<= 1` generation + `<= 1` repair |
| standard analytical run | `< 45s` excluding separately reported warehouse delay |
| explicit research run | `< 120s`; `<= 1` planner and `<= 1` narrator |
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
  corrections, limited-context Ask, similar-name meaning, trust-versus-relevance,
  identifier binding, call budgets, and surface parity;
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
