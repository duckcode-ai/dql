# Product and user flow

## Primary journey

1. **Connect dbt.** The user selects a dbt project. DQL locates or builds its
   artifacts and creates an immutable project snapshot.
2. **Review discovery.** DQL proposes domains from dbt groups, tags, paths,
   owners, exposures, package boundaries, and MetricFlow metadata. Every
   proposal cites evidence and confidence.
3. **Apply domains.** The user accepts, edits, or rejects proposals. Accepted
   packages are drafts in Git.
4. **Model analytical use.** Users bind business entities to dbt unique IDs,
   declare grain only where needed, and create relationship/contract evidence.
5. **Add knowledge.** Terms and domain skills define vocabulary, policies,
   examples, exclusions, and required clarifications.
6. **Certify assets.** Evaluated blocks/business views become preferred answer
   routes. Certification is an explicit review action.
7. **Ask or build.** The user can ask immediately, create a notebook, or create
   an app. Products stay global and reference domain context.
8. **Refresh safely.** `dql sync dbt` rebuilds the snapshot, reports drift, and
   marks affected proof stale without mutating source certification.

## Notebook semantic composition

The global Notebook semantic panel searches imported metrics and dimensions at
enterprise scale. Metrics declare whether they run through MetricFlow, the safe
native composer, or require runtime setup. After one or more executable metrics
are selected, the panel exposes only governed-compatible dimensions. Users can
run a bounded preview, inspect or copy the compiled SQL, and insert the
selection as a semantic DQL cell. The inserted cell retains metric and dimension
identities so later sync, lineage, validation, and execution do not degrade into
anonymous raw SQL (`API-004`, `UI-009`).

Ask ambiguity is shown as compact governed meaning choices. A choice continues
the original question with its stable evidence ID; users are not expected to copy
technical identifiers or answer a second free-form prompt. Failed grounding or
deadline states remain diagnostic only and do not show passed/reusable-answer
actions (`AGT-011`, `UI-010`).

## First-run states

| State | UI behavior | Ask behavior |
| ----- | ----------- | ------------ |
| no dbt artifacts | guided connect/build step | unavailable with actionable reason |
| snapshot, no domains | discovery review | limited-context; generated output requires review |
| draft domains | readiness checklist | scoped retrieval; uncertified paths clarify/refuse |
| certified paths/assets | normal Domain Studio | full governed cascade |
| stale snapshot/proof | drift banner and repair action | excludes stale proof; may fall back or refuse |

`AGT-003` requires progressive availability: domain setup improves trust but is
not a hard onboarding wall.

## Manual and AI-assisted paths

All onboarding operations have a deterministic manual path. AI assistance may
rank or draft domain membership, descriptions, relationship candidates, and
skills only from repository evidence. Each proposal contains:

- proposed change and target file;
- evidence references (dbt unique IDs, paths, tags, tests, exposures);
- confidence and ambiguity reasons;
- validation requirements; and
- lifecycle `draft`.

Apply is a separate, previewed write operation. No AI response can directly
create `certified` state (`AGT-002`).

## Global and contextual navigation

Apps, Ask, Notebooks, Blocks, Lineage, Domains, and Source control remain
reachable in the global rail. “Ask in domain” and “Create notebook from domain”
are shortcuts that prefill `ProductDomainContext`; they do not create a second
Ask or domain-local notebook store.

## Completion definition

A domain is **ready for governed generation** only when its selected dbt nodes
resolve, all automatically used joins have fresh certified proof, required
exports/imports match, evaluations pass, and the current snapshot has no
blocking diagnostics. Readiness is reported per capability, not as a single
misleading project-wide green check.

## Governed App Builder

App Builder is a composition workflow, not another Ask surface. It decomposes
the requested stakeholder outcome into typed analytical requirements and covers
each requirement from one immutable server-resolved snapshot. A compatible
certified block is selected only when its metric, grain, dimensions, outputs,
filters, parameters, ranking, freshness, and purpose fully cover the
requirement. Governed semantic queries cover only remaining requirements;
uncovered needs remain visible typed gaps (`PRD-004`, `AGT-007`).

App creation begins as one **local private draft**. The author selects an
authoring mode (**Describe with AI** or **Start blank**) and an independent
source policy (**Governed sources only** or **Include review-required
analysis**). The Project publication destination is chosen only after the App
has been reviewed. Certified blocks remain the fastest reusable route, but are
not an onboarding prerequisite. Governed semantic queries may back uncovered
requirements after exact compatibility and runtime preflight. Bounded
exploratory SQL is available only through the explicit review-required source
policy and remains an app-scoped DQL draft until separately promoted or
replaced (`PRD-005`, `PRD-006`, `EXP-004`).

The write-free Build Brief exposes each requirement, selected source,
alternatives, compatibility and lineage evidence, trust/review state, bounded
preview, filters, page, visualization, and layout. Editing any requirement or
source invalidates the affected preflight receipt and proposal hash. The final
action is **Build draft**, never an implicit certification or publication
action (`API-009`, `UI-017`).

