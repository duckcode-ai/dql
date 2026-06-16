# Connect DQL to an AI agent (MCP)

DQL ships an [MCP](https://modelcontextprotocol.io) server that gives any
MCP-capable agent **governed** access to your analytics: it answers from
certified blocks when they exactly fit the question and clearly flags anything
it has to generate. Point
Claude Code, Claude Desktop, Cursor, Codex, or any other MCP client at it and
your agent answers data questions from trusted, git-versioned blocks — citing
them — instead of inventing SQL.

## What the agent gets

The server exposes **12 tools** organized around a graduated-trust loop:

| Tier | Tools | Behavior |
|---|---|---|
| **1 — certified** | `query_via_block`, `search_blocks`, `get_block` | Serves only `status = "certified"` blocks when the block grain exactly answers the question. Safe to ship. |
| **2 — proposed** | `query_via_metadata`, `list_proposals`, `suggest_block` | For named customers/users/accounts, custom filters, rankings, breakdowns, comparisons, drill-throughs, or missing exact blocks, the agent's read-only SQL runs as a bounded preview, returns `uncertified: true`, and is saved as a draft under `blocks/_drafts/` for human review. |
| **support** | `certify`, `lineage_impact`, `list_metrics`, `list_dimensions`, `kg_search`, `feedback_record` | Governance checks, lineage tracing, the semantic layer, and feedback. |

The server's instructions tell the agent to search certified context first,
execute a certified block only for an exact direct KPI or saved-block match,
flag Tier‑2 answers verbatim, and refuse when metadata is insufficient — so
generated SQL never silently becomes a "trusted" number.

## Run the server

From a DQL project folder:

```bash
dql mcp                 # stdio (default) — for clients that spawn a child process
dql mcp --http          # loopback HTTP on 127.0.0.1 with a bearer token
```

Most desktop clients use **stdio** and launch the command for you — you just
add the config below. Use `--http` only for clients that connect to a URL
instead of spawning a process (it prints `http://127.0.0.1:<port>/mcp` and an
`Authorization: Bearer <token>` to stderr; loopback-only).

> **Project path matters.** `dql mcp` resolves the project from its working
> directory. Clients that don't launch from your project folder (Claude
> Desktop, Cursor, Codex) need the project path passed as the last argument —
> shown below as `/abs/path/to/your/dql`.

---

## Claude Code

Run from your DQL project folder (cwd is the project, so no path needed):

```bash
claude mcp add dql -- npx -y @duckcodeailabs/dql-cli mcp
```

Then ask Claude a data question — it answers from your certified blocks and
cites them.

## Claude Desktop

Settings → Developer → **Edit Config** opens `claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "dql": {
      "command": "npx",
      "args": ["-y", "@duckcodeailabs/dql-cli", "mcp", "/abs/path/to/your/dql"]
    }
  }
}
```

Restart Claude Desktop; "dql" appears in the tools menu.

## Cursor

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all
projects):

```json
{
  "mcpServers": {
    "dql": {
      "command": "npx",
      "args": ["-y", "@duckcodeailabs/dql-cli", "mcp", "/abs/path/to/your/dql"]
    }
  }
}
```

Enable it under Cursor → Settings → MCP.

## Codex (OpenAI Codex CLI)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.dql]
command = "npx"
args = ["-y", "@duckcodeailabs/dql-cli", "mcp", "/abs/path/to/your/dql"]
```

## Any other MCP client

The pattern is identical — a stdio server you launch with:

```
command: npx
args:    -y @duckcodeailabs/dql-cli mcp /abs/path/to/your/dql
```

If your DQL CLI is installed locally in the project, you can also use
`node ./node_modules/@duckcodeailabs/dql-cli/dist/index.js mcp`.

---

## Try it

After wiring any client, ask:

> *"What was our revenue last month?"*

A certified block match → the agent answers from it and cites it. No match →
or a deeper/custom-grain question → it proposes SQL flagged **Uncertified** and files a draft you can review with
`dql certify --from-draft`. Build the knowledge graph first if you haven't:

```bash
dql agent reindex
```

See [tutorial 04 — Agentic analytics](../tutorials/04-agentic-analytics.md) for
the full loop, and [the agentic architecture](../architecture/graduated-trust.md)
for how graduated trust works.
