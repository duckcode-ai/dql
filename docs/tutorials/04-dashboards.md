# 04 — Dashboards (assembling daily-ops)

**Who this is for:** App owners + analysts composing dashboards from
certified blocks.

**What you'll do:** build `apps/cards-ops/dashboards/daily-ops.dqld` — a
real grid layout with KPI tiles, a trend, and a drill-down — all referring
to the certified blocks Mei wrote in tutorial 02.

**Time:** 20 minutes.

---

## The `.dqld` mental model

`.dqld` files are **layout-only**. They reference blocks by id (or path),
pin a viz type per tile, and wire params + filters. The blocks themselves
own SQL, governance, RLS, and tests.

Think of it as: **dashboard = grid + viz config + block refs**. The blocks
do the work; the dashboard does the layout.

---

## Step 1 — Replace the auto-scaffolded dashboard

The `dql app new` command in tutorial 03 created an empty `overview.dqld`.
Rename it and fill it in:

```bash
mv apps/cards-ops/dashboards/overview.dqld \
   apps/cards-ops/dashboards/daily-ops.dqld
```

Replace its contents with:

```json
{
  "version": 1,
  "id": "daily-ops",
  "metadata": {
    "title": "Cards — Daily Operations",
    "description": "Daily transaction volume, chargebacks, and fraud snapshots.",
    "domain": "cards",
    "tags": ["daily", "ops", "fraud"]
  },
  "params": [
    { "id": "as_of_date", "type": "date", "default": "today",
      "description": "Snapshot date." }
  ],
  "filters": [
    { "id": "region", "type": "select",
      "options": ["ALL", "NA-NE", "NA-W", "EMEA", "APAC"],
      "default": "ALL", "bindsTo": "region" }
  ],
  "layout": {
    "kind": "grid",
    "cols": 12,
    "rowHeight": 80,
    "items": [
      { "i": "kpi-volume", "x": 0, "y": 0, "w": 3, "h": 2,
        "title": "Today's Volume",
        "block": { "blockId": "daily_transaction_volume" },
        "viz":   { "type": "single_value", "options": { "format": "currency" } } },

      { "i": "kpi-chargeback", "x": 3, "y": 0, "w": 3, "h": 2,
        "title": "Chargeback Rate",
        "block": { "blockId": "chargeback_rate" },
        "viz":   { "type": "kpi", "options": { "suffix": "%" } } },

      { "i": "kpi-fraud", "x": 6, "y": 0, "w": 6, "h": 2,
        "title": "Fraud Exposure (24h)",
        "block": { "blockId": "fraud_alerts_by_region" },
        "viz":   { "type": "kpi" } },

      { "i": "trend-volume", "x": 0, "y": 2, "w": 12, "h": 4,
        "title": "Daily transaction volume",
        "block": { "blockId": "daily_transaction_volume" },
        "viz":   { "type": "line", "options": { "x": "day", "y": "volume_usd" } } },

      { "i": "fraud-bar", "x": 0, "y": 6, "w": 6, "h": 4,
        "title": "Fraud by region",
        "block": { "blockId": "fraud_alerts_by_region" },
        "viz":   { "type": "bar", "options": { "x": "region", "y": "exposure_usd" } } },

      { "i": "fraud-merchants", "x": 6, "y": 6, "w": 6, "h": 4,
        "title": "Top merchants by exposure",
        "block": { "blockId": "fraud_by_merchant" },
        "viz":   { "type": "table" } }
    ]
  }
}
```

Save.

---

## Step 2 — Update the App's homepage to point at the renamed dashboard

We renamed `overview` → `daily-ops`. Open `apps/cards-ops/dql.app.json`
and confirm:

```json
"homepage": { "type": "dashboard", "id": "daily-ops" }
```

