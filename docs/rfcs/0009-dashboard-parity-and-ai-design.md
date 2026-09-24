# RFC 0009: Dashboard parity with Tableau and Power BI, and AI that designs

| Field              | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| **Author(s)**      | @KKranthi6881                                                         |
| **Status**         | Accepted; building step by step                                       |
| **Created**        | 2026-09-24                                                            |
| **Builds on**      | RFC 0007 (Datasets and tile queries), RFC 0008 (App Builder commercial) |
| **Implementation** | branch `claude/app-builder-commercial`                                |

## Summary

DQL is sold as an agentic analytics platform that customers run on their own
infrastructure: cost-effective, secure, and their data never leaves. For the
dashboard to replace Tableau or Power BI, two things must be true at once:

1. **Nothing a Tableau or Power BI author relies on is missing.** They build
   the way they already know: drag fields onto shelves, let the tool pick a
   chart, add a quick calculation, format a table, drill, filter, export.
2. **AI is a real step up, not a chat box.** Describe a page and get a
   well-designed one built from certified blocks. Ask why a number moved and
   get an answer that reconciles. Turn a page into a board-ready story in one
   step. Every figure stays provable.

RFC 0008 made the App trustworthy: contract-checked tiles, trust labels,
receipts, drivers, stories, governed HTML pages, signed exports, alerts and
review diffs. This RFC closes the craft gap in the builder and makes AI the
fastest way to a stunning, correct page. It adds no second execution path:
every new feature compiles to a checked `TileQuery` (or a checked calculation
on top of one), runs through the page-run endpoint, and publishes through
preflight.

## What we heard and what exists

The evaluation of RFC 0008 and a feature review against Tableau and Power BI
(September 2026) found the governance ahead of both, and the builder behind:

- Chart choice is a rule of thumb: no dimension and one measure makes a KPI,
  a time field makes a line, anything else makes a bar.
- The Query editor offers a single "Group by". Several dimensions are only
  possible by clicking fields in the Data tab, and there is no shelf for
  colour, size, label or tooltip.
- Authors cannot write a calculation. Measures come only from the Dataset,
  and the only built-in calculations are period comparison and top-N.
- Pivots, maps, conditional formatting, highlight actions, tooltips with
  detail, layout containers and an editable phone layout do not exist.

Already in place and kept:

- Governed Datasets from certified blocks and semantic models, with a
  per-measure additivity contract.
- Time grains, period comparison, filters, top-N, bounded row detail.
- Ten ECharts types: bar, grouped bar, stacked bar, line, area, scatter, pie,
  donut, heatmap, funnel.
- Reference lines and bands, annotations, KPI tiles.
- Drill down a declared hierarchy, cross-filter from a mark, go to a page
  (carrying filters), row detail.
- Relative-date, multi-select, search and number-range filters.
- A free grid with keyboard control and derived tablet and phone layouts.
- Trust labels, receipts, drivers, stories, governed HTML pages.
- CSV download, signed HTML / PNG / PDF, digests, alerts, share links,
  review diffs.

## Principles

1. **Familiar first.** A Tableau or Power BI author finds the same concepts
   in the same places: a Data pane, shelves, Show Me, a right-click field
   menu, a format pane, dashboard actions. Our words, their mental model.
2. **Every calculation is governed.** Calculations are typed expressions over
   approved fields that DQL compiles and checks. Additivity rules decide what
   is allowed (no sum of a distinct count, no average of a ratio). There is
   no free SQL on a dashboard. A calculation can be promoted into the
   certified block or semantic model through review.
3. **AI proposes, people apply.** Unchanged from RFC 0008: typed, hashed,
   per-tile Keep or Skip.
4. **One spec, one renderer.** New charts extend `viz` spec v2 and draw with
   ECharts. KPI and sparkline micro-visuals stay SVG. Exports and HTML pages
   draw from the same code.
5. **Self-hosted by default.** Maps, fonts and themes ship in the product; no
   call to a map tile server or font CDN. Result values reach a model only
   when the model runs on the customer's machine.
6. **Measured, not claimed.** Each milestone has an exit check, and parity is
   a checklist a verifier runs, not a slide.

