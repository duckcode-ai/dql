# W07 — Integration, evaluations, and performance

## Goal

Prove the complete product behavior and scale budgets on deterministic fixtures;
repair integration defects without weakening safety contracts.

Acceptance IDs: every functional ID, with primary ownership of `PERF-001`,
`PERF-002`, `E2E-001`, `E2E-005`, `E2E-006`, `E2E-007`, and `E2E-012`.
Dependencies: verified W01–W06.

## Required implementation

- Create/complete the Commerce/Growth functional fixture and deterministic
  10k-model/300k-column/7k-metric scale generator exactly as spec 09.
- Add a deterministic similar-name evidence corpus covering balance versus flow
  versus risk versus allowance meanings, duplicate names across domains, trust
  conflicts, late-position candidates, ambiguity, and explicit references.
- Add cross-package integration, CLI, MCP, migration, agent-eval, browser,
  compatibility, security, and performance suites.
- Prove end-to-end typed lineage from dbt through proof/asset/product/answer.
- Instrument artifact read counts, timings, response sizes, and memory; remove
  eager all-node loading/reparsing and unbounded graph/context behavior.
- Run the built CLI notebook runtime for browser acceptance and restart after
  builds to prevent stale localhost evidence.
- Verify the published CLI in clean project-local and global npm prefixes so
  `npx dql` and bare `dql` are both executable, and exercise internal npm
  resolution without relying on an interactive-shell PATH.
- Verify first-install and version-upgrade Guided Setup prompts in the built CLI,
  including one-time acknowledgement and preservation of user preferences and
  every project-local connection setting.
- Compare browser Ask, direct CLI, MCP, and Chat on the same snapshot and assert
  identical interpretation, selected qualified IDs, route, trust, and error.
- Execute the plan-first stage harness through compilation and bounded fixture
  execution; assert identical plan/result receipts rather than only router labels.

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
