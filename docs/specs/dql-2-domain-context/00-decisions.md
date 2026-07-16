# Locked decisions

The following decisions are normative. Changing one requires an RFC/spec PR and
an acceptance-matrix update.

| ID | Decision |
| -- | -------- |
| SPEC-001 | This Git-tracked pack is the normative implementation source. |
| SPEC-002 | Work ships in dependency-ordered workstreams with independent verification. |
| CFG-001 | New dbt-backed projects default to manifest v3 and `modeling.mode: dbt-first`. |
| CFG-002 | Existing projects migrate explicitly; init/sync never silently upgrade them. |
| CFG-003 | A configured local or Git dbt project path is authoritative for profile discovery, artifact compilation, and Domain Studio; complete default dbt profile targets may supply the runtime connection without overwriting saved DQL connections. |
| ID-001 | Every domain-owned object has a domain-qualified compiled identity. |
| DOM-001 | Domains own semantics and governance, not physical dbt schema. |
| DOM-002 | Domain hierarchy scopes organization/retrieval; it grants no join or access rights. |
| PRD-001 | Apps, Ask, and Notebooks remain global shared product surfaces. |
| PRD-002 | Domain Studio shows Apps/Notebooks as Related Products backlinks. |
| PRD-003 | Global products declare owner/used domains and required exports. |
| PRD-004 | App Builder composes governed dashboards requirement-first: compatible certified blocks first, governed semantic queries only for uncovered requirements, and visible gaps otherwise. |
| REL-001 | dbt lineage and matching column names are never automatic join proof. |
| REL-002 | Only certified, fresh, exported, fanout-safe relationships authorize generated joins. |
| CONTRACT-001 | Cross-domain use requires both certified relationship proof and matching provider export/consumer import. |
| SKILL-001 | Domain skills are governed domain context; global skills are reusable workflow capability. |
| SKILL-002 | Skill exclusions are negative constraints and never positive retrieval tokens. |
| CTX-001 | One server-resolved `DomainContextEnvelope` scopes every governed answer. |
| CTX-002 | One immutable `snapshotId` is used from retrieval through final validation. |
| AGT-001 | Route order is certified block, MetricFlow, governed generation, clarify/refuse. |
| AGT-002 | AI discovery produces evidence-cited drafts only and never auto-certifies. |
| AGT-003 | Ask is available before domain setup only in limited-context, review-required mode. |
| AGT-007 | App planning and analytical answering are separate orchestrators that share one server-resolved snapshot, retrieval contracts, trust vocabulary, and evidence model. |
| AGT-008 | App Business Stories verbalize server-computed facts from the settled dashboard run; unsupported numbers, comparisons, causal claims, grains, or filters are rejected. |
| API-001 | Domain, modeling, onboarding, and context APIs return stable codes and snapshot IDs. |
| API-002 | App proposal is write-free; commit is snapshot/hash guarded and atomic; dashboard run/story APIs bind filters, results, persona, trust, and evidence to stable fingerprints. |
| UI-001 | Domain Studio uses vertical contextual navigation; global product navigation stays stable. |
| UI-002 | dbt-owned metadata is read-only and edited only through previewed source patches. |
| UI-004 | Generated Apps render page navigation, an apply/reset filter row, a live Business Story row, KPI band, analysis tiles, detail evidence, then reviewer appendix. |
| UI-005 | App Copilot uses the canonical App run context and cannot mutate an App without an explicit previewed user action. |
| MIG-001 | Manifest v2 and legacy domain-local product paths remain readable through DQL 3.x. |
| MIG-002 | DataLex/legacy migration is deterministic, idempotent, loss-reporting, and never upgrades lifecycle. |
| PERF-001 | Large projects use indexed snapshots, pagination, batch detail, and bounded graph neighborhoods. |
| SEC-001 | Non-loopback serving requires authentication; wildcard CORS is not allowed there. |
| SEC-002 | App proposal, run, story, and commit trust server-owned snapshots and run evidence; clients cannot inject trusted source, result, lineage, or claim evidence. |
| E2E-001 | Release requires CLI-backed browser, agent-eval, migration, performance, and embed-contract proof. |
| E2E-002 | Release proves certified-first App planning, semantic fallback, atomic commit, filter-consistent multi-tile stories, stale-response rejection, and deterministic no-provider fallback in the built CLI UI. |
| E2E-003 | Release proves colocated and external dbt repositories, canonical and compatibility profile filenames, existing connection preservation, profile-backed runtime execution, and manifest-v3 Domain Studio compilation. |

## OSS and Cloud boundary

DQL OSS includes the complete accuracy loop for one primary dbt project:
artifact ingestion, domain modeling, skills, certified assets, relationship
safety, context routing, evaluations, local UI, CLI, and MCP. That project may
contain dbt packages, thousands of models, and many nested domains.

Cloud adds multi-repository federation, centralized identity and real RBAC,
managed approvals, hosted execution, audit retention, policy distribution, and
organization-wide discovery. OSS metadata such as `classification` is
descriptive unless a local policy adapter explicitly enforces it.
