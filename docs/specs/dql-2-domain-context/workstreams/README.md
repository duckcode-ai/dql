# Workstream index and status

Workstreams are dependency-ordered implementation contracts. Their status is
maintained only in the parent [execution tracker](../execution-tracker.md).

| ID | Workstream | Primary acceptance IDs |
| -- | ---------- | ---------------------- |
| W01 | [Core contracts and identity](W01-core-contracts-and-identity.md) | CFG-001/2, ID-001, DOM-001/2, PRD-003 |
| W02 | [Project snapshot and scale](W02-project-snapshot-and-scale.md) | CTX-002/5, API-001, PERF-001/2 |
| W03 | [Onboarding and discovery](W03-onboarding-and-discovery.md) | CFG-001/2, AGT-002, API-001 |
| W04 | [Agent context and governance](W04-agent-context-and-governance.md) | REL, CONTRACT, SKILL, CTX, AGT-001–10, API-003, SEC-003 |
| W05 | [Domain Studio and products](W05-domain-studio-and-products.md) | PRD-001/2/3, UI-001/2, AGT-003 |
| W06 | [Migration and security](W06-migration-and-security.md) | MIG-001/2, SEC-001/3 |
| W07 | [Integration, evals, and performance](W07-integration-evals-and-performance.md) | PERF-001/2, E2E-001/5/6 |
| W08 | [OSS release and docs](W08-oss-release-and-docs.md) | SPEC-001/2, MIG-001, E2E-001 |

Do not begin a dependent workstream until its required contracts are integrated
and independently verified. UI and agent work may use reviewed API fixtures
after W01/W02 interfaces freeze, but integration order remains authoritative.
