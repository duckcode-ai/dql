# Install

Two paths. Pick whichever matches your toolchain.

## Option A — Docker (zero local toolchain) · 60 seconds

The fastest way. No Node, no pnpm, no native build deps.

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
docker compose up
```

> First build takes ~3 minutes (deps + workspace build). Subsequent runs
> reuse cached layers and start in seconds.

The notebook is now live at **http://127.0.0.1:3474**. If you run this from
the DQL framework source repo, Docker creates and opens an ignored starter
project under `.dql/docker-starter/`. If you run the same image from a folder
that already has `dql.config.json`, that folder opens as the project.

To run the Slack bot or a local Ollama daemon in the same compose stack:

```bash
docker compose --profile slack  up   # adds the bot on :3479
docker compose --profile ollama up   # adds local Ollama on :11434
```

## Option B — npm (Node 20 or 22 LTS) · 2 minutes

If you already have Node, scaffold a project and run the notebook with the
project-local DQL CLI:

```bash
npx create-dql-app@latest my-analytics
cd my-analytics
npm install
npm run doctor
npm install --prefix .dql/connectors duckdb       # DuckDB/local files only
# npm install --prefix .dql/connectors snowflake-sdk  # Snowflake only
# Databricks does not need an extra package.
npm run notebook
```

Open **http://127.0.0.1:3474**. The starter is a clean project with
`dql.config.json`, a welcome notebook, and npm scripts for the local workflow.
Run it inside a dbt repo and the dbt project is wired in automatically (see
below). To try DQL on a sample dbt project, clone
[jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).

Install only the database driver the project uses:

| Database | Extra install before running queries | Notes |
| --- | --- | --- |
| Databricks SQL | none | Built into DQL through HTTPS |
| DuckDB or local CSV/Parquet/JSON files | `npm install --prefix .dql/connectors duckdb` | Needed for `duckdb` and `file` connections |
| Snowflake | `npm install --prefix .dql/connectors snowflake-sdk` | Needed for Snowflake connections |

The notebook Connections page can also install DuckDB or Snowflake into
`.dql/connectors/`.

For an existing DQL project, install only the CLI:

```bash
npm i -D @duckcodeailabs/dql-cli
npx @duckcodeailabs/dql-cli doctor
npx @duckcodeailabs/dql-cli notebook
```

## Existing dbt repo

If you already have a dbt repo, keep DQL isolated in a `dql/` folder inside
that repo — this is the recommended path:

```bash
cd my-dbt-repo
dbt parse                        # ensure target/manifest.json exists
npx create-dql-app@latest dql    # detects the dbt project, wires the config
cd dql
npm install
npm run sync                     # import dbt models + lineage
npm install --prefix .dql/connectors duckdb       # DuckDB/local files only
# npm install --prefix .dql/connectors snowflake-sdk  # Snowflake only
# Databricks does not need an extra package.
npm run notebook
```

Global or local CLI install alone does not create the project folders. If you
installed `dql` globally, bootstrap the folder explicitly:

```bash
cd my-dbt-repo
dbt parse
dql init ./dql
cd dql
dql doctor
dql compile
dql sync dbt
dql notebook
```

Equivalent project-local manual path:

```bash
cd my-dbt-repo
npm i -D @duckcodeailabs/dql-cli
npx dql init ./dql
```

The resulting layout is:

```text
my-dbt-repo/
├─ dbt_project.yml
├─ models/
├─ target/manifest.json
└─ dql/
   ├─ dql.config.json
   ├─ blocks/
   ├─ notebooks/
   ├─ apps/
   └─ .dql/
```

`dql.config.json` will point at the local dbt project:

```json
{
  "semanticLayer": { "provider": "dbt", "projectPath": ".." },
  "dbt": { "projectDir": "..", "manifestPath": "target/manifest.json" }
}
```

Use the sibling layout instead when you want dbt and DQL in separate folders:
`analytics/dbt/` plus `analytics/dql/`.

Global install is optional, but project-local scripts avoid stale global CLIs:

```bash
npm i -g @duckcodeailabs/dql-cli
dql --version
```

After a global install, run `dql init ./dql` from your dbt repo root before
trying `cd dql`.

Works on macOS, Linux, and Windows.

## Verify

```bash
dql --version
# dql 1.6.14 or later
```

If you see the version number, jump to the [Quickstart →](01-quickstart.md).

## Troubleshooting

- **`command not found: dql`** — use `npm run notebook` inside a scaffolded
  project, `npx dql ...` when the CLI is installed locally, or add your global
  npm bin (`npm prefix -g`/bin) to `$PATH`.
- **Node version errors** — DQL requires Node 20 or 22 LTS. Node 23 is not
  supported for native local drivers. Install via
  [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm).
- **Port already in use** — edit `docker-compose.yml` and change
  `127.0.0.1:3474:3474` to map a different host port (e.g. `:3475:3474`).
- **Container can't see your project** — confirm `volumes: ./:/workspace`
  in `docker-compose.yml`; if you `cd` to a different directory before
  `docker compose up`, that's the project that gets mounted.
