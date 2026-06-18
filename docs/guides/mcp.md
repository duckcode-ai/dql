# Connect DQL to an AI agent (MCP)

DQL ships an [MCP](https://modelcontextprotocol.io) server that gives any
MCP-capable agent **governed** access to your analytics: it answers from
certified blocks when they exactly fit the question and clearly flags anything
it has to generate. Point
Claude Code, Claude Desktop, Cursor, Codex, or any other MCP client at it and
your agent answers data questions from trusted, git-versioned blocks — citing
them — instead of inventing SQL.

## What the agent gets

The server exposes governed workflow tools plus the lower-level building blocks
they use:

| Tier | Tools | Behavior |
|---|---|---|
| **front door** | `inspect_dql_project`, `ask_dql` | Verifies the project, refreshes local metadata/indexes, and returns the safe route: certified block, generated SQL preview, research, or clarify. |
| **1 — certified** | `query_via_block`, `search_blocks`, `get_block` | Serves only `status = "certified"` blocks when the block grain exactly answers the question. Safe to ship. |
| **2 — proposed** | `query_via_metadata`, `list_proposals`, `suggest_block`, `build_dql_block` | For named customers/users/accounts, custom filters, rankings, breakdowns, comparisons, drill-throughs, or missing exact blocks, the agent's read-only SQL runs as a bounded preview, returns `uncertified: true`, and is saved as a draft under `blocks/_drafts/` for human review. |
| **Apps** | `build_dql_app` | Creates or plans an app draft using certified tiles first and review-only placeholders for missing evidence. |
| **support** | `certify`, `lineage_impact`, `list_metrics`, `list_dimensions`, `kg_search`, `feedback_record` | Governance checks, lineage tracing, the semantic layer, and feedback. |

The server's instructions tell the agent to search certified context first,
execute a certified block only for an exact direct KPI or saved-block match,
flag Tier‑2 answers verbatim, and refuse when metadata is insufficient — so
generated SQL never silently becomes a "trusted" number.

For external agents, the preferred call order is:

1. `inspect_dql_project`
2. `ask_dql`
3. `query_via_block` when `ask_dql.route = "certified"`
4. `query_via_metadata` when `ask_dql.route = "generated_sql"`
5. `build_dql_block` or `build_dql_app` only after the user asks to save a reusable asset

## App chat with SDK providers

The notebook and app chat runtime can also attach trusted remote MCP servers
when OpenAI or Anthropic is the active provider. DQL still exposes its own
governed tools first: certified block search/execution, DQL manifest search,
dbt/source metadata, semantic context, runtime schema inspection, bounded SQL
preview, draft block creation, and certification checks.

Create `.dql/mcp-servers.json` to let the active SDK provider use external
remote MCP servers or OpenAI connectors:

```json
{
  "servers": [
    {
      "name": "github",
      "url": "https://api.githubcopilot.com/mcp/",
      "trusted": true,
      "authorizationTokenEnv": "GITHUB_MCP_TOKEN",
      "allowedTools": ["search_issues"],
      "providers": ["openai", "anthropic"]
    }
  ],
  "connectors": [
    {
      "name": "gdrive",
      "connectorId": "connector_googledrive",
      "trusted": true,
      "authorizationTokenEnv": "GOOGLE_DRIVE_OAUTH_TOKEN",
      "providers": ["openai"]
    }
  ]
}
```

`trusted: true` is required before DQL attaches a remote MCP server. Use
provider filtering when a server should only be available to one SDK. OpenAI
uses the Responses API `mcp` tool for remote servers and connectors; Anthropic
uses the Messages API MCP connector for remote HTTP/SSE servers.

## Run the server

From a DQL project folder:

```bash
dql mcp                 # stdio (default) — for clients that spawn a child process
dql mcp --http          # loopback HTTP on 127.0.0.1 with a bearer token
dql mcp test            # verify manifest, metadata, agent index, and MCP readiness
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

Run from your DQL project folder:

```bash
dql connect claude-code
```

This writes project-local `.mcp.json` and adds DQL guidance to `CLAUDE.md`.
Open Claude Code in the same project and run `/mcp` to confirm the `dql` server
is loaded. Then ask a data question — Claude routes through `ask_dql`, answers
from certified blocks when the grain fits, and flags generated SQL as
uncertified.

Starter projects ignore `.mcp.json` because it can contain local machine paths.
Commit `CLAUDE.md` only when you want to share the DQL agent guidance with the
team.

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

Or let DQL write/update that config:

```bash
dql connect claude-desktop /abs/path/to/your/dql
```

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

Or generate the project config:

```bash
dql connect cursor
```

## Codex (OpenAI Codex CLI)

Add to the trusted project's `.codex/config.toml`:

```toml
[mcp_servers.dql]
command = "npx"
args = ["-y", "@duckcodeailabs/dql-cli", "mcp", "/abs/path/to/your/dql"]
```

Or let DQL add the block and DQL guidance in `AGENTS.md`:

```bash
dql connect codex
```

Open the DQL project in Codex after connecting. If Codex asks whether to trust
the project, trust it so the project-local MCP config is loaded.

Starter projects ignore `.codex/` because it can contain local machine paths.
Commit `AGENTS.md` only when you want to share the DQL agent guidance with the
team.

## Configure all local clients

From the DQL project folder:

```bash
dql connect all
```

This writes project config for Claude Code, Codex, and Cursor, and updates
Claude Desktop's user config. Use the individual commands above when you only
want one client configured.

After connecting any client, run:

```bash
dql mcp test /abs/path/to/your/dql
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
