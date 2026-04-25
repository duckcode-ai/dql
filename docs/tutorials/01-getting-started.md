# 01 — Getting started

**Who this is for:** anyone setting up DQL on their machine for the first time.

**What you'll do:** install the toolchain, build the workspace, scaffold the
Acme Bank project, run a hello-world block, and open the desktop UI.

**Time:** 15 minutes.

---

## Prerequisites

- **Node.js** ≥ 18.19 (check: `node --version`)
- **pnpm** ≥ 9 (`npm i -g pnpm` if you don't have it)
- **DuckDB** is bundled — no separate install needed for the local hello-world
- **git** (any modern version)
- *(optional, for the agent tutorials)* an LLM credential — `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, or `GEMINI_API_KEY`. **Or** install [Ollama](https://ollama.com)
  for fully-local agent execution.

---

## Step 1 — Clone and install

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm -r build
```

> **You should see** every package built in turn — last line ends with
> `apps/cli build: Done`. Build takes ~30s on a warm cache.

If a build fails, the most common cause is Node version. Confirm:

```bash
node --version
# v18.19.x or newer
```

---

## Step 2 — Make `dql` available on your PATH

The CLI lives at `apps/cli/dist/index.js`. The simplest setup for the
tutorials:

```bash
# from the repo root
alias dql="node $(pwd)/apps/cli/dist/index.js"
```

> **You should see** `dql --version` print a version (e.g. `1.3.6`) and `dql --help`
> list every command including `app`, `agent`, `slack`, `verify`.

For a permanent install, `pnpm --filter @duckcodeailabs/dql-cli link --global`
will add `dql` to your `$PATH` directly.

---

## Step 3 — Scaffold the Acme Bank project

We'll create a fresh project that has DuckDB-backed sample data so every
tutorial in this series runs without a real warehouse.

```bash
cd ~
mkdir acme-bank && cd acme-bank
dql init .
```

> **You should see**
> ```text
>   ✓ Created dql.config.json
>   ✓ Created blocks/, notebooks/, semantic-layer/, dashboards/
>   Next: dql notebook  (or dql new block <name>)
> ```

Take a look at what `dql init` made:

```bash
ls -la
```

```text
dql.config.json
blocks/
notebooks/
semantic-layer/
dashboards/
data/                    # local CSV / Parquet bucket (git-ignored)
.gitignore
```

---

## Step 4 — Drop in the bank's sample data

For the rest of the tutorials we need a few CSVs that play the role of the
warehouse fact tables. Save these three files under `acme-bank/data/`:

```csv
# acme-bank/data/transactions.csv
txn_id,account_id,merchant_id,amount_usd,region,branch,ts
T001,A100,M-amzn,84.20,NA-NE,NYC-042,2026-04-25T08:14:00Z
T002,A101,M-walmart,162.00,NA-W,SFO-007,2026-04-25T08:32:00Z
T003,A100,M-amzn,4900.00,NA-NE,NYC-042,2026-04-25T02:11:00Z
T004,A104,M-darknet1,2700.00,EMEA,LON-018,2026-04-25T02:14:00Z
T005,A107,M-darknet1,3200.00,EMEA,LON-018,2026-04-25T02:18:00Z
```

```csv
# acme-bank/data/fraud_alerts.csv
alert_id,txn_id,merchant_id,amount_usd,region,branch,alert_ts,reason
F001,T003,M-amzn,4900.00,NA-NE,NYC-042,2026-04-25T02:12:00Z,velocity
F002,T004,M-darknet1,2700.00,EMEA,LON-018,2026-04-25T02:15:00Z,merchant_blocklist
F003,T005,M-darknet1,3200.00,EMEA,LON-018,2026-04-25T02:19:00Z,merchant_blocklist
```

```csv
# acme-bank/data/merchants.csv
merchant_id,merchant_name,mcc_code,risk_band
M-amzn,Amazon Marketplace,5942,low
M-walmart,Walmart Stores,5411,low
M-darknet1,Darknet Vendor 1,7995,critical
```

These three CSVs back every fraud / cards example in the tutorials.

---

## Step 5 — Confirm the runtime is healthy

```bash
dql doctor .
```

> **You should see** every check land with a green tick:
>
> ```text
>   ✓ Node.js  v20.x.x   OK
>   ✓ DuckDB   bundled   OK
>   ✓ Project  acme-bank   OK
>   ✓ Connection  duckdb (memory)  OK
>   ✓ Blocks  0 found
>   ✓ Notebooks  0 found
> ```

Zero blocks and zero notebooks is fine — we're about to add one.

---

## Step 6 — Hello-world block

Create your first block:

```bash
dql new block hello_fraud --domain cards
```

> **You should see**
> ```text
>   ✓ Created blocks/hello_fraud.dql
>   Next: dql parse blocks/hello_fraud.dql
> ```

Open `blocks/hello_fraud.dql` and edit the `query` to read from the CSV:

```dql
// blocks/hello_fraud.dql
// dql-format: 1

block "hello_fraud" {
  domain      = "cards"
  type        = "custom"
  owner       = "you@acme-bank.com"
  description = "Smoke-test block over the seeded fraud_alerts.csv."
  tags        = ["fraud", "smoke-test"]

  query = """
    SELECT region, COUNT(*) AS alerts
    FROM read_csv_auto('./data/fraud_alerts.csv')
    GROUP BY 1
    ORDER BY alerts DESC
  """

  visualization { chart = "bar"; x = "region"; y = "alerts" }
}
```

Compile and run:

```bash
dql validate
dql preview blocks/hello_fraud.dql
```

> **You should see** a browser window open with two bars:
> `EMEA — 2`, `NA-NE — 1`. If you don't see it, check
> [troubleshooting](./10-troubleshooting.md#preview-doesnt-open).

---

## Step 7 — Open the desktop UI

```bash
dql notebook
```

> **You should see** a localhost URL print (e.g. `http://127.0.0.1:3475`) and
> your default browser open the DQL Notebook UI.

Click around:

- Top of the **activity bar (left)**: a **Files** icon, then **Schema**,
  **Block Library**, **Apps**, **Lineage**.
- Hit **Apps**. The right pane now reads:
  > _No apps yet._
  > _Create one with: `dql app new <id> --domain <domain>`_

That's exactly what we'll do next.

---

## What you now have

✓ A fully-built DQL workspace
✓ A scaffolded `acme-bank/` project with seeded sample data
✓ One certified-shape block (`hello_fraud`) that runs against DuckDB
✓ A running desktop UI

[Continue to tutorial 02 — Authoring blocks →](./02-authoring-blocks.md)
