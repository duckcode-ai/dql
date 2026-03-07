# Publishing

This repository publishes the public DQL packages to npm and the editor extension to the VS Code marketplace.

## First release checklist

1. Replace the placeholder GitHub org in package manifests if needed.
2. Ensure `pnpm build` and `pnpm test` pass.
3. Run a dry pack of all publishable packages:

```bash
pnpm release:dry-run
```

4. Review the generated tarballs in `.release-artifacts/`.
5. Publish the npm packages:

```bash
pnpm release:publish
```

6. Package the VS Code extension:

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
