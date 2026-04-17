# Testing

```bash
pnpm test                   # everything
pnpm -F @duckcodeailabs/dql-core test
pnpm -F @duckcodeailabs/dql-compiler test
```

## Unit tests (Vitest)

Every package has co-located `*.test.ts` files. Target is ≥80% coverage on
`dql-core`, `dql-compiler`, `dql-governance`.

## Golden-file tests

Parser and lineage extractor run against a corpus of real-world SQL samples
(CTEs, lateral joins, `QUALIFY`, dialect quirks). Snapshots live at
`packages/dql-core/test/golden/`.

Update snapshots deliberately:

```bash
pnpm -F @duckcodeailabs/dql-core test -- -u
```

## Connector cassettes

Integration tests for each connector record real query/response pairs
(sanitized) and replay them in CI. Live connectivity tests run nightly
against an internal fixture warehouse.

## E2E (Playwright)

Runs the full Jaffle Shop happy path in a headless browser:

```bash
pnpm -F @duckcodeailabs/dql-notebook-app test:e2e
```

## Stress test

Synthetic 4,000-model dbt project generated in CI to catch scale regressions:

```bash
pnpm bench:manifest
```

Gates: cold build `<30s`, warm rebuild `<2s`, lineage panel FPS `≥50`.

## CI

Every PR to `main` runs: lint + unit + golden + connector cassettes + E2E
+ 4,000-model stress + docs link-check. Merges blocked on any failure.
