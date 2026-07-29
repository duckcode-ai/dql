# Domain Studio UI

## Information architecture

The global rail remains:

```text
Insights   Apps · Ask
Build      Notebooks · Blocks · Lineage
Govern     Domains · Source control
```

Domains opens a focused Domain Workspace. OSS deliberately avoids asking a new
user to navigate internal governance objects. The workspace presents the
parent-first Domain Package tree and five task-level destinations:

```text
Models · Skills · Blocks · Notebooks · Apps
```

Models is the primary data-context destination. It begins with an Area selector
(`All domain` plus focused Model Areas), a business/data view switch, and
compact actions to add a dbt model, connect a relationship, create an Area,
auto-layout, fit, and inspect. Skills is the parallel instruction/context
editor. Blocks lists the selected domain's canonical block sources. Notebooks
and Apps show the global products that own or use the selected domain. Selecting
a card opens the exact source in Block Studio, the Notebook editor, or the App
viewer; it does not create a domain-local copy. Global Apps/Ask/Notebooks
behavior and canonical root storage remain unchanged (`PRD-001`, `UI-001`).

Terms, business views, join proofs, contracts, interfaces, evaluations, dbt
scope, and Knowledge 360 are not separate Domain navigation destinations. Their
compiled evidence remains available to retrieval, validation, Models
inspectors, Block Studio, Source Control, and other task-specific surfaces.
Historical deep links to those removed sections normalize to Models.

The Domain selector presents nested Domain Packages parent-first. Domain and
Area selection round-trip through `domain`, `modelArea`, and `domainSection`
URL parameters. The same Area selector is available in Model and Skills, new
Skills created there inherit the Area, and “Ask” carries the qualified Area ID
into a visible, removable Ask scope (`UI-006`).

Long-running Ask and Research turns progressively explain the active governed
work instead of showing generic loading copy. After the initial wait, the UI
states that DQL is checking certified blocks, semantic metrics, domain
modeling, and dbt metadata. If generation or research continues, it explains
that reusable relationship modeling and semantic metrics shorten future
analysis, while a reviewed result can be saved as a block and explicitly
certified to reduce repeated AI work and token usage. This guidance is shown
only for materially long or repaired/deep turns and never implies that saving a
draft certifies it (`UI-003`).

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

## Agent context

Models and Skills are the user-facing Domain context. Agent retrieval may also
consume current dbt metadata, semantic context, certified assets, relationship
proof, and evaluation state from the compiled snapshot, but those sources do
not require separate Domain tabs. Domain skills clearly differ from global
workflow skills and preserve domain-qualified identity.

## Readiness

Join proofs, contracts, interfaces, and evaluations remain validation and
retrieval evidence. Surface a relevant problem in the Models inspector or in
the task that needs action; do not expose standalone empty governance tables in
Domain navigation.

## Related Products

Related Products is derived from `ProductDomainContext` and manifest lineage.
It shows global Notebooks/Apps that own or use this domain and highlights
missing required exports or unscoped legacy products.

## Theme and accessibility contract

Preserve `<html data-theme="paper|white|obsidian">`, the shared semantic token
vocabulary, `dql-theme`, and its storage event listener. New components use
semantic tokens only. All icon-only controls require labels/tooltips, canvas
actions have keyboard alternatives, focus is visible, and safety is never
communicated by color alone.

## UI acceptance

Browser acceptance starts the built CLI with `dql notebook` against the
dedicated fixture. Tests cover the five-section sidebar, exact Block/Notebook/App
routing, removed-section deep-link fallback, inspector toggle/resize, free
movement, auto-fit, column-to-column drag, compact relationship editing, source
preview, related products, theme changes, and a Cloud embed-contract check.
Vite-only screenshots are insufficient.
