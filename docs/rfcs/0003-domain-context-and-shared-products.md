# RFC 0003: Domain context and shared analytical products

| Field              | Value                                            |
| ------------------ | ------------------------------------------------ |
| **Author(s)**      | @KKranthi6881                                    |
| **Status**         | Accepted for implementation                      |
| **Created**        | 2026-07-12                                       |
| **Targets**        | DQL `>= 2.0`                                     |
| **Implementation** | `codex/dql-2-dbt-first-modeling`                 |
| **Amends**         | RFC 0002                                         |

## Summary

DQL 2.0 uses domains as the authoritative context and governance boundary for
agentic analytics, while keeping Apps, Ask, and Notebooks as shared product
surfaces. A domain owns the sparse analytical model, terms, domain skills,
certified blocks and business views, contracts, interfaces, and evaluations
that make an answer safe and explainable. Shared products declare which domain
context they use instead of being physically duplicated under every domain.

This RFC makes the user flow, storage model, agent-context envelope, onboarding
contract, compatibility policy, and OSS boundary explicit. The normative
implementation specification is
[`docs/specs/dql-2-domain-context/`](../specs/dql-2-domain-context/README.md).

## Decisions

1. **Shared product surfaces.** Apps, Ask, and Notebooks remain global. Blocks
   remain globally discoverable but domain-owned blocks and business views are
   authored and governed in Domain Studio.
2. **Domain-owned authority.** A Domain Package owns `domain.dql`, sparse model
   bindings and relationships, terms, skills, contracts, interfaces, blocks,
   business views, evaluations, and tests.
3. **Related Products, not copies.** Domain Studio shows Apps and Notebooks
   through backlinks based on product domain metadata. It does not store new
   Apps or Notebooks inside the domain.
4. **One Ask with explicit context.** “Ask in domain” sends a domain reference;
   the server resolves the effective domain, ancestors, allowed imports,
   purpose, and snapshot. The browser cannot assert trusted exports directly.
5. **dbt-first and sparse.** dbt artifacts remain the read-only physical and
   MetricFlow source of truth. Domain Packages never copy dbt columns,
   descriptions, tests, lineage, or metric formulas.
6. **New-project default.** Newly initialized dbt-backed projects default to
   manifest v3 and `modeling.mode: "dbt-first"`. Existing projects change only
   through an explicit, previewable migration.
7. **Evidence-bounded AI.** AI may propose domains, bindings, relationships,
   skills, and patches only from cited repository evidence. Proposals are draft
   and never auto-certified.
8. **Progressive availability.** Before domain setup is complete, Ask remains
   available in a limited-context, review-required mode. It must disclose the
   missing governance context.
9. **OSS scale boundary.** DQL OSS supports one primary dbt project/manifest,
   including dbt packages and many domains. Multi-repository federation, real
   RBAC enforcement, and managed policy distribution belong to Cloud.
10. **Compatibility window.** Manifest v2 and legacy domain-local product paths
    remain readable throughout DQL 3.x. Their earliest removal is DQL 4.0.

## Shared product metadata

Apps and Notebooks may declare:

```ts
interface ProductDomainContext {
  ownerDomain?: string;
  usesDomains: string[];
  purpose?: string;
  requiredExports: string[];
  classification?: string;
}
```

`ownerDomain` identifies stewardship, not storage or authorization.
`usesDomains` scopes retrieval and lineage. `requiredExports` makes cross-domain
dependencies reviewable. Missing metadata is allowed for legacy products and
is reported as unscoped rather than silently inferred as certified.

## Domain context contract

Every governed answer is planned against a server-created envelope:

```ts
interface DomainContextEnvelope {
  activeDomain: string | null;
  ancestors: string[];
  allowedImports: Array<{
    providerDomain: string;
    exportRef: string;
    purpose: string;
  }>;
  purpose?: string;
  source: "explicit_ui" | "explicit_api" | "inferred";
  confidence: "high" | "medium" | "low";
  snapshotId: string;
}
```

The envelope is resolved against one immutable project snapshot. Candidate
selection, tool calls, final SQL validation, provenance, and the answer trust
label must use the same `snapshotId`.

## UI architecture

The global navigation remains:

```text
Insights   Apps · Ask
Build      Notebooks · Blocks · Lineage
Govern     Domains · Source control
```

Selecting a domain opens Domain Studio with a vertical contextual navigation:

```text
Overview
Domain Model
Knowledge          Terms · Skills
Certified Assets   Blocks · Business views
Readiness          Join proofs · Contracts · Interfaces · Evaluations
Related Products   Notebooks · Apps
dbt Scope
```

The physical dbt layer is read-only. AI proposals and source patches require a
preview and explicit user apply. Existing Cloud embed theme selectors, tokens,
and the `dql-theme` persistence contract remain unchanged.

## Amendments to RFC 0002

- The RFC 0002 example that stores `notebooks/` and `apps/` inside every Domain
  Package is compatibility-only. New Apps and Notebooks use root shared-product
  paths and `ProductDomainContext` metadata.
- Manifest v3/dbt-first remains opt-in for an existing project, but is the
  default produced by `dql init` for a newly initialized dbt-backed project.
- The horizontal Domains workspace described by RFC 0002 is refined into the
  vertical Domain Studio information architecture above.
- Domain resolution is a required server contract, not a UI-only filter.

All other RFC 0002 ownership, sparse-overlay, relationship-safety, staleness,
migration, and governed-answer decisions remain in force.

## Consequences

The design reduces duplicated navigation and filesystem sprawl, while making
domain semantics available to every agent route. It also creates a clear
commercial boundary: OSS provides Git-native context and safety for one dbt
project; Cloud can add federation, centrally enforced identity/RBAC, approval
workflows, and managed distribution without withholding the core accuracy
mechanism.
