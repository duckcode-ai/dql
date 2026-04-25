# 09 — CI and `dql verify`

**Who this is for:** platform engineers wiring DQL into CI and audits.

**What you'll do:** add a GitHub Actions workflow that runs `dql verify`
on every PR, demonstrate that drift is caught, and walk through the
manifest fingerprint that makes it cheap.

**Time:** 15 minutes.

---

## Why `dql verify`?

The DQL manifest (`dql-manifest.json`) is the single source of truth for
downstream tooling: lineage, MCP, KG, the desktop UI's lineage drawer, and
external systems via the OpenLineage exporter. If the manifest drifts
from the source tree, every downstream consumer is reading a lie.

`dql verify`:

1. Reads `dql-manifest.json` from disk.
2. Recompiles the manifest in-memory from source.
3. Diffs the two — block contents, dashboard refs, App schedules, RLS
   bindings, lineage edges, everything.
4. Returns a non-zero exit code on drift, prints a structured diff, and
   tells you exactly which files to recompile.

It's the "did you forget to commit `dql compile`?" guard.

---

## Step 1 — Run it locally

From a clean tree:

```bash
cd ~/acme-bank
dql compile          # ensure dql-manifest.json is fresh
dql verify
```

> **You should see**
> ```text
>   ✓ Manifest verified — no drift between source tree and dql-manifest.json.
> ```

Now intentionally introduce drift:

```bash
# rename a block name in the file but DON'T recompile
sed -i.bak 's/fraud_alerts_by_region/fraud_alerts_by_region_v2/' \
  blocks/fraud_alerts_by_region.dql
dql verify
```

> **You should see**
> ```text
>   ✗ Manifest drift detected:
>     - blocks: removed "fraud_alerts_by_region"
>     - blocks: added "fraud_alerts_by_region_v2"
>
>   Run `dql compile` to regenerate, then commit.
> ```

Exit code is **1** — perfect for CI gates.

Restore:

```bash
mv blocks/fraud_alerts_by_region.dql.bak blocks/fraud_alerts_by_region.dql
dql compile
dql verify        # green again
```

---

## Step 2 — Add the GitHub Actions workflow

Create `.github/workflows/dql-ci.yml`:

```yaml
# .github/workflows/dql-ci.yml
name: DQL CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 9

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Build workspace
        run: pnpm -r build

      - name: Validate DQL sources
        run: pnpm dlx @duckcodeailabs/dql-cli validate

      - name: Run governance tests on certified blocks
        run: |
          for blk in $(git diff --name-only origin/main... | grep '^blocks/.*\.dql$'); do
            pnpm dlx @duckcodeailabs/dql-cli certify "$blk" --connection duckdb
          done

      - name: Compile manifest
        run: pnpm dlx @duckcodeailabs/dql-cli compile

      - name: Verify manifest is reproducible
        run: pnpm dlx @duckcodeailabs/dql-cli verify

      - name: Reindex KG (smoke test only — KG is not committed)
        run: pnpm dlx @duckcodeailabs/dql-cli agent reindex

      - name: Workspace tests
        run: pnpm -r test
```

Commit the workflow. The first PR you open will run all six steps and
fail-fast on the first red light.

> **A note on `pnpm dlx`** — if you publish your CLI to a private
> registry, swap the `pnpm dlx` invocations for direct `node` calls
> against your built dist (`node apps/cli/dist/index.js verify`).

---

## Step 3 — Block merges on drift

In GitHub repository settings → **Branches** → **Branch protection rules**
for `main`:

1. **Require status checks to pass before merging** ✓
2. Add `verify / DQL CI` to the required checks.
3. **Require branches to be up to date before merging** ✓ — so a stale
   PR can't sneak past `dql verify`.

Now any PR that:

- Edits a block but forgets to recompile,
- Renames a dashboard but doesn't update referenced App schedules,
- Adds an App member but never re-runs `dql app build`,

cannot merge. The fix is always: `dql compile && git add dql-manifest.json && git commit`.

---

## Step 4 — Audit the certifier output (regulator-friendly)

For audited industries, archive certifier output as part of the PR:

```yaml
- name: Certify and upload report
  run: |
    mkdir -p /tmp/dql-reports
    for blk in $(git diff --name-only origin/main... | grep '^blocks/.*\.dql$'); do
      name=$(basename "$blk" .dql)
      pnpm dlx @duckcodeailabs/dql-cli certify "$blk" --connection $WAREHOUSE_DSN \
        --format json > /tmp/dql-reports/$name.json
    done

- uses: actions/upload-artifact@v4
  with:
    name: dql-certifier-report
    path: /tmp/dql-reports/
```

The JSON report has every rule, severity, pass/fail, and timestamp —
auditors get a per-PR snapshot of governance evidence.

---

## Step 5 — Lineage diff in PR comments (advanced)

Optional but lovely: post a lineage diff on every PR using `dql lineage --json`
on `main` vs the PR branch.

Sketch:

```yaml
- name: Lineage diff
  run: |
    git checkout origin/main -- ./
    pnpm dlx @duckcodeailabs/dql-cli compile
    cp dql-manifest.json /tmp/main.json
    git checkout -
    pnpm dlx @duckcodeailabs/dql-cli compile
    node scripts/lineage-diff.js /tmp/main.json dql-manifest.json > /tmp/diff.md

- uses: peter-evans/create-or-update-comment@v4
  with:
    issue-number: ${{ github.event.pull_request.number }}
    body-path: /tmp/diff.md
```

This makes "this PR adds 1 block, removes 0, changes 2 dashboards"
visible without opening the manifest.

---

## What `dql verify` actually checks

From [`apps/cli/src/commands/verify.ts`](../../apps/cli/src/commands/verify.ts):

| Check | Drift signal |
|---|---|
| Block keys | Added / removed block names |
| Notebook keys | Added / removed `.dqlnb` |
| App keys | Added / removed `dql.app.json` |
| Dashboard keys | Added / removed `.dqld` |
| Metric keys | Added / removed semantic-layer metrics |
| Dimension keys | Added / removed semantic-layer dimensions |
| Source keys | Added / removed source tables |
| Per-block SQL | Block SQL changed without recompile |
| Per-block status | Certification status changed |
| Per-block domain | Domain reassigned |

Lineage edges aren't diffed yet — they're derived from the above, so a
clean check on those generally implies clean lineage. Future work will
add explicit edge-set diffing.

---

## What you now have

✓ A CI workflow that validates, certifies, compiles, and verifies on every PR
✓ Branch protection that blocks drift from reaching `main`
✓ Per-PR audit artefacts for regulator response
✓ A clear, reproducible source-of-truth pipeline

[Continue to tutorial 10 — Troubleshooting →](./10-troubleshooting.md)
