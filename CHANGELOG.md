# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## v1.7.0 - 2026-06-27

### Governed agentic analytics: AI-drafts/human-certify onboarding, enforced trust, and data freshness

This release makes DQL a governed agentic-analytics layer end to end: AI proposes
draft analytics from your dbt evidence, humans certify, and the agent answers
certified-first with honest trust labels — never presenting generated or stale
results as certified. Everything here is OSS and local-first.

### Added

- **`dql propose` — AI drafts, humans certify.** Scans your dbt evidence
  (`manifest.json`, `catalog.json`, semantic metrics) and generates a value-ranked
  queue of **draft** blocks with inferred grain, pattern, outputs, and `llmContext`.
  Every proposal is run through the certifier and stored as `draft` — nothing is
  ever auto-certified.
- **Get Started onboarding flow** in the notebook — a readiness scan that surfaces
  the ranked draft proposals with trust badges and a per-draft "what's missing to
  certify" summary, routing each into the existing Review & Certify queue.
- **`dql eval` — routing-accuracy harness.** Replays each block's `examples` (plus
  optional `eval/*.yaml`) through the agent router and scores route, block
  selection, and grain match across the certified / generated / insufficient-context
  / conflict / wrong-grain cases. CI-gateable.
- **Canonical trust-label vocabulary** — `Certified`, `Reviewed`, `AI-Generated`,
  `Insufficient-Context`, and `Conflict`, modeled as a base label plus optional
  qualifier and consumed consistently across the MCP server, agent, and UI.
- **Definition-conflict detection** — two certified terms or blocks that claim the
  same concept/grain but disagree are flagged at compile time and routed as a
  `conflict` (the agent surfaces both definitions and asks, instead of guessing).
- **Runtime invariant enforcement** — a block's declared `invariants` now execute
  against results at run and certification time. A violation blocks certification
  and downgrades the label to "Certified · invariant violated".
- **Grain / contract gate** — the agent refuses to serve a near-miss certified block
  whose grain doesn't match the question, demoting to a labeled generated query
  instead of a confidently-wrong governed answer.
- **Show-your-work** — a consumer-facing derivation walk (value → block →
  metric/term → dbt model → owner / review cadence / freshness), with depth hidden
  by default.
- **Freshness-aware trust** — folds dbt `run_results.json` and source freshness into
  a block's effective trust: a certified block over a failed or stale upstream shows
  "Certified · upstream failed" / "Certified · stale data".
- **Output-contract drift detection** — a new additive `outputContract` field;
  `dql compile`/`dql doctor` **warn** (never block) when a block `ref()`s a child
  column that no longer exists, keeping freeform composition safe.
- **Impact & re-cert gate** — `dql diff --impact` reports a changed block's full
  transitive downstream, the affected cross-domain edges, the `domainTrust` delta,
  and the certified artifacts that need re-certification; exits non-zero in CI when
  certified downstream is invalidated.
- **Scoped correction memory** — Git-versioned, approved-only hints (scoped to a
  metric / model / domain / dialect) compiled into the agent knowledge graph, so
  reviewed corrections improve future drafts without weakening certification. Plus a
  pluggable `EmbeddingProvider` (offline default) for hybrid retrieval.

### Fixed

- **`dql propose` is now business-first and selective (was a `SELECT *`-per-model
  dump).** A convention-agnostic classifier (dbt `meta` → exposures → semantic
  manifest → folder/path → tags → name, configurable via a `propose` block in
  `dql.config.json`) splits the warehouse into a business layer and excluded
  plumbing, ranks cheaply across all models but runs inference + the Certifier only
  on a bounded per-domain selection (scales to thousands of models), and generates
  **real aggregation SQL** for semantic-metric models / narrowed projections for
  entity marts — never a passthrough per model. Get Started now shows a deterministic
  **plan** (domains, "will generate N / skip M", per-candidate evidence) that writes
  nothing until you **Approve & Generate** the scope you pick. On jaffle: 13 scanned →
  7 business, 6 staging excluded, 19 metrics detected.
- **Optional AI enrichment for proposed drafts (content only).** When "Approve &
  Generate" runs with an AI provider configured (`propose.aiEnrichment`), each
  drafted block's `llmContext` and example questions are written by the model, and a
  `description` is generated for models dbt left undescribed — a real human-authored
  dbt `description` always wins. Structure (classification, grain, outputs, SQL,
  invariants) stays fully deterministic; enrichment is best-effort with a timeout and
  falls back to dbt-derived content offline, so nothing requires a provider.
- **`dql propose --enrich`** brings the same AI enrichment to the CLI (off by default
  so CLI runs stay deterministic/CI-reproducible).
