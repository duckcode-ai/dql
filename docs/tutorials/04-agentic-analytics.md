# 04 — Agentic analytics

**Who this is for:** anyone who wants AI to answer data questions **from
governed blocks**, not from improvised SQL.

**What you'll do:** build the local knowledge graph, ask questions through
the agent, watch the graduated-trust model route between certified blocks
and flagged proposals, promote a good proposal to a certified block, and
connect the MCP server so Claude/Cursor can do the same.

**Time:** 20 minutes.

> Setup: continues from [03 — Dashboards & Apps](./03-dashboards-and-apps.md).
> You'll need one LLM provider: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
> `GEMINI_API_KEY`, or a local [Ollama](https://ollama.com) daemon
> (`ollama pull llama3.1`). Keys can also be set in the notebook's
> **Settings** page; they're stored locally with `0600` permissions.

---

## The graduated-trust model

The agent never silently invents SQL. Every answer is routed through tiers:

| Tier | Source | Label |
|---|---|---|
| 1 | A **certified DQL artifact** matches the question: executable blocks for data answers, or business terms/views for definition and context answers | ✓ Certified |
| 2 | No match — the LLM proposes SQL grounded in business context, dbt, and semantic metadata, saved as a **draft** | ⚠ Uncertified |
| 3 | Not answerable from the project | Refusal, with what's missing |

Tier-2 drafts land in `blocks/_drafts/` so popular questions become
candidates for certification — that's the promotion loop.

---

## Step 1 — Build the knowledge graph

```bash
dql agent reindex
```

> **You should see** a node/edge count — your business terms, business views,
> certified blocks, dbt models, metrics, and dimensions indexed into a local SQLite FTS5 knowledge graph
> at `.dql/cache/agent-kg.sqlite`. Nothing leaves your machine except the
> LLM calls you configure.

---

## Step 2 — Ask a question that hits a certified block

```bash
dql agent ask "how has revenue trended by month?"
```

> **You should see**
> ```text
> ✓ Certified
> Answered from block: revenue_by_month (revenue · certified)
> ```
> followed by the result rows. The `llmContext`, `examples`, attached `terms`,
> and related `business_view` context you wrote earlier are what made retrieval land.

Inspect the routing decision:

```bash
dql agent ask "how has revenue trended by month?" --format json | jq '.kind'
```

> **You should see** `"certified"`.

---

## Step 3 — Ask something no block covers

```bash
dql agent ask "what share of orders are food vs drink?"
```

> **You should see** the answer clearly labelled **Uncertified**: the LLM
> proposed SQL against the dbt `orders` mart (`is_food_order` /
> `is_drink_order`), and the proposal was saved as a draft under
> `blocks/_drafts/`.

List accumulated proposals:

```bash
ls blocks/_drafts/
```

Questions that get asked repeatedly accumulate in `_drafts/` — that's your
prioritized review queue for what to certify next.

---

## Step 4 — Promote a good proposal to a certified block

Review the draft like any code: open it in Block Studio, fix the SQL if
needed, add `owner`, `llmContext`, and `tests`, then run it through the same
gate as tutorial 02:

```bash
dql certify --from-draft blocks/_drafts/<draft-file>.dql
```

> **You should see** the rule table go green and the block land in
> `blocks/` as `certified`. Re-run `dql agent reindex`, ask the same
> question again, and the answer is now **✓ Certified** — the loop is
> closed.

Feedback tunes retrieval over time:

```bash
dql agent feedback up --question "monthly revenue" --block "block:revenue_by_month"
```

---

## Step 5 — Connect the MCP server

The same graduated-trust loop is exposed to any MCP client (Claude Code,
Claude Desktop, Cursor):

```bash
dql mcp
```

Register it with your client — e.g. for Claude Code, from your project folder:

```bash
claude mcp add dql -- npx -y @duckcodeailabs/dql-cli mcp
```

Claude Desktop, Cursor, and Codex use a config file instead — full copy-paste
setup for each is in [Connect an AI agent (MCP)](../guides/mcp.md).

The server exposes 12 tools — `search_blocks`, `query_via_block` (Tier 1,
certified only), `query_via_metadata` (Tier 2, flagged + drafted),
`list_proposals`, `list_metrics`, `lineage_impact`, `suggest_block`, and more.
Ask your agent a revenue question and it answers **from your certified
blocks**, citing them — and files drafts when it has to improvise.

---

## What you now have

✓ A local knowledge graph over blocks, dbt models, and metrics
✓ Agent answers that are certified-first, flagged when improvised
✓ The promotion loop: draft → review → certify → re-ask → certified
✓ An MCP server giving Claude/Cursor governed access to your analytics

[Continue to tutorial 05 — CI and `dql verify` →](./05-ci-and-verify.md)
