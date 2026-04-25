# 06 — Agentic analytics (KG, Skills, multi-provider)

**Who this is for:** anyone who'll ask the agent a question — directly via
CLI, in the desktop chat cell, in Slack, or via MCP from Claude Code /
Cursor.

**What you'll do:** build the local knowledge graph, drop in a Skill for
Sara (CFO), wire a provider, and walk through the **block-first answer
loop**: certified block hit → uncertified fallback → review.

**Time:** 25 minutes.

---

## What is the KG and why does it exist?

DQL ships an in-process SQLite database that mirrors the manifest into a
shape the agent can search:

```
.dql/cache/agent-kg.sqlite
├─ kg_nodes        — blocks, metrics, dimensions, dbt models, sources, dashboards, apps, skills
├─ kg_nodes_fts    — FTS5 virtual table over name + description + llm_context + tags
├─ kg_edges        — adjacency list (block→dashboard, app→dashboard, …)
├─ kg_feedback     — thumbs-up/down events per (user, question, blockId)
└─ kg_meta         — built_at timestamp + manifest fingerprint
```

The agent **always retrieves before generating**. FTS5 is fast,
deterministic, dependency-free, and has zero PII exposure. If a certified
block exists for the question, the LLM is never called.

> Why FTS5 instead of embeddings? It's the OSS-first choice — keyword +
> structured filters cover the vast majority of "find the right block"
> queries with no ML deps and no PII leaving the box. Embeddings can be
> layered later for fuzzy NL phrasings.

---

## Step 1 — Build the KG

```bash
cd ~/acme-bank
dql agent reindex
```

> **You should see**
> ```text
>   ✓ Knowledge graph rebuilt — 12 nodes, 6 edges, 0 skill(s).
> ```

Twelve nodes is correct: 4 blocks + 1 app + 2 dashboards + 0 metrics
+ 0 dimensions + 0 dbt models + the source tables we read from + the
domain `cards` itself.

Inspect:

```bash
sqlite3 .dql/cache/agent-kg.sqlite \
  "SELECT kind, name, status FROM kg_nodes ORDER BY kind, name;"
```

> **You should see** something like
> ```text
> app|cards-ops|
> block|chargeback_rate|certified
> block|daily_transaction_volume|certified
> block|fraud_alerts_by_region|certified
> block|fraud_by_merchant|certified
> dashboard|daily-ops|
> dashboard|fraud-watch|
> domain|cards|
> dbt_source|fraud_alerts|
> dbt_source|merchants|
> dbt_source|transactions|
> ```

---

## Step 2 — Pick (or stub) an LLM provider

The agent supports four providers; pick whichever fits your security
posture. **All four can coexist** — `pickProvider()` falls through in this
order: `claude → openai → gemini → ollama`.

| Provider | Env var(s) | Notes |
|---|---|---|
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | Default model: `claude-opus-4-7`. |
| OpenAI / compatible | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` | Default model: `gpt-4.1-mini`. Works with Azure OpenAI / vLLM by overriding `OPENAI_BASE_URL`. |
| Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Default model: `gemini-2.5-pro`. System messages prepended to the first user turn. |
| Ollama | `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`), `OLLAMA_MODEL` (default `llama3.1`) | Fully local; **prompts never leave the machine.** |

For these tutorials, pick **one**:

```bash
# Pick A: Claude
export ANTHROPIC_API_KEY=sk-ant-…

# Pick B: Local Ollama (no creds needed; install from https://ollama.com)
ollama pull llama3.1
# then `dql agent` calls go local automatically
```

---

## Step 3 — Ask the agent something a certified block answers

```bash
dql agent ask "fraud exposure by region in the last 24 hours"
```

> **You should see**
> ```text
> ✓ Certified
>
> Answered by certified block fraud_alerts_by_region · a3c7f1d2.
>
> Use this block when asked about recent card-fraud alerts…
>
> Citations:
>   - block fraud_alerts_by_region · a3c7f1d2
> ```

That's the **Stage 1** path: FTS5 found a certified block whose
`llmContext` + tags match the question, the score cleared the threshold,
and we never invoked an LLM. **Cost: 0 tokens.**

Verify by adding `--format json`:

```bash
dql agent ask "fraud exposure by region in the last 24 hours" --format json | jq '.kind, .block.nodeId'
```

> **You should see**
> ```text
> "certified"
> "block:fraud_alerts_by_region"
> ```

---

## Step 4 — Ask something that has no certified match

```bash
dql agent ask "which merchants are driving the biggest fraud exposure this morning?"
```

> **You should see** — assuming `fraud_by_merchant` *isn't* a strong
> match (it's not RLS-narrowed and the question is "this morning",
> i.e. a different time window):
>
> ```text
> ! AI-generated · uncertified
>
> Top merchants by fraud exposure 02:00–08:00 EST. Joins fct_fraud_alerts
> with dim_merchants. Limit 25.
>
> Citations:
>   - block fraud_alerts_by_region · a3c7f1d2
>   - dbt_source merchants
>   - dbt_source fraud_alerts
>
> --- Proposed SQL (review before saving as a block) ---
> SELECT m.merchant_name, m.mcc_code, …
> Viz: bar
> ```

This is the **Stage 2** path. The loop:

1. FTS5 hit `fraud_by_merchant`, but the certified-bar didn't clear (small
   KG; tweak `CERTIFIED_HIT_THRESHOLD` in
   [`answer-loop.ts`](../../packages/dql-agent/src/answer-loop.ts) to
   tune).
2. Loop gathered the top 6 KG hits as context (blocks + sources).
3. LLM was called with that grounded prompt.
4. SQL was extracted from a fenced ```sql block + viz hint.

