# Quickstart

> ~10 minutes · ends with the dbt DAG imported, a certified block, a
> manifest, and end-to-end lineage

DQL adds an analytics layer on top of a dbt project: certified blocks,
dashboards in Apps, notebooks, and governed agent answers — all as files in
git. This quickstart adds DQL to **your own dbt repo**. No external warehouse,
hosted account, SSO, or team RBAC is required.

> **Just want to see it running?** The
> [jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb) repo
> ships a complete, ready-built DQL workspace (10 certified blocks + an
> executive App dashboard). Clone it, `./setup.sh`, then
> `cd dql && npm install && npm run notebook`. The rest of this page builds the
> same thing from scratch on your repo.

## 1. Make your dbt manifest fresh

```bash
cd your-dbt-repo
dbt parse        # or dbt build — either writes target/manifest.json
```

## 2. Scaffold the DQL workspace

From the dbt repo root:

```bash
npx create-dql-app@latest dql
cd dql
npm install
```

The scaffolder detects the parent dbt project and wires it into
`dql.config.json`. DQL stays isolated under `./dql`; your dbt files are
untouched. The generated project installs the DQL CLI locally, so `npm run
...` works without a global `dql` binary.

Point the default connection at your dbt warehouse in `dql.config.json`. For a
local DuckDB file that's:

```json
"connections": {
  "default": { "driver": "duckdb", "filepath": "../my_warehouse.duckdb" }
}
```

(Postgres, Snowflake, BigQuery, etc. — see
[connectors](reference/connectors.md).)

## 3. Check the setup and sync dbt

```bash
npm run doctor
npm run sync
```

`dql doctor` verifies the project shape, notebook assets, and default
connection. `dql sync dbt` imports the dbt models and sources into the DQL
manifest so lineage connects end to end.

## 4. Start the notebook

```bash
npm run notebook
```

The CLI starts a local server on **http://127.0.0.1:3474** and opens the
browser UI. Query a dbt model from a notebook cell, then open **Blocks** to
create your first block from a dbt model (the
[authoring tutorial](tutorials/02-authoring-blocks.md) walks through a full
certified block).

## 5. Compile the manifest and view lineage

```bash
npm run compile
npm run lineage
```

`dql compile` writes `dql-manifest.json`, the dbt-like artifact for the DQL
workspace: blocks, notebooks, Apps, dashboard pages, semantic objects, dbt
imports, and lineage edges. `npm run lineage` summarizes how data flows from
sources through dbt models into blocks, dashboard pages, and Apps.

## Verify it worked

You should have:

- A running local notebook at `http://127.0.0.1:3474`
- The dbt DAG visible in the **Lineage** view
- `dql-manifest.json` written in the workspace root

## Where to go next

- [Tutorials — end to end](tutorials/README.md) *(blocks → dashboards & Apps → agent → CI)*
- [DQL in 5 concepts](04-dql-in-5-concepts.md)
- [Block Studio dbt-first workflow](guides/block-studio.md)
- [Import your dbt project](guides/import-dbt.md)
