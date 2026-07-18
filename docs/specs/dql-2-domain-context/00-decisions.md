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
| CFG-004 | Setup, Settings, Home, and governed runtime share one redacted provider contract and readiness definition. Native OpenAI, Anthropic, and Gemini support optional enterprise Base URL/model routing; custom OpenAI-compatible requires Base URL/model; unsaved tests use the governed adapter; blank secret inputs preserve stored secrets. |
| ID-001 | Every domain-owned object has a domain-qualified compiled identity. |
| DOM-001 | Domains own semantics and governance, not physical dbt schema. |
| DOM-002 | Domain hierarchy scopes organization/retrieval; it grants no join or access rights. |
| DOM-003 | A domain may contain multiple focused Model Areas; Areas compile into one domain graph and never become a second semantic model or authorization boundary. |
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
| CTX-004 | Model Area identity is domain-qualified; explicit or inferred Area focus narrows modeling and Skill retrieval inside its owning domain. |
| CTX-005 | Every Ask surface acquires one qualified immutable project-search snapshot containing DQL v3/modeling, certified assets, semantic metadata, dbt metadata, safe runtime schema, and approved hints; warm retrieval does not reparse source artifacts. |
| AGT-001 | Route order is certified block, MetricFlow, governed generation, clarify/refuse. |
| AGT-002 | AI discovery produces evidence-cited drafts only and never auto-certifies. |
| AGT-003 | Ask is available before domain setup only in limited-context, review-required mode. |
| AGT-007 | App planning and analytical answering are separate orchestrators that share one server-resolved snapshot, retrieval contracts, trust vocabulary, and evidence model. |
| AGT-008 | App Business Stories verbalize server-computed facts from the settled dashboard run; unsupported numbers, comparisons, causal claims, grains, or filters are rejected. |
| AGT-009 | Analytical natural-language requests perform broad governed retrieval before general routing, then use at most one bounded AI meaning-resolution call over qualified retrieved candidates; explicit qualified references may bypass that call. |
| AGT-010 | Relevance and business meaning select the concept before trust selects the execution route; every AI recommendation is identifier-bound and must pass deterministic compatibility, policy, compilation, and execution guards. |
| API-001 | Domain, modeling, onboarding, and context APIs return stable codes and snapshot IDs. |
| API-002 | App proposal is write-free; commit is snapshot/hash guarded and atomic; dashboard run/story APIs bind filters, results, persona, trust, and evidence to stable fingerprints. |
| API-003 | Browser Ask, CLI, MCP, and Chat use the same snapshot, retrieval, meaning-resolution, route, trust, and error contracts and expose only redacted phase diagnostics. |
| UI-001 | Domain Studio uses vertical contextual navigation; global product navigation stays stable. |
| UI-002 | dbt-owned metadata is read-only and edited only through previewed source patches. |
| UI-004 | Generated Apps render page navigation, an apply/reset filter row, a live Business Story row, KPI band, analysis tiles, detail evidence, then reviewer appendix. |
| UI-005 | App Copilot uses the canonical App run context and cannot mutate an App without an explicit previewed user action. |
| UI-006 | Domain Studio presents the nested Domain Package hierarchy and focused Areas with shareable deep links; Ask visibly preserves and can clear the selected Area context. |
| UI-007 | One Settings hub under Govern owns Overview, Project & dbt, Database, AI provider, Agent memory, and Advanced. Guided Setup launches from Settings and automatically once per project on first install and each installed CLI version change; it embeds the same project, database, and provider editors, AI is optional, saved settings remain untouched without successful test/apply, and Setup has no separate rail destination. Successful dbt Apply automatically prepares the shared governed search snapshot and exposes truthful background progress without requiring another command. |
| MIG-001 | Manifest v2 and legacy domain-local product paths remain readable through DQL 3.x. |
| MIG-002 | DataLex/legacy migration is deterministic, idempotent, loss-reporting, and never upgrades lifecycle. |
| PERF-001 | Large projects use indexed snapshots, pagination, batch detail, and bounded graph neighborhoods. |
| PERF-002 | Ask enforces retrieval, evidence-size, provider-call, tool-call, SQL, repair, cancellation, and wall-clock budgets; simple answers never pay an open-ended planning or synthesis loop. |
| SEC-001 | Non-loopback serving requires authentication; wildcard CORS is not allowed there. |
| SEC-002 | App proposal, run, story, and commit trust server-owned snapshots and run evidence; clients cannot inject trusted source, result, lineage, or claim evidence. |
| SEC-003 | Search repair, runtime-value grounding, evidence packaging, and optional embeddings are allowlisted, policy-bounded, redacted, and cannot expose or persist secrets, unauthorized metadata, or plaintext sampled values. |
| E2E-001 | Release requires CLI-backed browser, agent-eval, migration, performance, and embed-contract proof. |
| E2E-002 | Release proves certified-first App planning, semantic fallback, atomic commit, filter-consistent multi-tile stories, stale-response rejection, and deterministic no-provider fallback in the built CLI UI. |
| E2E-003 | Release proves colocated and external dbt repositories, canonical and compatibility profile filenames, existing connection preservation, profile-backed runtime execution, and manifest-v3 Domain Studio compilation. |
| E2E-004 | Release proves duplicate local Area IDs across domains, explicit and inferred Area focus, Area-scoped Skills, hierarchy/deep-link round trips, and bounded context reduction in the built CLI. |
| E2E-005 | Release proves built-CLI parity across Settings and Guided Setup, automatic shared dbt snapshot/index preparation with no duplicate first-Ask rebuild, one-time first-install/version-upgrade setup prompts, all provider modes and enterprise URLs, dbt/profile/database preservation and rollback, optional-AI behavior, accurate readiness states, project-local/global npm command availability, PATH-independent internal npm resolution, and unchanged Cloud embed contracts. |
| E2E-006 | Release proves retrieval-first meaning resolution and route parity at enterprise scale: 7,000 similar/late-position metrics, 10,000 dbt models, 300,000 columns, trust-versus-relevance conflicts, bounded call budgets, accurate ambiguity, and identical built-CLI browser/CLI/MCP/Chat outcomes. |

## OSS and Cloud boundary

DQL OSS includes the complete accuracy loop for one primary dbt project:
artifact ingestion, domain modeling, skills, certified assets, relationship
safety, context routing, evaluations, local UI, CLI, and MCP. That project may
contain dbt packages, thousands of models, and many nested domains.

Cloud adds multi-repository federation, centralized identity and real RBAC,
managed approvals, hosted execution, audit retention, policy distribution, and
organization-wide discovery. OSS metadata such as `classification` is
descriptive unless a local policy adapter explicitly enforces it.
