# 03 — Apps, RBAC, and personas (Raj sets up cards-ops)

**Who this is for:** App owners — typically domain heads or ops leads.

**What you'll do:** play **Raj Kumar**, Head of Cards. You'll create the
`cards-ops` App, add three members (Raj, Mei, Li), define roles + access
policies + RLS bindings, and prove that switching personas changes what each
member sees.

**Time:** 30 minutes.

---

## The mental model in one diagram

```
       ┌──────────────── App: cards-ops ────────────────┐
       │  members[]  →  who is in this App              │
       │  roles[]    →  vocabulary used by policies     │
       │  policies[] →  what each role may do           │
       │  rlsBindings[] → role → {user.var} ← attribute │
       │  schedules[] → cron-driven Slack/email digests │
       │  dashboards/*.dqld → what stakeholders see     │
       └────────────────────────────────────────────────┘
                    │              │
        Raj (owner) │              │ Li (branch_viewer, NYC-042)
                    ▼              ▼
        sees every region    sees only region=NA-NE, branch=NYC-042
                  (no narrowing)         (RLS injects WHERE …)
```

`personas` are **runtime activations of members**. The local owner can switch
persona to preview what each member sees — that's how you test RBAC + RLS
without spinning up real authentication.

---

## Step 1 — Scaffold the App

```bash
cd ~/acme-bank
dql app new cards-ops --domain cards --owner raj.kumar@acme-bank.com
```

> **You should see**
> ```text
>   ✓ Created app: cards-ops
>     Path: apps/cards-ops
>     Domain: cards   Owner: raj.kumar@acme-bank.com
>
>   Next steps:
>     1. Add blocks to your project under blocks/
>     2. Edit apps/cards-ops/dashboards/overview.dqld to reference them
>     3. dql app build       # writes apps[] and dashboards[] into dql-manifest.json
>     4. dql notebook        # open the App in the desktop UI
> ```

The scaffolder created:

```text
apps/cards-ops/
├─ dql.app.json
├─ dashboards/
│  └─ overview.dqld
└─ notebooks/
```

with sensible defaults: 3 roles (`owner`, `analyst`, `viewer`), 2 policies,
and one empty `overview` dashboard.

---

## Step 2 — Edit `dql.app.json` to reflect your real team

Replace `apps/cards-ops/dql.app.json` with this fully-realised version:

```json
{
  "version": 1,
  "id": "cards-ops",
  "name": "Cards — Operations",
  "domain": "cards",
  "description": "Daily operations + fraud monitoring for the Cards org.",
  "owners": ["raj.kumar@acme-bank.com"],
  "tags": ["daily", "fraud", "ops"],

  "members": [
    { "userId": "raj.kumar@acme-bank.com", "displayName": "Raj (Head of Cards)",
      "roles": ["owner"], "attributes": { "region": "*" } },
    { "userId": "mei.chen@acme-bank.com",  "displayName": "Mei (Cards Analyst)",
      "roles": ["analyst"], "attributes": { "region": "*" } },
    { "userId": "tom.ng@acme-bank.com",    "displayName": "Tom (Compliance)",
      "roles": ["viewer"], "attributes": { "region": "*" } },
    { "userId": "li.park@acme-bank.com",   "displayName": "Li (Branch Manager NYC-042)",
      "roles": ["branch_viewer"],
      "attributes": { "region": "NA-NE", "branch": "NYC-042" } }
  ],

  "roles": [
    { "id": "owner",          "displayName": "Owner",
      "description": "Full read + execute across all classifications." },
    { "id": "analyst",        "displayName": "Analyst",
      "description": "Read + execute on confidential. Can author and certify blocks." },
    { "id": "viewer",         "displayName": "Viewer",
      "description": "Read-only across the organisation; no RLS narrowing." },
    { "id": "branch_viewer",  "displayName": "Branch Viewer",
      "description": "Read-only, narrowed to the member's region + branch via RLS." }
  ],

  "policies": [
    { "id": "viewers-read", "domain": "cards",
      "minClassification": "internal",
      "allowedRoles": ["viewer", "branch_viewer", "analyst", "owner"],
      "accessLevel": "read", "enabled": true },
    { "id": "analyst-execute", "domain": "cards",
      "minClassification": "confidential",
      "allowedRoles": ["analyst", "owner"],
      "accessLevel": "execute", "enabled": true },
    { "id": "restricted-owner-only", "domain": "cards",
      "minClassification": "restricted",
      "allowedRoles": ["owner"],
      "accessLevel": "read", "enabled": true }
  ],

  "rlsBindings": [
    { "role": "branch_viewer", "variable": "user.region", "from": "region" },
    { "role": "branch_viewer", "variable": "user.branch", "from": "branch" }
  ],

  "schedules": [],

  "homepage": { "type": "dashboard", "id": "daily-ops" }
}
```

**Edit highlights you should look at:**

- `members[].attributes.region` and `branch`: these are the values that
  `rlsBindings` will substitute into `{user.region}` / `{user.branch}` at
  query time.
- `policies` use `minClassification` ∈ `public | internal | confidential | restricted`.
  Today every block defaults to `internal` — see [09-ci-and-verify](./09-ci-and-verify.md)
  for tagging blocks with classifications.
- `homepage` references a dashboard id we haven't built yet (`daily-ops`).
  We'll build it in [tutorial 04](./04-dashboards.md). For now, `dql app build`
  will surface a warning, which is the right behaviour.

Save the file.

---

## Step 3 — Validate the App

```bash
dql app build
```

> **You should see**
> ```text
>   ✓ Built 1 app(s), 1 dashboard(s).
>     - cards-ops: 1 dashboard(s)
>
>   Diagnostics:
>     [warning] apps/cards-ops/dql.app.json: homepage references unknown dashboard "daily-ops"
> ```

