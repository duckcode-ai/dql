# Concepts

> ~4 minutes · the mental model behind every feature

DQL has five primitives. Once these click, the rest of the docs read like
reference material.

## 1. Notebook

A `.dql` file containing an ordered list of cells. Cells can be:

- **SQL** — free-form queries against any connected warehouse
- **DQL** — reference semantic objects via `@metric(name)` / `@dim(name)`
- **Markdown** — commentary, docs, dashboards-as-code
- **Param** — text/select/date/number inputs wired into downstream cells

Notebooks live in git. Results never do (they go in a sibling
`.run.json` that's git-ignored by default — see [Run Snapshots](./reference/file-formats.md#run-snapshots)).

## 2. Block

A **named, versioned, governed** analytics artifact. Think of a block as a
dbt model that ships with a chart spec and governance metadata (owner,
certification status, tags).

```dql
block revenue_by_segment {
  domain: "finance"
  owner:  "analytics@company.com"
  tags:   ["revenue", "certified"]

  query: |
    select segment, sum(amount) as revenue
    from @table("orders")
    group by 1

  visualization: bar(x: "segment", y: "revenue")
}
```

Blocks are authored in **Block Studio** (an editor with lint, preview,
lineage, and a promote-to-certified flow). They compile to SQL + a chart
spec and are embeddable in notebooks, dashboards, or other blocks.

## 3. Semantic layer

The shared vocabulary of the business — **metrics** (measures),
**dimensions** (attributes), **hierarchies** (drill paths), **cubes**
(pre-joined fact/dim sets). DQL imports from dbt's semantic layer by default
and lets you author the rest locally.

In a DQL cell, `@metric("revenue")` and `@dim("customer.segment")` resolve
against the semantic layer — no hand-written joins.

## 4. Lineage

A graph of every **table → block → notebook → dashboard** edge in the
project, built from AST-level SQL parsing (not regex). The lineage panel
renders it with React Flow; the CLI exposes it via
`dql lineage impact <name>` and friends.

Lineage answers three questions:

- *What depends on this table?* (impact analysis)
- *Where did this number come from?* (trust chain)
- *What's shared across teams?* (cross-domain detection)

## 5. Dashboard

A compiled, static HTML artifact built from one or more blocks + markdown +
params. Dashboards are **files on disk**, not rows in a SaaS DB — you host
them on anything that serves HTML.

---

## How they fit

```
dbt models ──┐
             ├─▶ semantic layer ──▶ blocks ──▶ notebooks ──▶ dashboards
warehouse ───┘                        │
                                      ▼
                                   lineage DAG
```

With that mental model loaded, [the guides](guides/README.md) all make sense.
