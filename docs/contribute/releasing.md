# Release process

DQL uses one version across OSS publishable packages. The authoritative npm
publication path is the `vX.Y.Z` tag workflow in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml). It runs
`scripts/release-packages.mjs`, which builds the workspace, rewrites
`workspace:*` dependencies to concrete versions for packing/publishing, and
restores the repo manifests afterward. A release tag publishes npm packages
only; it never publishes the VS Code extension.

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

4. Commit the release candidate and push `main`. Let ordinary CI complete.
5. Create an annotated tag at that exact release commit and push it:

```bash
git tag -a v1.7.0 -m "v1.7.0"
git push origin v1.7.0
```

6. Monitor the tag workflow. It is the authoritative npm publication path.
7. Smoke the published packages:

```bash
npx @duckcodeailabs/dql-cli@latest --version
npx @duckcodeailabs/dql-cli@latest --help
npx create-dql-app@latest --help
```

## Local same-SHA fallback

Use a local publish only when the tag workflow cannot publish and the
maintainer has explicitly authorized the fallback. It must run from a clean
checkout at the **exact SHA** named by the already-pushed release tag; do not
move, recreate, or retarget a tag to make a fallback easier.

Before running the fallback, confirm the tag, `HEAD`, package manifests, and
registry target version agree, then run:

```bash
git diff --check
git rev-parse HEAD
git rev-parse v1.7.0^{}
pnpm release:publish
```

Record that the packages came from the tagged SHA, investigate why the tag
workflow failed, and perform the same registry and install smoke checks. The
fallback does not make VS Code Marketplace publication automatic.

## Publishing Gotchas

- Use the release script or `pnpm publish`, not raw `npm publish`; workspace
  dependencies must be rewritten to concrete versions.
- Keep generated templates on the same CLI range as the release.
- The notebook React app is served by the CLI; the release script builds the
  workspace before packing so the CLI ships fresh notebook assets.
- The VS Code extension ships separately through the Marketplace and only from
  an explicit `workflow_dispatch` run with `publish_extension=true`.

## What Ships

| Artifact | Where |
| --- | --- |
| npm packages | `npmjs.com/org/duckcodeailabs` |
| `create-dql-app` templates | npm tarball |
| Notebook app assets | bundled inside `@duckcodeailabs/dql-cli` |
| VS Code extension | Marketplace |
| Docs | `docs/` in this repo |

Homebrew tap and desktop/Tauri binaries are not part of the OSS release path.
