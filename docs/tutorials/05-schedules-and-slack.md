# 05 — Schedules and Slack delivery

**Who this is for:** App owners who want stakeholders to see their
dashboards without opening the desktop UI.

**What you'll do:** wire two schedules into `cards-ops` (a 7am daily digest
and a 15-minute fraud-spike watch), boot the Slack bot, send a test
message, and verify the round-trip.

**Time:** 35 minutes (mostly the Slack app setup).

---

## Two pieces, one loop

```
   ┌── App.schedules[] ──┐         ┌── dql slack serve ──┐
   │  cron + dashboard   │         │  /dql ask <q>       │
   │  + deliver targets  │         │  /dql block <id>    │
   └─────────┬───────────┘         └────────┬────────────┘
             ▼                              ▼
        Slack channel ◄────── Block-Kit reply (Certified · git SHA)
                                        │
                                  Feedback buttons
                                        │
                                        ▼
                              kg_feedback (self-learning)
```

Both surfaces share the **same answer pipeline**, so a Slack reply and an
in-UI dashboard are 1:1 in semantics: a `Certified` answer from one is a
`Certified` answer in the other.

---

## Part A — Schedules

### Step 1 — Add two schedules to the App

Edit `apps/cards-ops/dql.app.json` and replace the `schedules` array:

```json
"schedules": [
  {
    "id": "daily-7am-digest",
    "cron": "0 7 * * 1-5",
    "dashboard": "daily-ops",
    "description": "Weekday 07:00 AM ET digest for the cards leadership team.",
    "deliver": [
      { "kind": "slack", "channel": "#cards-ops" },
      { "kind": "email", "to": ["raj.kumar@acme-bank.com",
                                "mei.chen@acme-bank.com"] }
    ],
    "enabled": true
  },
  {
    "id": "fraud-spike-watch",
    "cron": "*/15 * * * *",
    "dashboard": "fraud-watch",
    "description": "Every 15 minutes — only sent when fraud_alerts_by_region exposes new alerts.",
    "deliver": [
      { "kind": "slack", "channel": "#cards-fraud-alerts" }
    ],
    "enabled": true
  }
]
```

Validate:

```bash
dql app build
```

> **You should see** the build succeed with no diagnostics. The manifest
> now records both schedules under `apps['cards-ops'].schedules[]`.

### Step 2 — Inspect what the scheduler sees

```bash
dql schedule list
```

> **You should see**
> ```text
>   App: cards-ops
>     daily-7am-digest        cron 0 7 * * 1-5     → dashboard: daily-ops
>                             deliver: slack #cards-ops, email 2 recipient(s)
>     fraud-spike-watch       cron */15 * * * *    → dashboard: fraud-watch
>                             deliver: slack #cards-fraud-alerts
> ```

### Step 3 — Run a single scheduled delivery on demand

The scheduler exposes a `--run` mode you can use to test without waiting
for the cron to fire:

```bash
dql schedule run daily-7am-digest --app cards-ops --dry-run
```

> **You should see**
> ```text
>   ⏵ Rendering apps/cards-ops/dashboards/daily-ops.dqld …
>     - daily_transaction_volume:  3 rows
>     - chargeback_rate:           1 row
>     - fraud_alerts_by_region:    3 rows  (owner persona — no RLS narrowing)
>     - fraud_by_merchant:         2 rows
>
>   Would deliver to:
>     slack:  #cards-ops
>     email:  raj.kumar@acme-bank.com, mei.chen@acme-bank.com
>
>   (Dry run — no message sent.)
> ```

Drop `--dry-run` to actually send. Email needs SMTP env vars set
(`DQL_SMTP_HOST`, `DQL_SMTP_USER`, `DQL_SMTP_PASS`); Slack needs
`SLACK_BOT_TOKEN`.

---

## Part B — The Slack slash-command bot

### Step 4 — Create a Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it `DQL Bot — Acme`. Pick your workspace.
3. **Slash commands** → **Create New Command**:
   - Command: `/dql`
   - Request URL: `https://YOUR-NGROK-URL/slack/commands` *(set after step 5)*
   - Short description: `Ask the DQL agent a question`
   - Usage hint: `ask <question>` or `block <id>`
4. **Interactivity & Shortcuts** → toggle **on** → Request URL:
   `https://YOUR-NGROK-URL/slack/actions`
