# dbt-first DQL 2.0

DQL is the open-source workspace for governed analytics: it connects dbt
transformation and MetricFlow to analytical blocks, notebooks, business views,
stakeholder apps, lineage, Ask AI, evaluations, and approved learning hints.

In DQL 2.0, **dbt owns physical modeling**. DQL does not replace dbt and does
not maintain a second `schema.yml`.

## One source of truth, one sparse overlay

| Concern | Owner | DQL behavior |
| --- | --- | --- |
| Model SQL, columns, descriptions, dbt tests | dbt | Read from dbt artifacts; edit through a previewed dbt YAML patch |
| Transformation lineage | dbt | Import as provenance and transformation lineage |
| MetricFlow models, measures, dimensions and formulas | dbt / MetricFlow | Compose from the dbt semantic artifact |
| Domain/subdomain/microdomain organization | DQL | Git-versioned Domain Packages |
| Entity binding, relationship cardinality, fanout, export policy | DQL | Sparse analytical overlay only where dbt is insufficient |
| Business contracts, conformance, reusable blocks and apps | DQL | Version, review and certify in the DQL project |
| Agent hints and evaluations | DQL | Draft → evaluate → review → approved retrieval |

The compiler records dbt **provenance**—unique IDs, artifact paths,
fingerprints and availability—not a serialized copy of physical columns,
descriptions, tests, or MetricFlow formulas. This prevents a second schema from
drifting out of sync with dbt.

## Domain Packages

Each analytical domain is an ordinary Git folder:

```text
domains/
  commerce/
    domain.dql.yaml
    modeling/
      entities.dql.yaml
      relationships.dql.yaml
      contracts.dql.yaml
    blocks/
    notebooks/
    business-views/
    skills/
    evaluations/
  growth/
    domain.dql.yaml
    modeling/
      relationships.dql.yaml
    blocks/
    business-views/
    apps/
```

Domains organize ownership and retrieval; they do **not** imply a safe join or
automatic cross-domain access. A generated analytical join needs a DQL
relationship with explicit keys, cardinality, fanout policy, lifecycle state,
and—across a domain boundary—an export contract.

## Safe agent behavior

Ask AI follows this order:

1. compatible certified DQL block;
2. compatible dbt/MetricFlow semantic query;
3. review-required generated SQL backed by certified, fanout-safe DQL
   relationships;
4. a clarification or refusal when policy is missing, stale, unsafe, or
   attribution-dependent.

dbt's DAG can explain how a model was transformed. It never proves that two
models may be joined or that a revenue aggregate will not fan out. For example,
revenue by customer acquisition channel can use a certified customer-grain
relationship; revenue through raw campaign touches must ask for first-touch,
last-touch, fractional, or another explicit attribution policy.

## Enable DQL 2.0

```json
{
  "project": "commerce-analytics",
  "manifestVersion": 3,
  "modeling": { "mode": "dbt-first" },
  "dbt": {
    "projectDir": "../dbt",
    "manifestPath": "target/manifest.json"
  }
}
```

Then run:

```bash
dbt parse
dql compile .
dql notebook .
```

Manifest v3 is opt-in during the compatibility window. Existing manifest v2
projects keep their current behavior and do not need a separate migration.

## Migrating from DataLex

DataLex can be migrated into a dbt-first DQL project without treating it as a
second runtime dependency:

```bash
# Review only; default and --dry-run never write source
dql migrate datalex --input ../datalex/datalex-manifest.json --dry-run

# Write draft Domain Package overlays and suggested dbt YAML patch files
dql migrate datalex --input ../datalex/datalex-manifest.json --apply
```

The migration matches legacy objects to dbt unique IDs, deliberately drops
mirrored dbt facts, converts only DataLex-specific analytical semantics into
draft overlays, writes divergent dbt-owned descriptions as suggested patches,
and reports every loss. It is idempotent and never auto-certifies a migrated
relationship, contract, block, or hint.

See [RFC 0002](rfcs/0002-dbt-first-domain-modeling.md) for the full contract
and [the implementation plan](rfcs/0002-implementation-plan.md) for acceptance
gates.
