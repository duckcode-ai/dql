# Import a dbt project

> ~4 minutes · ends with dbt models and semantic metrics available to DQL

DQL reads dbt artifacts directly:

- `target/manifest.json` for models, sources, columns, lineage, exposures, and saved queries.
- `target/semantic_manifest.json` for MetricFlow semantic models, metrics, measures, dimensions, and entities.

## Recommended layouts

For an existing single dbt repo, keep DQL isolated under `dql/`:

```text
my-dbt-repo/
├─ dbt_project.yml
├─ models/
├─ macros/
├─ seeds/
├─ target/
│  ├─ manifest.json
│  └─ semantic_manifest.json
└─ dql/
   ├─ dql.config.json
   ├─ blocks/
   ├─ notebooks/
   ├─ apps/
   │  └─ <app-id>/
   │     ├─ dql.app.json
   │     ├─ dashboards/*.dqld
   │     ├─ notebooks/*.dqlnb
   │     └─ drafts/*.dql
   └─ .dql/
      ├─ cache/
      └─ local/apps.sqlite
```

This is the recommended default. dbt remains clean, and all DQL blocks,
notebooks, Apps, imports, local cache, and AI pins stay in one obvious folder.

For a two-repo or two-folder workspace, keep dbt and DQL as siblings:

```text
analytics/
├─ dbt/
│  ├─ dbt_project.yml
│  ├─ models/
│  └─ target/manifest.json
└─ dql/
   ├─ dql.config.json
   ├─ blocks/
   ├─ notebooks/
   └─ apps/
```

Use the sibling layout when DQL Apps have a different repo, ownership model, or
release cadence from dbt.

## 1. Add DQL to an existing dbt repo

From the dbt repo root:

```bash
npm i -D @duckcodeailabs/dql-cli
npx dql init ./dql
```

`dql init ./dql` detects the parent `dbt_project.yml` and writes portable dbt
wiring:

```json
{
  "project": "dql",
  "semanticLayer": {
    "provider": "dbt",
    "projectPath": ".."
  },
  "dbt": {
    "projectDir": "..",
    "manifestPath": "target/manifest.json"
  }
}
```

Add convenient scripts to `package.json` if your repo does not already have
them:

```json
{
  "scripts": {
    "dql:doctor": "dql doctor ./dql",
    "dql:compile": "dql compile ./dql",
    "dql:sync": "dql sync dbt ./dql",
    "dql:reindex": "cd dql && dql agent reindex",
    "dql:notebook": "dql notebook ./dql"
  }
}
```

## 2. Or point a sibling DQL project at dbt

Configure dbt in `dql.config.json`:

```json
{
  "project": "my-dql-project",
  "semanticLayer": {
    "provider": "dbt",
    "projectPath": "../my-dbt-project"
  },
  "dbt": {
    "projectDir": "../my-dbt-project",
    "manifestPath": "target/manifest.json"
  }
}
```

`create-dql-app` will create this wiring automatically when it detects a sibling
`dbt_project.yml`.

## 3. Generate dbt artifacts

```bash
dbt build
```

`dbt parse` or `dbt compile` is enough for `manifest.json`; use `dbt build` for
the cleanest demo path because it also proves the project runs.

## 4. Rebuild DQL metadata

Run from the dbt repo root:

```bash
dql compile ./dql
dql sync dbt ./dql
cd dql && dql agent reindex
```

`dql compile` rebuilds `dql-manifest.json` and merges dbt lineage into the local
DQL graph. `dql sync dbt` is a status/cache sync command: it verifies the
resolved dbt artifact paths, reports model/source/metric counts, and updates the
local cache when artifacts changed. `dql agent reindex` refreshes the local
SQLite + FTS knowledge graph used by governed agent answers.

## 5. Verify it worked

- Notebook Schema panel shows dbt models and sources.
- Notebook Semantic panel shows dbt semantic models, metrics, measures, and dimensions.
- Block Studio start page shows dbt artifact status and the model/metric block
  creation paths.
- `dql lineage` prints dbt source/model nodes connected to DQL blocks and Apps.
- Agent answers cite certified blocks first, then semantic/dbt metadata when no certified asset exists.

## 6. Build blocks from dbt

Open **Blocks** in the notebook UI.

- Use **Create SQL Block from dbt Model** when you need explicit SQL against a
  dbt-built table/view or warehouse table.
- Use **Create Semantic Block from dbt Metric** when the business logic already
  lives in `target/semantic_manifest.json`.
- Use **Import SQL** only for one-time migration of existing queries. Review and
  save the generated draft blocks before adding them to Apps.

SQL blocks and semantic blocks are intentionally separate. Selecting a semantic
metric while editing a SQL block prompts you to create a Semantic Block or
explicitly insert an advanced semantic reference; DQL does not silently mix
semantic metrics into raw SQL.

## What lineage tracks

After `dql compile .`, DQL builds a local `dql-manifest.json` from dbt and DQL
artifacts:

```text
dbt source
  -> dbt model
  -> semantic metric
  -> DQL block
  -> chart
  -> dashboard page
  -> App
```

DQL does not copy dbt models. It reads the dbt manifest, resolves SQL table
references from `.dql` blocks and `.dqlnb` notebooks, and connects matching dbt
models/sources into the lineage graph. App dashboards add the consumption layer
above blocks.

For large dbt projects, DQL imports the dbt subgraph anchored by DQL-referenced
tables and optional `dbtImport` filters in `dql.config.json`:

```json
{
  "dbtImport": {
    "anchors": ["tag:cards", "fct_card_transactions"],
    "include": ["path:models/marts/cards"],
    "exclude": ["tag:deprecated"]
  }
}
```

## Troubleshooting

- **`manifest.json not found`** — run `dbt build`, `dbt compile`, or `dbt parse` first.
- **Semantic metrics missing** — confirm `target/semantic_manifest.json` exists and your dbt version emits MetricFlow artifacts.
- **Lineage is stale** — rerun `dql compile .` and `dql agent reindex`.
- **Too much dbt metadata** — add `dbtImport` anchors/include/exclude filters
  and rerun `dql compile .`.
