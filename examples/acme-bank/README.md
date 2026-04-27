# Acme Bank example

The runnable Acme Bank project is bundled as a `create-dql-app` template so it
stays installable from npm and does not duplicate generated files in
`examples/`.

```bash
npx create-dql-app acme-bank --template acme-bank
cd acme-bank
dql compile
dql app build
dql agent reindex
dql notebook
```

It includes:

- Banking sample CSV data across cards, deposits, lending, and executive review
- Certified blocks with domain, owner, tags, descriptions, tests, and
  agent-facing context
- Four Apps: `cards-ops`, `retail-deposits`, `risk-office`,
  `executive-cockpit`
- `.dqld` dashboards with qualified manifest IDs
- Programmable single-user OSS governance and persona preview
- Agent Skills for cards fraud and CFO weekly review

Walk through it in [docs/tutorials](../../docs/tutorials/README.md).

