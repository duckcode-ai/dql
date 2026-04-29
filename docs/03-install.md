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
the DQL framework source repo, Docker creates and opens the bundled Acme Bank
starter at `.dql/docker-starter/acme-bank`. If you run the same image from a
folder that already has `dql.config.json`, that folder opens as the project.

To run the Slack bot or a local Ollama daemon in the same compose stack:

```bash
docker compose --profile slack  up   # adds the bot on :3479
docker compose --profile ollama up   # adds local Ollama on :11434
```

## Option B — npm (Node 20+) · 2 minutes

If you already have Node, scaffold a project and run the notebook with the
project-local DQL CLI:

```bash
npx create-dql-app@latest my-analytics
cd my-analytics
npm install
npm run doctor
npm run notebook
```

Open **http://127.0.0.1:3474**. Use the Acme Bank template when you want the
full Apps/persona/agent walkthrough:

```bash
npx create-dql-app@latest acme-bank --template acme-bank
cd acme-bank
npm install
npm run compile
npm run app:build
npm run notebook
```

For an existing DQL project, install only the CLI:

```bash
npm i -D @duckcodeailabs/dql-cli
npx @duckcodeailabs/dql-cli doctor
npx @duckcodeailabs/dql-cli notebook
```

## Existing dbt repo

If you already have one dbt repo, keep DQL isolated in a `dql/` folder inside
that repo:

```bash
cd my-dbt-repo
npm i -D @duckcodeailabs/dql-cli
npx dql init ./dql
dbt build
npx dql compile ./dql
npx dql sync dbt ./dql
npx dql notebook ./dql
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

Global install is optional:

```bash
npm i -g @duckcodeailabs/dql-cli
dql --version
```

Works on macOS, Linux, and Windows.

## Verify

```bash
dql --version
# DQL 1.4.0 or later
```

If you see the version number, jump to the [Quickstart →](01-quickstart.md).

## Troubleshooting

- **`command not found: dql`** — use `npm run notebook` inside a scaffolded
  project, `npx dql ...` when the CLI is installed locally, or add your global
  npm bin (`npm prefix -g`/bin) to `$PATH`.
- **Node version errors** — DQL requires Node 20+. Install via
  [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm).
- **Port already in use** — edit `docker-compose.yml` and change
  `127.0.0.1:3474:3474` to map a different host port (e.g. `:3475:3474`).
- **Container can't see your project** — confirm `volumes: ./:/workspace`
  in `docker-compose.yml`; if you `cd` to a different directory before
  `docker compose up`, that's the project that gets mounted.
