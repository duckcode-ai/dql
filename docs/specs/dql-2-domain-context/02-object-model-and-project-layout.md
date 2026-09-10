# Object model and project layout

## Canonical project layout

```text
dql.config.json
domains/
  commerce/
    domain.dql
    modeling/
      model.dql.yaml
      areas/
        <area-id>.dql.yaml
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
  /** Optional focused Model Area; a ranking hint inside activeDomain only. */
  modelAreaId?: string;
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
- A Model Area is one small, Git-backed source section under
  `modeling/areas/<area-id>.dql.yaml`. Areas compile into the same canonical
  domain graph: they are source ownership, diagram, and retrieval-ranking
  hints, never a second semantic model or authorization boundary. An entity has
  one owning area; another area may show it only as a read-only reference.
- Model Area identity is always compiled as `<domain>::model_area::<localId>`.
  A local Area ID may repeat in another domain; APIs and persisted product
  context return the qualified identity even when authoring accepts an
  unambiguous domain-local ID (`DOM-003`, `CTX-004`).
- Product ownership is stewardship only; authorization remains a runtime/Cloud
  concern.

## Business concepts (amendment A-005, 2026-09-09)

A **concept** is the one thing a business knows under several keys: a term with
identity, bound to one or more modeled entities, optionally with a conformance
rule. It is authored in the modeling source (`modeling/*.dql.yaml` or
`modeling/areas/*.dql.yaml`) under `concepts:` and compiles to
`<domain>::concept::<localId>`:

```yaml
concepts:
  - id: customer
    name: Customer
    description: One purchasing account, however a system keys it.
    synonyms: [client, account]
    bindings:
      - entity: customer              # local or <domain>::entity::<id>
        role: canonical
        grain: customer_id
      - entity: growth::entity::acquisition
        role: conformed
        grain: customer_id
    rule: customer_id is the same identity in both models
    equivalences:                     # typed, certifiable mapping between two bindings
      - from: customer
        to: growth::entity::acquisition
        keys: [{ from: customer_id, to: customer_id }]
        cardinality: one_to_one
        validFrom: 2024-01-01
        status: draft
    status: draft                     # draft | reviewed | certified
    owner: analytics@company.test
    origin: ai_draft                  # ai_draft | manual
```

`bindings` say where the concept lives; an `equivalence` is the typed mapping
(key translation, cardinality, applicable time) that execution may later rely
on. A cross-domain binding requires the authorized route — certified export,
matching consumer import and allowed purpose — else it is a diagnostic. A
concept with two or more bindings and a `rule` derives a conformance
declaration, so existing `conforms_to` edges keep working.

**Concepts are discovery and clarification first.** In their first release a
concept reference in a question becomes a clarification listing the bindings
with their grain and domain; it never rewrites an executable identity.
Executable equivalence is a separately gated later capability that may resolve
a concept to one binding only through a **certified** `equivalence`, and across
domains only when the full interface chain holds. AI may draft concepts on
demand from existing terms, entities and certified relationships; every draft
is `status: draft`, `origin: ai_draft`, and nothing auto-certifies.

## Serialization

Source writers preserve comments and stable ordering where feasible. Compiled
manifest output is deterministic, uses qualified IDs, and contains source
locations for every DQL-owned object. It must never serialize copied dbt schema,
descriptions, tests, compiled SQL, or MetricFlow formulas.
