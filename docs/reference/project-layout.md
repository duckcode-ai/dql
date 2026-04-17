# Project layout

A DQL project is a git repo with a few conventional directories. Everything
is plain files — no database, no lockfile, no hidden state.

```text
my-dql-project/
├─ dql.config.json          # connection, semantic layer, dbt wiring
├─ package.json             # npm scripts: notebook, compile, sync, doctor
├─ blocks/                  # certified reusable .dql files
│   └─ revenue_by_segment.dql
├─ notebooks/               # .dqlnb interactive notebooks
│   └─ welcome.dqlnb
├─ semantic-layer/          # metrics, dimensions, hierarchies, cubes (YAML)
│   ├─ metrics/revenue.yaml
│   └─ dimensions/customer.yaml
├─ dashboards/              # composable dashboards (.dql dashboard blocks)
│   └─ overview.dql
├─ data/                    # local CSV/Parquet — git-ignored by default
└─ .dql/                    # manifest cache — git-ignored
```

## What each directory holds

- **`blocks/`** — one `.dql` file per block. Governance fields (`domain`,
  `owner`) are required by default; the certification check runs on CI.
- **`notebooks/`** — interactive analysis. Saved results live beside the
  notebook as `.run.json` (git-ignored).
- **`semantic-layer/`** — metrics and dimensions authored locally. When you
  run `dql sync dbt`, entries imported from a sibling dbt project are merged
  here too.
- **`dashboards/`** — composed views that reference blocks.
- **`data/`** — sample data for local exploration. Production projects usually
  query a warehouse instead.

## Working with a sibling dbt project

The default layout assumes your dbt project lives alongside your DQL project:

```text
my-team/
├─ dbt/                     # your dbt project (dbt_project.yml)
│   └─ target/manifest.json # produced by `dbt parse` or `dbt build`
└─ dql/                     # your DQL project
    └─ dql.config.json      # dbt.projectDir: "../dbt"
```

`create-dql-app` and `dql init` both auto-detect the sibling and wire the
config for you. Then `dql sync dbt` imports the manifest on demand.

## What gets committed

**Commit:** `blocks/`, `notebooks/`, `semantic-layer/`, `dashboards/`,
`dql.config.json`, `package.json`.

**Don't commit:** `data/`, `.dql/`, `*.run.json`, `dql-manifest.json` (build
output). The default `.gitignore` from the scaffolder handles this.