## Parity checklist

Tiers: **P0** is what an author misses in the first hour (they switch back
without it), **P1** is expected within a month, **P2** is differentiation or
long tail. "Have" means shipped today.

### Building a chart

| Capability | Tableau / Power BI | DQL today | Tier | Plan |
| --- | --- | --- | --- | --- |
| Shelves: Columns, Rows, Colour, Size, Label, Tooltip, Detail | Marks card / field wells | Missing (encodings x, y, colour only in `viz.options`) | P0 | Step 1 |
| Drag and drop fields onto shelves | Yes | Missing (click only) | P0 | Step 1 |
| Several dimensions and measures in the editor | Yes | Partial (Data tab clicks) | P0 | Step 1 |
| Show Me: ranked chart suggestions with reasons | Yes | Rule of thumb | P0 | Step 2 |
| Right-click field menu: aggregation, sort, filter, format, rename | Yes | Missing | P0 | Step 1 |
| Aggregation choice per measure (sum, avg, min, max, count distinct) | Yes | Fixed by Dataset | P1 | Step 3 (only where the contract allows) |
| Number and date formats per field | Yes | Partial (tile-level format) | P0 | Step 1 |

### Calculations

| Capability | Tableau / Power BI | DQL today | Tier | Plan |
| --- | --- | --- | --- | --- |
| Quick calcs: % of total, running total, difference and % difference, rank, moving average, YoY | Table calcs / visual calcs | Missing (period comparison only) | P0 | Step 3 |
| Calculated measures (ratio, arithmetic, conditional) | Calculated fields / DAX measures | Missing | P0 | Step 3 |
| Groups, bins, buckets on dimensions | Groups, bins, sets | Missing | P1 | Step 3 |
| Parameters (what-if values used in calcs, top-N, filters) | Parameters / what-if | Partial (`limit: { param }`) | P1 | Step 3 |
| Level of detail (fixed / include / exclude) | LOD / CALCULATE | Missing | P2 | Later; governed grain covers most needs |

### Charts and tables

| Capability | Tableau / Power BI | DQL today | Tier | Plan |
| --- | --- | --- | --- | --- |
| Bar (grouped, stacked, 100%), line, area, scatter, pie, donut, heatmap, funnel | Yes | Have (no 100% stacked) | P0 | Step 4 adds 100% |
| Combo bar + line | Yes | Missing | P0 | Step 4 (one axis, or indexed; no dual axis) |
| Pivot / crosstab / matrix with subtotals and grand totals | Yes | Missing | P0 | Step 4 |
| Conditional formatting: colour scale, data bars, icons, rules | Yes | Missing | P0 | Step 4 |
| KPI with target, delta, sparkline | Yes | Partial (value only) | P0 | Step 4 |
| Maps: filled regions and points | Yes | Missing | P0 | Step 4 (bundled geography, offline) |
| Treemap, waterfall, bullet, box plot, histogram, gauge | Yes | Partial (waterfall, histogram and gauge in the older SVG renderer only; the rest missing) | P1 | Step 4 |
| Small multiples (trellis) | Yes | Missing | P1 | Step 4 |
| Trend line and forecast | Yes | Missing | P1 | Step 4 (labelled as a projection, never certified) |
| Tooltips with extra fields; a small chart inside a tooltip | Yes | Default tooltip | P1 | Step 6 |

### Interactivity

| Capability | Tableau / Power BI | DQL today | Tier | Plan |
| --- | --- | --- | --- | --- |
| Filter action from a mark | Yes | Have | — | — |
| Highlight and cross-highlight | Yes | Missing | P0 | Step 6 |
| Drill down a hierarchy | Yes | Have (declared hierarchies) | — | Step 6 adds date auto-hierarchy |
| Drill-through to a page with context | Yes | Have (go to page, carry filters) | — | — |
| Cascading filters ("only relevant values") | Yes | Partial (`dependsOn` declared) | P0 | Step 6 |
| Saved views / bookmarks | Yes | Missing | P1 | Step 6 (local views in OSS; shared views commercial) |
| Parameter actions | Yes | Missing | P2 | Step 6 |

