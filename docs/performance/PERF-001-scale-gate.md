# PERF-001 scale release gate

The DQL 2.0 scale fixture is generated, never committed. It contains 10,000
dbt models with 30 columns each, 100 domains, 1,000 entities, 2,000
relationships, 1,000 domain skills, 1,000 blocks, 1,000 business views, and a
combined 500 Apps/Notebooks.

Run the deterministic generator unit test:

```bash
pnpm perf:scale:unit
```

Run the release gate after building the workspace:

```bash
pnpm test:perf:scale
```

For a faster local diagnostic after `pnpm build`:

```bash
pnpm perf:scale -- --samples 3
```

The harness writes machine-readable evidence below `.dql/perf/evidence/` and
the generated fixture below `.dql/perf/`. Both paths are ignored. Evidence
records the commit, hardware, seed, sample timings, p50/p95, sampled peak RSS,
response bytes, production dbt-artifact read counters, observed fixture counts,
and every enforced budget from `PERF-001`.

The cold index gate covers the local OSS SQLite metadata catalog and knowledge
graph and does not depend on a warehouse, vector service, or hosted component.
The one-domain refresh measurement is labeled as an atomic full-snapshot
fallback until dependency-sharded compilation is implemented; the documented
two-second budget is still enforced.
