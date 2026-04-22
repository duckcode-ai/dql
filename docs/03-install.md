# Install

> ~2 minutes · requires Node 20+

DQL ships as an npm package. One path, every platform.

## Install

```bash
npx @duckcodeailabs/dql-cli --version                 # zero-install
npm i -g @duckcodeailabs/dql-cli && dql --version     # global
```

Works on macOS, Linux, and Windows.

## Verify it worked

```bash
dql --version
# DQL 1.0.4 or later
```

If you see the version number, you're ready for the [Quickstart →](01-quickstart.md).

## Troubleshooting

- **`command not found: dql`** — use `npx @duckcodeailabs/dql-cli` instead, or
  add your global npm bin (`npm prefix -g`/bin) to `$PATH`.
- **Node version errors** — DQL requires Node 20+. Install via
  [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm).

## Homebrew / desktop bundles

Not shipped. If you'd use them, [open an issue](https://github.com/duckcode-ai/dql/issues)
and we'll scope them in. The packaging scaffolds live in
[`packaging/`](https://github.com/duckcode-ai/dql/tree/main/packaging) and
[`apps/desktop/`](https://github.com/duckcode-ai/dql/tree/main/apps/desktop) —
they're wired up but intentionally not on the release path until there's real
demand.
