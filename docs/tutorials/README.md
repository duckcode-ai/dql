# DQL Tutorials — Acme Bank end-to-end

Hands-on walkthroughs that take you from `git clone` to a fully-running
domain-scoped analytics surface with RBAC, RLS, scheduled deliveries, and a
block-first agent. Every tutorial is **scenario-based** — we use a single
fictional bank, **Acme Bank**, and follow real stakeholders through real
workflows.

## The cast

| Stakeholder | Role | App they live in |
|---|---|---|
| **Sara Fitch**       | CFO                       | `cxo-board` |
| **Raj Kumar**        | Head of Cards             | `cards-ops` (owner) |
| **Mei Chen**         | Cards Analyst             | `cards-ops` (analyst) |
| **Tom Ng**           | Compliance Officer        | `risk-compliance` (viewer) |
| **Li Park**          | Branch Manager (NYC-042)  | `branch-managers` (RLS-scoped) |
| **Anna Vasquez**     | Wealth Advisor            | `wealth-advisors` (RLS-scoped) |

## Reading order

1. **[01 — Getting started](./01-getting-started.md)** — install, scaffold the Acme Bank project.
2. **[02 — Authoring blocks](./02-authoring-blocks.md)** — Mei builds her first certified block (`fraud_alerts_by_region`).
3. **[03 — Apps, RBAC, and personas](./03-apps-rbac-personas.md)** — Raj creates `cards-ops`, sets up roles + RLS, and Li sees only her branch.
4. **[04 — Dashboards](./04-dashboards.md)** — assemble `daily-ops.dqld` from certified blocks.
5. **[05 — Schedules + Slack delivery](./05-schedules-and-slack.md)** — daily 7am digest into `#cards-ops`, fraud-spike alerts.
6. **[06 — Agentic analytics](./06-agentic-analytics.md)** — knowledge graph, Skills, asking questions, multi-provider.
7. **[07 — End-to-end fraud spike](./07-fraud-spike-walkthrough.md)** — the full story: cron alert → Slack → ask → analyst review → certify.
8. **[08 — Promoting AI answers to certified blocks](./08-promoting-ai-blocks.md)** — the uncertified → certified loop.
9. **[09 — CI, `dql verify`, and change management](./09-ci-and-verify.md)** — keep `dql-manifest.json` reproducible.
10. **[10 — Troubleshooting + FAQ](./10-troubleshooting.md)** — common issues, debugging, where to look.

## Mental model in one paragraph

Domains author **certified `.dql` blocks** (SQL + governance metadata + tests).
Apps bundle dashboards into a consumption surface for stakeholders, with
declarative members, roles, access policies, RLS bindings, and schedules. The
**persona registry** picks "who am I running as right now" and feeds RLS
template variables into the SQL executor. The **agent** retrieves certified
blocks first; if nothing matches, an LLM proposes SQL marked Uncertified that
analysts review and certify back into blocks. **Slack** is the same answer
loop, fronted by a slash command. **`dql verify`** keeps the on-disk manifest
in lock-step with source so CI gates programmable artifacts.

If you'd rather skim the architecture before doing the tutorials, jump to
[../architecture/overview.md](../architecture/overview.md). If you want a
narrative tour of a real workday, start at
[07 — End-to-end fraud spike](./07-fraud-spike-walkthrough.md).

## Conventions

- Code blocks fenced with **`bash`** are commands you run; the prompt is
  implied.
- Code blocks fenced with **`text`** are screen output you should see.
- File-content blocks are labelled with their **path as a comment on the
  first line** so you can copy them as-is.
- **"You should see"** boxes describe the expected outcome of a step. If
  you don't see it, jump to [troubleshooting](./10-troubleshooting.md).

Ready? [Start with tutorial 01 →](./01-getting-started.md)
