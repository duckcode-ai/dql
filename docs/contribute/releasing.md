# Release process

DQL uses one version across OSS publishable packages. The current release path
uses `scripts/release-packages.mjs`, which builds the workspace, rewrites
`workspace:*` dependencies to concrete versions for packing/publishing, and
restores the repo manifests afterward.

## Cut a Release

1. Update package versions and template CLI ranges to the target version.
2. Update `CHANGELOG.md`, `ROADMAP.md`, and `docs/oss-readiness-checklist.md`.
3. Run the release candidate gates:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
node scripts/check-doc-links.mjs
pnpm release:dry-run
```

4. Publish from a clean working tree:

```bash
pnpm release:publish
```

5. Tag and push:

```bash
git tag v1.6.1
git push origin main
git push origin v1.6.1
```

6. Smoke the published packages:

```bash
npx @duckcodeailabs/dql-cli@latest --version
npx @duckcodeailabs/dql-cli@latest --help
npx create-dql-app@latest --help
```

## Publishing Gotchas

- Use the release script or `pnpm publish`, not raw `npm publish`; workspace
  dependencies must be rewritten to concrete versions.
- Keep generated templates on the same CLI range as the release.
- The notebook React app is served by the CLI; the release script builds the
  workspace before packing so the CLI ships fresh notebook assets.
- The VS Code extension ships separately through the Marketplace.

## What Ships

| Artifact | Where |
| --- | --- |
| npm packages | `npmjs.com/org/duckcodeailabs` |
| `create-dql-app` templates | npm tarball |
| Notebook app assets | bundled inside `@duckcodeailabs/dql-cli` |
| VS Code extension | Marketplace |
| Docs | `docs/` in this repo |

Homebrew tap and desktop/Tauri binaries are not part of the OSS release path.
