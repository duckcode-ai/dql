---
hide:
  - navigation
  - toc
---

# DQL

> **Analytics as code for certified reusable blocks, Apps, and dbt-aware lineage.**

DQL OSS is a local-first, single-user workspace for turning analytics work into
git-backed source artifacts. Blocks carry SQL or semantic intent, owner, domain,
description, tests, chart config, and agent context. Apps package certified
blocks into decision-facing dashboard pages and notebooks. `dql compile`
generates a dbt-like manifest with lineage from sources and dbt models through
blocks and Apps.

No hosted account is required. Certification is a local trust label. Personas
and policies are local previews, not hosted RBAC.

## Start Here

```bash
npx create-dql-app@latest acme-bank --template acme-bank
cd acme-bank
npm install
npm run doctor
npm run notebook
```

Then run:

```bash
npm run certify:cards
npm run compile
npm run lineage
```

## Why DQL

- **Certified blocks.** Save reusable answer units with metadata, tests, and
  local trust status.
- **Apps in git.** Package dashboard pages, notebooks, text, AI pins, and draft
  blocks in local App folders.
- **dbt-aware lineage.** Connect sources, dbt models, semantic metrics, DQL
  blocks, dashboard pages, and Apps in `dql-manifest.json`.
- **Agent-safe defaults.** Local agent and MCP tools prefer certified blocks and
  label fallback generated SQL as uncertified.
- **OSS boundary clarity.** Local single-user workflows are open source; hosted
  auth, managed secrets, audit logs, organization RBAC, and approval workflows
  are outside OSS.

## Learn

1. [Quickstart](01-quickstart.md) — Acme Bank local-first workflow
2. [DQL in 5 concepts](04-dql-in-5-concepts.md)
3. [Block Studio](guides/block-studio.md)
4. [Author a certified block](guides/authoring-blocks.md)
5. [Import dbt](guides/import-dbt.md)
6. [Jaffle Shop walkthrough](guides/jaffle-shop.md)

## What Ships

```mermaid
flowchart LR
    Project["DQL project"] --> Compiler["dql compile"]
    Compiler --> Manifest["dql-manifest.json"]
    Manifest --> Lineage["dql lineage"]
    Manifest --> MCP["dql mcp"]
    Manifest --> Notebook["dql notebook + Apps"]
    Blocks["Certified blocks"] --> Apps["Apps"]
    Apps --> Notebook
```

| Package | What it does |
|---|---|
| [`@duckcodeailabs/dql-cli`](https://www.npmjs.com/package/@duckcodeailabs/dql-cli) | The `dql` binary: notebook, compile, validate, certify, lineage, MCP |
| [`@duckcodeailabs/dql-core`](https://www.npmjs.com/package/@duckcodeailabs/dql-core) | Parser, formatter, semantic analyzer, manifest builder, lineage |
| [`@duckcodeailabs/dql-mcp`](https://www.npmjs.com/package/@duckcodeailabs/dql-mcp) | MCP tools for certified block search, query, certification, and lineage |
| [`@duckcodeailabs/dql-lsp`](https://www.npmjs.com/package/@duckcodeailabs/dql-lsp) | LSP for `.dql` files |
| [`@duckcodeailabs/dql-openlineage`](https://www.npmjs.com/package/@duckcodeailabs/dql-openlineage) | OpenLineage project snapshot events |

[GitHub](https://github.com/duckcode-ai/dql) · [Roadmap](https://github.com/duckcode-ai/dql/blob/main/ROADMAP.md) · [Support](https://github.com/duckcode-ai/dql/blob/main/SUPPORT.md)
