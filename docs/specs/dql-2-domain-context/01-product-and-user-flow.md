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
