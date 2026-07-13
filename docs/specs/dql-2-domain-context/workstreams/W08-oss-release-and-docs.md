# W08 — OSS release, documentation, and final verification

## Goal

Make the unified domain-context flow understandable and reproducible for a new
OSS user, close compatibility/documentation conflicts, and assemble the final
release-quality evidence without publishing packages unless separately asked.

Acceptance IDs: `SPEC-001`, `SPEC-002`, `MIG-001`, `E2E-001` plus final
verification of all matrix rows. Dependency: verified W07.

## Required implementation

- Update README, install/quickstart, configuration, project layout, CLI, MCP,
  modeling, skills, agent safety, migration, and contribution documentation to
  match shipped behavior.
- Remove or clearly label stale statements that place new Apps/Notebooks inside
  domains, imply copied semantic imports, or misstate which OSS surfaces exist.
- Document the honest OSS/Cloud boundary: one primary dbt project in OSS;
  federation, real centralized RBAC, hosted approvals/operations in Cloud.
- Complete the acceptance matrix and execution tracker with commit-scoped,
  independently verified evidence.
- Run all final gates, inspect staged diff for generated/private material, and
  prepare release-note/PR text. No npm publish/version bump is implied.

## Suggested ownership

Owned: public documentation/spec status/release notes/verification summaries and
small integration-only fixes explicitly approved. Prohibited: ignored
commercial plans, customer data, pricing/GTM/private cloud architecture,
generated evidence, unrelated product work.

## Required evidence

Fresh-clone quickstart against Jaffle/dedicated fixture; all commands and links
verified; full tests/builds/diff check; CLI-backed browser and Cloud embed
contract; clean git artifact audit; compatibility statement; matrix with no
unresolved release-blocking rows.
