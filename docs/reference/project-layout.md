# Project layout

A DQL project is a local-first git repo with a few conventional directories.
Shared assets are plain files. Private App overlays, saved layouts, and AI pins
live under `.dql/local/` and are not committed.

For new enterprise-style repos, prefer the domain-first layout:

```text
my-dql-project/
├─ dql.config.json
├─ domains/
│   ├─ customer/
│   │   ├─ domain.dql
│   │   ├─ terms/
│   │   ├─ blocks/
│   │   │   └─ _drafts/
│   │   ├─ views/
│   │   └─ apps/
│   └─ revenue/
├─ blocks/                  # legacy-compatible shared blocks
├─ terms/                   # legacy-compatible shared terms
├─ business-views/          # legacy-compatible shared views
├─ apps/
└─ .dql/cache/
```

The compiler scans both layouts and emits one manifest. Use:

```bash
dql new domain customer
dql new block --domain customer --pattern entity_profile "Customer Profile"
dql new view --domain customer "Customer 360"
dql migrate layout --to domain-first --dry-run
```

```text
my-dql-project/
├─ dql.config.json          # connection, semantic layer, dbt wiring
├─ package.json             # npm scripts: notebook, compile, sync, doctor
├─ blocks/                  # certified reusable .dql files
│   └─ revenue_by_segment.dql
├─ terms/                   # .dql business vocabulary terms
│   └─ customer.dql
├─ business-views/          # .dql business composition views
│   └─ customer_360.dql
├─ notebooks/               # .dqlnb interactive notebooks
│   └─ welcome.dqlnb
├─ apps/                    # OSS App packages for decision-facing work
│   └─ cards-fraud-ops/
│       ├─ dql.app.json     # App metadata: domain, subdomain, group, lifecycle
│       ├─ README.md
│       ├─ dashboards/
│       │   └─ daily-ops.dqld
│       ├─ notebooks/
│       │   └─ investigation.dqlnb
│       └─ drafts/
│           └─ ai-generated-block.dql
├─ semantic-layer/          # metrics, dimensions, hierarchies, cubes (YAML)
│   ├─ metrics/revenue.yaml
│   └─ dimensions/customer.yaml
├─ data/                    # local CSV/Parquet — git-ignored by default
└─ .dql/                    # manifest cache and private local state — git-ignored
    ├─ imports/             # SQL import review sessions
    └─ local/apps.sqlite    # private Apps, AI pins, saved layouts
```

## What each directory holds

- **`domains/<domain>/domain.dql`** — first-class domain metadata: owner,
  business owner, bounded context, source systems, primary terms, cadence, and
  tags. Domain folders can contain `terms/`, `blocks/`, `views/`, and `apps/`.
- **`blocks/`** — one `.dql` file per block. Governance fields (`domain`,
  `owner`) are required by default; the certification check runs on CI.
- **`terms/`** — one `.dql` file per `term`. These define business vocabulary,
  identifiers, synonyms, business rules, and caveats without requiring SQL.
- **`business-views/`** — one `.dql` file per `business_view`. These compose
  blocks and other business views into business lineage, without running SQL.
- **`notebooks/`** — interactive analysis. Saved results live beside the
  notebook as `.run.json` (git-ignored).
- **`apps/`** — decision-facing packages. An App can have dashboard pages,
  attached notebooks, AI conversations and pins, and draft DQL blocks. In OSS, `domain`,
  `subdomain`, `groups`, `audience`, `visibility`, and `lifecycle` are
  organization metadata, not enterprise access-control boundaries.
- **`semantic-layer/`** — metrics and dimensions authored locally. When you
  configure dbt artifacts, DQL reads MetricFlow semantics from
  `target/semantic_manifest.json` and keeps generated cache files under `.dql/`.
- **`data/`** — sample data for local exploration. Production projects usually
  query a warehouse instead.
- **`.dql/imports/`** — local import review sessions. AI SQL imports follow
  `extract -> parameterize -> match/reuse -> validate -> review -> certify`.
  The session stores draft candidates, parameter decisions, evidence, and
  duplicate/reuse recommendations.
- **`.dql/local/apps.sqlite`** — private single-user state such as local Apps,
  layout overrides, AI pins, and saved views.

## App mental model

Use one library model:

