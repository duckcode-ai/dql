# 08 — Promoting AI answers to certified blocks

**Who this is for:** the analyst on the receiving end of the Uncertified
answers — the person responsible for "is this SQL actually right?"

**What you'll do:** play **Mei Chen**. You'll find a candidate, generalise
its SQL, add tests + governance metadata, run the certification gate,
commit the new block, reindex the KG, and confirm the same question now
returns Certified.

**Time:** 25 minutes.

---

## The pipeline

```
       Slack / UI / CLI / MCP question
                   │
                   ▼
       ┌─── answer-loop ────┐
       │                    │
       ▼                    ▼
 Certified block      Uncertified SQL
  (agent runs)         (agent shows + flags)
                         │
                         ▼
                   👍 / 👎 feedback
                         │
                ┌────────┴────────┐
                ▼                 ▼
       getPromotionCandidates  No promotion
       (≥ N ups, 0 downs)
                │
                ▼
        Mei reviews + saves
        as a real block
                │
                ▼
        dql certify   ←── governance gate
                │
                ▼
        Git PR  →  merge  →  dql agent reindex
                │
                ▼
        Same question now answers Certified
```

The gate is **`dql certify`** — see
[`packages/dql-governance/src/certifier.ts`](../../packages/dql-governance/src/certifier.ts).

---

## Step 1 — Find a candidate

We seeded one in [tutorial 07](./07-fraud-spike-walkthrough.md). Run:

```bash
cd ~/acme-bank
node -e "
  const { getPromotionCandidates } = require('@duckcodeailabs/dql-agent');
  for (const c of getPromotionCandidates(process.cwd(), 1)) {
    console.log('-', c.question, '(' + c.ups + ' ups)');
  }
"
```

> **You should see**
> ```text
> - which merchants drove the biggest fraud loss this morning between 2 and 3 am EST? (1 ups)
> ```

Pull the original answer + SQL the agent proposed. The cleanest way is to
re-run the question and capture the JSON shape:

```bash
dql agent ask "which merchants drove the biggest fraud loss this morning between 2 and 3 am EST?" \
  --format json > /tmp/proposal.json
jq '.proposedSql' /tmp/proposal.json
```

> **You should see** the same SQL the agent showed in Slack:
>
> ```sql
> SELECT m.merchant_name, m.mcc_code,
>        COUNT(*)             AS alerts,
>        SUM(f.amount_usd)    AS exposure_usd
> FROM read_csv_auto('./data/fraud_alerts.csv') f
> JOIN read_csv_auto('./data/merchants.csv')   m USING (merchant_id)
> WHERE f.alert_ts >= '2026-04-25 02:00:00'
>   AND f.alert_ts <  '2026-04-25 03:00:00'
> GROUP BY 1, 2
> ORDER BY exposure_usd DESC
> LIMIT 25
> ```

---

## Step 2 — Generalise it

Mei's first instinct: that hard-coded date range is wrong for a reusable
block. Generalise to a parameterisable rolling window. Decide on a
sensible default (24h), and let downstream callers override.

Create `blocks/cards/fraud_by_merchant_recent.dql`:

```dql
// blocks/cards/fraud_by_merchant_recent.dql
// dql-format: 1

@rls("region", "{user.region}")

block "fraud_by_merchant_recent" {
  domain      = "cards"
  type        = "custom"
  owner       = "mei.chen@acme-bank.com"
  description = "Top merchants by fraud exposure in the last 24 hours."
  tags        = ["fraud", "cards", "merchants", "real-time"]

  llmContext = """
    Use this block when asked "which merchants are driving fraud" or
    "top merchants by fraud exposure". Window is rolling 24h. Joins
    fct_fraud_alerts to dim_merchants. Region filter is applied at
    runtime via @rls based on the active persona; branch filtering
    is intentionally NOT applied because merchants span branches.
  """
  examples = [
    { question = "which merchants drove fraud overnight?" },
    { question = "top fraud merchants today" },
    { question = "fraud by merchant in EMEA this morning" }
  ]
  invariants = [
    "exposure_usd >= 0",
    "alerts >= 0",
    "row_count <= 100"
  ]

  query = """
    SELECT
      m.merchant_name,
      m.mcc_code,
      m.risk_band,
      COUNT(*)              AS alerts,
      SUM(f.amount_usd)     AS exposure_usd
    FROM read_csv_auto('./data/fraud_alerts.csv') f
    JOIN read_csv_auto('./data/merchants.csv')   m USING (merchant_id)
    WHERE f.alert_ts >= now() - INTERVAL '24 hours'
    GROUP BY 1, 2, 3
    ORDER BY exposure_usd DESC
    LIMIT 25
  """

  visualization {
    chart = "bar"
    x     = "merchant_name"
    y     = "exposure_usd"
  }

  tests {
    assert row_count >= 0
    assert null_count(merchant_name) == 0
    assert min(exposure_usd) >= 0
  }
}
```

