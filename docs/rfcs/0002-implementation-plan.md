# RFC 0002 — Implementation Plan: dbt-first domain modeling

> Companion to [RFC 0002](./0002-dbt-first-domain-modeling.md). This is the
> executable delivery plan and acceptance contract for DQL 2.0.

## Delivery rules

- Work is isolated on `codex/dql-2-dbt-first-modeling`; `main` remains the
  tagged, deployable baseline.
- dbt source files and generated dbt artifacts remain the source of physical
  and MetricFlow facts. No test may accept a duplicate DQL representation of
  dbt columns, descriptions, tests or metric formulas.
- New v3 behavior is explicitly opt-in. V2 compile, CLI and agent paths stay
  covered throughout implementation.
- Any new UI work preserves the embedded Cloud theme contract and is checked
  in the Cloud repository with `node scripts/embed-contract.test.mjs`.

## Workstream A — manifest v3 and dbt provenance

1. Extend the core manifest discriminant to `1 | 2 | 3` and add v3-only
   modeling fields: `dbtProvenance`, `modeling`, `relationships`, `contracts`,
   `conformance`, `rules`, and `domainLineage`.
2. Extend project config with `manifestVersion` and `modeling.mode`. Reject an
   incomplete v3 configuration with a clear diagnostic; keep v2 as default.
3. Build the provenance index from dbt `manifest.json`, `catalog.json` and
   `semantic_manifest.json`. Persist only source paths, unique IDs, relation
   identifiers, availability references and stable fingerprints.
4. Make `domain.dql` the canonical package declaration and parse sparse files
   under `modeling/`. Legacy `domain.dql.yaml` is compatibility-only and a
   conflicting dual declaration is a compile error. Bind entities only to
   known dbt unique IDs.
5. Add stable diagnostics for unresolved bindings, invalid key pairs, missing
   export contracts, unsafe cardinality, fanout policy, and stale certification.
6. Make `collectInputFiles` include all selected dbt artifacts and domain
   package source files so cache rebuilds are correct.

Acceptance tests:

- v3 output is stable apart from `generatedAt`.
- changing only a dbt description changes provenance fingerprint but does not
  copy the description into manifest output.
- changing an entity key/grain marks attached relationships/contracts stale.
- v2 fixture output and consumers remain valid.

## Workstream B — DQL source, graph and CLI

1. Add typed source loaders and deterministic writers for domain packages.
2. Add relationship graph validation that considers only `status: certified`,
   fresh, exported, fanout-safe edges as automatic join proof.
3. Extend lineage graph output with a distinct DQL analytical-relationship edge
   type. Retain dbt DAG edges as transformation lineage.
4. Add `dql model` commands to list, validate and explain domain package state.
5. Add `dql migrate datalex --manifest <path> [--dry-run]`, with an explicit
   loss report and suggested dbt YAML patch output.

Acceptance tests:

- `dql model validate` reports unsafe, stale and unexported edges without
  pretending they are usable.
- legacy migration is idempotent; a second dry run has the same report and
  applying twice produces no additional source changes.
- every dropped mirror and unmatchable legacy object appears in the loss report.

## Workstream C — agent and governance

1. Materialize v3 relationships, contracts and provenance as agent catalog/KG
   records with source ownership and certification state.
2. Route in exact order: certified block, MetricFlow, governed SQL, clarify or
   refuse. Existing v2 behavior stays unchanged.
3. The SQL guard accepts cross-domain joins only with certified, exported,
   non-stale, fanout-safe relationship proof. It emits a structured reason for
   missing attribution policy versus an unavailable object.
4. Feed corrections into the existing draft → evaluation → review → approved
   hint lifecycle. Retrieval remains approved-hints-only.

Acceptance tests:

- `gross_revenue by acquisition_channel` selects the certified business block
  or MetricFlow path with relationship proof.
- a raw `campaign_touches` request asks for attribution policy or refuses; it
  must never execute a join that multiplies revenue.
- a correction cannot appear in answer context before its evaluation and review
  complete.

## Workstream D — migration and modeling UI

1. Add one Domains workspace to the notebook app with overview, context assets,
   relationship diagram, interfaces, contracts, quality, and explicit dbt-owned
   provenance; no Cloud-specific CSS dependency.
2. Use source patch previews for dbt metadata changes. The patch must target
   the original dbt YAML and never write copied metadata to a DQL package.
3. Store relationship, export and contract edits in the appropriate Domain
   Package and show their current lifecycle and stale diagnostics.
4. Extend lineage/app surfaces to expose end-to-end provenance from dbt model
   through relationship/block/business view to stakeholder app.

Acceptance tests:

- UI labels model provenance correctly and makes dbt-owned fields read-only.
- a DQL relationship edit changes a Domain Package source file only.
- the Cloud embed contract test passes unchanged after the UI is built.

## Workstream E — end-to-end fixture and release gates

Create a dedicated dbt/DQL fixture with:

```text
Commerce
├── Orders              fct_orders (order grain)
└── Customers           dim_customers (customer grain)

Growth
├── Marketing           fct_campaign_touches (many-touch fanout)
└── Acquisition         dim_customer_acquisition (customer grain)
```

It includes MetricFlow `gross_revenue`, certified `Order → Customer` and
`Customer Acquisition → Customer` relationships, an explicit cross-domain
export, and a Growth-owned certified block/business view for revenue by
acquisition channel.

The fixture gates are:

1. `gross_revenue by acquisition_channel` succeeds through the certified safe
   path with full lineage.
2. The same question through raw Campaign Touches requests an attribution
   policy or refuses.
3. A dbt key/grain change marks related DQL certification stale.
4. Correction lifecycle covers draft, required evaluation, review and approved
   hint retrieval.
5. A stakeholder app executes a certified block and exposes full lineage.

Final gates before opening the ready PR:

- unit, integration, compiler, CLI, migration and agent-eval tests pass;
- browser workflow is served by `dql notebook` against the dedicated fixture;
- no generated caches, connector state, runtime state or Playwright artifacts
  are staged;
- `git diff --check` passes;
- Cloud `embed-contract.test.mjs` passes after UI changes;
- the DQL 2.0 branch is pushed with a release-note-quality PR summary and
  `main` has not been changed since the rollback baseline.
