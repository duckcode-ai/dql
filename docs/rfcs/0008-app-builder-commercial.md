# RFC 0008: App Builder for commercial use — one pipeline, visible trust, three layouts

| Field              | Value                                                                        |
| ------------------ | ---------------------------------------------------------------------------- |
| **Author(s)**      | @KKranthi6881                                                                |
| **Status**         | Accepted; building step by step                                              |
| **Created**        | 2026-09-23                                                                   |
| **Builds on**      | RFC 0007 (Datasets and tile queries)                                         |
| **Implementation** | branch `claude/app-builder-commercial` (RFC 0007 series rebased onto `main`) |
| **Design**         | canvas https://claude.ai/artifact/X6Xp9ZbbF3Rfq6VWxgscz8                     |

## Summary

Apps should be good enough to replace a Tableau, Power BI or Hex dashboard,
while keeping what those products lack: every number on the page can prove
where it came from. This RFC fixes the order of work and the file-format
changes. It adds no second execution path. Every author — a person in Studio,
the App AI planner, Autopilot, or an Ask answer added to an App — writes the
same draft operations into the same `.dqld` page, and every tile is checked
by `validateTileQuery`, run by the page-run endpoint and published through
preflight exactly as RFC 0007 describes.

## Principles

1. **One pipeline.** Manual and AI authoring differ only in who fills in a
   tile's query, `viz` and layout. The renderer never knows who authored it.
2. **Trust is visible.** Readers see one vocabulary — certified, governed,
   review, blocked — on every tile, with freshness and a receipt behind every
   number. Hashes stay in the evidence panel for authors.
3. **AI proposes, people apply.** Proposals stay typed and hashed. Page-level
   proposals become additive, with accept or reject per tile.
4. **Files stay reviewable.** A page stores one layout; phone and tablet
   layouts are derived. New fields are optional so v3 pages keep loading.

## Steps

Each step lands as its own commits with tests and leaves `main` releasable.

| Step | Scope | Exit check |
| ---- | ----- | ---------- |
| 1. Brand tokens | Deep-teal accent in every theme; caption contrast; one validated chart palette per theme; tabular numerals; no hard-coded purple | token test, palette test, notebook suite |
| 2. App type and colour system | App Studio and reader use the type scale (11–32), weights 400/500/600, radii 4/8/12, and status tokens only | style test extended |
| 3. Consolidate | Page AI targets the open page and is additive with per-tile accept; App copilot scoped to its App and filters server-side; schedules run every certified tile type; old editor and chat builder retired | apps-api, agent-run and schedule tests |
| 4. Viz spec v2 | `viz` gains encodings, style, labels, reference lines and bands, annotations and table rules; one renderer draws it for Apps, notebook cells and Ask answers | schema round-trip, renderer tests |
| 5. Canvas | Free grid with resize, snap, duplicate, keyboard; saved undo; only edited tiles rerun | Studio tests |
| 6. Reader trust | Trust and freshness on every tile, receipts, Trust Lens, tile descriptions | reader tests |
| 7. Driver tiles | “Why did it move?” runs the investigation engine and can be pinned as a `driver` tile that reruns on refresh | investigation and tile tests |
| 8. Story layout | Page `layout: "story"` with text whose `{{bind}}` numbers are checked against receipts | story checker tests |
| 9. Canvas pages | Page `kind: "canvas"`: sandboxed HTML plus named bindings, each a tile query; no naked numbers | binding and sandbox tests |
| 10. Distribution | Share links, PDF / PNG / signed HTML, rendered digests, monitors, visual PR diff | per feature |

## Progress

| Step | State | Notes |
| ---- | ----- | ----- |
| 0. Branch | Done | RFC 0007 series rebased onto `main`, DuckDB data-loss fix included; two calendar-dependent Ask trace tests fixed (they failed on `main` too) |
| 1. Brand tokens | Done | Teal in every theme, validated chart series and heatmap ramp, tabular digits, no purple or gradient mark left |
| 2. App type and colour system | Done | Scale, weights, radii and status tokens pinned by `app-type-system.test.ts` |
| 3a. Page AI | Done | Targets the open page; add mode by default; Keep/Skip per proposed tile; only proposed tiles can be removed |
| 3b. App copilot scope | Done | Server resolves the App's domain and states the reader's filters in the question |
| 3c. Schedules | Done | Full-page runs through the App runtime; webhook delivery; digest with values, trust and failures |
| 4. Viz spec v2 | Done | `viz.style` validated in core and drafts; ECharts 6.1 draws 10 chart types everywhere ChartOutput is used, SVG kept for the rest and as fallback; Studio style panel; planner may style components |
| 3d. Retire legacy paths | Deferred | The in-place editor is still the only place a published App shows review-required AI pins; Studio must show them first. `app-planner.ts` exports a type live code uses. The chat builder backs the `build_dql_app` MCP tool. |

## File format

All additions are optional fields on `.dqld` version 3 until step 5, which
introduces version 4 only if the single-layout change needs it.

- **Tile `description`** (markdown, readers see it) and `owner`.
- **`viz.style`** (built in step 4) — `labels` (`none | last | all`), `stack`,
  `format` (`number | compact | currency | percent`), `palette`, `legend`,
  `sort`, `referenceLines[]`, `bands[]`, `annotations[]` (`{at, text}`, kept
  in git). Encodings stay in `viz.options` (`x`, `y`, `color`). Table rules
  (colour scales, data bars) are still to come. No second y-axis: two
  measures are indexed to one axis.
- **App `theme`** in `dql.app.json` — `{ base: "paper" | "obsidian" |
  "editorial" | "brand", accent?, series? }`. Brand palettes are validated
  on save.
- **Driver tile** — `driver: { metric, current, comparison, dimensions }`.
- **Story page** — `layout: "story"`, `blocks[]` of markdown with bindings.
- **Canvas page** — `kind: "canvas"`, `html` path, `bindings{}` of tile queries.

## Colour and type

Deep teal is the brand in every theme and doubles as the certified colour.
Governed is ink blue, review is amber, blocked is red. Chart deltas use blue
for up and orange for down, always with an arrow. Series colours come from
fixed, validated palettes (colour-blind separation and contrast checked for
both light and dark), assigned in order and never cycled.

## Out of scope

Joining two Datasets in one tile (RFC 0007, D2), multi-user review, SSO, RBAC
and hosting; those belong to the commercial server.