```text
Domain -> Subdomain -> Group / Use Case -> App
  -> Dashboard pages
  -> Supporting notebooks
  -> AI conversations and pinned summaries
  -> Draft blocks
```

- **Domain** is the business area, such as Cards, Lending, or Deposits.
- **Subdomain** is the narrower area, such as Fraud or Merchant Risk.
- **Group** is a local use-case/team label in OSS.
- **App** is the main user-facing package.
- **Dashboard page** is a curated grid inside an App.
- **Notebook** is the analysis workbench attached to an App.
- **AI Pin** is local output that can be promoted to a review draft.

`certified` is a trust label in OSS. It is not SSO, RBAC, or hosted governance.

## Notebook UI workflow

The OSS notebook UI is organized around the work a single user does most often:

- **Apps** — browse My Local, Shared, Templates, and Review App views by
  domain, subdomain, group, owner, lifecycle, certification, and tags.
- **Notebooks** — open and edit `.dqlnb` analysis files.
- **Blocks** — browse reusable `.dql` blocks and open the dbt-first Block
  Studio. Import SQL is a top action inside this surface, not a separate left
  navigation item.
- **Review** — inspect Apps in review, AI pins, draft blocks, and certified
  App counts before promoting work.
- **Settings** — local provider keys and runtime settings.

Inside an App, the UI has two modes:

- **View** shows dashboard pages, attached notebook previews, AI conversations,
  and pinned summaries. It hides builder controls, drafts, and settings.
- **Build** exposes dashboard page creation, chart tile editing, notebook
  attachment, AI pin promotion, draft blocks, and App settings.

The create-App flow starts from one of four sources: empty App, notebook,
template, or import. Import opens Block Studio's SQL import wizard first, then
you add the saved draft/certified blocks from the App Build catalog.

## Working with dbt

For an existing single dbt repo, keep DQL isolated under `dql/`:

```text
my-dbt-repo/
├─ dbt_project.yml
├─ models/
├─ macros/
├─ target/
│   └─ manifest.json       # produced by `dbt parse` or `dbt build`
└─ dql/
    ├─ dql.config.json     # dbt.projectDir: ".."
    ├─ blocks/
    ├─ terms/
    ├─ business-views/
    ├─ notebooks/
    ├─ apps/
    └─ .dql/
```

This is the recommended OSS path. The dbt project stays clean, while all DQL
blocks, notebooks, Apps, imports, private state, and cache files live in one
folder.

The sibling layout keeps the DQL workspace next to dbt:

```text
my-team/
├─ dbt/                     # your dbt project (dbt_project.yml)
│   └─ target/manifest.json # produced by `dbt parse` or `dbt build`
└─ dql/                     # your DQL project
    └─ dql.config.json      # dbt.projectDir: "../dbt"
```

`dql init ./dql` detects the parent dbt project. `create-dql-app` and
`dql init` also auto-detect common sibling layouts and wire the config for you.
After `dbt build`, run `dql compile ./dql`, `dql sync dbt ./dql`, and
`cd dql && dql agent reindex` to refresh lineage, cache status, and the agent
index.

The lineage flow is:

```text
business term -> DQL block -> business_view -> dashboard page -> App
dbt source -> dbt model -> semantic metric -> DQL block -> business_view -> dashboard page -> App
```

## What gets committed

**Commit:** durable shared source: `domains/**/domain.dql`,
`domains/**/blocks/**/*.dql`, legacy `blocks/**/*.dql`, `terms/**/*.dql`,
`business-views/**/*.dql`, `semantic-layer/**/*.yaml`, reviewed
`apps/*/dql.app.json`, reviewed `apps/*/dashboards/*.dqld`, curated/shared
`.dqlnb` notebooks, `dql.config.json`, and `package.json`.

**Don't commit:** local or generated state: `.dql/cache/**`, `.dql/local/**`,
`.dql/imports/**` by default, `*.run.json`, `dql-manifest.json`, `data/**`,
AI pins, saved views, personal layout overrides, local SQLite/DuckDB files, and
temporary generated artifacts.

Use `dql promote notebook <path> --to shared`, `dql promote app <app-id> --to shared`,
or `dql promote dashboard <app-id>/<dashboard-id> --to shared` to turn private
work into clean shared source. Run `dql doctor git-hygiene` before committing to
flag tracked files that violate this policy.
