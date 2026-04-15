# Publishing @duckcodeailabs/dql-* to npm

This document is for maintainers releasing the open-source DQL packages and VS Code extension.

If you are trying DQL as a user, start with:

- [Why DQL](./why-dql.md)
- [Getting Started](./getting-started.md)

This repository publishes the public DQL packages to npm and the editor extension to the VS Code marketplace.

---

## Prerequisites

- An npm account that is a member of the `@dql` organisation
- `npm whoami` returns your username (run `npm login` if not)
- pnpm 9+, Node.js 18+
- GitHub Actions secrets configured on the repository:
  - `NPM_TOKEN` — for `@duckcodeailabs/dql-*` package publishing
  - `VSCE_PAT` — for VS Code extension publishing from CI (optional)

---

## Package Dependency Graph

The release script (`scripts/release-packages.mjs`) publishes packages in the following order, which respects the dependency graph:

```
@duckcodeailabs/dql-core                    (no @duckcodeailabs/dql-* deps)
@duckcodeailabs/dql-compiler                (depends on @duckcodeailabs/dql-core)
@duckcodeailabs/dql-runtime                 (no @duckcodeailabs/dql-* deps)
@duckcodeailabs/dql-charts                  (no @duckcodeailabs/dql-* deps; peer deps: react)
@duckcodeailabs/dql-project                 (depends on @duckcodeailabs/dql-core)
@duckcodeailabs/dql-governance              (depends on @duckcodeailabs/dql-core, @duckcodeailabs/dql-project)
@duckcodeailabs/dql-connectors              (no @duckcodeailabs/dql-* deps)
@duckcodeailabs/dql-notebook                (depends on @duckcodeailabs/dql-core, @duckcodeailabs/dql-connectors)
@duckcodeailabs/dql-lsp                     (depends on @duckcodeailabs/dql-core)
@duckcodeailabs/dql-cli                     (depends on @duckcodeailabs/dql-core, @duckcodeailabs/dql-compiler,
                                         @duckcodeailabs/dql-project, @duckcodeailabs/dql-governance,
                                         @duckcodeailabs/dql-connectors, @duckcodeailabs/dql-notebook)
```

---

## Bumping Versions

All packages share a version number. Update every `package.json` together before publishing.

```bash
# Patch release (e.g. 0.1.0 → 0.1.1):
pnpm --recursive exec npm version patch --no-git-tag-version

# Minor release (e.g. 0.1.0 → 0.2.0):
pnpm --recursive exec npm version minor --no-git-tag-version

# Then commit the version changes:
git add packages/*/package.json apps/cli/package.json apps/vscode-extension/package.json
git commit -m "chore: bump version to 0.6.1"
```

---

## Release Workflow

### Step 1 — Ensure the build and tests are green

```bash
pnpm build
pnpm test
```

### Step 2 — Dry run (inspect tarballs before publishing)

```bash
pnpm release:dry-run
```

This runs `pnpm build && pnpm test` and then packs each package into `.release-artifacts/` using `pnpm pack`. Review the generated `.tgz` files to verify that only the `dist/` directory and `package.json` are included (the `files` field in each `package.json` is set to `["dist"]`).

### Step 3 — Tag the release

```bash
git tag -a v0.7.0 -m "DQL v0.7.0"
git push origin v0.7.0
```

### Step 4 — Publish

**Via CI (recommended):** Pushing the tag triggers the GitHub `Release` workflow, which publishes all packages automatically when `NPM_TOKEN` is set.

**Manually (if CI is unavailable):**

```bash
pnpm release:publish
```

This runs `scripts/release-packages.mjs --publish`, which calls `pnpm publish --access public --no-git-checks` for each package in dependency order:

```bash
# The script iterates through:
packages/dql-core
packages/dql-compiler
packages/dql-runtime
packages/dql-charts
packages/dql-project
packages/dql-governance
packages/dql-connectors
packages/dql-notebook
packages/dql-lsp
apps/cli
```

**To publish a single package manually:**

```bash
cd packages/dql-core
pnpm publish --access public
```

`--access public` is required because all packages are scoped (`@duckcodeailabs/dql-`) and scoped packages default to private on npm. Each `package.json` also carries `"publishConfig": { "access": "public" }` as a safety net.

---

## Publishing the VS Code Extension

The VS Code extension (`apps/vscode-extension`) is published to the VS Code Marketplace using `vsce`, not npm.

```bash
# Package into a .vsix file:
pnpm release:extension
# Equivalent to:
cd apps/vscode-extension
pnpm run package    # produces dql-language-support-<version>.vsix

# Publish to the marketplace (requires VSCE_PAT):
cd apps/vscode-extension
VSCE_PAT=<your-token> pnpm run publish:vsce
```

Obtain a Personal Access Token from https://dev.azure.com under the `dql` publisher account.

---

## GitHub Release

After all packages are published, create a GitHub release against the tag:

```bash
gh release create v0.7.0 \
  --title "v0.7.0 — Project Manifest & Enhanced Lineage" \
  --notes "## Highlights

- **\`dql compile\`** — generates \`dql-manifest.json\` project artifact (like dbt's manifest.json)
- **dbt manifest import** — \`dql compile --dbt-manifest\` connects dbt lineage as upstream
- **Notebook lineage** — \`.dqlnb\` SQL/DQL cells included in lineage and manifest
- **Smart lineage lookup** — \`dql lineage orders\` auto-resolves to table, block, or metric
- **\`--table\` / \`--metric\` flags** — explicit type lookup for lineage queries
- **Impact analysis on any node** — \`dql lineage --impact orders\` works on tables, metrics, blocks
- **DuckDB reader extraction** — \`read_csv_auto()\` / \`read_parquet()\` tracked as source tables
- **Rich lineage summary** — data flow DAG tree, block details, cross-domain flows

Published packages:
- [@duckcodeailabs/dql-cli@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-cli)
- [@duckcodeailabs/dql-core@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-core)
- [@duckcodeailabs/dql-compiler@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-compiler)
- [@duckcodeailabs/dql-connectors@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-connectors)
- [@duckcodeailabs/dql-runtime@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-runtime)
- [@duckcodeailabs/dql-charts@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-charts)
- [@duckcodeailabs/dql-project@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-project)
- [@duckcodeailabs/dql-governance@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-governance)
- [@duckcodeailabs/dql-notebook@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-notebook)
- [@duckcodeailabs/dql-lsp@0.7.0](https://www.npmjs.com/package/@duckcodeailabs/dql-lsp)"
```

---

## Notes

- Do not publish packages from the closed DuckCode product from this repository.
- `@duckcodeailabs/dql-cli` registers a `dql` binary on install.
- `dql-language-support` is packaged separately through `vsce`, not `npm publish`.
- `v0.8.7` is the current release. All packages use unified versioning — bump all together.

---

## First Release Checklist

- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes for all packages
- [ ] Version bumped consistently in all `package.json` files
- [ ] `pnpm release:dry-run` completed; tarballs reviewed
- [ ] `NPM_TOKEN` secret set in GitHub repository settings
- [ ] `VSCE_PAT` secret set (if publishing extension from CI)
- [ ] Release tag created and pushed: `git push origin v<version>`
- [ ] GitHub release created via `gh release create`
- [ ] VS Code extension published (if applicable)