When this happens to your team, the *next* step is review (tutorial 08).

---

## Step 5 — Add a Skill for Sara (CFO)

Skills are markdown files with YAML frontmatter that personalise the agent
per user. Sara's skill makes "VaR", "AUM", "deposits" expand to specific
metric ids and frames every answer in board-meeting style.

Create `acme-bank/.dql/skills/cfo-monthly.skill.md`:

```markdown
---
id: cfo-monthly-review
user: sara.fitch@acme-bank.com
description: Sara's monthly board review at Acme Bank
preferred_metrics: [aum, total_deposits, fraud_loss, nim, var]
preferred_blocks: [fraud_alerts_by_region, daily_transaction_volume]
vocabulary:
  ARR: "metric:arr"
  AUM: "metric:aum"
  VaR: "metric:var"
  "fraud loss": "metric:fraud_loss"
  NIM: "metric:nim"
  "deposits": "metric:total_deposits"
---

Sara presents to the board on the last Tuesday of each month.

Always cite the block + git SHA. Default to YoY comparisons on revenue and
deposits, MoM on fraud loss, and current-month + 12-month-trailing on AUM.
Flag any metric whose domainTrust score is below 0.85 — those need analyst
sign-off before the deck.
```

Reindex so the KG picks up the skill node:

```bash
dql agent reindex
```

> **You should see** `13 nodes, 6 edges, 1 skill(s).`

Now ask **as Sara**:

```bash
dql agent ask "deposits trend last quarter" --user sara.fitch@acme-bank.com
```

> **You should see** — even if no certified block matches — the agent's
> proposal cite the `total_deposits` metric (vocabulary mapping fired)
> and the prose include "YoY" framing (Sara's skill body).

The flow:

1. `loadSkills(projectRoot)` reads `.dql/skills/**`.
2. `buildSkillsPrompt(skills, userId)` filters to skills bound to Sara
   (or unscoped) and stitches them into the system prompt.
3. The LLM sees Sara's vocabulary + presentation rules + preferred metrics
   in addition to the KG context.

---

## Step 6 — Record feedback and watch promotion candidates surface

Run a fallback question and 👎 it:

```bash
dql agent ask "MRR last month" --user finance@acme-bank.com
# (assume the answer is uncertified)

dql agent feedback down --question "MRR last month" \
  --block "block:revenue_mrr" --user finance@acme-bank.com \
  --comment "wrong cohort definition"
```

> **You should see** `✓ Recorded down from finance@acme-bank.com.`

Now run a high-quality fallback five times with thumbs-up:

```bash
for u in u1 u2 u3 u4 u5; do
  dql agent feedback up \
    --question "median order value by region" \
    --block "block:median_order_by_region" \
    --user "$u@acme-bank.com"
done
```

Pull the promotion suggester:

```bash
node -e "
  const { getPromotionCandidates } = require('@duckcodeailabs/dql-agent');
  console.log(getPromotionCandidates(process.cwd()));
"
```

> **You should see**
> ```js
> [{ blockId: 'block:median_order_by_region',
>    question: 'median order value by region',
>    ups: 5 }]
> ```

That's how analysts find AI answers worth certifying — covered fully in
[tutorial 08](./08-promoting-ai-blocks.md).

---

## Step 7 — Same answer loop from the desktop chat cell

Open `dql notebook`. Anywhere in a notebook, hit **+ Cell → Chat**. Type
the same question:

> **What you'll see (today):** the existing chat cell answers via the
> Claude Agent SDK path that's been there since v1.0.3. Wiring the new
> answer loop to also produce Certified/Uncertified badges in this cell
> is a small follow-up — the engine is the same, the cell just doesn't
> render the badge yet.

Tutorial 07 walks the full Slack experience where badges are visible.

---

## Step 8 — Same loop via MCP (Claude Code, Cursor, Claude Desktop)

The MCP server now exposes `kg_search` and `feedback_record` alongside the
existing `search_blocks`, `get_block`, `query_via_block`, `lineage_impact`,
`certify`, and `suggest_block`.

Boot it:

```bash
dql mcp                     # stdio for Claude Code / Cursor
# or:
dql mcp --http              # loopback HTTP for the VS Code extension
```

In Claude Code, configure the MCP server entry pointing at the `dql mcp`
command. Then ask the model:

> _"Search the DQL knowledge graph for fraud-related blocks in the cards
> domain."_

The model calls `kg_search({ query: "fraud", kinds: ["block"], domain: "cards" })`
and returns the certified blocks as grounded context. Every downstream
"answer" is anchored to a block id.

---

## What you now have

✓ A built KG indexing every block + dashboard + skill
✓ A working answer loop with Certified vs Uncertified badging
✓ A Skill that personalises the agent for Sara
✓ Feedback rows feeding the self-learning suggester
✓ MCP exposing the same loop to external agent clients

[Continue to tutorial 07 — End-to-end fraud spike →](./07-fraud-spike-walkthrough.md)
