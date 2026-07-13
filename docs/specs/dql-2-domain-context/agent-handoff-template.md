# Agent handoff template

Copy this template for every implementer and verifier assignment.

```markdown
# DQL 2.0 workstream assignment

Role: implementer | verifier
Workstream: WXX — <name>
Integration branch: codex/dql-2-dbt-first-modeling
Assigned branch/worktree: <branch and absolute path>
Base SHA: <immutable SHA>
Target head/commit: <for verifier>

## Normative sources
- docs/specs/dql-2-domain-context/<files>
- docs/rfcs/0002-dbt-first-domain-modeling.md
- docs/rfcs/0003-domain-context-and-shared-products.md
- AGENTS.md and any nested AGENTS.md

## Acceptance IDs
<exact immutable IDs>

## Dependencies
<verified commits/interfaces this work may assume>

## Ownership
Owned globs:
- <paths the agent may edit>

Prohibited globs:
- <overlapping paths owned by another workstream>
- packages/dql-ui/src/styles/tokens.css unless explicitly assigned
- unrelated user changes

## Deliverable
<concrete behavior, public interfaces, tests, docs>

## Required commands
<focused tests/builds/typecheck/diff check>

## Required evidence
- commit SHA and `git status --short`
- command/result table
- fixture and exact scenarios
- raw output path:
  output/dql2-domain-context/WXX/<commit>/
- implementation notes, compatibility impact, unresolved risks

## Status authority
Implementer may report `implemented` only. A different verifier/integrator may
report `verified`. Do not edit the integration tracker unless assigned as its
owner. Do not commit generated evidence or caches.

## Stop conditions
Stop and report if the spec conflicts with code, a dependency is missing, an
owned file has unrelated edits, a public contract must change, or a shared
Cloud embed contract would be altered.
```

## Verifier minimum

The verifier reviews the full diff, maps behavior to every assigned ID, runs the
listed commands independently, adds adversarial/negative checks, verifies no
prohibited files/generated state changed, and reports evidence. A green build
without behavior-level acceptance is not verification.