- **`dql init` auto-wires the DuckDB connection from the dbt project dir.** When the
  `.duckdb` lives next to `dbt_project.yml` a level up from the DQL workspace (the
  common layout), init now finds it and writes a workspace-relative connection
  (e.g. `../warehouse.duckdb`) instead of reporting "DuckDB file: none".
- **Clearer error when a query hits a missing table.** A DuckDB "table does not
  exist" / catalog error now appends a hint that the database may be empty or the
  connection may point at the wrong `.duckdb` file (run `dbt build` to populate it).
- **The Review & Certify queue lists draft blocks (was always empty).** It read only
  `apps/*.dql-app` apps, so the standalone draft blocks `dql propose` writes never
  appeared ("No Apps or drafts are waiting for review"). It now lists every draft /
  in-review governance block with its status, and each row opens that block in Block
  Studio to preview, edit, run tests, and certify. Nothing certifies automatically.
- **`dql agent ask` starts its own runtime.** It no longer assumes a notebook server
  on a hardcoded `127.0.0.1:3474` (which collides with unrelated services — e.g.
  Docker, whose health check returns `{"status":"ok"}` — producing a misleading "no
  database connection" error). With no `--runtime-url`/`DQL_RUNTIME_URL` it now starts
  an ephemeral runtime bound to the project on a free port and closes it on exit; an
  explicit runtime URL is validated as a real DQL runtime before use.
- **Lineage no longer self-references a block that wraps its own dbt model.** A block
  named after the dbt model it `ref()`s (e.g. `block "customers"` →
  `ref('customers')`) used to appear as its own upstream and downstream, distorting
  `dql lineage --impact` and risking false cycles. The dependency now resolves to the
  dbt-model node (`dbt_model:customers → block:customers`).
- **`dql propose` drafts are sharper.** Generated `examples` are now concrete business
  questions ("How many customers are there?", "What is the total <measure> per
  <entity>?") instead of a generic "What does X contain?", and the uncheckable
  `row_count >= 0` invariant is no longer emitted (row-count coverage lives in the
  block's tests; the runtime invariant evaluator only sees result columns).
- **Notebook no longer crashes (OOM) on every query.** The DQL parser could
  infinite-loop on input it didn't recognize — including the raw SQL the cell
  executor feeds it (e.g. `SELECT COUNT(*) …`) — exhausting the heap and killing the
  notebook runtime. The parser now guarantees forward progress and terminates on any
  input; a regression test exercises raw SQL and non-DQL text.
- **Local DuckDB connector works on the latest `duckdb` (1.4.x).** `COUNT(*)`/`SUM`/id
  results come back as `BIGINT`; the driver coerces them to numbers before marshaling
  and `serializeJSON` carries a BigInt replacer, so the full local path is BigInt-safe
  (verified on real data across UUID/BIGINT/decimal/datetime columns). The install spec
  is unpinned (`duckdb@^1.1.0`, latest 1.x) — no version pin needed.
- **dbt-profile DuckDB path now resolves against the dbt project, not the DQL
  workspace.** A relative `path:` in `profiles.yml` (e.g. `jaffle_shop.duckdb`) was
  resolved against the DQL workspace dir, so DuckDB silently opened/created an empty
  database and every query failed "table does not exist". The imported connection now
  resolves to an absolute path under the dbt project dir and warns when the file
  doesn't exist yet.
- **dbt import + freshness on the standard staging + mart layout.** The selective
  dbt import anchored **0 models** when a staging model's role-prefix-stripped alias
  (`stg_customers` → `customers`) collided with a same-named mart, which also
  prevented freshness-aware trust from surfacing. Anchor resolution now prefers exact
  model names; freshness resolution matches schema-qualified block refs
  (`dev.customers`) and treats upstream nodes with no run record (e.g. raw sources)
  as neutral rather than `unknown`.

### Notes

- Certification remains a **local** trust label. Organization-wide approval
  workflows, audit logs, and permission-aware retrieval are part of the commercial
  cloud product, not OSS.

---

## v1.6.17 - 2026-06-18

### Notebook startup patch

### Fixed

- Notebook startup no longer invents a hidden DuckDB-backed `file/:memory:`
  connection when a project has no default connection.
- Fresh projects can open the notebook UI before DuckDB or Snowflake optional
  connector packages are installed.
- Schema/catalog startup endpoints now degrade to project/file metadata when no
  runtime connection is active, while SQL execution returns a clear connection
  setup message.

---

## v1.6.16 - 2026-06-18

### MCP agent readiness for Claude Code and Codex

### Added

- `dql connect` configures Claude Code, Codex, Claude Desktop, Cursor, or all
  supported MCP clients from a DQL project.
- `dql mcp test` verifies manifest loading, metadata catalog freshness, the
  agent index, and the MCP tool surface before users ask an external agent.
- The DQL MCP server now exposes front-door workflow tools:
  `inspect_dql_project`, `ask_dql`, `build_dql_block`, and `build_dql_app`.

### Changed

- Generated Claude Code and Codex setup is project-local and includes
  `CLAUDE.md` / `AGENTS.md` guidance so agents route questions through DQL
  trust rules before writing SQL.
- Starter projects ignore generated local agent config files such as
  `.mcp.json`, `.codex/`, and `.cursor/`.
- MCP documentation and the starter README now show the full Claude/Codex
  testing path.

---

## v1.6.1 - 2026-06-10

### OSS release: clean foundation, external example, UI polish

### Changed

- **Repo restructured dbt-core style — no bundled example projects.**
  Removed `examples/` and the `acme-bank` / `jaffle-shop` templates;
  `create-dql-app` now ships a single `starter` template (the default) that
  auto-wires a detected dbt project. The example dbt project lives in its own
  repo: [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).
- Quickstart and README rewritten around two entry points with identical
  steps: your own dbt repo, or the cloned example repo
  (`create-dql-app` → `dql sync dbt` → `dql notebook`).
- Tutorials condensed from 11 to 5 (getting started, authoring blocks,
  dashboards & Apps, agentic analytics, CI & verify) and re-based on the
  example repo; troubleshooting moved to `docs/guides/troubleshooting.md`.
- Docker starter now scaffolds the minimal starter project instead of the
  removed Acme Bank template.

### Fixed

- `create-dql-app` no longer runs `git init` inside an existing git repo
  (previously nested a repo when scaffolding `./dql` inside a dbt project).
- Results table renders DATE values as `YYYY-MM-DD` instead of raw ISO
  timestamps; timestamps render as `YYYY-MM-DD HH:MM:SS` (exports keep raw
  values).
- Chart x-axis date labels are formatted in UTC — month boundaries no longer
  shift a day backwards in western timezones; line/area charts gained axis
  titles and date-aware tooltips.
- Notebook cell editor no longer paints a tinted slab behind the code: the
  always-on active-line highlight is now focus-scoped and the editor inherits
  the cell surface.
- Header is view-aware: static titles for Apps/Review/Settings/Source control
  and editor-only actions (Run all, Save, Share) hidden outside editor views.
- Sidebar panel headers wrap instead of overlapping their action buttons;
  Block Studio start cards and dbt-status panels reflow at narrow widths.
- Lineage side panel groups dashboards under "Dashboards" (was "Notebooks");
  row/duration counters use correct pluralization and rounded timings.
- Tutorial sample code used an inline `visualization { ...; ... }` form the
  parser rejects; corrected to the canonical multi-line form.
- `SECURITY.md` supported-versions table updated to 1.6.x/1.5.x.

### Added

- Privacy & telemetry disclosure in the README (off by default, no PII,
  `DO_NOT_TRACK` honored).
- Lineage fixture (`apps/cli/test/fixtures/lineage-app`) preserving
  source → block → dashboard → App compile coverage after the template
  removal.

## v1.6.0 - 2026-05-01

### Graduated trust + contracts

### Added

- **Graduated trust + Tier-2 promotion loop**: agent answers route through
  certified blocks first (Tier 1); LLM proposals are flagged *Uncertified*,
  saved as drafts under `blocks/_drafts/`, and promoted via
  `dql certify --from-draft` (optionally `--open-pr`).
- DataLex contracts end-to-end: certified blocks can cite a contract id;
  `--contract <id@version>` binding on certification.
- Column-level lineage extraction with honest `unresolved` marking.
- MCP server test coverage and tool hardening.
- `datalex-lsp`: schema-aware language server for `.model.yaml` semantic
  definitions.
- OpenLineage event emission for project snapshots.
- mkdocs-material public docs site.
- Community files: issue templates, PR template, support/triage policy.

## v1.5.3 - 2026-04-30

### OSS release candidate polish

### Added

- dbt-first Block Studio guide covering SQL blocks, semantic blocks, SQL import,
  certification, and lineage.
- OSS readiness checklist sections for Block Studio and Apps UX release gates.

### Changed

- Updated README and docs to position DQL as a local-first dbt companion where
  dbt owns models/semantics and DQL owns certified blocks, Apps, notebooks,
  AI pins, and answer-level lineage.
- Updated project layout docs to describe Apps as View/Build surfaces with
  dashboard pages, attached notebooks, AI conversations, pins, and drafts.
- Clarified that Import SQL is a Block Studio wizard, not a separate primary
  navigation area.

### Fixed

- Fixed standalone preview for `single_value` block visualizations by lowering
  them to KPI output.
- Fixed semantic analyzer validation so `@rls` decorators on block declarations
  pass the same way they do in notebook/App execution.

---

## v1.5.1 - 2026-04-29

### OSS app workspace structure and dbt repo onboarding

This patch publishes the OSS single-user App workspace flow on top of the
1.5.0 agentic Apps release.

### Changed

- Clarified OSS product language around local Apps, policies, personas, and
  commercial boundaries.
- Updated docs for the recommended isolated `./dql` folder inside existing dbt
  repositories.
- Added clean dbt-style init/compile/sync readiness coverage and release
  checklist updates.
- Bumped starter templates to use `@duckcodeailabs/dql-cli@^1.5.1`.

---

## v1.5.0 - 2026-04-27

### Agentic analytics evidence, app builder, and local-first AI setup

This release turns the first DQL agent surface into a governed analytics
workflow: certified assets first, semantic/dbt fallback second, and generated
answers clearly labeled for analyst review. It also makes Apps a stronger
stakeholder surface with editable layouts, local AI pins, scoped lineage, and
provider setup in Settings.

### Added

- Governed answer envelopes with source tier, certification state, SQL/result
  metadata, citations, confidence, review state, and evidence tabs.
- Evidence view for agent answers: Answer, Chart, Data, Lineage, Business
  Context, SQL / Block, and Review.
- Certified-first agent routing across certified blocks/dashboards/apps,
  semantic/dbt metadata, and manifest-backed SQL fallback.
- Local agent memory storage and Settings UI for scoped project/user/artifact
  memory.
- Provider setup cards for OpenAI, Gemini, Ollama, and custom OpenAI-compatible
  endpoints, with local Settings-backed provider selection.
- App Builder edit mode with Add tab, Add tile, text/summary tiles, section
  headings, domain-scoped certified block catalog, drag handles, size presets,
  and auto-packed layout movement.
- Local AI pins for Apps with refresh cadence, citations, review status, and
  promote-to-draft-block path.
- Add-to-App choices for AI answers: Chart + data, Chart only, or Data table.
- Scoped App lineage from Domain -> App -> Dashboard -> Tile -> Block ->
  semantic/dbt/source nodes.
- dbt semantic manifest and semantic YAML ingestion improvements.

### Changed

- Dashboard/App chat now uses the provider configured in Settings instead of
  asking users to pick a provider in every chat surface.
- App chat is a sticky, viewport-bounded side drawer with expand/collapse and
  close controls so the input remains visible.
- Chat answer cards are compact by default in App/Dashboard mode and keep route
  details out of the primary answer tab.
- Certified block answers can execute and return result data when the runtime
  host provides governed execution.

### Fixed

- Ollama/provider configuration persistence and default provider resolution.
- `@block("...")` execution path for block-backed notebook usage.
- Duplicate Add menus in empty App tabs.
- App dashboard AI pins previously added only chart views even when result rows
  were available.
- Lineage labels and notebook/dashboard node typing in scoped lineage views.

---

## v1.4.0 — 2026-04-25

### Apps, Agentic Analytics, programmable end-to-end DQL

A major scope expansion landing the consumption layer (Apps + first-class
dashboards), an OSS block-first agent (knowledge graph + Skills + multi-provider),
a Slack front-end, and CI-grade reproducibility. Identity stays single-user
in OSS; RBAC declarations are programmable and enforced via persona switching.

See `docs/tutorials/` for hands-on walkthroughs (Acme Bank scenario).

### Added

- **Apps** — first-class consumption-layer artifact at `apps/<id>/dql.app.json`.
  Members + roles + access policies + RLS bindings + schedules + homepage,
  validated by [`packages/dql-core/src/apps/app-document.ts`](packages/dql-core/src/apps/app-document.ts).
- **Dashboards (`.dqld`)** — first-class grid-layout artifact distinct from
  notebook-as-dashboard, validated by [`packages/dql-core/src/apps/dashboard-document.ts`](packages/dql-core/src/apps/dashboard-document.ts).
  Block refs by id or path; viz config per tile; params + filters.
- **Persona registry** — runtime active-user state in
  [`packages/dql-project/src/persona.ts`](packages/dql-project/src/persona.ts).
  Drives the existing PolicyEngine + a new
  [`personaVariables()`](packages/dql-project/src/persona-variables.ts) helper
  that supplies template values to `executor.executeQuery`'s `variables` map,
  so `@rls("col", "{user.var}")` decorators resolve at execution time.
- **Manifest extensions** — `apps[]`, `dashboards[]`, `ManifestApp`,
  `ManifestDashboard` in [`packages/dql-core/src/manifest/types.ts`](packages/dql-core/src/manifest/types.ts).
  Builder cross-checks homepage + schedule references and surfaces unresolved
  block refs as diagnostics.
- **Lineage** — populates the previously-reserved `app` node type and
  `dashboard → app` `contains` edges, completing the chain
  `Domain → App → Dashboard → Block → metric/dimension → dbt_model → source`.
- **SQLite registries** — `app_registry` + `dashboard_registry` tables in
  [`packages/dql-project/src/sqlite-storage.ts`](packages/dql-project/src/sqlite-storage.ts)
  for fast queries from the API layer (file format remains source of truth).
- **CLI: `dql app new|ls|show|build|reindex`** — see
  [`apps/cli/src/commands/app.ts`](apps/cli/src/commands/app.ts).
- **API endpoints** — `GET/POST /api/apps`, `/api/apps/:id`,
  `/api/apps/:id/dashboards/:did`, `/api/persona` in
  [`apps/cli/src/apps-api.ts`](apps/cli/src/apps-api.ts).
- **Desktop UI** — new `mainView: 'apps'` with
  [`AppsView`](apps/dql-notebook/src/components/apps/AppsView.tsx),
  [`PersonaSwitcher`](apps/dql-notebook/src/components/apps/PersonaSwitcher.tsx),
  and [`DashboardRenderer`](apps/dql-notebook/src/components/apps/DashboardRenderer.tsx)
  wired into `AppShell` + the activity bar.
- **`@duckcodeailabs/dql-agent`** — new package with:
  - SQLite + FTS5 knowledge graph at `.dql/cache/agent-kg.sqlite`,
    built from manifest + Skills.
  - Skills loader for `.dql/skills/*.skill.md` (YAML frontmatter +
    markdown body).
  - Block-first answer loop: certified blocks first, otherwise LLM-proposed
    SQL marked Uncertified and routed through analyst review.
  - Provider abstractions for Claude, OpenAI / OpenAI-compatible, Gemini,
    and local Ollama, with automatic `pickProvider()` fallback.
  - `getPromotionCandidates()` — surface uncertified answers ready for
    certification.
- **MCP tools** — `kg_search` and `feedback_record` join the existing 8
  tools (`search_blocks`, `get_block`, `query_via_block`, `list_metrics`,
  `list_dimensions`, `lineage_impact`, `certify`, `suggest_block`) in
  [`packages/dql-mcp/src/tools/kg.ts`](packages/dql-mcp/src/tools/kg.ts).
- **CLI: `dql agent ask|reindex|feedback`** — block-first answer loop on the
  command line, see [`apps/cli/src/commands/agent.ts`](apps/cli/src/commands/agent.ts).
- **`@duckcodeailabs/dql-slack`** — new package with a slash-command bot,
  Slack signature verification, Block-Kit reply formatting, and feedback
  buttons.
- **CLI: `dql slack serve`** — boots the bot.
- **CLI: `dql verify`** — proves `dql-manifest.json` is reproducible from
  source. Non-zero on drift; structured diagnostic; CI-ready.
- **Tutorials** — full Acme Bank walkthrough at `docs/tutorials/` covering
  setup, authoring, Apps + RBAC + personas, dashboards, schedules + Slack,
  agentic analytics, end-to-end fraud spike, promoting AI to certified,
  CI + verify, troubleshooting.
- **Tests** — 31 new tests across the new code (12 app-document, 6 dashboard-
  document, 6 persona, 3 manifest scan, 21 dql-agent, 8 dql-slack). All 489
  workspace tests green.

### Changed

- `dql app new` now scaffolds the new programmable schema (`dql.app.json`
  with members/roles/policies/RLS bindings/schedules) instead of the
  earlier `app.yml`-based prototype.
- `dql-mcp` now depends on `dql-agent` for the KG-backed tools.
- `ROADMAP.md` updated — multi-user identity / hosted SSO remains closed
  product; agent + apps + RBAC declarations are now OSS.

### Out of scope (still closed product)

- Real authentication (login screens, OIDC, password storage)
- Hosted cloud / multi-tenant deployment
- Approval workflows or run history as a managed service

---

## v1.0.3 — 2026-04-21

### v0.11 — Block-First Notebook (Tracks 1–6)

Collapses three authoring paths (notebook SQL, notebook DQL, Block Studio) into one mental model: **every notebook cell is a draft block; blocks are live-referenced with `bound` / `forked` state; promotion is certification-gated**.

### Added
- **Unified `@metric()` / `@dim()` resolver** — notebook SQL cells now resolve semantic refs the same way Block Studio does. `SELECT @metric(revenue) FROM @dim(date)` runs against the warehouse instead of throwing.
- **Block Picker as primary palette tile** — `Block` is the left-most tile in the Add-Cell palette; picking a block drops a **bound cell** (live reference, not `@include` SQL).
- **Semantic-aware cell pickers** — Chart / Pivot / SingleValue / Filter pickers read `QueryResult.semanticRefs` and show typed icons (`# metric`, `∴ dimension`, `abc column`); falls back to inference with a "no semantic binding" nag strip.
- **Save-as-Block governance gate** — `SaveAsBlockModal` runs `BUILTIN_RULES` inline; missing owner / domain / description blocks the save. Git metadata (commit SHA, repo, branch) auto-captured and written to the companion YAML.
- **Bound-cell state model** — `BlockBinding { path, commitSha?, version?, state, originalContent? }` on each cell. Green chrome for `bound`, yellow for `forked` after a local edit. Inline chip with path · 🔒 · Revert (forked only) · Unbind.
- **Bound cells in lineage** — bound cells flow into the lineage graph as `block:<name> → dashboard:<notebook>` edges. Draft SQL cells stay excluded (design preserved).

### Changed
- Palette surface: dropped `Python` / `Map` / `Writeback` "coming soon" tiles and the legacy `DQL block` entry; single row, block-first ordering.
- `SingleValueCell` / `ChartCell` / `PivotCell` / `FilterCell` empty states rewritten to guide the user toward the upstream cell.
- Git metadata moved from `.dql` block body into companion YAML (DQL parser drops unknown tokens; body now only carries parser-known keys).

### Fixed
- Notebook SQL cells containing `@metric()` / `@dim()` previously failed with a raw warehouse error. Resolver is now shared between the notebook path and the Block Studio path.
- `workspace:*` dependency resolution (retained from v0.8.2): release script rewrites to real `^x.y.z` before publish.

---

## v0.8.7 — 2026-04-14

### Added
- **14-driver schema introspection** — all database connectors now implement `listTables()` and `listColumns()` with a 3-tier fallback strategy (information_schema → connector methods → lazy loading)
- **Connection hot-swap** — changing the database connection via the notebook Connection Panel or `PUT /api/connections` re-initializes the executor at runtime without restarting the server
- **Block Studio improvements** — save guard opens NewBlockModal when metadata is missing, save/catalog errors shown as inline banners with retry, sidebar no longer forced closed
- **`dql doctor` notebook asset check** — verifies the notebook SPA assets (`index.html`) are bundled correctly
- **`dql --version` / `-V` flag** — prints the CLI version
- **Driver-aware welcome notebook** — `createWelcomeNotebook()` generates database-specific SQL (`SHOW TABLES` for DuckDB, `information_schema` for Postgres/Snowflake/etc.)
- **Semantic import uses project config** — re-resolve after import uses `dql.config.json` provider, not hardcoded `'dql'`
- **`/api/describe-table` endpoint** — lazy column loading for the schema sidebar and Block Studio
- **Type-colored column badges** — shared color utility for schema browser (blue=string, green=number, pink=boolean, gold=date, purple=json)

### Documentation
- **README rewrite** — three clear install paths (DQL-only, Jaffle Shop, Enterprise), Block Studio section, version 0.8.7
- **Quickstart rewrite** — two-track guide (Path A: DQL-only 2min, Path B: dbt+Jaffle Shop 5min) with Block Studio walkthrough
- **Getting Started rewrite** — fixed stale table references, added Block Studio step-by-step (Step 7), clarified auto-import behavior
- **NEW: Enterprise Getting Started** — 11-step guide for teams with existing dbt repos and production databases (Snowflake, Postgres, BigQuery, etc.)
- **Examples rewrite** — three-path table, Block Studio in learning path, parameterized block examples
- **Semantic Layer Guide** — added Snowflake provider section (Option D) with config and notebook UI import steps
- **Data Sources** — documented Connection Panel hot-swap workflow

---

## v0.8.2 — 2026-03-25

### Fixed
- **`workspace:*` dependency resolution** — published packages on npm previously contained raw `workspace:*` dependency versions, causing `EUNSUPPORTEDPROTOCOL` errors during `npm install -g`. The release script now explicitly resolves workspace dependencies to real `^x.y.z` versions before publishing.

---

## v0.8.1 — 2026-03-25

### Fixed
- **`dql init` detection improvements** — added more DuckDB filename candidates (`database.duckdb`, `analytics.duckdb`, `target/jaffle_shop.duckdb`), improved detection output with clear status for dbt project and DuckDB file discovery
- **`dql init` works on non-empty directories** — removed the "Target directory is not empty" guard so `dql init .` works inside existing dbt projects (e.g., Jaffle Shop)

### Changed
- Init output now shows detection results: dbt project (yes/no), DuckDB file path, and semantic layer provider

---

## v0.8.0 — 2026-03-25

### Added
- **Interactive lineage DAG visualization** — full React Flow + dagre-powered graph in the notebook, with node type filtering, click-to-focus highlighting, minimap, legend, and detail panel (`LineageDAG.tsx`)
- **Lineage fullscreen toggle** — "Open Graph View" button in lineage sidebar panel switches main content area to the DAG canvas
- **Jaffle Shop getting-started flow** — `dql init` auto-detects `dbt_project.yml` and `.duckdb` files, scaffolds config with dbt provider, creates welcome notebook

### Removed
- **Project templates** — removed `templates/` directory, `--template` CLI flag, and all template-based scaffolding. `dql init` now always creates a minimal project structure.
- **Example projects** — removed `examples/` and `my-dql-project/` directories

### Changed
- All documentation updated to use Jaffle Shop dbt project as the canonical getting-started path
- README, quickstart, CLI reference, FAQ, and use cases rewritten to remove template references
- Package versions bumped to 0.8.0 across all 10 packages

---

## v0.7.1 — 2026-03-24

### Added
- **Inline cell lineage** — SQL cells in the notebook now show upstream table dependencies and `@metric()` / `@dim()` tracking inline
- **Client-side ColumnMeta normalization** — backward-compatible normalization of `ColumnMeta[]` to `string[]` at the API boundary

### Fixed
- React crash from inconsistent ColumnMeta format at API boundary
- Added `@codemirror/autocomplete` and `@codemirror/search` dependencies, updated `sql-formatter`

---

## v0.7.0 — 2026-03-24

### Added
- **`dql compile` command** — generates `dql-manifest.json`, a complete project artifact containing all blocks, notebooks, metrics, sources, dependencies, and pre-computed lineage (similar to dbt's `manifest.json`)
- **Manifest system** (`packages/dql-core/src/manifest/`) — `DQLManifest` type with `ManifestBlock`, `ManifestNotebook`, `ManifestMetric`, `ManifestSource`, `ManifestLineage`
- **Recursive directory scanning** — blocks and notebooks in nested subdirectories are now discovered (no longer flat-only)
- **Config-driven semantic layer path** — reads `semanticLayer.path` from `dql.config.json` instead of hardcoding `semantic-layer/`
- **Notebook lineage** — `.dqlnb` notebook SQL/DQL cells are scanned for table and ref() dependencies; DQL cells declaring blocks are added to the lineage graph
- **dbt manifest import** — `dql compile --dbt-manifest path/to/manifest.json` imports dbt models and sources with column-level metadata as upstream nodes
- **Smart node lookup** — `dql lineage <name>` auto-resolves to block, table, metric, or dimension (no type prefix needed)
- **`dql lineage --table <name>`** — show lineage for a specific source table
- **`dql lineage --metric <name>`** — show lineage for a specific metric
- **`dql lineage --impact <name>`** — impact analysis now works on any node type (tables, metrics), not just blocks
- **`dql lineage --no-manifest`** — force live scan, skip reading `dql-manifest.json`
- **DuckDB reader function extraction** — `read_csv_auto()`, `read_parquet()`, `read_json()` calls in SQL are now extracted as source table dependencies
- **Rich lineage summary** — `dql lineage` now shows actual block/table/metric names, ownership, data flow relationships, and a DAG tree visualization

### Changed
- `dql lineage` reads from `dql-manifest.json` when available for faster lookups; falls back to live scanning
- Lineage output shows direct vs transitive upstream/downstream, with `*` marking direct connections
- `dql lineage` data flow tree renders from root source tables through all downstream nodes

---

## v0.6.0 — 2026-03-24

### Added
- **Answer-layer lineage engine** — tracks data flow from source tables through blocks, semantic metrics, business domains, and charts
- **`ref("block_name")` system** — declare explicit block-to-block dependencies in SQL queries, similar to dbt's `ref()`
- **`dql lineage` CLI command** — full lineage analysis with subcommands:
  - `dql lineage` — project summary with node counts, cross-domain flows, domain trust scores
  - `dql lineage <block>` — upstream/downstream for a specific block
  - `dql lineage --domain <name>` — domain-scoped view with data flows in/out
  - `dql lineage --impact <block>` — impact analysis showing affected downstream nodes by domain
  - `dql lineage --trust-chain <from> <to>` — certification status at every hop between two blocks
  - `dql lineage --format json` — export full lineage graph as JSON
- **Cross-domain flow detection** — automatic detection when data crosses business domain boundaries (e.g., data → finance → executive)
- **Trust chain scoring** — certified blocks are trust checkpoints; trust score = certified/total ratio
- **Lineage API endpoints** — `GET /api/lineage`, `/api/lineage/block/:name`, `/api/lineage/domain/:name`, `/api/lineage/impact/:block`, `/api/lineage/trust-chain`
- **Notebook Lineage Panel** — sidebar panel showing blocks, metrics, source tables, domains, and cross-domain flows
- **SQL table extractor** — lightweight regex-based parser for FROM/JOIN/INTO/CTE table extraction
- **Dependency resolver** — topological sort with circular dependency detection
- **DuckDB reader normalization** — `read_csv_auto('./data/revenue.csv')` normalizes to `revenue` in lineage nodes
- **Edge deduplication** — prevents duplicate edges in the lineage graph
- **Comprehensive lineage documentation** — new `docs/lineage.md` with tutorials, CLI reference, and dbt complement strategy
- **Unified package versioning** — all 10 packages now share a single version number (0.6.0)

### Changed
- Updated all documentation to cover lineage, ref(), and cross-domain flows
- README now includes Lineage & Trust Chains section
- ROADMAP updated with lineage as shipped feature

---

## v0.5.2 — 2026-03-23

### Added
- **Snowflake semantic layer provider** — `provider: "snowflake"` in `dql.config.json` now wires a live Snowflake connection into the semantic layer; no manual YAML duplication required
- **Time dimension picker in Compose Query UI** — select a date dimension and granularity (`day` / `week` / `month` / `quarter` / `year`); generates dialect-correct `DATE_TRUNC()` SQL
- **Live test execution in `dql certify`** — `assert` statements in `.dql` blocks now run against real data before governance checks; use `--skip-tests` to bypass for metadata-only validation
- **`defaultConnection` auto-detection** — `dql certify` and `dql test` now read `defaultConnection` from `dql.config.json` without requiring `--connection`
- **Auto-refresh semantic layer via SSE** — editing a YAML file in `semantic-layer/` while the notebook is open now triggers an automatic panel reload (no manual Retry click)
- **New Metric form in notebook sidebar** — create a new metric YAML file from inside the Semantic Panel without leaving the notebook
- **Block Governance Bar** — DQL cells with a `block { ... }` declaration show an inline form for editing `domain`, `owner`, `tags`, and `description` without touching the raw syntax
- **DQL / SQL cell type tooltips** — hover over the cell type badge to see what each cell type does
- **`dql test` deprecation notice** — `dql test` now prints a deprecation warning; use `dql certify --connection` instead (removal planned for v0.6.0)

### Fixed
- Removed non-existent `@import` syntax from authoring-blocks.md and notebook reference panel; replaced with the real `@metric()` / `@dim()` patterns and Compose Query workflow
- Removed dead `BlockImportView` component and all `@import` dead code from the notebook frontend
- `dql certify` no longer reports "✓ certified" when `tests-pass` governance rule would have failed on live data

### Changed
- Semantic layer section in Reference Panel now leads with Compose Query (canonical path) and marks `@metric()` / `@dim()` as advanced
- `dql test` marked `[deprecated]` in help text

---

## v0.5.1 — 2026-03-20

### Fixed
- Resolved `workspace:*` dependency resolution issue for npm publish
- Version bumps across all packages for v0.5.0 release alignment

---

## v0.5.0 — 2026-03-18

### Added
- **Semantic Compose Query** — Semantic Panel now has a Compose Query section: select metrics, dimensions, compose SQL, and insert as a cell with one click
- **"Insert as Cell" button** — composed SQL can be inserted directly as a new SQL cell
- **Notebook semantic panel** — browse metrics, dimensions, and hierarchies from the sidebar; click to insert refs into SQL cells
- **`type = "semantic"` block** — reference a metric by name from a DQL block (`metric = "total_revenue"`)
- **`@metric()` / `@dim()` inline refs** — use semantic metrics and dimensions directly inside SQL cells
- Comprehensive documentation overhaul: authoring-blocks guide, own-repo tutorial, progressive doc index
- Tutorial rewrite for getting-started, data-sources connector reference, notebook semantic panel guide

---

## v0.4.0

### Added
- Semantic layer core: DQL native YAML provider, dbt provider, Cube.js provider
- 14-database SQL dialect abstraction in `composeQuery()`
- `dql certify` command with governance rule evaluation
- `dql fmt` format-on-save for `.dql` files
- DQL Language Support VS Code extension packaging

---

## v0.3.0

### Added
- Multi-cell notebook with param cells, markdown cells, and auto-charting
- DQL block AST: `block { domain, owner, tags, params, query, visualization, tests }`
- `dql parse` semantic analysis
- `dql preview` and `dql build` for static HTML bundles
- `dql serve` for local preview serving

---

## v0.1.0

Initial public DQL release.

- Open-sourced the DQL language core, compiler, runtime, connectors, governance, LSP, and Git-backed project package
- Published the `dql` CLI and the `DQL Language Support` VS Code extension packaging path
- Added starter docs, examples, templates, and GitHub release automation for the OSS repo
