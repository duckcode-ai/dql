# Import a dbt project

> ~4 minutes · ends with dbt models and semantic metrics available to DQL

DQL reads dbt artifacts directly:

- `target/manifest.json` for models, sources, columns, lineage, exposures, and saved queries.
- `target/semantic_manifest.json` for MetricFlow semantic models, metrics, measures, dimensions, and entities.

## 1. Point DQL at dbt

Configure dbt in `dql.config.json`:

```json
{
  "project": "my-dql-project",
  "dbt": {
    "projectDir": "../my-dbt-project",
    "manifestPath": "target/manifest.json",
    "semanticManifestPath": "target/semantic_manifest.json"
  }
}
```

`create-dql-app` will create this wiring automatically when it detects a sibling
`dbt_project.yml`.

## 2. Generate dbt artifacts

```bash
cd ../my-dbt-project
dbt build
```

`dbt parse` or `dbt compile` is enough for `manifest.json`; use `dbt build` for
the cleanest demo path because it also proves the project runs.

## 3. Rebuild DQL metadata

```bash
cd ../my-dql-project
dql compile .
dql sync dbt .
dql agent reindex
```

`dql compile` rebuilds `dql-manifest.json` and merges dbt lineage into the local
DQL graph. `dql sync dbt` is a status/cache sync command: it verifies the
resolved dbt artifact paths, reports model/source/metric counts, and updates the
local cache when artifacts changed. `dql agent reindex` refreshes the local
SQLite + FTS knowledge graph used by governed agent answers.

## 4. Verify it worked

- Notebook Schema panel shows dbt models and sources.
- Notebook Semantic panel shows dbt semantic models, metrics, measures, and dimensions.
- `dql lineage` prints dbt source/model nodes connected to DQL blocks and Apps.
- Agent answers cite certified blocks first, then semantic/dbt metadata when no certified asset exists.

## Troubleshooting

- **`manifest.json not found`** — run `dbt build`, `dbt compile`, or `dbt parse` first.
- **Semantic metrics missing** — confirm `target/semantic_manifest.json` exists and your dbt version emits MetricFlow artifacts.
- **Lineage is stale** — rerun `dql compile .` and `dql agent reindex`.
- **Too much dbt metadata** — keep certified DQL blocks and Apps domain-scoped; selective dbt subgraph import is planned but not the default OSS v1 path.