5. **OAuth & Permissions** → Bot Token Scopes:
   - `commands`
   - `chat:write`
   - `chat:write.public`
   - Install the app to your workspace.
6. Capture two values from the **Basic Information** page:
   - **Signing Secret** → `SLACK_SIGNING_SECRET`
   - **Bot User OAuth Token** → `SLACK_BOT_TOKEN` (`xoxb-…`)

### Step 5 — Run the DQL bot

```bash
export SLACK_SIGNING_SECRET="…"
export SLACK_BOT_TOKEN="xoxb-…"
export ANTHROPIC_API_KEY="…"        # or OPENAI / GEMINI / OLLAMA

# (we'll build the agent KG in tutorial 06; for the smoke test, run reindex first)
dql agent reindex

dql slack serve --port 3479
```

> **You should see**
> ```text
>   ✓ Slack bot listening on http://127.0.0.1:3479
>     POST /slack/commands  (slash commands)
>     POST /slack/actions   (block-kit interactivity)
>     GET  /health
>
>   Forward Slack to this port via ngrok or a similar tunnel.
> ```

Expose it to the internet:

```bash
ngrok http 3479
```

ngrok prints a URL like `https://abcd-1234.ngrok-free.app`. Paste it into
the Slack app's slash command + interactivity URLs (suffixes
`/slack/commands` and `/slack/actions`).

### Step 6 — Send a test message

In Slack, in any channel:

```
/dql ask which regions had the most fraud last night?
```

> **You should see**
>
> ```
> ✓ Certified — _which regions had the most fraud last night?_
>
> Answered by certified block fraud_alerts_by_region · a3c7f1d2.
>
> Use this block when asked about recent card-fraud alerts. The window is
> a rolling 24 hours from now()…
>
> Citations
> • block:fraud_alerts_by_region (a3c7f1d2)
>
> [👍 Helpful]   [👎 Not helpful]
> ```

Click **👍 Helpful**. Behind the scenes the bot calls
[`kg.recordFeedback(...)`](../../packages/dql-agent/src/kg/sqlite-fts.ts) —
that row is what fuels self-learning later.

### Step 7 — A question that has no certified block (fallback path)

```
/dql ask which merchants drove the biggest fraud loss this morning?
```

> **You should see**
>
> ```
> ⚠️ AI-generated · uncertified — _which merchants drove the biggest fraud loss this morning?_
>
> Top merchants by fraud exposure 02:00–08:00 EST.
>
> Proposed SQL (review before saving):
>   SELECT m.merchant_name, m.mcc_code,
>          COUNT(*) AS alerts,
>          SUM(f.amount_usd) AS exposure_usd
>   FROM read_csv_auto('./data/fraud_alerts.csv') f
>   JOIN read_csv_auto('./data/merchants.csv')   m USING (merchant_id)
>   WHERE …
>   GROUP BY 1, 2
>   ORDER BY exposure_usd DESC
>
> Citations
> • dbt_source:fraud_alerts
> • dbt_source:merchants
> • block:fraud_alerts_by_region (a3c7f1d2)
>
> [👍 Helpful]   [👎 Not helpful]
> ```

The badge says `Uncertified`. Mei (Cards Analyst) sees this in the review
queue — see [tutorial 08](./08-promoting-ai-blocks.md).

---

## Step 8 — Lock down signature verification (production)

The `dql slack serve` server checks every request's HMAC against
`SLACK_SIGNING_SECRET` (see
[`packages/dql-slack/src/signature.ts`](../../packages/dql-slack/src/signature.ts)).
If you ever see `401 Bad signature` after deploying behind a reverse
proxy, the most common causes are:

- **Body modification** — Slack signs the *raw* body. Make sure your proxy
  doesn't rewrite the request body (some WAFs strip whitespace).
- **Clock skew** — the verifier rejects requests older than 5 minutes.
- **Header rewriting** — make sure `x-slack-signature` and
  `x-slack-request-timestamp` reach the bot intact.

For local development you can pass `--skip-verification` to the
`startSlackServer` options when calling it programmatically. Don't ship
that to prod.

---

## What you now have

✓ Two schedules wired into the App, ready for cron firing
✓ A running Slack bot answering `/dql ask` and `/dql block`
✓ Feedback buttons that persist into the KG
✓ A working signature-verified production posture

[Continue to tutorial 06 — Agentic analytics →](./06-agentic-analytics.md)
