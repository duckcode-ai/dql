# Domain modeling and governance

## One analytical model, two ownership layers

The Domain Model is a single user-facing graph. Its nodes combine read-only dbt
provenance with a sparse DQL analytical overlay; this is not a separate
conceptual/logical/physical modeling product. The UI distinguishes ownership
within the same model:

- **dbt implementation:** relation, columns, types, descriptions, tests,
  transformation DAG, MetricFlow;
- **DQL analytical context:** business identity, optional asserted grain,
  concepts, relationship safety, contract/export policy, lifecycle, evidence.

`model.dql.yaml` is the default source for bindings and relationships. Split
legacy files remain readable, but the UI presents one model and offers a
lossless consolidation migration.

### Focused Model Areas (OSS v1)

Large domains can be authored as several small, reviewable Model Areas without
creating competing models. Each `modeling/areas/<area-id>.dql.yaml` carries a
short business scope, example questions, owned entities/relationships, and
optional read-only boundary-entity references. The compiler merges every Area
and legacy/default source into one qualified domain graph. A relationship is
owned by its active Area and may cross Areas; cross-domain policy remains the
same explicit relationship/export/import/contract path. Area selection boosts
retrieval only after the domain and lifecycle gates have passed.

## Entity bindings

Each binding resolves a qualified entity to one dbt unique ID. It may add a
business name, business context, concepts, analytical role, and grain assertion
only where dbt/MetricFlow is insufficient. Binding validation checks referenced
columns against the current snapshot without copying them into source.

## Relationship proof

A relationship requires:

- qualified endpoints and exact column pairs;
- cardinality (`one_to_one`, `one_to_many`, `many_to_one`, `many_to_many`, or
  `unknown`);
- fanout policy (`safe`, `dedupe_required`, `attribution_required`, or
  `forbidden`);
- lifecycle, owner, evidence, validation query/test fingerprint, and dependency
  fingerprint;
- cross-domain import/export reference when endpoints cross domains.

Automatic generated joins require all of the following (`REL-002`):

1. relationship status is `certified`;
2. dependency and evidence fingerprints match the active snapshot;
3. all relationship key columns still exist and satisfy the recorded proof;
4. evidence has not expired and the validation query has not changed;
5. cardinality/fanout is automatically safe for the requested aggregation;
6. any cross-domain export/import and purpose are certified and compatible.

Unknown/many-to-many/attribution-required edges may remain visible but cause a
clarification or refusal. A dbt DAG edge never supplies join proof (`REL-001`).

## Relationship authoring UX contract

Users drag from a source column handle to a target column handle. The UI creates
a draft edge and opens a compact inspector. It pre-fills only evidence-backed
values. Required choices are presented progressively: relationship meaning,
cardinality/fanout, evidence/validation, and certification workflow. Handles,
PK/unique/not-null/foreign-key indicators, and source ownership remain visible
without clipping at all supported zooms. Entity boxes are freely movable,
resizable, auto-layoutable, collapsible, and persisted as a separate layout so
visual movement never changes semantic source.

## Contracts, interfaces, and conformance

- **Interface:** the narrow provider export/consumer import boundary: entity,
  keys, dimensions/metrics/blocks, filters, purpose, consumers,
  classification, owner, version, lifecycle.
- **Contract:** the runtime promise for an analytical asset: required inputs,
  grain, allowed filters, output semantics, owner, freshness, and evaluations.
- **Conformance:** an assertion that identities/dimensions represent the same
  concept, with an explicit reconciliation rule.

These are executable readiness gates, not documentation tabs. A failed required
evaluation makes the dependent relationship/asset unavailable to certified
routing. The UI leads with plain-language readiness and reveals source details
on demand (`CONTRACT-001`).

## Skills and terms

Domain skills specify intent examples, vocabulary, policies, ambiguity rules,
tool guidance, exclusions, and evaluation links. Global skills specify reusable
workflow/tool technique and cannot override domain safety. A domain skill is
selected only when the active/allowed domain matches and evidence is fresh.
Skills may optionally name focused Model Areas; that further narrows ranking
inside their already-authorized domain and never grants context outside it.
`exclusions` reduce or veto a match and are never indexed as positive search
tokens (`SKILL-001`, `SKILL-002`).

## Lifecycle

All authored semantics use `draft → evaluated → reviewed → certified`, plus
`deprecated` and computed `stale_certification`. AI, import, migration, and
warehouse proof can attach evidence or advance evaluation results but cannot
perform the human review/certification transition. Corrections enter the same
draft/evaluation/review path before they become approved hints.

## Lineage

End-to-end lineage keeps edge types distinct: dbt transformation, DQL entity
binding, analytical relationship, contract/interface dependency, block/view
consumption, notebook/app consumption, and answer/tool execution. A user and an
agent can trace an answer to exact source paths, proof, snapshot, and lifecycle.
