# 02 — Authoring blocks (Mei the analyst)

**Who this is for:** analysts who'll author and certify reusable analytics
blocks.

**What you'll do:** play **Mei Chen**, a Cards Analyst at Acme Bank. You'll
write a real fraud block with `@rls` decorators, agent-facing metadata, tests,
and walk it through the certification gate.

**Time:** 25 minutes.

---

## The scenario

Raj (Head of Cards) just paged Mei: "I need a single block that gives us
**fraud alerts in the last 24h, grouped by region and branch**, but it must
respect branch-level data isolation so we can re-use it on the
branch-manager dashboard later." Mei opens the desktop UI.

---

## Step 1 — Open Block Studio

In the desktop UI:

1. Click **Files** in the activity bar.
2. Click **+ New** → **Block**.
3. Name it `fraud_alerts_by_region`. Domain: `cards`. Hit **Create**.

> **You should see** a CodeMirror editor open with a starter `.dql` template
> and three tabs along the top: **Validate · Results · Save**.

The file lives at `blocks/fraud_alerts_by_region.dql`.

---

## Step 2 — Write the SQL + metadata

Replace the template with this full block. We'll walk through each section
afterwards.

```dql
// blocks/fraud_alerts_by_region.dql
// dql-format: 1

@rls("region", "{user.region}")
@rls("branch", "{user.branch}")

block "fraud_alerts_by_region" {
  domain      = "cards"
  type        = "custom"
  owner       = "mei.chen@acme-bank.com"
  description = "Fraud alerts in the last 24h, grouped by region and branch."
  tags        = ["fraud", "cards", "real-time"]

  // ── Agent-facing metadata (v1.2 Track G) ────────────────────────────
  llmContext = """
    Use this block when asked about recent card-fraud alerts. The window is
    a rolling 24 hours from now(). Region/branch filters are applied at
    runtime via @rls based on the active persona — viewers scoped to a
    branch will only see their own rows. Alert reasons include velocity,
    merchant_blocklist, geo_anomaly, and amount_outlier.
  """
  examples = [
    { question = "Which regions had the most fraud last night?" },
    { question = "Show me the fraud at my branch." },
    { question = "Top branches by fraud exposure today." }
  ]
  invariants = [
    "exposure_usd >= 0",
    "alert_count >= 0",
    "row_count <= 10000"
  ]

  // ── Query ────────────────────────────────────────────────────────────
  query = """
    SELECT
      region, branch,
      COUNT(*)             AS alert_count,
      SUM(amount_usd)      AS exposure_usd
    FROM read_csv_auto('./data/fraud_alerts.csv')
    WHERE alert_ts >= now() - INTERVAL '24 hours'
    GROUP BY 1, 2
    ORDER BY exposure_usd DESC
  """

  visualization {
    chart = "bar"
    x     = "region"
    y     = "exposure_usd"
  }

  tests {
    assert row_count >= 0
    assert null_count(region) == 0
    assert min(exposure_usd) >= 0
  }
}
```

Hit **Cmd-S**. Block Studio auto-validates.

> **You should see** the **Validate** tab go green: `0 errors · 3 warnings`.
> The warnings are governance suggestions (next step). The **Results** tab
> shows three rows: EMEA / LON-018, NA-NE / NYC-042, etc.

### What each section is for

| Section | Purpose |
|---|---|
| `@rls(column, "{user.var}")` | Compile-time wraps the SQL in `SELECT * FROM (…) WHERE column = $param`. The `{user.var}` template is filled at execution time from the active persona's `attributes`. See [03 — RLS](./03-apps-rbac-personas.md). |
| `domain`, `owner`, `tags` | Routed into `dql-manifest.json` and the lineage graph. Required by the certifier. |
| `description` | Human-readable; shown in the Block Library + dashboards. |
| `llmContext` | One paragraph the agent uses to ground SQL generation and to score retrieval. **Required for agent recall — without it, the FTS5 KG only has the description to work with.** |
| `examples` | Few-shot pairs the chat cell + Slack bot use to disambiguate. |
| `invariants` | Free-form post-conditions used as prompt grounding. Not executable today, but agents respect them. |
| `query` | Your SQL. Triple-quoted so multi-line is comfortable. |
| `visualization` | Default chart for tiles that don't override. |
| `tests` | Assertions run by `dql certify` against a real connection. |

---

## Step 3 — Run the certification gate

Mei doesn't ship until certification passes. From the terminal:

```bash
cd ~/acme-bank
dql certify blocks/fraud_alerts_by_region.dql --connection duckdb
```