(That's already what tutorial 03 set, so you should be done.)

---

## Step 3 — Compile and inspect

```bash
dql app build
```

> **You should see**
> ```text
>   ✓ Built 1 app(s), 1 dashboard(s).
>     - cards-ops: 1 dashboard(s)
> ```

No diagnostics this time — the homepage points at a dashboard that exists.

Confirm block resolution:

```bash
node -e "
  const m = require('./dql-manifest.json');
  const d = m.dashboards['daily-ops'];
  console.log({
    appId: d.appId, title: d.title,
    blockIds: d.blockIds, unresolved: d.unresolvedRefs,
    items: d.layout.itemCount
  });
"
```

> **You should see**
> ```js
> {
>   appId: 'cards-ops',
>   title: 'Cards — Daily Operations',
>   blockIds: [
>     'daily_transaction_volume',
>     'chargeback_rate',
>     'fraud_alerts_by_region',
>     'fraud_by_merchant'
>   ],
>   unresolved: [],
>   items: 6
> }
> ```

`unresolved: []` is the important bit. If you see anything in there, the
dashboard is referencing a block id that doesn't exist (typo, or the block
isn't compiled). Re-run `dql certify` for that block.

---

## Step 4 — Open the dashboard in the desktop UI

```bash
dql notebook
```

1. Click **Apps** in the activity bar.
2. Click `Cards — Operations` in the left list.
3. The dashboard tab `daily-ops` is selected by default (it's the homepage).

> **You should see** the grid laid out:
>
> ```
>  ┌─Today's Volume──┬─Chargeback Rate─┬─Fraud Exposure (24h)──────────────┐
>  │   single_value  │      kpi        │              kpi                  │
>  ├─────────────────┴─────────────────┴───────────────────────────────────┤
>  │              Daily transaction volume   (line)                        │
>  ├─────────────────────────────────────┬─────────────────────────────────┤
>  │       Fraud by region (bar)         │   Top merchants by exposure     │
>  │                                     │            (table)              │
>  └─────────────────────────────────────┴─────────────────────────────────┘
> ```

Each tile shows:
- **Title** (top-left)
- **Viz type pill** (top-right)
- **Block ref** (small mono text)
- A placeholder line *"Live data preview lands when the dashboard executor
  ships."*

> **A note on data rendering.** Today the DashboardRenderer ships layout +
> metadata with placeholder cells. The dashboard executor — which will
> stream live block results into each tile — is the next slice. The
> programmable model (RBAC, RLS, lineage, Apps) is fully in.

---

## Step 5 — Persona-switch to validate the dashboard's RLS posture

While in the App view:

1. Click `View as: Owner ▾`.
2. Pick **Li (Branch Manager NYC-042) [branch_viewer]**.

> **You should see** the chip update. Lineage edges to RLS-decorated blocks
> (`fraud_alerts_by_region` is `@rls`-tagged on `region` + `branch`) will
> resolve under Li's persona when the live executor lands.

You can verify the persona is set on the server:

```bash
curl -s http://127.0.0.1:3475/api/persona | jq
```

> **You should see**
> ```json
> {
>   "persona": {
>     "userId": "li.park@acme-bank.com",
>     "displayName": "Li (Branch Manager NYC-042)",
>     "roles": ["branch_viewer"],
>     "attributes": { "region": "NA-NE", "branch": "NYC-042" },
>     "rlsContext": {
>       "user.region": "NA-NE",
>       "user.branch": "NYC-042"
>     },
>     "appId": "cards-ops"
>   }
> }
> ```

The `rlsContext` is the runtime substitution map the executor uses for
`@rls("col", "{user.var}")` decorators.

---

## Step 6 — Add a second dashboard for the fraud-watch schedule

We'll need a second dashboard so [tutorial 05](./05-schedules-and-slack.md)
can wire two different schedules. Create
`apps/cards-ops/dashboards/fraud-watch.dqld`:

```json
{
  "version": 1,
  "id": "fraud-watch",
  "metadata": {
    "title": "Cards — Fraud Watch (real-time)",
    "description": "Rolling 24h fraud snapshot. Triggered by the cron schedule.",
    "domain": "cards"
  },
  "layout": {
    "kind": "grid",
    "cols": 12,
    "rowHeight": 80,
    "items": [
      { "i": "by-region", "x": 0, "y": 0, "w": 12, "h": 4,
        "title": "Fraud exposure by region (24h)",
        "block": { "blockId": "fraud_alerts_by_region" },
        "viz":   { "type": "bar" } },
      { "i": "by-merchant", "x": 0, "y": 4, "w": 12, "h": 4,
        "title": "Fraud exposure by merchant (24h)",
        "block": { "blockId": "fraud_by_merchant" },
        "viz":   { "type": "table" } }
    ]
  }
}
```

Rebuild:

```bash
dql app build
```

> **You should see** `Built 1 app(s), 2 dashboard(s).` — and the App view
> in the UI now shows a second tab next to **daily-ops** for **fraud-watch**.

---

## What you now have

✓ A grid-laid-out dashboard composed from four certified blocks
✓ Filters + params declared and ready for the executor
✓ A second dashboard prepped for the Slack schedule
✓ App view in the desktop UI showing both dashboards under cards-ops

[Continue to tutorial 05 — Schedules and Slack delivery →](./05-schedules-and-slack.md)
