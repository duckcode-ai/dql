# @duckcodeailabs/docs

The DQL documentation site. Nextra + Next.js, static-exported, deployed to
`docs.duckcode.ai`.

## Develop

```bash
pnpm -F @duckcodeailabs/docs dev
# http://localhost:3030
```

## Build

```bash
pnpm -F @duckcodeailabs/docs build
# out/ directory ready to upload to any static host
```

## Internal link check

```bash
pnpm -F @duckcodeailabs/docs link-check
```

Fails the build if any relative `[text](/foo/)` link doesn't resolve.

## IA

```
pages/
├── index.mdx              landing
├── get-started/           install, quickstart, concepts
├── guides/                task-oriented walkthroughs
├── reference/             CLI, language, connectors, file formats
├── architecture/          how DQL fits with dbt, plugin API, OpenLineage
└── contribute/            repo layout, testing, releasing
```

One topic → one canonical URL. See [docs/README.md](../../docs/README.md)
for the legacy flat-file docs still shipping during migration.
