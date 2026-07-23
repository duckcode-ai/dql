# DQL 2.0 domain context — normative implementation specification

Status: **accepted for implementation**
RFCs: [RFC 0002](../../rfcs/0002-dbt-first-domain-modeling.md),
[RFC 0003](../../rfcs/0003-domain-context-and-shared-products.md), and
[RFC 0004](../../rfcs/0004-plan-first-governed-answer-engine.md), amended by
[RFC 0005](../../rfcs/0005-analytical-composition-and-transparent-repair.md)
Integration branch: `codex/dql-2-dbt-first-modeling`

This directory is the implementation truth for the unified DQL 2.0 domain
context program. Chat history, Codex memory, issue descriptions, and ignored
planning files are advisory only. If code and this pack disagree, stop the
workstream, record the conflict in `execution-tracker.md`, and update the spec
through review before continuing.

## Reading order

1. [Decisions](00-decisions.md)
2. [Product and user flow](01-product-and-user-flow.md)
3. [Object model and project layout](02-object-model-and-project-layout.md)
4. [dbt onboarding](03-dbt-connect-discovery-and-onboarding.md)
5. [Modeling and governance](04-domain-modeling-and-governance.md)
6. [Domain Studio UI](05-domain-studio-ui.md)
7. [Agent context and routing](06-agent-context-retrieval-and-routing.md)
8. [Runtime, CLI, MCP, and snapshots](07-runtime-cli-mcp-and-snapshots.md)
9. [Migration, compatibility, scale, and security](08-migration-compatibility-scale-security.md)
10. [Fixtures, evaluations, and release gates](09-fixtures-evals-and-release-gates.md)
11. [Analytical composition and transparent repair](10-analytical-composition-and-repair.md)
12. [Acceptance matrix](acceptance-matrix.md)
13. [Execution tracker](execution-tracker.md)

## Stable requirement IDs

Requirements use these immutable prefixes: `SPEC`, `CFG`, `ID`, `DOM`, `PRD`,
`REL`, `CONTRACT`, `SKILL`, `CTX`, `AGT`, `API`, `UI`, `MIG`, `PERF`, `SEC`, and
`E2E`. An ID is never reused or renumbered. Superseded requirements remain in
the matrix with a pointer to their replacement.

## Verification rule

An implementer may mark a requirement `implemented` and attach evidence. Only a
different verifier or the integration owner may mark it `verified`. Evidence
must identify the exact commit, command, fixture, and output path. UI evidence
must come from the real `dql notebook` runtime against a fixture, not Vite in
isolation.

## Workstreams

| Workstream | Scope | Depends on |
| ---------- | ----- | ---------- |
| [W01](workstreams/W01-core-contracts-and-identity.md) | core contracts and qualified identity | spec freeze |
| [W02](workstreams/W02-project-snapshot-and-scale.md) | immutable snapshot service and scale | W01 |
| [W03](workstreams/W03-onboarding-and-discovery.md) | dbt onboarding and domain discovery | W01, W02 |
| [W04](workstreams/W04-agent-context-and-governance.md) | Ask, skills, retrieval, analytical composition, repair APIs, join safety, MCP | W01, W02 |
| [W05](workstreams/W05-domain-studio-and-products.md) | Domain Studio, shared products, and How it answered | W01–W04 APIs |
| [W06](workstreams/W06-migration-and-security.md) | migration, runtime security, and repair redaction | W01–W03; W04 repair contract |
| [W07](workstreams/W07-integration-evals-and-performance.md) | fixtures, analytical/repair E2E, evals, performance | W01–W06 |
| [W08](workstreams/W08-oss-release-and-docs.md) | compatibility, docs, release evidence | W07 |

Use [the handoff template](agent-handoff-template.md) for every assignment.