> **You should see**
> ```text
> Block: fraud_alerts_by_region (cards)
>
>   Rule                  Status   Severity
>   has-description       ✓        error
>   has-owner             ✓        error
>   has-domain            ✓        error
>   has-tags              ✓        warning
>   has-llm-context       ✓        warning
>   has-tests             ✓        warning
>   tests-pass            ✓        error
>   cost-reasonable       ✓        warning
>
>   Status: certified
> ```

The block's `status` flips from `draft` → `certified`. The metadata is now
committed to `.dql/registry.sqlite` (the block registry).

---

## Step 4 — Confirm it landed in the manifest

```bash
dql compile
```

This rebuilds `dql-manifest.json`. Inspect:

```bash
node -e "
  const m = require('./dql-manifest.json');
  const b = m.blocks['fraud_alerts_by_region'];
  console.log({
    name: b.name, status: b.status, domain: b.domain,
    chartType: b.chartType, tableDeps: b.tableDependencies, tags: b.tags
  });
"
```

> **You should see**
> ```js
> {
>   name: 'fraud_alerts_by_region',
>   status: 'certified',
>   domain: 'cards',
>   chartType: 'bar',
>   tableDeps: [ 'fraud_alerts' ],
>   tags: [ 'fraud', 'cards', 'real-time' ]
> }
> ```

---

## Step 5 — See it in the lineage graph

```bash
dql lineage --block fraud_alerts_by_region
```

> **You should see**
> ```text
> block:fraud_alerts_by_region (certified · cards · mei.chen@acme-bank.com)
>   ↑ reads_from
> source_table:fraud_alerts
>
> Downstream: (none yet — add it to a dashboard or App)
> ```

Or click **Lineage** in the activity bar of the desktop UI for the
interactive React Flow + dagre view.

---

## Step 6 — Add a couple more blocks for the rest of the tutorials

Mei needs three more blocks so we have something to compose into a
dashboard later. Use **Block Studio → + New → Block** for each.

```dql
// blocks/daily_transaction_volume.dql
block "daily_transaction_volume" {
  domain = "cards"
  type   = "custom"
  owner  = "mei.chen@acme-bank.com"
  description = "Daily card transaction volume in USD."
  tags = ["cards", "volume"]
  llmContext = "Use for top-of-funnel transaction volume. Counts and amount_usd."
  query = """
    SELECT date_trunc('day', ts) AS day,
           COUNT(*)              AS txn_count,
           SUM(amount_usd)       AS volume_usd
    FROM read_csv_auto('./data/transactions.csv')
    GROUP BY 1 ORDER BY 1
  """
  visualization { chart = "line"; x = "day"; y = "volume_usd" }
  tests { assert row_count >= 0 }
}
```

```dql
// blocks/chargeback_rate.dql
block "chargeback_rate" {
  domain = "cards"
  type   = "custom"
  owner  = "mei.chen@acme-bank.com"
  description = "Chargeback rate (placeholder — replace with real charge_backs join)."
  tags = ["cards", "kpi"]
  llmContext = "Card chargeback rate as a percentage. Single-value KPI."
  query = """
    SELECT 0.42 AS chargeback_rate_pct
  """
  visualization { chart = "single_value" }
  tests { assert row_count == 1 }
}
```

```dql
// blocks/fraud_by_merchant.dql  (start as DRAFT — Mei will certify after the agent tutorial)
block "fraud_by_merchant" {
  domain = "cards"
  type   = "custom"
  owner  = "mei.chen@acme-bank.com"
  description = "Fraud exposure grouped by merchant."
  tags = ["fraud", "cards"]
  llmContext = "Use for 'which merchants are driving fraud' style questions."
  query = """
    SELECT m.merchant_name, m.mcc_code,
           COUNT(*)              AS alerts,
           SUM(f.amount_usd)     AS exposure_usd
    FROM read_csv_auto('./data/fraud_alerts.csv') f
    JOIN read_csv_auto('./data/merchants.csv')    m USING (merchant_id)
    GROUP BY 1, 2 ORDER BY exposure_usd DESC
  """
  visualization { chart = "bar"; x = "merchant_name"; y = "exposure_usd" }
  tests { assert row_count >= 0 }
}
```

Certify all three:

```bash
dql certify blocks/daily_transaction_volume.dql --connection duckdb
dql certify blocks/chargeback_rate.dql           --connection duckdb
dql certify blocks/fraud_by_merchant.dql         --connection duckdb
```

> **You should see** all three flip to `certified`. We now have **four**
> certified blocks — enough to compose a real App.

---

## What you now have

✓ A `cards`-domain block with `@rls`, agent metadata, and tests
✓ A working understanding of every block-section field
✓ Three more certified blocks ready to compose into dashboards
✓ A `.dql/registry.sqlite` and `dql-manifest.json` populated with the cards domain

[Continue to tutorial 03 — Apps, RBAC, and personas →](./03-apps-rbac-personas.md)
