# How DQL fits with dbt

dbt is the **modeling** tool. DQL is the **reporting + governance** layer.
They share a single source of truth: `target/manifest.json`.

## Division of concerns

| Concern | dbt | DQL |
| --- | --- | --- |
| Transform raw → marts | ✅ | — |
| Tests on models | ✅ | — |
| Semantic layer (MetricFlow) | ✅ authoring | ✅ import + extend |
| Lineage at the model level | ✅ | ✅ (absorbs dbt's) |
| Lineage at the block / dashboard level | — | ✅ |
| Notebook authoring | — | ✅ |
| Certified reusable analytics blocks | — | ✅ |
| Static HTML dashboards | — | ✅ |
| Governance (owner, certification, lint) | partial | ✅ |
| BI-style exploration | — | ✅ |

## The integration surface

DQL reads `target/manifest.json`. That's it — no dbt-API calls, no YAML
duplication, no "DQL's version of a model."

```
dbt models     ─▶  target/manifest.json  ─▶  DQL semantic layer
dbt metrics    ─┘                         │
dbt sources    ─┘                         ▼
                                     DQL blocks
                                     DQL notebooks
                                     DQL dashboards
```

## Workflow

```bash
# In your dbt project:
dbt build

# In your DQL project:
dql sync dbt
```

Add `dql sync dbt` to your CI after `dbt build`, and DQL always reflects
the latest manifest.

## What DQL does *not* do

- **Transform raw data.** Use dbt for that.
- **Schedule model runs.** Use dbt + Airflow/Dagster/dbt Cloud.
- **Replace MetricFlow.** DQL extends it, never competes with it.

## What to move to DQL

The user-facing outputs of your analytics stack: reports, dashboards, ad
hoc notebooks, certified shared blocks. All the stuff that used to live in
Metabase/Looker/Hex and had no good git story.
