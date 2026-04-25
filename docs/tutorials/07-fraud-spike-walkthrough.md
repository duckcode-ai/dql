# 07 — End-to-end fraud spike (the full story)

**Who this is for:** anyone who wants to see every piece of DQL fire in
sequence on a single realistic incident.

**What you'll see:** a 02:13 fraud spike, the cron alert, Raj asking the
agent in Slack, Mei reviewing and certifying the answer, Tom auditing it
the next morning, Sara seeing it in the board view — all from one repo,
one project, one set of files.

**Time:** 30 minutes (read-through; ~10 minutes if you have the previous
tutorials' state in place).

---

## 02:00 — the schedule fires

The cron `*/15 * * * *` on `apps/cards-ops`'s `fraud-spike-watch` schedule
fires. The DQL scheduler:

1. Loads `apps/cards-ops/dql.app.json`, picks the schedule with id
   `fraud-spike-watch`.
2. Resolves `dashboard: 'fraud-watch'` against
   `apps/cards-ops/dashboards/fraud-watch.dqld`.
3. Activates the **owner persona** for the render — schedules always run
   org-wide, never RLS-narrowed (the scheduler is the org's eyes, not a
   member's).
4. Executes each block referenced by the dashboard (`fraud_alerts_by_region`,
   `fraud_by_merchant`).
5. Composes a Block-Kit message and POSTs it to `#cards-fraud-alerts`.

In Slack:

```
⚠️ DQL · cards-ops · fraud-spike-watch · 02:15

Fraud exposure by region (24h)
[bar chart]
EMEA       $5,900   2 alerts
NA-NE      $4,900   1 alert

Top merchants by exposure (24h)
[table]
M-darknet1   Darknet Vendor 1   $5,900   2 alerts   risk_band=critical
M-amzn       Amazon Marketplace $4,900   1 alert    risk_band=low

Source: dql-manifest.json · git:main · cards-ops/fraud-watch.dqld
```

> **What Raj sees on his phone:** the chart + the merchant table inline.
> Two alerts on the same suspicious merchant, plus one anomalous Amazon
> charge. He taps the channel.

---

## 02:13 — Raj asks the bot

Raj types in `#cards-fraud-alerts`:

```
/dql ask which merchants drove the biggest fraud loss this morning between 2 and 3 am EST?
```

The Slack bot ([`packages/dql-slack/src/server.ts`](../../packages/dql-slack/src/server.ts))
acks immediately:

```
Working on it… (ask)
```

Behind the scenes:

1. **Signature verification** — HMAC over `v0:<ts>:<rawBody>` against
   `SLACK_SIGNING_SECRET`. Anything that fails returns 401 before the
   agent even sees the question.
2. **Persona resolution** — Raj's `user_id` matches a member in
   `cards-ops` with the `owner` role. The bot sets the active persona
   accordingly. (This is also where RLS would narrow if Raj were a
   `branch_viewer`.)
3. **Answer loop** ([`packages/dql-agent/src/answer-loop.ts`](../../packages/dql-agent/src/answer-loop.ts)):
   a. FTS5 search the KG. Top hit is `fraud_alerts_by_region` (score 0.41,
      certified). But the question asks "**by merchant**" — the block is
      grouped by **region/branch**. Score doesn't meet the certified-merchant
      relevance bar, so we fall through.
   b. Gather top 6 KG hits + Skills. No skill is bound to Raj for this
      App, so the prompt has no personalised additions.
   c. Call the configured LLM provider (`pickProvider()` order:
      Claude → OpenAI → Gemini → Ollama). Claude returns:

      ```text
      Top merchants by fraud exposure 02:00–03:00 EST.

      ```sql
      SELECT m.merchant_name, m.mcc_code,
             COUNT(*)              AS alerts,
             SUM(f.amount_usd)     AS exposure_usd
      FROM read_csv_auto('./data/fraud_alerts.csv') f
      JOIN read_csv_auto('./data/merchants.csv')   m USING (merchant_id)
      WHERE f.alert_ts >= '2026-04-25 02:00:00'
        AND f.alert_ts <  '2026-04-25 03:00:00'
      GROUP BY 1, 2
      ORDER BY exposure_usd DESC
      LIMIT 25
      ```

      Viz: bar
      ```

   d. `parseProposal()` extracts the SQL + viz hint + prose.
4. **Format for Slack** — `formatAnswerForSlack()` builds Block-Kit:

```
⚠️ AI-generated · uncertified — _which merchants drove the biggest fraud loss…_

Top merchants by fraud exposure 02:00–03:00 EST.

Proposed SQL (review before saving):
SELECT m.merchant_name, m.mcc_code, …

Citations
• block:fraud_alerts_by_region (a3c7f1d2)
• dbt_source:fraud_alerts
• dbt_source:merchants

[👍 Helpful]   [👎 Not helpful]
```

5. The bot POSTs that to Slack via the `response_url` Slack supplied with
   the slash command (no need to use the bot token here; `response_url`
   is one-shot).

---

## 02:14 — Raj acts on the answer

Raj sees `Darknet Vendor 1` is the dominant exposure. He calls the FraudOps
on-call to suspend that merchant from the network. He hits **👍 Helpful**
on the Slack message.

The action handler:

1. Verifies signature again (Slack signs interactivity events too).
2. Parses `payload.actions[0].value`:
   `{ rating: 'up', question: '…', blockId: undefined }`.
3. Calls `KGStore.recordFeedback({ rating: 'up', user: 'raj.kumar', … })`
   into `kg_feedback`.

The thumbs-up doesn't promote the answer to a certified block on its own.
It feeds the self-learning ranking signal — repeated upvotes from
multiple users surface it on Mei's review queue (next section).

---

## 09:00 — Mei opens the analyst's review queue

Mei starts her day. From the terminal:

```bash
dql agent reindex                 # pull in any new blocks since last night
node -e "
  const { getPromotionCandidates } = require('@duckcodeailabs/dql-agent');
  console.log(getPromotionCandidates(process.cwd(), 1));   // threshold = 1 for the demo
"
```

> **You should see**
> ```js
> [
>   { blockId: undefined,
>     question: 'which merchants drove the biggest fraud loss this morning between 2 and 3 am EST?',
>     ups: 1 }
> ]
> ```

Mei looks at the original Slack thread, copies the proposed SQL into a new
block, generalises the time window, names it. She runs through tutorial
[08 — promoting AI answers](./08-promoting-ai-blocks.md):

1. Saves `blocks/cards/fraud_by_merchant_recent.dql` (proper domain, owner,
   tags, RLS, llmContext).
2. Adds tests (`row_count >= 0`, `null_count(merchant_name) == 0`).
3. `dql certify blocks/cards/fraud_by_merchant_recent.dql --connection prod-warehouse`
   — green.
4. Commits + opens a PR.
5. After merge, `dql agent reindex` picks up the new block.

Now anyone asking the same question (Slack, desktop, MCP) gets a
**Certified** answer with no LLM call.

---

## 09:30 — Tom audits the incident

Tom (Compliance) opens the Risk-Compliance App and asks:

```
/dql lineage block:fraud_by_merchant_recent
```

The bot returns (or `dql lineage --block fraud_by_merchant_recent` from
the CLI) the full chain:

```
domain:cards
  ↑ contains
app:cards-ops
  ↑ contains
dashboard:fraud-watch (already linked) + dashboard:daily-ops (no, only via fraud_alerts_by_region)
  ↑ contains
block:fraud_by_merchant_recent (certified · 2026-04-25 09:21 · git:f4a8c2)
  ↑ reads_from
dbt_source:fraud_alerts
dbt_source:merchants
```

Tom screenshots the chain into the regulator response: every Slack reply,
every dashboard tile, every certified block ties back to a git SHA and a
governance status.

---

## 11:00 — Li the branch manager opens her dashboard

Li in NYC-042 opens the Branch Managers App. The persona switcher is set
to her by default (`branch_viewer` role, `region: NA-NE`, `branch: NYC-042`).
The same `fraud_alerts_by_region` block runs but this time the compiler's
RLS lowering produces:

```sql
SELECT * FROM (
  SELECT region, branch, COUNT(*) AS alert_count, SUM(amount_usd) AS exposure_usd
  FROM read_csv_auto('./data/fraud_alerts.csv')
  WHERE alert_ts >= now() - INTERVAL '24 hours'
  GROUP BY 1, 2
) _dql_rls
WHERE region = $1 AND branch = $2
```

`personaVariables(li.persona)` supplies `$1='NA-NE'`, `$2='NYC-042'`. Li
sees one row: her own branch.

She asks the agent:

```
What was unusual at my branch this morning?
```

The agent's answer cites `fraud_alerts_by_region` (Certified) and runs it
under Li's persona. Li sees the velocity-rule alert on the $4900 Amazon
charge. She calls the cardholder to verify.

---

## 17:00 — Sara reviews the day for the board view

Sara opens the CXO Board App. Her dashboard pulls org-wide totals — she
runs as `owner`, no RLS. Asking the bot:

```
/dql ask card fraud loss MoM trend
```

The agent uses Sara's Skill (`cfo-monthly.skill.md`):

- `vocabulary`: "fraud loss" → `metric:fraud_loss` (if defined).
- `body`: framing rules — MoM on fraud loss, flag domainTrust < 0.85.
- `preferred_blocks`: `fraud_alerts_by_region`.

Answer is Certified, anchored on the block, framed for the board. Sara
exports the chart for her deck.

---

## CI verifies that nothing drifted

Each PR triggers:

```yaml
- run: pnpm install && pnpm -r build
- run: dql validate
- run: dql certify blocks/cards/fraud_by_merchant_recent.dql --connection $WAREHOUSE_DSN
- run: dql compile
- run: dql verify         # fails if dql-manifest.json drifted
- run: dql agent reindex  # rebuilds the KG so search picks up the new block
```

The `dql verify` step ([`apps/cli/src/commands/verify.ts`](../../apps/cli/src/commands/verify.ts))
recompiles the manifest in-memory and diffs against the on-disk file.
Drift = non-zero exit + structured diagnostic.

---

## What just happened, in one paragraph

A single piece of programmable analytics (the `fraud_alerts_by_region`
block) plus one App declaration (`cards-ops`) plus one Skill
(`cfo-monthly`) plus one cron rule (`fraud-spike-watch`) gave us:
**stakeholder-specific dashboards, branch-level data isolation, scheduled
Slack alerts, ad-hoc agent answers with certified-vs-uncertified
provenance, an analyst review pipeline, regulator-ready lineage, and CI
gates** — all from files in git, all reproducible.

[Continue to tutorial 08 — Promoting AI answers to certified blocks →](./08-promoting-ai-blocks.md)
