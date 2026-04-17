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
  they ship as prebuilt binaries. The `--filter '!…'` exclusions above
  enforce that.

## What ships in a release

| Artifact | Where |
| --- | --- |
| npm packages (11) | `npmjs.com/org/duckcodeailabs` |
| CLI Homebrew tap | `github.com/duckcode-ai/homebrew-dql` |
| VS Code extension | Marketplace |
| Desktop notebook binaries | GitHub release assets (macOS/Linux/Windows) |
| Docs | `docs/` in this repo (rendered on github.com) |
