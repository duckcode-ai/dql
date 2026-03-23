# OSS Readiness Checklist

This checklist tracks what DQL needs in order to feel complete, trustworthy, and easy to adopt as an open-source project.

It is written as a practical maintainer checklist, not a marketing document.

## Status Key

- `[x]` done or mostly in place
- `[ ]` still missing or blocked
- `[~]` partially complete and needs polish

---

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

---

## 2. Local Experimentation Loop

- `[x]` `dql doctor` exists for local setup checks
- `[x]` `dql preview` exists for browser preview
- `[x]` `dql build` exists for static bundle generation
- `[x]` `dql serve` exists for local serving of built output
- `[x]` local CSV/file-first flow is documented
- `[x]` DuckDB local example exists
- `[~]` full validation of preview/build/serve is blocked until dependencies can be installed and build can run

---

## 3. Documentation

- `[x]` root README explains the project clearly
- `[x]` README has CI, npm, license, and Node badges
- `[x]` README has Community and Support section
- `[x]` README has Contributing link
- `[x]` README lists four semantic layer providers (including Snowflake)
- `[x]` quickstart guide exists
- `[x]` getting-started guide exists
- `[x]` FAQ exists
- `[x]` compatibility matrix exists
- `[x]` migration guides exist
- `[x]` examples guide exists
- `[x]` package-level READMEs exist
- `[x]` `why-dql.md` exists for positioning and differentiation
- `[x]` authoring-blocks.md shows real `@metric()`/`@dim()` patterns (no `@import`)
- `[~]` docs should be re-verified after the first successful full build and package publish

---

## 4. Examples and Templates

- `[x]` starter template exists
- `[x]` starter template now includes `dashboards/` and `workbooks/`
- `[x]` finance KPI example exists
- `[x]` local dashboard example exists
- `[x]` local workbook example exists
- `[x]` DuckDB local example exists
- `[x]` semantic block example exists
- `[ ]` add one more polished business-facing example set if community feedback asks for it

---

## 5. CLI Surface

- `[x]` parse, fmt, certify are documented
- `[x]` init, doctor, preview, build, serve are documented
- `[x]` new block/dashboard/workbook/semantic-block are documented
- `[x]` `dql test` deprecated with clear migration path to `dql certify --connection`
- `[x]` `dql certify` runs live test assertions against real data (not just governance metadata)
- `[x]` `--skip-tests` flag available for governance-only checks
- `[x]` `defaultConnection` from config used automatically (no `--connection` required)
- `[~]` `dql migrate` is correctly documented as scaffold-only, but could be improved later with richer source-specific helpers

---

## 6. Packaging and Release

- `[x]` public package manifests are present
- `[x]` `publishing.md` exists for maintainers
- `[x]` CHANGELOG.md has proper version history
- `[ ]` full workspace install needs validation in a network-enabled environment
- `[ ]` full `pnpm build` needs to complete successfully in a dependency-available environment
- `[ ]` full `pnpm test` needs to complete successfully in a dependency-available environment
- `[ ]` published package smoke test should be recorded after first successful npm release

---

## 7. Contributor Experience

- `[x]` `CONTRIBUTING.md` exists with setup, code style, versioning, and first-issue guidance
- `[x]` `ROADMAP.md` exists with known limitations and planned work
- `[x]` `SECURITY.md` exists with vulnerability reporting process
- `[x]` scope boundaries are documented
- `[x]` open-source/product boundary is documented
- `[x]` GitHub issue templates exist (bug report, feature request, config)
- `[x]` PR template exists with validation checklist

---

## 8. CI / Automation

- `[x]` CI workflow exists (`ci.yml`) — runs build and test on push and PR
- `[x]` CI runs on Node 20 and Node 22 (matrix build)
- `[x]` Release workflow exists (`release.yml`)
- `[x]` `.gitignore` covers `.env`, `.env.*`, `*.log`, `node_modules`, `dist`, `.turbo`

---

## 9. Final Pre-Launch Checks

- `[ ]` run `pnpm install` in a network-enabled environment
- `[ ]` run `pnpm build`
- `[ ]` run `pnpm test`
- `[ ]` verify `dql init` from a clean environment
- `[ ]` verify `dql preview` from a clean environment
- `[ ]` verify `dql new semantic-block` from a clean environment
- `[ ]` verify package publishing flow and `npx` usage

---

## Current Blocker

The remaining pre-launch checks are environment-level, not repo-level:

- The repo is fully authored and ready to open-source
- Dependency installation requires npm registry access (`registry.npmjs.org`) to run `pnpm install`
- Final build, test, and publish smoke tests should be run in a network-enabled environment before the first public release announcement

## Recommended Next Actions

1. Run `pnpm install` in a network-enabled environment.
2. Run `pnpm build` and `pnpm test`.
3. Fix any TypeScript or test regressions.
4. Run `pnpm release:publish` to publish packages to npm.
5. Validate the published CLI: `npx @duckcodeailabs/dql-cli@latest --help`.
6. Mark the remaining checklist items complete.
7. Open the GitHub repo to public.
