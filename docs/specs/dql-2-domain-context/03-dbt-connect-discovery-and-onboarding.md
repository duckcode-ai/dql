# dbt connect, discovery, and onboarding

## Configuration

New dbt-backed projects created by `dql init` produce:

```json
{
  "manifestVersion": 3,
  "modeling": { "mode": "dbt-first" },
  "dbt": {
    "projectDir": ".",
    "manifestPath": "target/manifest.json",
    "catalogPath": "target/catalog.json",
    "semanticManifestPath": "target/semantic_manifest.json"
  }
}
```

Optional artifact paths are omitted when absent. Existing configs are never
rewritten without an explicit apply operation (`CFG-001`, `CFG-002`).

## Onboarding APIs

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/onboarding/status` | current config, artifact, snapshot, domain, and readiness state |
| `POST` | `/api/onboarding/dbt/preview` | locate project/artifacts, validate inputs, show proposed config/build |
| `POST` | `/api/onboarding/dbt/apply` | apply approved config and start artifact/snapshot job |
| `POST` | `/api/onboarding/refresh` | rebuild artifacts/snapshot with source-change guard |
| `GET` | `/api/onboarding/jobs/:jobId` | structured job progress and diagnostics |
| `DELETE` | `/api/onboarding/jobs/:jobId` | request cancellation; never leave partial active snapshot |
| `POST` | `/api/onboarding/domains/discover` | return evidence-bounded draft domain proposals |
| `POST` | `/api/onboarding/domains/apply` | preview/apply selected proposals with source fingerprint guard |

Every response includes `requestId`; snapshot-backed responses include
`snapshotId`. Mutating requests accept an expected source/config fingerprint
and return `SOURCE_CHANGED` on optimistic-concurrency failure (`API-001`).

## Stable error codes

- `DBT_PROJECT_NOT_FOUND`
- `DBT_MANIFEST_MISSING`
- `DBT_ARTIFACT_INVALID`
- `DBT_PARSE_FAILED`
- `SOURCE_CHANGED`
- `SNAPSHOT_BUILD_FAILED`
- `DOMAIN_COLLISION`
- `DOMAIN_MEMBERSHIP_AMBIGUOUS`
- `WAREHOUSE_UNAVAILABLE`
- `AI_PROVIDER_UNAVAILABLE`

Errors contain `code`, human-readable `message`, `recoverable`, and optional
`details`/`nextActions`. UI copy branches on `code`, never parses messages.

## Artifact lifecycle

Preview detects `dbt_project.yml`, the dbt executable, target/profile needs,
and existing artifact freshness. Apply may run `dbt parse` (and catalog
generation only when configured and available), then validates artifact schema
versions before building a candidate snapshot. The active snapshot pointer is
swapped atomically only after compile/index validation. Cancellation or failure
leaves the prior active snapshot usable.

Artifact generation commands, environment requirements, and redacted stderr
are visible to the user. Secrets are never stored in project source or API job
records.

## Domain discovery evidence

The deterministic detector scores, in descending precedence:

1. explicit `meta.dql.domain`;
2. dbt group membership;
3. configured path selectors;
4. stable tags;
5. owners and exposures;
6. MetricFlow semantic-model/metric affinity;
7. package boundaries and conservative name clusters.

Each proposed domain and membership includes evidence, score, conflicts, and
whether a human decision is required. AI may summarize or propose descriptions
but cannot invent membership without cited evidence. Discovery output is a
draft proposal document; applying it writes `domain.dql` and sparse bindings
only, never copied dbt facts (`AGT-002`).

## Refresh and drift

`dql sync dbt` computes artifact/config/source fingerprints, creates a new
snapshot, diffs domain membership and proof dependencies, and reports added,
removed, changed, ambiguous, and stale objects. Removed nodes are retained as
diagnostics for dependent DQL sources. Refresh never deletes source objects or
silently preserves certification across changed evidence.