App creation is deliberately incremental: one AI request proposes one page,
while manual authoring opens the same versioned draft with a blank page.
From an existing App, **+ Add page** starts the same write-free Build Brief for
exactly one additional page, inheriting the server-owned App domain, audience,
owner, and source policy. Approval may edit the proposed page title, tile
selection, tile titles, and visualizations; it cannot rename the App or rewrite
an existing page. A local private draft may explicitly include bounded AI-SQL
gap exploration; Project publication remains certified/approved-semantic only.
The commit
binds both the metadata snapshot and an exact
fingerprint of the existing App package, stages a full candidate copy, and
atomically swaps it only if neither source has changed (`API-009`, `API-013`,
`UI-017`, `UI-022`).

If generated App SQL or an App dashboard semantic/draft query fails at
execution, DQL may spend one bounded repair attempt through the same repair
boundary used by Ask and Notebook. The retry stays on the original data target,
retains the redacted failure and SQL fingerprints, and never runs for access,
permission, policy, unsafe-query, or cancellation failures. A repaired query is
shown as a review-required preview and is never written over the source
silently. In particular, repaired compiler SQL from a semantic tile is no
longer eligible for semantic approval or shared publication; it must be reviewed
as exploratory App analysis (`AGT-023`, `API-010`, `UI-018`).

Proposal is write-free. Selected sources are preflighted before commit, and a
snapshot or proposal-hash change fails with a conflict. Commit writes the App,
dashboard, and derived `ProductDomainContext` atomically. Personal Apps begin as
private drafts; stakeholder Apps must satisfy governed publication gates.

App Copilot is not the App planning orchestrator. It adapts the server-owned
whole-App or focused-section context into the shared governed AgentRun used by
Ask, Notebook, and Block AI for retrieval, semantic routing, execution, repair,
and evidence. App-specific answers, investigations, and typed Add-to-App
proposals remain explicit and cannot silently mutate App source (`AGT-007`,
`AGT-022`).

Ask AI's explicit **Add to App** action uses the same `AppBuildDraft` boundary.
It adds certified answers as fingerprinted certified-block tiles, stores
exploratory DQL only in the ignored app-scoped local bundle, and treats an
existing Project App as the base of a safe local edit draft. Opening the result
lands in the editable Studio; leaving Studio clears the draft/App selection and
returns to the unified Apps library rather than the retired App workspace
(`API-013`, `UI-005`, `UI-022`, `E2E-020`).

Shared publication permits current certified blocks and explicitly approved,
successfully preflighted semantic queries. It rejects required gaps, local AI
pins, exploratory App drafts, stale semantic definitions, failed source/filter
preflight, or stories not bound to one settled dashboard run. Apps containing
approved semantic sources remain reviewed rather than certified; only an
all-certified App may use certified lifecycle state.

**Publish to Project** opens one guided publication review. It groups every
blocking question, scoped review, stale preview, source-trust failure, and
filter-binding failure with the corrective action beside it. Corrective actions
update the review from the current draft; the author is never sent through a
separate, repeated "check readiness" loop. The final publish action is shown
only after the blocking list is empty; it consumes the exact reviewed preflight
receipt instead of starting another client-side check. The publish endpoint
still revalidates in the same server request before the atomic write. A stale
runtime receipt offers one bounded **Refresh all page previews** action, then
re-evaluates automatically. Source refresh is a no-op when fingerprints are
already current and therefore cannot invalidate a settled preview (`API-013`,
`UI-022`).

Dashboard filter authoring is governed-field-first: search a declared block
filter, semantic dimension, or settled result column that the server SQL parser
has proved safe and non-aggregate; choose the control; choose App/page scope;
and explicitly include every compatible component. Select controls use
bounded, run-scoped server choices. Date controls expose ephemeral min/max
availability from safe settled result columns; a checked field with no usable
date values is shown as empty before the filter can be saved. These values and
bounds are not persisted in the App artifact. A tile with an explicit
`unsupported` capability and explanation is a governed exclusion, not a
missing filter binding or publication blocker (`UI-022`, `E2E-020`).

Generated App pages use this reading order (`UI-004`):

1. page title and navigation;
2. full-width searchable filters with explicit tile scope, debounced automatic
   apply, and Reset;
3. full-width live Business Story;
4. KPI band;
5. trends and driver breakdowns;
6. detail/evidence tables; and
7. a collapsed reviewer appendix.

The dashboard persists a story evidence plan, never result-specific prose.
After Apply, one settled dashboard run supplies all tiles and a deterministic
story from the same snapshot, persona, filters, and results. Optional richer AI
wording may replace it only after claim validation, and stale responses are
ignored. Provider failure leaves the deterministic story usable (`AGT-008`).
