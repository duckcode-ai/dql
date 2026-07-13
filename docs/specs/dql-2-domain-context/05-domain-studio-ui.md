# Domain Studio UI

## Information architecture

The global rail remains:

```text
Insights   Apps · Ask
Build      Notebooks · Blocks · Lineage
Govern     Domains · Source control
```

Domains opens a focused Domain Workspace. OSS v1 deliberately avoids asking a
new user to construct every governance object up front. Selecting a domain
opens a domain selector plus two contextual tabs:

```text
Model
Skills
```

The Model tab begins with an Area selector (`All domain` plus focused Model
Areas), a business/data view switch, and compact actions to add a dbt model,
connect a relationship, create an Area, auto-layout, fit, and inspect. Skills
is the only parallel tab. Terms, business views, join proofs, contracts,
interfaces, evaluations, related products, and dbt scope are contextual
inspector/readiness details—not top-level authoring destinations in this first
OSS workflow. Global Apps/Ask/Notebooks behavior is unchanged (`UI-001`).

## Overview

Show ownership, parent/children, selected dbt scope, readiness by capability,
stale/blocking diagnostics, recent source changes, certified asset counts, and
next best actions. Do not collapse readiness into one score that hides unsafe
joins or missing exports.

## Domain Model canvas

The canvas is the unified analytical model from
`04-domain-modeling-and-governance.md`.

- one compact toolbar row uses accessible icons with tooltips and keyboard
  equivalents for add/bind, connect, layout, column density, fit, undo, and
  inspector toggle;
- entity width/height adapts to content, with manual resize and remembered
  layout; handles and constraint icons remain inside the visible hit area;
- nodes move freely; auto layout respects node dimensions and avoids inspector
  overlap; fit accounts for the open/closed inspector;
- dragging a column handle to another column creates a draft relationship;
- clicking a node or edge opens the right inspector; relationship information
  is not a separate top-level tab;
- the inspector is resizable and closable, remembers user preference, traps no
  canvas shortcuts, and restores focus correctly;
- node cards show business context, dbt relation/grain, domain/lifecycle, and
  PK/unique/not-null/foreign-key signals with accessible labels;
- edges show cardinality, key mapping, safety/attribution state, lifecycle, and
  cross-domain/export state without labels covering nodes.
- Business view is the default: business name/context, concepts, role, grain,
  and relationship meaning lead the interaction. Data view exposes the dbt
  relation, columns, tests, keys, and column-to-column relationship handles.
- First-run guidance creates an Area (name, business question, example
  questions, and optional boundary entities), then adds dbt-backed entities.

## Inspectors and editing

Node inspector sections: business context, concepts, analytical role, dbt
identity, grain/keys, dbt columns, provenance, dependencies, and source.
Relationship inspector sections: meaning, endpoint/key mapping, cardinality,
fanout, evidence, validation, lifecycle, owner, interface/export, staleness, and
lineage. The default view is concise; advanced fields are progressively
disclosed.

dbt-owned fields are read-only. Edit opens a source patch preview against the
actual dbt SQL/YAML with fingerprint guard. DQL-owned changes preview and write
Domain Package source. No canvas action writes copied dbt metadata (`UI-002`).

## Knowledge and assets

Terms and Skills share search, source, lifecycle, evidence, and evaluation
patterns. Domain skills clearly differ from global workflow skills. Certified
Assets shows domain blocks/views with grain, compatible dimensions, contracts,
evaluations, consumers, and certification state. Authoring shortcuts preserve
the domain-qualified identity.

## Readiness

Join proofs, Contracts, Interfaces, and Evaluations are task-focused queues:
what is blocked, why it matters to Ask, evidence, affected products, and the
next action. They are not empty configuration tables. Every item links back to
the relevant graph edge/asset and source diff.

## Related Products and dbt Scope

Related Products is derived from `ProductDomainContext` and manifest lineage.
It shows global Notebooks/Apps that own or use this domain and highlights
missing required exports or unscoped legacy products. dbt Scope provides
paginated, filterable read-only provenance and source-patch entry points.

## Theme and accessibility contract

Preserve `<html data-theme="paper|white|obsidian">`, the shared semantic token
vocabulary, `dql-theme`, and its storage event listener. New components use
semantic tokens only. All icon-only controls require labels/tooltips, canvas
actions have keyboard alternatives, focus is visible, and safety is never
communicated by color alone.

## UI acceptance

Browser acceptance starts the built CLI with `dql notebook` against the
dedicated fixture. Tests cover sidebar/deep links, inspector toggle/resize,
free movement, auto-fit, column-to-column drag, compact relationship editing,
source preview, related products, theme changes, and a Cloud embed-contract
check. Vite-only screenshots are insufficient.
