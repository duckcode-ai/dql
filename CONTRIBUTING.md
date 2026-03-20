# Contributing

## Scope

This repository is for the open DQL language and tooling layer. Contributions should improve authoring, validation, compilation, project structure, connectors, or editor support.

Please do not open issues here for DuckCode product behavior, notebook UX, or agentic workflows. Those belong to the closed product repository.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Pull requests

- Keep changes focused on the public DQL surface.
- Add or update tests when behavior changes.
- Update docs or examples when syntax or workflow changes.
- Avoid introducing product-specific assumptions into public packages.

## Release readiness

Before treating a change as OSS-ready, review the launch checklist:

- [`docs/oss-readiness-checklist.md`](./docs/oss-readiness-checklist.md)
