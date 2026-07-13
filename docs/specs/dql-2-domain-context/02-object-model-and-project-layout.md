# Object model and project layout

## Canonical project layout

```text
dql.config.json
domains/
  commerce/
    domain.dql
    modeling/
      model.dql.yaml
      layouts/
    terms/
    skills/
    blocks/
    views/
    contracts/
    interfaces/
    evaluations/
    tests/
  growth/
    domain.dql
    modeling/model.dql.yaml
notebooks/
apps/
blocks/                 # unowned/legacy or intentionally cross-domain
skills/                 # reusable global workflow skills
.dql/                   # ignored caches, snapshots, connectors, runtime state
```

New Apps and Notebooks are stored globally. Legacy `domains/*/apps` and
`domains/*/notebooks` remain readable and receive a migration preview.

## Exact public contracts

```ts
interface ProductDomainContext {
  ownerDomain?: string;
  usesDomains: string[];
  purpose?: string;
  requiredExports: string[];
  classification?: string;
}

interface QualifiedDomainObject {
  id: string;
  localId: string;
  domain: string;
}

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

These shapes are shared by core, compiler, runtime, CLI, agent, MCP, and UI.
Additive fields require compatibility tests; changing existing semantics
requires an RFC.

## Qualified identity

Compiled domain objects use `<domain>::<kind>::<localId>` as their canonical
`id`, while preserving `localId` for source edits and display. Domain IDs are
normalized lowercase path segments separated by `.`. Collisions after
normalization are compile errors. References may use a local ID only within the
same package and are always compiled to a qualified ID (`ID-001`).

## Domain declaration

`domain.dql` defines ID, display name, optional parent, owners, selectors,
imports, and exports. Selectors are executable membership rules, not labels:

```yaml
id: growth.acquisition
name: Acquisition
parent: growth
selectors:
  any:
    - dbt_group: growth
    - path: models/growth/acquisition/**
    - tag: acquisition
imports:
  - ref: commerce.customer_v1
    from: commerce
    purpose: revenue attribution
```

One central membership resolver applies selectors with precedence: explicit
`meta.dql.domain`, exact unique-ID binding, dbt group, path, tag, owner/exposure
evidence. Ambiguous membership remains unresolved until reviewed.

## Ownership rules

- dbt owns physical relations, columns, types, descriptions, tests, SQL, DAG,
  and MetricFlow definitions.
- DQL stores only references/fingerprints plus sparse analytical assertions.
- Domains own terms, skills, relationship policy, contracts, interfaces,
  certified blocks/views, evaluations, and lifecycle.
- A global skill describes reusable execution technique. A domain skill carries
  vocabulary/policy for one domain and participates in that domain context.
- Product ownership is stewardship only; authorization remains a runtime/Cloud
  concern.

## Serialization

Source writers preserve comments and stable ordering where feasible. Compiled
manifest output is deterministic, uses qualified IDs, and contains source
locations for every DQL-owned object. It must never serialize copied dbt schema,
descriptions, tests, compiled SQL, or MetricFlow formulas.
