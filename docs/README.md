# docs/

**The user-facing docs have moved to [`apps/docs/`](../apps/docs/) (Nextra).
Site: [docs.duckcode.ai](https://docs.duckcode.ai).**

This folder now holds only:

- **Long-form references** not yet ported — e.g. [`dql-language-spec.md`](./dql-language-spec.md)
- **Maintainer / internal docs** — [`publishing.md`](./publishing.md), [`repo-testing.md`](./repo-testing.md), [`oss-readiness-checklist.md`](./oss-readiness-checklist.md), [`v1-support-scope.md`](./v1-support-scope.md)
- **Migration notes** — [`migration-guides/`](./migration-guides/)
- **Example notebooks** — [`examples/`](./examples/)

New documentation goes in `apps/docs/pages/`, not here.

## Canonical IA (in `apps/docs`)

```
Get Started    /get-started/       install · quickstart · concepts
Guides         /guides/            task-oriented walkthroughs
Reference      /reference/         CLI · language · connectors · file formats · semantic layer
Architecture   /architecture/      overview · dbt-integration · lineage-model · plugin-api · openlineage
Contribute     /contribute/        repo-layout · testing · releasing
```

## Running the site locally

```bash
pnpm -F @duckcodeailabs/docs dev
# http://localhost:3030
```
