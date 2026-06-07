# 01 - Getting started

**Who this is for:** anyone setting up DQL on their machine for the first time.

**What you'll do:** install the toolchain, scaffold the Acme Bank sample,
compile the manifest, build Apps, open the desktop UI, and run the first
certified banking blocks.

**Time:** 15 minutes.

---

## Prerequisites

- **Node.js** 20 or 22 LTS (check: `node --version`)
- **pnpm** >= 9 (`npm i -g pnpm` if you do not have it)
- **git** (any modern version)
- Optional for agent tutorials: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, or a local Ollama server.

---

## Step 1 - Clone and install DQL

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm -r build
```

> **You should see** every package build cleanly. The CLI artifact lives at
> `apps/cli/dist/index.js`.

For the tutorials, make the local CLI easy to call:

```bash
alias dql="node $(pwd)/apps/cli/dist/index.js"
dql --help
```

---

## Step 2 - Scaffold Acme Bank

The Acme Bank template is a full OSS single-user banking project: sample CSV
warehouse, certified blocks, domain Apps, dashboards, governance, schedules,
and Skills.

```bash
cd ~
node /path/to/dql/packages/create-dql-app/bin/create-dql-app.mjs acme-bank --template acme-bank
cd acme-bank
```

If you installed the package from npm, use:

```bash
npx create-dql-app acme-bank --template acme-bank
cd acme-bank
```

> **You should see** a project with `data/`, `blocks/`, `apps/`,
> `notebooks/`, `semantic-layer/`, and `.dql/skills/`.

---

## Step 3 - Inspect the project shape

```bash
find . -maxdepth 3 -type f | sort | sed -n '1,80p'
```

Key folders:

```text
data/                    DuckDB-readable CSV banking warehouse
blocks/cards/            card volume, approval, and fraud blocks
blocks/deposits/         deposit growth and branch leaderboard blocks
blocks/lending/          delinquency and high-risk exposure blocks
blocks/executive/        CXO scorecard block
apps/                    stakeholder App packages
.dql/skills/             agent Skills for Acme personas
```

Certified blocks stay in root `blocks/`. Apps reference those blocks through
`.dqld` dashboards instead of copying business logic.

---

## Step 4 - Compile and build Apps

```bash
dql compile
dql app build
```

> **You should see** a manifest with four Apps and five dashboards:
>
> - `cards-ops/daily-ops`
> - `cards-ops/fraud-watch`
> - `retail-deposits/deposit-growth`
> - `risk-office/credit-risk`
> - `executive-cockpit/bank-overview`

The dashboard IDs are local inside each App. The manifest keys are qualified
as `appId/dashboardId`, so multiple Apps can safely have their own dashboard
names.

---

## Step 5 - Run the welcome notebook

```bash
dql notebook
```

Open `notebooks/welcome.dqlnb`.

Run these cells:

- raw transaction health
- `@block("fraud_alerts_by_region")`
- `@block("deposit_trend")`
- `@block("bank_health_scorecard")`

> **You should see** real rows from the packaged CSVs and certified block
> citations in the notebook flow.

---

## Step 6 - Open Apps Command Center

In the desktop UI, click **Apps** in the left rail.

Open each App:

| App | What to inspect |
| --- | --- |
| `Cards Operations` | Approval rate, card volume, fraud by region, fraud by merchant |
| `Retail Deposits` | Deposit trend, deposit balance by segment, branch leaders |
| `Risk Office` | Delinquent exposure by region and high-risk loan watchlist |
| `Executive Cockpit` | Cross-domain CXO scorecard with certified block citations |

Use the persona switcher in `Cards Operations` and select
`li.park@acme-bank.com`. The fraud blocks are decorated with:

```dql
@rls("region", "{user.region}")
@rls("branch_id", "{user.branch}")
```

Li's member attributes in `apps/cards-ops/dql.app.json` narrow her view to
`region = NA-NE` and `branch_id = NYC-042`.

---

## Step 7 - Build the agent index

```bash
dql agent reindex
```

Ask the Chat cell or global agent drawer:

```text
Which merchants are driving card fraud?
```

The agent should retrieve the certified `fraud_by_merchant_recent` block
before attempting generated SQL.

---

## What you now have

- A runnable Acme Bank OSS project
- Banking sample data across cards, deposits, lending, and executive domains
- Certified blocks with domain, owner, tags, descriptions, tests, and agent
  context
- Four stakeholder Apps with programmable governance and dashboards
- A local agent knowledge base seeded from the same DQL source tree

[Continue to tutorial 02 - Authoring blocks ->](./02-authoring-blocks.md)
