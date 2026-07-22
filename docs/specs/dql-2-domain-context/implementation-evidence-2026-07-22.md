# Plan-first governed answer engine — implementation evidence

## Evidence identity

- Date: 2026-07-22
- Workstreams: W01, W02, W04, W07, W08
- Source state: v1.10.0 release candidate based on parent commit
  `8e85c5e1bc1d`; the immutable implementation state is identified by the
  `v1.10.0` release tag.
- Implementer: Codex primary agent
- Verifier: independent verifier pending; no requirement in this record is
  promoted to `verified`.
- Deterministic scale fixture: `dql2-domain-context-v1` with 7,000 semantic
  metrics, 10,000 dbt models, 300,000 columns, 100 domains, 1,000 skills, 1,000
  blocks, and 1,000 business views.

## Implemented acceptance

| Acceptance | Implementation evidence | Result |
| ---------- | ----------------------- | ------ |
| CTX-002 | `metadata/catalog.ts` snapshot leases and the catalog snapshot-race test | An old lease remains internally immutable after a newer snapshot activates. |
| CTX-005 | Independent exact, lexical/BM25, vector, and graph lanes in `metadata/catalog.ts`; catalog and scale tests | Qualified snapshot retrieval includes semantic/modeling/Skill evidence; warm context and node-detail reads report zero source-artifact reads. |
| SKILL-001/002 | `skills/loader.ts`, snapshot Skill capsules, Domain/Area eligibility, and exclusion tests | Global/domain Skills are bounded by scope; exclusions veto selection and never create positive ranking tokens. |
| AGT-013 | `resolved-analytical-plan.ts`, router cutover, and resolved-plan tests | One frozen, fingerprinted plan binds snapshot, qualified meaning, members, time, capability, proof, output, and typed follow-ups. |
| AGT-014 | `plan-execution-adapter.ts`, authoritative answer-loop integration, and adapter-failure tests | Certified and semantic adapters execute exact qualified IDs; a selected-adapter failure is terminal and cannot widen the route. |
| AGT-015 | `governed-relational-compiler.ts` and compiler/answer-loop tests | Governed SQL renders only constrained operators over allowlisted qualified relations, columns, and relationship proof. |
| AGT-016 | `research-governance.ts`, typed plan deltas, research-loop integration, and receipt/budget tests | Research preserves the root snapshot and KnowledgeLens, enforces bounded calls, and rejects unreceipted numeric claims. |
| API-006 | Versioned plan/executable/receipt contracts plus `plan-first-e2e.test.ts` | Browser Ask, CLI, MCP, Chat, Notebook, Preview, and Block Studio surface adapters produce identical plan, route, executable, and SQL fingerprints in the parity harness. |
| E2E-006 | Exact enterprise-scale fixture plus retrieval-first eval contract, cancellation tests, and the answer-engine benchmark | All 11 supported semantic/certified/clarify/blocked/governed-SQL cases match expected routes and qualified concepts; wrong-certified and invented-ID execution counts are zero. |
| E2E-012 | `plan-first-e2e.test.ts`, `plan-first-answer-loop.test.ts`, full Agent/CLI suites, authoritative default, and shadow rollback switch | Plan-first routing is authoritative; the legacy cascade is bypassed for authoritative plans and remains available only through the explicit shadow rollback mode. |

## Commands and results

| Command | Result |
| ------- | ------ |
| `pnpm --filter @duckcodeailabs/dql-agent test` | Passed: 93 files, 1,050 tests. |
| `pnpm --filter @duckcodeailabs/dql-agent build` | Passed. |
| `pnpm --filter @duckcodeailabs/dql-cli build` | Passed. |
| `pnpm --filter @duckcodeailabs/dql-cli test` | Passed: 49 files, 526 tests; 3 skipped, including enforced OSS upgrade reapply coverage. |
| `pnpm --filter @duckcodeailabs/dql-notebook-app test` | Passed: 25 files, 101 tests. |
| `pnpm --filter @duckcodeailabs/dql-notebook-app build` | Passed. |
| `node --test scripts/performance/dql2-scale-fixture.test.mjs` | Passed: 3 tests. |
| `node scripts/performance/dql2-scale-benchmark.mjs --samples 1 --summary --evidence /private/tmp/dql2-scale-functional.json` | Functional parity passed: 11/11 expected routes, zero concept-selection failures, zero route-parity failures, zero wrong-certified selections, and zero invented-ID executions. |

The CLI integration suite and scale benchmark require a loopback fixture server;
they were run with loopback permission after the restricted sandbox correctly
rejected `listen(127.0.0.1)`.

## Open release gates

`PERF-001` remains `specified`, and therefore `E2E-001` is not complete. The
maintainer accepted this disclosed OSS release exception for v1.10.0. The
20-sample reference run was functionally correct but missed these performance
budgets:

| Gate | Observed p95 | Budget | Result |
| ---- | ------------ | ------ | ------ |
| Cold compile | 11,681 ms | < 5,000 ms | Fail |
| Cold index/snapshot | 30,413 ms | < 30,000 ms | Fail |
| Warm context build | 580 ms | < 500 ms | Fail |
| Node detail | 152 ms | < 100 ms | Fail |
| One-domain refresh | 10,856 ms | < 2,000 ms | Fail |

Memory, warm Domain Workspace summary, response-size, zero-artifact-read, canvas
bound, wrong-certified, invented-ID, route-parity, and concept-parity gates pass.
The principal remaining engineering work is dependency-sharded domain refresh,
faster cold compilation/indexing, and lower-latency warm lookup paths. Generated
benchmark evidence stays in ignored `.dql/perf/evidence/` or temporary storage
and is not committed.
