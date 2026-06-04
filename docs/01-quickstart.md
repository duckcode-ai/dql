# Quickstart

> ~10 minutes · ends with a local App, certified blocks, a manifest, and lineage

This is the OSS adoption path for DQL. It uses the Acme Bank template because it
shows the complete local-first workflow: sample data, certified blocks, Apps,
notebooks, `dql-manifest.json`, and lineage. No external warehouse, hosted
account, SSO, or team RBAC is required.

## 1. Scaffold Acme Bank

```bash
npx create-dql-app@latest acme-bank --template acme-bank
cd acme-bank
npm install
```

The generated project installs the DQL CLI locally. You can use `npm run ...`
without installing a global `dql` binary.

## 2. Check the local project

```bash
npm run doctor
```

`dql doctor` verifies the local project shape, notebook assets, semantic layer,
and default connection. It also prints the next commands for the local OSS
workflow.

## 3. Start the notebook

```bash
npm run notebook
```

The CLI starts a local server on **http://127.0.0.1:3474** and opens the
browser UI. Open **Apps** to inspect Acme's packaged dashboard pages, then open
**Blocks** to inspect certified reusable blocks.

## 4. Inspect and certify a block

The template ships with certified example blocks. To run the local certification
gate for the cards KPI:

```bash
npm run certify:cards
```

Certification in OSS is a local trust label. It checks required metadata, query
execution, and test assertions, then marks blocks as reusable for local Apps,
notebooks, and agent answers.

## 5. Compile the manifest and view lineage

```bash
npm run compile
npm run lineage
```

`dql compile` writes `dql-manifest.json`, the dbt-like artifact for this DQL
project. It records blocks, notebooks, Apps, dashboard pages, semantic objects,
sources, dbt imports when present, and lineage edges.

`npm run lineage` summarizes how data flows from source CSV tables into certified
blocks, dashboard pages, and Apps.

## Verify it worked

You should have:

- A running local notebook at `http://127.0.0.1:3474`
- Certified Acme blocks visible in Block Studio
- `dql-manifest.json` written in the project root
- Lineage showing source tables, blocks, dashboards, and Apps

## Where to go next

- [DQL in 5 concepts](04-dql-in-5-concepts.md)
- [Block Studio dbt-first workflow](guides/block-studio.md)
- [Import your dbt project](guides/import-dbt.md)
- [Jaffle Shop walkthrough](guides/jaffle-shop.md)
