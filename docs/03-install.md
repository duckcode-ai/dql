# Install

> ~2 minutes · requires Node 20+ or a prebuilt binary

Pick the path that fits your setup.

## Option A — npm (recommended)

Works on macOS, Linux, and Windows. No global install required.

```bash
npx @duckcodeailabs/dql-cli --version
```

To make `dql` a global command:

```bash
npm i -g @duckcodeailabs/dql-cli
dql --version
```

## Option B — Homebrew (macOS / Linux) · *planned for GA*

> **Roadmap.** The `duckcode-ai/dql` tap is on the v1.0 GA checklist and is
> not published yet. Use Option A for now.

```bash
brew tap duckcode-ai/dql
brew install dql
```

## Option C — Prebuilt binary · *planned for GA*

> **Roadmap.** Prebuilt Tauri binaries ship with v1.0 GA. Check the
> [releases page](https://github.com/duckcode-ai/dql/releases) — if binaries
> aren't attached yet, use Option A.

When available, each release ships macOS (arm64/x64), Linux (arm64/x64), and
Windows (x64) binaries built with Tauri.

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
- **Windows + npm + path too long** — prefer the prebuilt binary.
