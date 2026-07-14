# Migration, compatibility, scale, and security

## Compatibility policy

Manifest v2 projects compile/run unchanged throughout DQL 3.x. New v3 fields
are additive and discriminated by `manifestVersion`. Consumers ignore unknown
additive fields and explicitly branch on incompatible semantics. Earliest v2
or legacy domain-local product removal is DQL 4.0 and requires a separate RFC,
deprecation telemetry, release notes, and a supported migration (`MIG-001`).

Legacy split modeling files and `domains/*/{notebooks,apps}` remain readable.
New authoring writes the canonical unified model and root product paths.

## Modeling migration

`dql migrate modeling --to dbt-first --dry-run` reports:

- config changes needed for v3/dbt-first;
- split-file consolidation and qualified-ID rewrites;
- domain-local Apps/Notebooks moved to root plus generated
  `ProductDomainContext`;
- unresolved/colliding identities, missing dbt bindings, and lossy fields;
- dbt-owned content that must become a previewed dbt YAML patch; and
- lifecycle/evaluation state preserved exactly.

`--apply` writes only the approved plan under an expected fingerprint. A second
dry run after apply is empty. Migration never certifies an object (`MIG-002`).

## DataLex migration

Legacy DataLex objects match dbt unique IDs by explicit ID, then unambiguous
relation/package/name evidence. Mirrored dbt facts are omitted and listed.
DataLex-only business semantics become draft DQL overlays. Divergent dbt-owned
facts become suggested dbt source patches. Every unmatched or lossy object is
reported. Output is deterministic/idempotent and preserves lifecycle without
upgrading it.

## Scale architecture

OSS must support one primary dbt manifest containing packages and many domains.
Required mechanisms:

- immutable indexed snapshots and incremental invalidation;
- domain membership, qualified identity, relationship, skill, asset, and
  product-backlink indexes;
- paginated inventory and server-bounded batch/neighborhood APIs;
- lazy node detail and canvas graph loading;
- domain-scoped compile/index refresh where dependencies permit;
- bounded context packs and graph traversal; and
- no request-path dbt artifact reparsing.

The reference scale fixture and budgets are in
`09-fixtures-evals-and-release-gates.md`.

## Runtime security

Loopback local serving may use the documented local trust mode. Binding to a
non-loopback interface requires configured authentication and allowed origins;
startup fails closed otherwise (`SEC-001`). Wildcard CORS is forbidden for
non-loopback serving. Mutating APIs require CSRF/origin protection where
browser cookies are used, expected source fingerprints, path confinement to the
project/dbt roots, and audit events.

Secrets stay in environment/keychain/ignored connector state and are redacted
from logs, jobs, snapshots, manifests, diffs, and browser responses. Source
patch endpoints reject path traversal/symlink escape and show the exact target
and diff before apply.

## OSS metadata versus enforcement

`classification`, owners, purposes, imports, and exports are governance
metadata in OSS and power routing/refusal. They are not a claim of enterprise
authorization. If a request requires identity-aware enforcement unavailable in
the active local adapter, the agent returns `policy_unenforced`. Cloud may
enforce these contracts with RBAC/ABAC across repositories.

## Federation boundary

OSS resolves a single primary project snapshot. dbt packages inside that
manifest are supported. Joining independently deployed repositories, resolving
organization-wide identities, centrally distributing policy, and enforcing
cross-repository approvals are Cloud federation features, not hidden
dependencies of OSS correctness.
