# 10 — Troubleshooting + FAQ

Real fixes for the things that bite people first.

---

## Setup

### `dql --version` works but `dql notebook` says "command not found"

The CLI's `dql` binary is set up by `pnpm install`, but if the link
silently failed (you saw a warning during install) you're running the
alias from tutorial 01. Re-link:

```bash
pnpm --filter @duckcodeailabs/dql-cli link --global
which dql
```

### `pnpm install` warns about a deprecated subdependency

It's noise — the workspace pins safe versions for the deprecated chain.
Continue.

### `tsc -b` fails inside `pnpm -r build` with "Cannot find module 'better-sqlite3'"

`better-sqlite3` ships native bindings. On a fresh OS install:

```bash
pnpm rebuild better-sqlite3
```

Or wipe and re-install:

```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
pnpm -r build
```

### Preview doesn't open

`dql preview` opens your default browser. If you're on a headless box or
the open command silently fails:

```bash
dql preview blocks/hello_fraud.dql --no-open
```

It still serves on localhost; the URL is printed in the console output.

---

## Authoring blocks

### `dql certify` says `tests-pass: ✗` but the data looks right

The certifier runs the block against the connection you pass with
`--connection`. If your local DuckDB doesn't have the seed CSVs but your
prod warehouse does, you'll see different test results. Pin the
connection explicitly:

```bash
dql certify blocks/foo.dql --connection duckdb
```

— and make sure the CSVs are under `acme-bank/data/`.

### `Block parse error in blocks/foo.dql`

The most common cause is `query = "..."` (single-line) where the SQL
contains characters that need escaping. Use triple-quoted strings:

```dql
query = """
  SELECT 1
"""
```

### Block doesn't show up in the manifest

`dql compile` only scans `blocks/`, `dashboards/`, `workbooks/`, and
`apps/<id>/blocks/` (when configured). If your block lives somewhere
else, add the directory to `dql.config.json`:

```json
{
  "extraBlockDirs": ["custom_blocks"]
}
```

### Two blocks have the same name

The manifest keys by `block.name` (the string after `block "..."`). If
two `.dql` files both declare `block "foo"`, the second one silently
overwrites the first — but `dql validate` catches it as an error. Run
`dql validate` early.

---

## Apps + RBAC

### `dql app build` says "homepage references unknown dashboard"

Either:

1. The dashboard id in `dql.app.json`'s `homepage` doesn't match any
   `.dqld` file's `id` field, or
2. You renamed a `.dqld` file but kept the homepage id pointing at the
   old name.

Open `apps/<id>/dashboards/*.dqld` and confirm the `id` field matches.

### Persona switcher does nothing

Two common causes:

1. **You're not in the App view.** The persona switcher only renders when
   `mainView === 'apps'`. Click the **Apps** activity bar icon first.
2. **The App has no members.** Open `dql.app.json` — the `members[]`
   array must be non-empty.

Verify on the server:

```bash
curl -s http://127.0.0.1:3475/api/persona | jq
curl -s http://127.0.0.1:3475/api/apps    | jq
```

### Branch viewer sees rows from other branches

`@rls` only narrows when the **block** carries the decorator. Confirm:

1. The block declares `@rls("branch", "{user.branch}")` (and `@rls("region", …)`).
2. The App has `rlsBindings` mapping `role: "branch_viewer"` → `from: "branch"`.
3. The member's `attributes.branch` is set.

Trace the resolution:

```bash
curl -s http://127.0.0.1:3475/api/persona | jq '.persona.rlsContext'
```

`rlsContext` should show the substituted values. If it's `{}`, the App
binding didn't match the member's roles + attributes.

### `policies[].domain = "*"` doesn't match my block's domain

Wildcard `*` matches every domain. If you want "any domain in the cards
org", make policies explicit per domain (`cards`, `cards.fraud`,
`cards.chargebacks`) — the engine doesn't currently parse hierarchical
domains.

---

## Agent

### `dql agent ask` says "KG not built"

Run the reindex:

```bash
dql agent reindex
```

That's the build step for `.dql/cache/agent-kg.sqlite`. It's also a no-op
fast on rebuilds because the manifest fingerprint is checked first.

