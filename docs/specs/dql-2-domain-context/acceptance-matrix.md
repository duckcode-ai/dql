# Acceptance matrix

Status vocabulary: `specified`, `implemented`, `verified`, `blocked`,
`superseded`. Implementers may set only `implemented`; a separate verifier or
integrator sets `verified`.

| ID | Acceptance statement | Primary spec | Workstream | Status | Evidence |
| -- | -------------------- | ------------ | ---------- | ------ | -------- |
| SPEC-001 | Code, tests, and docs trace to this tracked pack. | README | W08 | specified | — |
| SPEC-002 | Each workstream has independent commit-scoped verification. | handoff | W08 | specified | — |
| CFG-001 | New dbt init produces v3/dbt-first without copying dbt facts. | 03 | W03 | specified | — |
| CFG-002 | Existing projects are never silently upgraded. | 03, 08 | W06 | specified | — |
| CFG-003 | Configured local/Git dbt paths drive profile discovery, runtime connection fallback, artifacts, snapshots, and Domain Studio without overwriting existing DQL connections. | 03, 07 | W02/W03 | implemented | `apps/cli/src/local-runtime.ts`, `apps/cli/src/local-runtime.test.ts`, `apps/dql-notebook/src/components/modals/SetupOnboarding.tsx` |
| ID-001 | Same local IDs in different domains compile and retrieve without collision. | 02 | W01 | specified | — |
| DOM-001 | Domain source contains only sparse analytical assertions. | 02, 04 | W01 | specified | — |
| DOM-002 | Parent/child domain relation grants no implicit join/import. | 02, 04 | W01 | specified | — |
| DOM-003 | Multiple focused Areas compile deterministically into one domain graph without creating a second model type. | 02, 04 | W01 | implemented | `packages/dql-core/src/manifest/dbt-first-modeling.ts`, `packages/dql-core/src/manifest/dbt-first-authoring.ts` |
| PRD-001 | Apps, Ask, and Notebooks remain global surfaces. | 01, 05 | W05 | specified | — |
| PRD-002 | Domain Related Products derives backlinks without duplicated product files. | 05, 07 | W05 | specified | — |
| PRD-003 | Apps/Notebooks round-trip exact `ProductDomainContext`. | 02 | W01/W05 | specified | — |
| PRD-004 | App requirements are covered by fully compatible certified blocks first, governed semantic queries only for uncovered requirements, and typed visible gaps otherwise. | 01, 06 | W04/W05 | implemented | `packages/dql-agent/src/app-builder.ts`, `packages/dql-agent/src/app-builder.test.ts` |
| REL-001 | dbt DAG/shared names alone never authorize a generated join. | 04, 06 | W04 | specified | — |
| REL-002 | Missing keys, changed validation, expired evidence, stale proof, unsafe fanout, or missing export revokes auto-join. | 04, 06 | W04 | specified | — |
| CONTRACT-001 | Cross-domain route requires matching certified relationship, export/import, purpose, and contract. | 04 | W04 | specified | — |
| SKILL-001 | Domain and global skills are both indexed with correct precedence. | 04, 06 | W04 | specified | — |
| SKILL-002 | Exclusions veto/lower retrieval and never add positive tokens. | 04, 06 | W04 | specified | — |
| CTX-001 | UI/API/CLI/MCP resolve the same envelope for equivalent requests. | 06, 07 | W04 | specified | — |
| CTX-002 | Snapshot change cannot mix retrieval/tool/guard records in one answer. | 06, 07 | W02/W04 | specified | — |
| CTX-003 | Multi-turn Ask merges typed analytical intent; prior prose, SQL, DQL source, paths, and provider metadata cannot become dimensions or filters. | 06 | W04 | implemented | — |
| CTX-004 | Area identity is domain-qualified and explicit/inferred Area focus narrows modeling and Skill retrieval inside the active domain. | 02, 06 | W01/W04 | implemented | `packages/dql-agent/src/domain-context.ts`, `packages/dql-agent/src/kg/build.ts`, `packages/dql-agent/src/metadata/catalog.ts` |
| AGT-001 | Route order is compatible block, compatible MetricFlow, governed SQL, bounded exploratory DBT-grounded SQL when safe, then clarify/refuse. | 06 | W04 | specified | — |
| AGT-002 | AI discoveries are cited drafts and cannot certify. | 03, 04 | W03 | specified | — |
| AGT-003 | No-domain Ask checks global blocks and semantic models first, may use bounded DBT-grounded exploration when safe, and refuses unsafe generation. | 01, 06 | W04/W05 | specified | — |
| AGT-004 | Candidate entity scope follows the question; unrelated retrieved cross-domain policy failures retain their exact code and do not trigger retries or a misleading clarification. | 06 | W04 | specified | — |
| AGT-005 | Question planning grounds measures, dimensions, categorical values, filters, ranking, and grain before routing across certified, MetricFlow, domain, and dbt candidate classes. | 06 | W04 | implemented | — |
| AGT-006 | Certified assets terminate only when their contract covers every requested measure, output, dimension, grain, filter/value, ranking direction, and parameter. | 06 | W04 | implemented | — |
| AGT-007 | App Build and Unified Analysis use separate orchestrators over the same immutable context and trust contracts. | 01, 06, 07 | W04/W05 | implemented | `packages/dql-agent/src/app-builder.ts`, `apps/cli/src/local-runtime.ts` |
| AGT-008 | Business Story claims are grounded in server-computed multi-tile facts and reject invented values, unproved comparisons/causality, and incompatible grain/filter evidence. | 06, 07 | W04/W05 | implemented | `packages/dql-agent/src/dashboard-story.ts`, `packages/dql-agent/src/dashboard-story.test.ts` |
| EXP-001 | Exploratory DBT-grounded SQL is read-only, bounded, single-domain, provenance-recorded, review-required, and never treated as governed relationship proof. | 06 | W04 | specified | — |
| EXP-002 | Exploratory answers offer only explicit provenance-backed draft creation; they never auto-write, promote, or certify blocks or modeling. | 03, 06 | W03/W04 | specified | — |
| EXP-003 | Successful exploratory recovery persists its executed outcome, typed result contract, context/snapshot reference, provenance, bounds, and review-required trust state instead of an earlier refusal. | 06, 07 | W04 | implemented | — |
| API-001 | Stable APIs return request/snapshot IDs, codes, bounds, and conflict guards. | 03, 07 | W02/W03 | specified | — |
| API-002 | Proposal is write-free; commit is snapshot/hash guarded and atomic; run/story responses use server-owned run evidence and stable snapshot/filter/result/persona fingerprints. | 07 | W02/W05 | implemented | `apps/cli/src/apps-api.ts`, `apps/cli/src/apps-api.test.ts`, `apps/cli/src/local-runtime.ts` |
| UI-001 | Global rail/context sidebar/deep links and canvas UX pass CLI-backed browser tests. | 05 | W05 | specified | — |
| UI-002 | dbt edits use previewed source patches; DQL edits touch package source only. | 04, 05 | W05 | specified | — |
| UI-003 | Materially long Ask/Research turns explain active governed work and accurately guide users toward modeling, semantic metrics, and reviewed block certification for faster repeat questions. | 05 | W05 | implemented | — |
| UI-004 | Generated Apps show an apply/reset filter row, live Business Story row, KPI band, analyses, details, and reviewer appendix in that order. | 01, 05 | W05 | implemented | `apps/dql-notebook/src/components/apps/AppsView.tsx`, `apps/dql-notebook/src/components/apps/DashboardRenderer.tsx` |
| UI-005 | App Copilot receives canonical App run context, supports close/expand consistently, and performs no silent App mutation. | 05, 07 | W05 | implemented | `apps/dql-notebook/src/components/apps/DashboardRenderer.tsx`, `apps/cli/src/apps-api.ts` |
| UI-006 | Domain Studio hierarchy, Area-aware Skills, Ask scope, and URL deep links round-trip in the built CLI. | 05 | W05 | implemented | `apps/dql-notebook/src/components/modeling/DbtFirstModelingPage.tsx`, `apps/dql-notebook/src/components/skills/SkillsPage.tsx`, `apps/dql-notebook/src/components/home/AnalyticsHome.tsx` |
| MIG-001 | v2 and legacy product/modeling layouts remain readable through 3.x. | 08 | W06 | specified | — |
| MIG-002 | Migration is deterministic/idempotent, loss-reporting, lifecycle-preserving. | 08 | W06 | specified | — |
| PERF-001 | Reference scale fixture meets every recorded budget. | 07, 09 | W02/W07 | specified | — |
| SEC-001 | Non-loopback without auth/allowed origins fails closed. | 08 | W06 | specified | — |
| SEC-002 | App clients cannot inject trusted snapshot, source, result, lineage, fact, or claim evidence. | 07, 08 | W05/W06 | implemented | `apps/cli/src/apps-api.ts`, `apps/cli/src/local-runtime.ts` |
| E2E-001 | Functional fixture, agent eval, browser, security, migration, performance, and embed gates pass. | 09 | W07/W08 | specified | — |
| E2E-002 | Built CLI browser coverage proves certified-first planning, semantic fallback, atomic commit, filter-consistent stories, stale response rejection, and deterministic story fallback. | 09 | W07/W08 | implemented | `apps/cli/src/apps-api.test.ts`, `packages/dql-agent/src/dashboard-story.test.ts`, built CLI at `127.0.0.1:3474` |
| E2E-003 | Built CLI coverage proves colocated/external dbt paths, profile filename compatibility, saved-connection preservation, profile-backed runtime use, and manifest-v3 Domain Studio availability. | 03, 09 | W07/W08 | implemented | `apps/cli/src/local-runtime.test.ts`, `apps/dql-notebook/src/components/modeling/DbtFirstModelingPage.tsx`, built CLI at `127.0.0.1:3474` |
| E2E-004 | Built CLI coverage proves duplicate Area IDs across domains, explicit/inferred focus, Area-scoped Skills, hierarchy/deep-link round trips, and bounded retrieval. | 05, 06, 09 | W07/W08 | implemented | focused Core/Agent/UI tests plus built CLI browser evidence |

## Evidence format

Replace `—` only with a link/path containing workstream, commit SHA, verifier,
commands, fixture, date, and result. Raw generated logs/screenshots belong under
ignored `output/dql2-domain-context/<workstream>/<commit>/`; the matrix records
a durable summary and paths, not binary artifacts.
