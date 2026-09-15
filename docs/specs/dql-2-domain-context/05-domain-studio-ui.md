# Modeling UI

## Information architecture

The global rail remains:

```text
Insights   Apps · Ask
Build      Notebooks · Blocks · Lineage
Govern     Modeling · Ask observability · Source control · Settings
```

**Modeling** opens one page (`UI-032`). There is no second navigation rail and
no separate Governed context page: Notebooks, Blocks and Apps already live in
the app rail, and the page used to repeat them. The header holds:

- the **Domain** picker (parent-first, `All domains` first), **New domain** and
  **Domain settings** (the domain form: name, parent, description, covers, in
  scope, out of scope, primary terms, owners, source systems, tags, delete);
- the **Subject area** picker (`Whole domain` first) and **New subject area**,
  shown on the Map and Skills tabs, where it filters;
- **What Ask will do**, **Ask about <domain>**, Import YAML and Recompile.

The tabs are one per thing Ask reads, plus where the domain is used:

```text
Map · Terms & concepts · Skills · Blocks · Used by
```

- **Map** — the model canvas (below).
- **Terms & concepts** — business words. A term teaches Ask a word ("sales"
  means the Revenue metric) with its rules and caveats; it saves straight to
  `domains/<domain>/terms/<slug>.dql` (or `terms/` when project-wide) through
  `/api/terms`, and a metric link must name a governed metric. A concept names
  one business thing stored in several models; it binds models, so it goes
  through the reviewed proposal like every modeling change.
- **Skills** — the domain's skills and, below them, the project-wide skills every
  domain inherits. With no domain chosen it lists every skill.
- **Blocks** — the selected domain's canonical block sources.
- **Used by** — global Notebooks and Apps that own or use the domain. Selecting
  one opens the exact source; it never creates a domain-local copy
  (`PRD-001`, `UI-001`). Old `domainSection=notebooks|apps` links land here.

One vocabulary is used everywhere: Domain, Subject area, Model, Relationship,
Term, Concept, Skill. Join proofs, contracts, interfaces, evaluations, dbt scope
and Knowledge 360 are not tabs; their evidence stays in retrieval, validation,
the inspectors and "What Ask will do". Unknown sections normalize to Map.

Domain, subject area, section and selection round-trip through `domain`,
`modelArea`, `domainSection` and `domainObject` URL parameters and a mirrored
local location. "Ask about <domain>" carries the domain and qualified subject
area into a visible, removable Ask scope (`UI-006`).

Long-running Ask and Research turns progressively explain the active governed
work instead of showing generic loading copy (`UI-003`).

## Map

The canvas is the unified analytical model from
`04-domain-modeling-and-governance.md`.

- one compact toolbar row: add/bind a model, connect, layout, column density,
  fit, legend, AI dock, export and inspector toggle;
- nodes move and resize freely with remembered layout; fit accounts for the
  inspector;
- dragging a column handle to another column opens the relationship builder
  with both models and columns filled in; "+ Add a related model" binds the new
  model and then opens the relationship to it;
- edges take the colour of their status, the same one the legend and inspector
  name: Certified, Validated, Draft, Needs recheck, Retired;
- Business view is the default; Data view exposes relations, columns, tests and
  column handles.

## Relationship builder

A relationship reads as a sentence (`UI-033`):

> Each **Order** belongs to one **Customer**, matched on
> Order.customer_id = Customer.customer_id.

- Every column picker is labelled with its model, so the two sides of a key
  cannot be confused. Swap flips the models, keys and direction.
- Key suggestions come first from dbt `relationships` tests between the two
  models (either direction), then from naming (`customer_id` → `id` on
  customers, when the other side has no `customer_id`), then from shared
  identifier names.
- Choosing the columns runs the **warehouse check** automatically: one statement
  measures rows, matched and unmatched rows, empty keys and the most rows per key
  on each side. The cardinality the data shows is proposed (fanout follows:
  every join except many-to-many keeps each row once) and the evidence is written
  for that proposal. Choosing another cardinality re-runs the check for it; a
  check for other keys, cardinality or fanout is never saved as evidence.
- The person chooses what Ask may do with it: **Draft** (a hint only),
  **Validated** (checked safe to join; preferred when Ask writes SQL) or
  **Certified** (Ask must join these models on exactly these keys). A level that
  cannot be saved says why — no check, a failed check, or a model without a
  grain for certification — and nothing is silently downgraded.
- Name, description, subject area, join types, roles, optionality, aggregation
  sources, imports, attribution block, evidence expiry, owner and Retire are
  under "More details". Ids are short and unique (`orders_to_customers`,
  `orders_to_customers_2`).
- Escape closes an open picker before the dialog, and closing with unsaved input
  asks first. Saving opens the reviewed proposal, which names the level the
  relationship is saved at.

## Inspectors and editing

Model inspector: business context, concepts, analytical role, dbt identity,
grain/keys, columns, provenance and source. Relationship inspector: the
sentence, the status badge and what it means for Ask, the keys named by model,
the warehouse check in plain sentences, then details. dbt-owned fields are
read-only; editing them opens a guarded dbt source patch. DQL-owned changes
preview and write domain source (`UI-002`).

## What Ask will do

For the selected domain (and subject area) a drawer lists, from the same sources
Ask reads (`SKILL-007`):

- required filters that are always applied, with the skill that requires them;
- the skills that can guide answers, when each is used (its trigger words or
  vocabulary, or "never" when it has neither) and its enforced rules; then the
  project-wide skills;
- relationships grouped as joins Ask must use, prefers, treats as hints, or that
  need a recheck;
- data shared by other domains and the purpose it is approved for;
- counts of terms, concepts and certified blocks.

## Theme and accessibility contract

Preserve `<html data-theme="paper|white|obsidian">`, the shared semantic token
vocabulary, `dql-theme`, and its storage event listener. New components use
semantic tokens only. All icon-only controls require labels/tooltips, canvas
actions have keyboard alternatives, focus is visible, and status is never
communicated by colour alone (every badge carries its word).

## UI acceptance

Browser acceptance starts the built CLI with `dql notebook` against the
dedicated fixture. It covers the single header and tab bar, Used by routing and
old-link fallback, Domain settings, Terms & concepts create/edit, the
relationship builder (suggestion, automatic check, proposed cardinality, level
blockers, discard guard), the inspector, "What Ask will do", theme changes and a
Cloud embed-contract check. Vite-only screenshots are insufficient.
