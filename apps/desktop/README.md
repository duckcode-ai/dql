# DQL Desktop

Tauri wrapper that ships the DQL notebook + CLI as a single native app for
macOS (arm64/x64), Linux (arm64/x64), and Windows (x64).

The Tauri shell embeds the `dql-notebook` Vite build and spawns the CLI as
a sidecar process, giving users a **zero-node-required** install.

## Develop

```bash
# Requires the Rust toolchain + Tauri 2 prerequisites:
# https://v2.tauri.app/start/prerequisites/
pnpm -F @duckcodeailabs/dql-notebook-app build
pnpm -F @duckcodeailabs/desktop dev
```

## Build release binaries

Release binaries are built in CI (`.github/workflows/release-desktop.yml`)
on the three target platforms. To produce one locally:

```bash
pnpm -F @duckcodeailabs/desktop build
# out:
#   apps/desktop/src-tauri/target/release/bundle/
```

## Artifacts

| Platform | Formats |
| --- | --- |
| macOS | `.dmg`, `.app.tar.gz` (notarized) |
| Linux | `.deb`, `.AppImage`, `.rpm` |
| Windows | `.msi`, `.exe` (code-signed) |

See [docs.duckcode.ai/get-started/install](https://docs.duckcode.ai/get-started/install/).
