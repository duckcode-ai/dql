# Ask observability synthetic office fixture

This is a deliberately small, fully synthetic local project for Ask AI
observability acceptance work (`OBS-012`). It is **not** an office project,
customer export, provider capture, warehouse snapshot, or a source of runtime
gold SQL/results.

The fixture models a generic revenue-operations vocabulary only:

- synthetic accounts and customers;
- Revenue and BCM measures;
- a generic competitor dimension;
- a declared fiscal date role and fiscal-period dimension;
- certified blocks, MetricFlow semantic metadata, safe governed relationships,
  and an intentionally unsafe relationship that must not be inferred.

`target/manifest.json` and `target/semantic_manifest.json` are checked-in
metadata fixtures. They contain no rows, connection credentials, prompts,
provider bodies, or expected query results. The `test-support/` directory is
read by focused tests only; it is not DQL runtime guidance. In particular,
its failure adapters describe injected test boundaries rather than configuring
an external provider, tool, or warehouse.

Start it locally without a provider, warehouse, or network:

```sh
node apps/cli/dist/index.js notebook apps/cli/test/fixtures/ask-observability-office --port 3479
```

The runtime can start and build local metadata offline. Executing a data answer
still requires an explicitly configured local query target; that separation is
intentional and prevents this fixture from presenting invented results.

The three screenshot-shaped questions and expected *routing/role* evidence are
kept in `agent-evals/` and `test-support/fixture-contract.json`. No expected
SQL or result rows are supplied to an Ask runtime.
