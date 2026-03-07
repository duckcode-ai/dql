# Publishing

This repository publishes the public DQL packages to npm and the editor extension to the VS Code marketplace.

## First release checklist

1. Ensure the repo is on the release commit you want to tag.
2. Ensure GitHub Actions secrets are configured:
   - `NPM_TOKEN` for `@dql/*` package publish
   - `VSCE_PAT` if you want the extension published from CI
3. Ensure `pnpm build` and `pnpm test` pass.
4. Run a dry pack of all publishable packages:

```bash
pnpm release:dry-run
```

5. Review the generated tarballs in `.release-artifacts/`.
6. Create and push the release tag:

```bash
git tag -a v0.1.0 -m "DQL v0.1.0"
git push origin v0.1.0
```

7. The GitHub `Release` workflow will publish npm packages automatically when `NPM_TOKEN` is present.
8. If you need to publish packages after adding secrets later, rerun the `Release` workflow manually from GitHub Actions.
9. Publish the npm packages manually only if CI is unavailable:

```bash
pnpm release:publish
```

10. Package the VS Code extension locally if needed:

```bash
pnpm release:extension
```

## Published package order

The release script publishes in dependency order:

1. `@dql/core`
2. `@dql/compiler`
3. `@dql/runtime`
4. `@dql/charts`
5. `@dql/project`
6. `@dql/governance`
7. `@dql/connectors`
8. `@dql/lsp`
9. `@dql/cli`

## Notes

- The default release target is the public npm registry.
- `@dql/cli` publishes a `dql` binary.
- `dql-language-support` is packaged separately through `vsce`, not `npm publish`.
- Do not publish `duckcode` product packages from this repo.
- `v0.1.0` is the first public OSS release for the DQL language, tooling, and project system.
