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

The notebook is now live at **http://127.0.0.1:3474** with the current
working directory mounted as the project root, so anything you save lands
in your repo.

To run the Slack bot or a local Ollama daemon in the same compose stack:

```bash
docker compose --profile slack  up   # adds the bot on :3479
docker compose --profile ollama up   # adds local Ollama on :11434
```

## Option B — npm (Node 20+) · 30 seconds

If you already have Node, the CLI publishes to npm:

```bash
npx @duckcodeailabs/dql-cli --version              # zero-install
npm i -g @duckcodeailabs/dql-cli && dql --version  # global
```

Works on macOS, Linux, and Windows.

## Verify

```bash
dql --version
# DQL 1.4.0 or later
```

If you see the version number, jump to the [Quickstart →](01-quickstart.md).

## Troubleshooting

- **`command not found: dql`** — use `npx @duckcodeailabs/dql-cli` instead,
  or add your global npm bin (`npm prefix -g`/bin) to `$PATH`.
- **Node version errors** — DQL requires Node 20+. Install via
  [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm).
- **Port already in use** — edit `docker-compose.yml` and change
  `127.0.0.1:3474:3474` to map a different host port (e.g. `:3475:3474`).
- **Container can't see your project** — confirm `volumes: ./:/workspace`
  in `docker-compose.yml`; if you `cd` to a different directory before
  `docker compose up`, that's the project that gets mounted.