Save.

> **A note on what changed from the agent's proposal.** Mei:
> - Renamed (`fraud_by_merchant_recent`) to make the time semantics clear.
> - Added `@rls("region", …)` because the cards domain enforces region
>   isolation. *Branch isolation is intentionally omitted* — merchants
>   span branches.
> - Added `risk_band` to the SELECT so dashboards can colour-code
>   critical merchants without a join.
> - Replaced the hard-coded date with a rolling 24h window.
> - Added `tests`, `llmContext`, `examples`, `invariants` — none of
>   which the agent provided.

---

## Step 3 — Pre-flight validation

```bash
dql validate blocks/cards/fraud_by_merchant_recent.dql
```

> **You should see** `0 errors · 0 warnings`. If a warning surfaces about
> RLS templates or missing fields, fix and re-run.

Visual smoke check:

```bash
dql preview blocks/cards/fraud_by_merchant_recent.dql
```

> **You should see** the bar chart open in your browser, three rows
> (`Darknet Vendor 1` largest, `Amazon Marketplace` second), no errors.

---

## Step 4 — Run the certification gate

```bash
dql certify blocks/cards/fraud_by_merchant_recent.dql --connection duckdb
```

> **You should see**
> ```text
> Block: fraud_by_merchant_recent (cards)
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

If `tests-pass` is red, the assertions failed against the live data —
fix the test or the SQL until they're green. The gate is intentionally
strict: `error` rules block certification entirely.

The block's row in `.dql/registry.sqlite` flips to `status = 'certified'`,
`certified_by = 'mei.chen@acme-bank.com'`, `certified_at = now()`. The
`block_versions` row is pinned to the current git SHA.

---

## Step 5 — Recompile + reindex

```bash
dql compile               # rebuilds dql-manifest.json
dql agent reindex         # rebuilds .dql/cache/agent-kg.sqlite
```

> **You should see** node count tick up by 1 in the reindex output.

---

## Step 6 — Confirm the loop closes

Re-ask the original question:

```bash
dql agent ask "which merchants drove the biggest fraud loss in the last few hours?"
```

> **You should see**
> ```text
> ✓ Certified
>
> Answered by certified block fraud_by_merchant_recent · <new-sha>.
> Use this block when asked "which merchants are driving fraud"…
>
> Citations:
>   - block fraud_by_merchant_recent · <new-sha>
> ```

The Stage 1 path now wins — no LLM call. Slack will return the same
shape if Raj re-asks. The KG node is also visible in
`dql lineage --block fraud_by_merchant_recent`:

```text
block:fraud_by_merchant_recent (certified · cards · mei.chen@acme-bank.com)
  ↑ reads_from
source_table:fraud_alerts
source_table:merchants
```

---

## Step 7 — Wire it into a dashboard (optional)

If `fraud_by_merchant_recent` is going to be a permanent fixture, add it
to `apps/cards-ops/dashboards/fraud-watch.dqld` so future cron runs
include it:

```json
{ "i": "by-merchant-recent", "x": 0, "y": 8, "w": 12, "h": 4,
  "title": "Top merchants by exposure (24h, certified)",
  "block": { "blockId": "fraud_by_merchant_recent" },
  "viz":   { "type": "bar" } }
```

`dql app build` to re-resolve refs. `dql verify` will start passing
again on the next CI run.

---

## Step 8 — Commit + PR

Mei opens a PR with the diff:

```diff
+ blocks/cards/fraud_by_merchant_recent.dql
  apps/cards-ops/dashboards/fraud-watch.dqld   (new tile added)
  dql-manifest.json                            (re-compiled)
```

Useful PR body template:

```markdown
## Summary
Promote previously-uncertified agent answer for "which merchants drove the
biggest fraud loss" into a certified `fraud_by_merchant_recent` block.

- Source feedback row: 1+ thumbs-up, 0 thumbs-down.
- Generalised the agent's hard-coded date window to rolling 24h.
- Added `@rls("region")`, `llmContext`, `examples`, `invariants`, tests.
- Certification gate green; manifest + KG reproducible (`dql verify` clean).

## Test plan
- [x] `dql validate`
- [x] `dql certify ... --connection duckdb`
- [x] `dql compile && dql verify`
- [x] `dql agent reindex && dql agent ask "<original question>"` returns
      Certified with the new block.
```

After merge, anyone — Sara, Raj, Tom, Li, the bot — gets the same
Certified answer for that question class. **The agent doesn't have to
get it right twice.**

---

## What you now have

✓ A repeatable pipeline: question → uncertified → review → certified
✓ A second certified block in `cards`, with full governance metadata
✓ The same question class now answers with zero LLM calls

[Continue to tutorial 09 — CI and `dql verify` →](./09-ci-and-verify.md)
