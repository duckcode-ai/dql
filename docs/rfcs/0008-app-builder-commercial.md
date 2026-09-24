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
| 5. Canvas | Done | One grid engine in core (`apps/grid-layout`): a tile keeps the cell it was given, only overlaps move, empty rows close. Used by the draft reducer on save, the Studio canvas (drag by header, resize from edges, arrow keys, Shift+arrows, duplicate, Delete, undo) and the reader, which no longer re-ranks tiles. Editing, adding or removing a tile reruns only that tile; publishing still needs a full page run. Undo survives a reload (per draft, in the browser). Loading tiles show a skeleton of their shape. Tablet and phone layouts stay derived. |
| 6. Reader trust | Done | One reader vocabulary (certified, governed, needs review, blocked) worked out from run evidence (`reader-trust.ts`), with trust colour tokens in every theme. Every data tile shows its label and freshness; the label, or a KPI's number, opens a receipt (source, owner, filters, rows, time, result and SQL fingerprints, snapshot, run) that links to the query and SQL. Trust Lens outlines tiles by trust and the page says how many are certified. Tiles gain `description` and `owner`, edited in Studio. The reader asks for a full run when no tile is hidden, so the page story shows again on a normal open; author-only wording left the reader. Studio saves run one at a time, fixing a conflict when two fields saved together. |
| 7. Driver tiles | Done | "Why did it move?" with no AI: a driver definition (measure, time field, grain, period, comparison, dimensions or `*`) expands in the page run into ordinary governed Dataset comparison tiles — the whole measure plus one per dimension — so contract checks, filters, cache and evidence are the Dataset tile path. Their rows fold through the Research engine's exact-decimal contribution maths into a ranked split by member (additive shares, reconciliation, new and gone members, Other). Readers ask it from any trend tile (a bounded probe with the page's filters that never changes the App); authors add it as a tile from Studio and set its period, comparison and dimensions. A period with no data says so instead of guessing. Ratio mix/rate split is not in this step. |
| 8. Story layout | Done | A page can show as a story: `narrative` blocks of prose and embedded tiles. Every figure in the prose is a `{{binding}}` to a tile result (single values, members of grouped tiles, leaders, driver results), filled from the current run; a literal number is refused when the page is saved or parsed. Studio has a Dashboard/Story switch, a story editor with value insertion and live preview, and "Draft with AI": the configured model (tested with local Ollama `qwen3.8:27b`, about 50 s) writes around binding keys only, every draft is checked (known keys, no literal numbers, real tiles), one corrective retry, then a deterministic draft from the data. Result values reach the model only when it runs on this machine. Published story pages record an edition per change in their bound values (`.dql/local/story-editions`), and readers see what changed since the last edition. Also fixed: driver tiles now pass publish validation, reader filter coverage and the certified count. |
| 3d. Retire legacy paths | Deferred | The in-place editor is still the only place a published App shows review-required AI pins; Studio must show them first. `app-planner.ts` exports a type live code uses. The chat builder backs the `build_dql_app` MCP tool. |

## File format

All additions are optional fields on `.dqld` version 3. Step 5 needed no
version change: `layout.items` already carried `x, y, w, h`; saves now keep
them instead of re-packing rows. The derived tablet and phone projections are
still written to the file; storing only the desktop layout is a later clean-up.

- **Tile `description`** (markdown, readers see it as plain text, at most 2000 characters) and `owner` (at most 120) — built in step 6.
- **`viz.style`** (built in step 4) — `labels` (`none | last | all`), `stack`,
  `format` (`number | compact | currency | percent`), `palette`, `legend`,
  `sort`, `referenceLines[]`, `bands[]`, `annotations[]` (`{at, text}`, kept
  in git). Encodings stay in `viz.options` (`x`, `y`, `color`). Table rules
  (colour scales, data bars) are still to come. No second y-axis: two
  measures are indexed to one axis.
- **App `theme`** in `dql.app.json` — `{ base: "paper" | "obsidian" |
  "editorial" | "brand", accent?, series? }`. Brand palettes are validated
  on save.
- **Driver tile** (built in step 7) — `driver: { version, measure, timeField, grain, anchor, comparison, dimensions, timezone? }` on a tile with the Dataset's `sourceId`; `viz.type: "waterfall"`.
- **Story page** (built in step 8) — `narrative: { version, presentation: "story"|"dashboard", blocks: [{kind:"text", markdown}|{kind:"tile", tileId}], generatedBy?, model? }`; figures only as `{{tileId.field}}`, `{{tileId.field[member]}}`, `{{tileId.leader}}` or driver keys (`.current`, `.prior`, `.change`, `.change_percent`, `.top_member`).
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