### Layout and pages

| Capability | Tableau / Power BI | DQL today | Tier | Plan |
| --- | --- | --- | --- | --- |
| Free grid, snap, resize, keyboard | Yes | Have | — | — |
| Containers (horizontal/vertical), equal heights, distribute evenly | Yes | Missing | P0 | Step 5 |
| Padding, background, borders per tile | Yes | Missing | P1 | Step 5 |
| Images, logos, blank spacers, dividers | Yes | Text and headings only | P1 | Step 5 |
| Editable phone layout | Device designer / mobile layout | Derived only | P1 | Step 5 |
| Fixed page size for print and slides | Yes | Missing | P1 | Step 5 |
| Themes and brand palette | Yes | Paper / White / Obsidian | P1 | Step 5 (brand palette validated for colour-blind contrast) |

### Consumption

| Capability | Tableau / Power BI | DQL today | Tier | Plan |
| --- | --- | --- | --- | --- |
| Export data (CSV, Excel) | Yes | CSV per tile | P0 | Step 7 adds Excel with formats |
| Export PDF / image | Yes | Have (signed) | — | — |
| Subscriptions and alerts | Yes | Have | — | — |
| View underlying data | Yes | Partial (row detail tiles) | P1 | Step 7 ("show the rows behind this mark", bounded) |
| Comments on a page | Yes | Missing | P2 | Commercial server |
| Embed in another app | Yes | Missing | P1 | Commercial server |

## The AI step up

These are where DQL leads rather than catches up. Each one is built on the
parity work, so AI uses the same shelves, calculations and charts a person
does.

1. **Describe a page, get a designed one.** The planner already builds pages
   from certified Datasets. With Show Me v2 and governed calculations it can
   choose the right chart for each question, add the calculation that makes
   the point (share of total, YoY), order the page as an argument (headline,
   trend, breakdown, detail), and title each tile with its finding. Every
   tile stays a checked query, with Keep or Skip.
2. **Design pass.** "Make it board-ready" applies a design system to a page:
   consistent type, one accent, annotations on the moments that matter,
   callouts bound to data, and either a tidy dashboard, a story, or a
   governed HTML page. Colours come only from validated palettes.
3. **Explain on every chart.** "Why did it move?" (drivers, done) plus
   statistical flags on trend charts (unusual points, level shifts), with no
   AI in the numbers and AI only in the wording, checked against bindings.
4. **Ask the page, pin the answer.** The App copilot answers within the
   page's filters and pins its answer as a tile, with a certification path.
5. **Bring your Tableau and Power BI work.** Import a Tableau workbook
   (`.twb` / `.twbx` XML) or a Power BI project (`.pbip` report JSON):
   - Map each worksheet or visual to governed Datasets and fields.
   - Rebuild it as a DQL page.
   - List clearly what could not be mapped: a calculation that needs review,
     a custom visual, an unmatched field.

   This is the biggest adoption lever for "don't lose the traditional way".
6. **Accuracy you can show.** A benchmark for AI-built pages, reported like
   the Ask benchmarks:
   - share of proposed tiles that pass the contract;
   - share whose values match an independent query;
   - share an author kept.

## Governed calculations (the key design)

A calculation is stored on the tile (or promoted to the page) as a typed
expression, never as SQL:

```json
{
  "id": "aov",
  "label": "Average order value",
  "expr": { "op": "divide", "left": { "measure": "revenue" }, "right": { "measure": "order_count" } },
  "format": { "kind": "currency" }
}
```

- **Quick table calculations** run over the tile's result at its grain:
  - percent of total, running total, difference, percent difference, rank,
    moving average, year over year.
  - They are compiled into window functions in the tile's SQL, so the
    receipt and fingerprints cover them.
  - They are allowed only where the measure's additivity makes them true:
    percent of total and running total need an additive measure.
- **Calculated measures:**
  - arithmetic of additive measures;
  - a ratio of two measures, computed as a ratio of sums, never an average
    of ratios;
  - conditional measures (sum of revenue where region is US);
  - constants and parameters.
  - The checker infers the result's additivity and unit.
