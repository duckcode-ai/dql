# W07 — Integration, evaluations, and performance

## Goal

Prove the complete product behavior and scale budgets on deterministic fixtures;
repair integration defects without weakening safety contracts.

Acceptance IDs: every functional ID, with primary ownership of `PERF-001` and
`E2E-001`. Dependencies: verified W01–W06.

## Required implementation

- Create/complete the Commerce/Growth functional fixture and deterministic
  10k-model scale generator exactly as spec 09.
- Add cross-package integration, CLI, MCP, migration, agent-eval, browser,
  compatibility, security, and performance suites.
- Prove end-to-end typed lineage from dbt through proof/asset/product/answer.
- Instrument artifact read counts, timings, response sizes, and memory; remove
  eager all-node loading/reparsing and unbounded graph/context behavior.
- Run the built CLI notebook runtime for browser acceptance and restart after
  builds to prevent stale localhost evidence.

## Suggested ownership

Owned: dedicated fixtures, testkit/eval/performance/browser tests, integration
repairs explicitly assigned by the integration owner. Prohibited: weakening
assertions/budgets, changing public contracts without spec amendment, generated
fixture state, unrelated product redesign.

## Required evidence

Save command matrix, environment/hardware, fixture seed, route/provenance
snapshots, browser screenshots/traces, migration reports, security cases,
p50/p95/RSS/bytes/read counts, and commit SHA under the ignored evidence path.
Every acceptance ID receives an independent verifier result.