That warning is the manifest builder
([packages/dql-core/src/manifest/builder.ts](../../packages/dql-core/src/manifest/builder.ts))
flagging the dangling homepage reference — proof the cross-checks are working.

You can also confirm the App, members, and policies parsed correctly:

```bash
dql app show cards-ops
```

> **You should see**
> ```text
> App: Cards — Operations (cards-ops)
>   domain:      cards
>   owners:      raj.kumar@acme-bank.com
>   description: Daily operations + fraud monitoring for the Cards org.
>   members:     4
>     - raj.kumar@acme-bank.com [owner]
>     - mei.chen@acme-bank.com [analyst]
>     - tom.ng@acme-bank.com [viewer]
>     - li.park@acme-bank.com [branch_viewer]
>   policies:    3
>   schedules:   0
>   dashboards:  1
>     - overview (Cards — Operations — Overview)
> ```

---

## Step 4 — Open the App in the desktop UI

```bash
dql notebook
```

In the activity bar (left), click **Apps** (Package icon).

> **You should see**
>
> - The **Apps panel** opens. Left column lists `Cards — Operations`.
> - Top of the right pane shows the App name + domain + the
>   **persona switcher**: a button labelled `View as: Owner ▾`.
> - A row of dashboard tabs (currently just one: `overview`).
> - The dashboard area says
>   _"This dashboard has no blocks yet. Edit the .dqld file or use the
>    upcoming DashboardEditor to add tiles."_

That's correct — we haven't composed `daily-ops` yet. We'll do it in
[tutorial 04](./04-dashboards.md). Stay in the App for the next step.

---

## Step 5 — Switch persona, observe RBAC + RLS

This is the moment of truth.

1. Click the **persona switcher**: `View as: Owner ▾`.
2. The dropdown lists every member of `cards-ops` plus an "Owner (local)"
   default.
3. Pick **Li (Branch Manager NYC-042) [branch_viewer]**.

> **You should see** the button collapse into:
> ```text
>   View as: Li (Branch Manager NYC-042) [branch_viewer]
> ```

Behind the scenes, the UI called `POST /api/persona { userId: 'li.park@…',
appId: 'cards-ops' }`. The server's `defaultPersonaRegistry` is now bound to
Li, with RLS context resolved to `{ 'user.region': 'NA-NE', 'user.branch': 'NYC-042' }`.

### Run the fraud block as Li

The dashboard isn't built yet, so let's prove RLS works directly with the
block runner:

In a second terminal:

```bash
curl -s -X POST http://127.0.0.1:3475/api/block-studio/run \
  -H 'content-type: application/json' \
  --data '{"path":"blocks/fraud_alerts_by_region.dql"}' | jq '.result.rows | length'
```

> **You should see** `1` — only Li's branch (NYC-042). Switch the persona
> back to Owner and re-run the same curl: you'll see `3` rows (every region).

The compiled SQL Li ran was effectively:

```sql
SELECT * FROM (
  SELECT region, branch, COUNT(*) AS alert_count, SUM(amount_usd) AS exposure_usd
  FROM read_csv_auto('./data/fraud_alerts.csv')
  WHERE alert_ts >= now() - INTERVAL '24 hours'
  GROUP BY 1, 2
) _dql_rls
WHERE region = 'NA-NE' AND branch = 'NYC-042'
```

— produced by the `@rls` lowering pass +
[`personaVariables()`](../../packages/dql-project/src/persona-variables.ts).

---

## Step 6 — Confirm policies block forbidden access

Suppose Mei tagged a future block `restricted` (e.g. PII payouts). Tom
(`viewer`) opens the dashboard expecting to see it:

The runtime calls `PolicyEngine.checkAccess(user, 'cards', 'restricted', 'read')`.
Per the policy `restricted-owner-only`, only `owner` is allowed. Tom gets a
"Not authorized" placeholder on that tile — **and crucially the SQL never
runs** so no PII flows over the wire.

You can test the policy engine directly:

```bash
node -e "
  const { PolicyEngine } = require('@duckcodeailabs/dql-governance/dist/policy-engine.js');
  const pe = new PolicyEngine([
    { id:'p', domain:'cards', minClassification:'restricted',
      allowedRoles:['owner'], allowedUsers:[], accessLevel:'read', enabled:true }
  ]);
  console.log(pe.checkAccess({userId:'tom@x', roles:['viewer']}, 'cards', 'restricted', 'read'));
  console.log(pe.checkAccess({userId:'raj@x', roles:['owner']},  'cards', 'restricted', 'read'));
"
```

> **You should see**
> ```js
> { allowed: false, reason: 'No policy grants read access to domain "cards" with classification "restricted" for user "tom@x"' }
> { allowed: true, matchedPolicy: 'p' }
> ```

---

## Step 7 — Inspect the lineage edges that just appeared

```bash
dql lineage --app cards-ops
```

> **You should see**
> ```text
> app:cards-ops (consumption · cards · raj.kumar@acme-bank.com)
>   ↑ contains
> dashboard:overview
> ```

Once we add real blocks to the dashboard in tutorial 04, this graph will
extend down to `block:* → metric:* → dbt_model:* → dbt_source:*` so the
whole consumption surface is auditable.

---

## What you now have

✓ A first-class `cards-ops` App with 4 members, 4 roles, 3 policies, RLS bindings
✓ Working persona switching that exercises real PolicyEngine + RLS code paths
✓ Proof that branch managers see only their branch's data
✓ App + dashboard nodes appearing in the lineage graph

[Continue to tutorial 04 — Dashboards →](./04-dashboards.md)