- **Groups and bins:** member groups and numeric bins on approved
  dimensions, compiled to `CASE`.
- **Trust:**
  - a calculation over certified measures shows as **Governed** (checked
    arithmetic over certified inputs);
  - it becomes **Certified** only when promoted into the block or semantic
    model and reviewed there;
  - the receipt lists the expression.
- **Formula bar:** authors can type `revenue / order_count` or pick from
  menus. Both produce the same typed expression, and errors name the rule
  ("order_count is a distinct count; it cannot be summed across regions").

## Steps

Each step lands as its own commits with tests, keeps `main` releasable, and
ends with a verifier pass against the built CLI (as in RFC 0008).

| Step | Scope | Exit check |
| ---- | ----- | ---------- |
| 1. Builder UX v2 | Shelves (Columns, Rows, Colour, Size, Label, Tooltip, Detail) with drag and drop from the Data pane. Several dimensions and measures. Right-click field menu (sort, filter, format, rename, remove). Per-field number and date formats. The Query editor becomes the shelves. | Every P0 "Building a chart" row; keyboard and screen-reader operable; Codex rebuilds the Superstore overview without JSON. |
| 2. Show Me v2 | Ranked chart suggestions from field roles, counts, cardinality, time and additivity; each suggestion says why, and unsuitable charts are shown greyed out with the reason. The same ranking drives the AI planner. | Table of 40 field combinations with the expected first choice; planner uses it. |
| 3. Governed calculations | Quick table calcs, calculated measures, groups and bins, parameters; formula bar and menus; additivity checks; promote-to-certified flow. | Checker unit tests per rule; real-DuckDB tests that each calc matches an independent SQL result; refused cases explain the rule. |
| 4. Chart and table breadth | 100% stacked, combo, pivot with subtotals, conditional formatting, KPI with target and sparkline, filled and point maps (bundled geography), treemap, waterfall, bullet, box plot, histogram, small multiples, trend line and forecast. | Renderer tests per type in light and dark; exports and HTML pages draw them; palette validator passes. |
| 5. Layout parity | Containers with equal heights and distribute evenly, padding/background/border, images and dividers, editable phone layout, fixed page sizes, brand themes. | Layout engine tests; phone layout round-trips in the `.dqld`; review diff shows container changes. |
| 6. Interactivity parity | Highlight and cross-highlight, cascading filters, richer tooltips and tooltip charts, date auto-hierarchy, saved local views, parameter actions. | Interaction tests; filter coverage stays correct for calcs and drivers (the E1 lesson). |
| 7. Consumption parity | Excel export with formats, "show the rows behind this mark" (bounded, governed). | Export tests; row view respects filters and access. |
| 8. AI designer | Planner uses Show Me v2 and calcs; "make it board-ready" design pass; statistical flags on trends; copilot pins with certification path. | AI build benchmark: contract pass rate, value match, kept rate; local model and hosted model runs. |
| 9. Importers | Tableau `.twb/.twbx` and Power BI `.pbip` import to DQL pages with a mapping report. | Importer fixtures (5 workbooks each); unmapped items always listed, never dropped silently. |

Recommended order for the first release that can be sold against Tableau and
Power BI:

- **Milestone A:** steps 1, 2, 3 (quick calcs and calculated measures), and
  the P0 rows of step 4 (combo, pivot, conditional formatting, KPI with
  target, maps).
- **Milestone B:** steps 5 and 6, and the rest of steps 3 and 4.
- **Milestone C:** steps 7, 8 and 9.

## Progress

