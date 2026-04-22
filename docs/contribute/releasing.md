# Release process

DQL uses a **single version across all publishable packages**. Dev
convenience trumps the complexity of independent semver per package.

## Cut a release

```bash
# 1. Bump every package.json in one go
./scripts/bump-version.sh 0.12.0

# 2. Build everything (tests run as part of `prepublishOnly`)
pnpm -r --filter '@duckcodeailabs/*' \
       --filter '!@duckcodeailabs/dql-notebook-app' \
       --filter '!@duckcodeailabs/vscode-extension' build

# 3. Publish (pnpm rewrites workspace:* specifiers — don't use npm publish)
pnpm -r --filter '@duckcodeailabs/*' \
       --filter '!@duckcodeailabs/dql-notebook-app' \
       --filter '!@duckcodeailabs/vscode-extension' \
       publish --access public --no-git-checks

# 4. Commit + tag
git commit -am "v0.12.0: release"
git tag v0.12.0
git push && git push --tags

# 5. Draft GitHub release with CHANGELOG.md excerpt
gh release create v0.12.0 --title "v0.12.0" --notes-from-tag
```

## Publishing gotchas

- **Use `pnpm publish`, not `npm publish`.** pnpm rewrites `workspace:*` to
  the resolved version at publish time; npm doesn't, and the published
  tarball fails with `EUNSUPPORTEDPROTOCOL`.
- **The notebook app and VS Code extension aren't published to npm** —
  the notebook is a private workspace artifact served by the CLI, and the
  VS Code extension ships via the Marketplace. The `--filter '!…'`
  exclusions above enforce that.

## What ships in a release

| Artifact | Where |
| --- | --- |
| npm packages (11) | `npmjs.com/org/duckcodeailabs` |
| VS Code extension | Marketplace |
| Docs | `docs/` in this repo (rendered on github.com) |

Homebrew tap and desktop/Tauri binaries are not on the release path — the
scaffolds in [`apps/desktop/`](../../apps/desktop/) are kept for future use
but aren't exercised by CI. See [Install](../03-install.md#homebrew--desktop-bundles).