### Provider returns nothing

Check `available()` per-provider:

```bash
node -e "
  const a = require('@duckcodeailabs/dql-agent');
  for (const name of ['claude','openai','gemini','ollama']) {
    a.buildProvider(name).available().then(ok => console.log(name, ok));
  }
"
```

> If only `ollama` shows `true`, you have no API keys set. That's fine —
> the agent will use Ollama. If `ollama` returns `false`, the daemon
> isn't running. Start it: `ollama serve`.

### Every certified block answer cites the same block, even when wrong

The FTS5 retrieval threshold is too loose for your domain. Tune in
[`packages/dql-agent/src/answer-loop.ts`](../../packages/dql-agent/src/answer-loop.ts):

```ts
const CERTIFIED_HIT_THRESHOLD = 0.18;   // raise to 0.30 for stricter matching
const HARD_NEGATIVE_RATIO     = 0.5;    // lower to 0.3 to disqualify on fewer downvotes
```

Rebuild and reindex.

### Slack bot returns 401 "Bad signature"

In order of likelihood:

1. **Body modification.** Slack signs the raw body. Some reverse proxies
   strip whitespace or rewrite content-type. Bypass them or move the bot
   directly behind ngrok.
2. **Wrong signing secret.** Compare with the **Basic Information** page
   of your Slack app — not the Bot User OAuth Token (which is different).
3. **Stale request.** The verifier rejects requests > 5 minutes old.
   Clock skew is rare but check `date` on your server.

### Slack bot reply never arrives

The bot acks immediately ("Working on it…") then posts the real reply
via `response_url`. If the response URL POST fails (firewall, DNS,
timeouts), Slack will not retry. Check the bot logs for the failed
fetch — `dql slack serve` doesn't yet have structured logging; pipe to
a file or wrap with `2>&1 | tee dql-slack.log`.

---

## CI / `dql verify`

### `dql verify` says "drift" but the diff looks empty

The diff prints terse change descriptions. To see the full per-block
diff, use `--format json`:

```bash
dql verify --format json | jq
```

Common silent drift causes:

- A block test result changed (a stat was non-deterministic).
- A semantic-layer YAML moved.
- `dbtImport` filters changed.

If you can't pin it, force a fresh compile and inspect:

```bash
mv dql-manifest.json /tmp/old-manifest.json
dql compile
diff /tmp/old-manifest.json dql-manifest.json | head -80
```

### `dql certify` is non-deterministic in CI

If a block test like `assert max(x) < some_value` flickers, the
underlying data is non-deterministic. Either:

1. Pin the test data (commit a small CSV that drives the test).
2. Loosen the assertion (e.g. `< some_value * 1.1`).
3. Move volatile assertions to `invariants` (which are documentation,
   not executable).

---

## When in doubt, look at the source

The architecture is small and readable. Bookmark these:

- Block lifecycle and certification: [`packages/dql-governance/src/certifier.ts`](../../packages/dql-governance/src/certifier.ts)
- Apps + dashboards parsing: [`packages/dql-core/src/apps/`](../../packages/dql-core/src/apps/)
- Persona registry: [`packages/dql-project/src/persona.ts`](../../packages/dql-project/src/persona.ts)
- RLS lowering: [`packages/dql-compiler/src/ir/lowering.ts:440`](../../packages/dql-compiler/src/ir/lowering.ts) (`applyRLSDecorators`)
- Agent answer loop: [`packages/dql-agent/src/answer-loop.ts`](../../packages/dql-agent/src/answer-loop.ts)
- Slack server: [`packages/dql-slack/src/server.ts`](../../packages/dql-slack/src/server.ts)

If you find a bug or rough edge in any of these:

1. File an issue at <https://github.com/duckcode-ai/dql/issues>.
2. PRs welcome — every package has tests in `*.test.ts` next to the
   source it covers.

---

## Need more?

- The end-to-end story: [tutorial 07](./07-fraud-spike-walkthrough.md).
- The conceptual model: [tutorials/README.md](./README.md).
- The roadmap: [../../ROADMAP.md](../../ROADMAP.md).