| Step | State | Notes |
| ---- | ----- | ----- |
| 1. Builder UX v2 | Done | Tiles carry `viz.encoding`: Columns, Rows, Colour, Size, Label, Tooltip, Detail, and a per-field name and number format. The checked query is derived from the shelves and still validated against the Dataset contract; pages and drafts refuse shelves naming fields the query lacks, and tiles without shelves draw exactly as before. Studio's new-tile and selected-tile editors show the shelves: fields arrive by drag from the Data pane or by click (a date runs along Columns, a category lists down Rows or splits a date chart by Colour, a measure takes the other axis), move by drag or from their menu, and the menu sets time grain, sort, filter, number format (compact, currency, percent, decimals) and name. The renderer follows the shelves (orientation, one series per measure, colour split, bubble size, labels, tooltip measures, names and formats in tables, charts, HTML pages and exports), and a line draws single points as dots. Detail with a bar, line or heatmap reads as a table with the reason, because one mark would have to merge several rows. Not in this step: aggregation choice per measure (step 3) and a keyboard path that places a Data-pane field on a named shelf directly (fields can be clicked in, then moved from their menu). |
| 2. Show Me v2 | Done | `dql-core` `apps/show-me` ranks 13 charts (KPI, line, area, horizontal and vertical bars, side-by-side, stacked, donut, pie, funnel, scatter, heatmap, table) from field roles, counts, the values a dimension has in the tile's last result, additivity from the Dataset contract (a distinct count or ratio is never stacked or sliced; an area needs a measure that adds up over time), negative values (no slices or stacks), and units (two units never share an axis quietly; there is no dual axis). Every chart comes back with a reason it fits or does not. Studio shows the ranking under the shelves and in the Visual tab for Dataset tiles and the new-tile draft: the best is marked, charts that do not fit are greyed out and say why on hover or focus, and a pick rearranges the shelves while keeping Label, Tooltip and field names. The AI planner takes the first choice for every Dataset tile it proposes, with shelves; detail and evidence components stay tables. Exit check: 42 field combinations with the expected first choice (`show-me.test.ts`). Not in this step: value counts at plan time (the planner has no result yet, so a long category over time is offered as lines until the tile runs), and charts step 4 adds (combo, waterfall, map, small multiples). |

## Measuring outcomes

- **Time to first page.** A new author connects a Dataset and publishes a
  four-tile page. Target: under 10 minutes, measured in a scripted
  walkthrough on every release.
- **Parity checklist pass rate.** A verifier runs every P0 and P1 row above
  against the built CLI. Target for Milestone A: all P0 rows pass.
- **Rebuild test.** Codex or a person rebuilds three reference dashboards
  from Tableau and Power BI examples (Superstore, a finance P&L, a sales
  pipeline) with no JSON editing, then scores what they could not do.
- **AI build benchmark.** On the insurance and commerce anchors:
  - the share of AI-proposed tiles that pass the contract;
  - the share that match independent SQL;
  - the share an author keeps;
  - time to a publishable page.

  Reported with denominators, like the Ask benchmarks.
- **No regressions in trust.** Zero wrong numbers shown as Certified. Every
  calculation's receipt shows its expression.

## Open-source and commercial boundary

Open source (self-hosted, single team):
- the whole builder, calculations, charts, layout and interactivity;
- AI build with local or bring-your-own models;
- exports, schedules and alerts;
- share links on the local network;
- importers.

Commercial server:
- multi-user review and comments, shared saved views;
- SSO and role-based access, row-level access per viewer, audit;
- embedding and a hosted viewer;
- scheduled delivery at scale.

This follows `AGENTS.md`: none of the commercial items are needed to close an
open-source step.

## Decisions needed

1. **Formula surface.** Typed formulas (`revenue / order_count`) plus menus,
   or menus only in Milestone A? Recommendation: both. Formulas are what
   Tableau and Power BI authors expect, and the typed checker makes them
   safe.
2. **Maps.** Bundle world countries, US states and a postcode centroid set
   (offline, about 5 MB), or require the customer to supply geography?
   Recommendation: bundle the three, allow custom GeoJSON.
3. **Importer priority.** Tableau first (XML, widely used, clearer mapping)
   or Power BI first (`.pbip` JSON, large market)? Recommendation: Tableau
   first, Power BI second in the same milestone.
4. **Forecasts.** Offer simple, explainable projections (linear, seasonal)
   marked "Projection, not certified", or leave forecasting to Research?
   Recommendation: offer them on line charts, clearly marked.
5. **Design first.** Mock the shelves builder, Show Me and the format pane on
   the RFC 0008 design canvas before building step 1. Recommendation: yes,
   one short design round.
