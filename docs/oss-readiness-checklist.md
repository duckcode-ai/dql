# OSS Readiness Checklist

This checklist tracks what DQL needs in order to feel complete, trustworthy, and easy to adopt as an open-source project.

It is written as a practical maintainer checklist, not a marketing document.

## Status Key

- `[x]` done or mostly in place
- `[ ]` still missing or blocked
- `[~]` partially complete and needs polish

## 1. Install and First Run

- `[x]` source-based install path is documented
- `[x]` local-first quickstart exists
- `[x]` starter project can be scaffolded with `dql init`
- `[x]` starter project includes local sample data
- `[x]` users can create new assets with `dql new block`
- `[x]` users can create dashboards and workbooks with `dql new dashboard` and `dql new workbook`
- `[x]` users can create semantic scaffolds with `dql new semantic-block`
- `[ ]` published npm install path needs final validation in a network-enabled environment
- `[ ]` `npx @duckcodeailabs/dql-cli --help` needs end-to-end validation after package publication

## 2. Local Experimentation Loop

- `[x]` `dql doctor` exists for local setup checks
- `[x]` `dql preview` exists for browser preview
- `[x]` `dql build` exists for static bundle generation
- `[x]` `dql serve` exists for local serving of built output
- `[x]` local CSV/file-first flow is documented
- `[x]` DuckDB local example exists
- `[~]` full validation of preview/build/serve is blocked until dependencies can be installed and build can run

## 3. Documentation

- `[x]` root README explains the project clearly
- `[x]` quickstart guide exists
- `[x]` getting-started guide exists
- `[x]` FAQ exists
- `[x]` compatibility matrix exists
- `[x]` migration guides exist
- `[x]` examples guide exists
- `[x]` package-level READMEs exist
- `[x]` `why-dql.md` exists for positioning and differentiation
- `[~]` docs should be re-verified after the first successful full build and package publish

## 4. Examples and Templates

- `[x]` starter template exists
- `[x]` starter template now includes `dashboards/` and `workbooks/`
- `[x]` finance KPI example exists
- `[x]` local dashboard example exists
- `[x]` local workbook example exists
- `[x]` DuckDB local example exists
- `[x]` semantic block example exists
- `[ ]` add one more polished business-facing example set if community feedback asks for it

## 5. CLI Surface

- `[x]` parse, fmt, info, test, certify are documented
- `[x]` init, doctor, preview, build, serve are documented
- `[x]` new block/dashboard/workbook/semantic-block are documented
- `[~]` `dql migrate` is correctly documented as scaffold-only, but could be improved later with richer source-specific helpers

## 6. Packaging and Release

- `[x]` public package manifests are present
- `[x]` `publishing.md` exists for maintainers
- `[ ]` full workspace install needs validation in a network-enabled environment
- `[ ]` full `pnpm build` needs to complete successfully in a dependency-available environment
- `[ ]` full `pnpm test` needs to complete successfully in a dependency-available environment
- `[ ]` published package smoke test should be recorded after first successful npm release

## 7. Contributor Experience

- `[x]` `CONTRIBUTING.md` exists
- `[x]` scope boundaries are documented
- `[x]` open-source/product boundary is documented
- `[~]` consider adding a small section for good first issues, versioning, and release expectations

## 8. Final Pre-Launch Checks

- `[ ]` run `pnpm install`
- `[ ]` run `pnpm build`
- `[ ]` run `pnpm test`
- `[ ]` verify `dql init` from a clean environment
- `[ ]` verify `dql preview` from a clean environment
- `[ ]` verify `dql new semantic-block` from a clean environment
- `[ ]` verify package publishing flow and `npx` usage

## Current Blocker

The main remaining blocker is environment-level, not repo-level:

- dependency installation failed in this session because npm registry access was unavailable (`ENOTFOUND registry.npmjs.org`)

Until that is resolved, the final build and test verification steps remain open.

## Recommended Next Actions

1. Run `pnpm install` in a network-enabled environment.
2. Run `pnpm build` and `pnpm test`.
3. Fix any TypeScript or test regressions found from the new scaffold work.
4. Validate the published CLI flow.
5. Mark the remaining checklist items complete.
