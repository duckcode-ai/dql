# Use Cases

This guide maps DQL's open-source workflows to the most common user goals.

The command snippets assume `dql` is already available on your shell `PATH`. If you are running from a source checkout, replace `dql` with `pnpm --filter @duckcodeailabs/dql-cli exec dql` from the repo root.

## 1. Evaluate DQL quickly

Use this path if you want to understand the product in under ten minutes.

```bash
dql init my-dql-project --template ecommerce
cd my-dql-project
dql doctor
dql notebook
```

Best fit:

- engineering leaders evaluating an OSS analytics workflow
- data practitioners comparing DQL with Malloy or notebook-first tooling
- contributors reviewing the end-user experience

## 2. Explore sample data in the browser notebook

Use this path if you want an interactive, cell-by-cell workflow.

Best fit:

- ad hoc SQL exploration
- DQL block prototyping
- notebook-based demos and internal enablement

Recommended templates:

- `starter` — smallest local-first flow
- `ecommerce` — strongest OSS demo story
- `saas` — recurring revenue and retention metrics
- `taxi` — time-series and operations analysis

## 3. Author reusable analytics blocks

Use this path if your goal is durable Git-based analytics assets rather than one-off queries.

Typical workflow:

```bash
dql new block "Pipeline Health"
dql parse blocks/pipeline_health.dql
dql certify blocks/pipeline_health.dql
```

Best fit:

- analytics engineers building reusable SQL + chart assets
- teams that want tests and metadata in source control
- semantic-layer experimentation before a heavier BI rollout

## 4. Build dashboards and workbooks

Use this path if you want a static deliverable from DQL assets.

Typical workflow:

```bash
dql new dashboard "Revenue Overview"
dql new workbook "Quarterly Review"
dql build dashboards/revenue_overview.dql
dql serve dist/revenue_overview --open
```

Best fit:

- lightweight internal reporting
- static artifact reviews in PRs
- browser validation before embedding elsewhere

## 5. Track data lineage and impact

Use this path if you want to understand data flow, cross-domain dependencies, and certification trust chains.

Typical workflow:

```bash
dql lineage                                 # full project lineage summary
dql lineage revenue_by_segment              # upstream/downstream for a block
dql lineage --domain finance                # what's in the finance domain?
dql lineage --impact clean_orders           # what breaks if clean_orders changes?
dql lineage --trust-chain raw_orders exec_dashboard  # trust at every hop
dql lineage --format json > lineage.json    # export for CI or external tools
```

Best fit:

- teams tracking cross-domain data flows (data → finance → executive)
- analytics engineers assessing impact before changing upstream blocks
- data governance leads auditing certification coverage by domain
- CI pipelines that need lineage metadata for automated checks

See also:

- [Lineage & Trust Chains](./lineage.md)

## 6. Connect to a real database

Use this path after you validate the local-first experience.

Typical workflow:

- update `dql.config.json`
- run `dql doctor`
- test the connection in the notebook
- run blocks against the remote source

Best fit:

- teams moving from sample data to warehouse-backed analysis
- connector validation for PostgreSQL, Snowflake, BigQuery, Redshift, Fabric, Databricks, Athena, Trino, and more

See also:

- [Data Sources](./data-sources.md)
- [CLI Reference](./cli-reference.md)

## 7. Validate the full repo before release

Use this path if you are contributing to DQL itself.

Typical workflow:

```bash
pnpm install
pnpm build
pnpm test
```

Then follow the full smoke test guide in [Repo Testing](./repo-testing.md).
