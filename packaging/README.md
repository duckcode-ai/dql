# Packaging

Distribution channels for DQL releases.

| Channel | Source | Install command |
| --- | --- | --- |
| npm | `packages/*`, `apps/cli` | `npm i -g @duckcodeailabs/dql-cli` |
| create-app | `packages/create-dql-app` | `npx create-dql-app <name>` |
| Homebrew | `packaging/homebrew/` | `brew tap duckcode-ai/dql && brew install dql` |
| Desktop (Tauri) | `apps/desktop/` | Download from GitHub Releases |

## Release flow

Triggered by pushing a `v*.*.*` tag:

1. `.github/workflows/release.yml` runs on `ubuntu-latest`:
   - builds + publishes all npm packages
   - generates Homebrew formula via `packaging/homebrew/publish.mjs <version>`
   - opens a PR against `duckcode-ai/homebrew-dql`
2. `.github/workflows/release-desktop.yml` runs on matrix `[macos-14, macos-13, ubuntu-22.04, windows-latest]`:
   - builds Tauri bundle per platform
   - attaches `.dmg` / `.AppImage` / `.msi` to the GitHub Release

Both workflows need these secrets:

- `NPM_TOKEN` — npm publish auth
- `HOMEBREW_TAP_GITHUB_TOKEN` — PR into the tap repo
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` — macOS signing + notarization,
  `release-desktop.yml`. Missing secrets produce unsigned builds (users see a
  Gatekeeper warning on first open).

Windows bundles are currently unsigned; adding code-signing is a post-GA item.
