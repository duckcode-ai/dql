# Why DQL

## The $40,000 Question

You query revenue last Tuesday. A colleague queries it Thursday. The numbers differ by $40,000. Neither of you knows why.

Was it the date filter? A different join? A customer segment definition that changed last month? You spend two hours digging through Slack, a shared Notion doc, and three BI "saved queries" that all have slightly different SQL. You never find a definitive answer. You ship the number you feel most confident about and move on.

This is not a data quality problem. It is a version control problem. Your analytics logic has no canonical home, no ownership, no history, and no tests. The same SQL exists in five places and has quietly drifted into five different answers.

DQL fixes the root cause: it makes each analytics answer a single file that lives in Git.

---

## Before DQL / After DQL

| Situation | Before | After |
|---|---|---|
| Where does the revenue query live? | Slack, Notion, BI saved queries, a notebook | `blocks/revenue_by_segment.dql` in Git |
| Who owns this metric? | Unknown, ask around | `owner = "data-team"` in the block |
| Why did the number change? | No way to know | `git log blocks/revenue_by_segment.dql` |
| Is the chart still in sync with the SQL? | Maybe — last person to edit either might know | Chart config lives inside the same file as the SQL |
| Can I run this against my local CSV? | Set up a whole environment | `dql preview blocks/revenue_by_segment.dql --open` |
| Can someone review my analytics change? | No standard workflow | Open a PR — the diff shows exactly what changed |
| Does this query actually return data? | Ship and hope | `tests { assert row_count > 0 }` |
| Can I reuse this across dashboards? | Copy-paste and drift | Reference the block by name |

---

## Who DQL Is For

### Data Analyst

You answer the same question every Monday. Someone asks on Thursday and gets a different number because they ran a slightly different query. You have no way to say "use this one, it is the canonical version."

DQL gives you a place to commit the answer. One file, one home, one source of truth. When someone asks again, you send them a Git path.

### Analytics Engineer

You use dbt to model clean tables. But once the data leaves dbt, it scatters. The charting logic lives in Tableau. The segment definitions live in a Notion doc. The filter parameters live in someone's head. There is no PR review for analytics answers — only for models.

DQL is the dbt-style layer for answer assets. The same rigor you bring to models — versioning, testing, ownership — now applies to the blocks that actually get used in dashboards and reports.

### Data Team Lead

You cannot trust the dashboards. Not because the data is bad, but because you cannot tell which queries are current, which are stale, and whether any of them have tests. When someone changes a dashboard, there is no diff. No review. No rollback.

DQL gives your team a Git-native analytics workflow. Changes go through PRs. Every block has an owner. Failures have a traceable cause.

---

## DQL vs Everything Else

| | Raw SQL | dbt | BI Tools | DQL |
|---|---|---|---|---|
| Git-native | Manual | Yes (models) | No | Yes (blocks) |
| Testable | No | Yes (models) | No | Yes (answers) |
| Local preview | No | No | No | Yes |
| Visualization config | No | No | Yes | Yes |
| Reusable parameters | No | Macros | Limited | Yes |
| Portable (no vendor lock-in) | Yes | Partial | No | Yes |
| Covers the "answer" layer | No | No | Yes | Yes |

> dbt and DQL are complementary. Use dbt to model your data. Use DQL for the blocks that answer business questions on top of those models.

---

## Why Now: The AI Angle

AI can write a SQL query in ten seconds. That is not the problem anymore.

The problem is that AI-generated SQL creates sprawl faster than humans ever could. Every conversation produces a query. Few of them get saved anywhere useful. None of them have tests. None of them have owners. Three months later, six people have independently asked the same question and gotten six slightly different answers.

DQL is the contract layer that makes AI-generated analytics durable. You take the query the AI wrote, wrap it in a block, add an owner, add a test, commit it. Now it exists. Now it can be reviewed. Now it does not disappear.

AI proposes. DQL keeps.

---

## What It Feels Like to Use DQL

**1. Init.** You have a CSV. You run `dql init myproject` and `dql notebook`. The browser opens. You drag the CSV into `data/`. You are writing SQL against it in thirty seconds, no warehouse credentials, no setup.

**2. Explore.** The notebook gives you SQL cells, markdown cells, and param widgets. You write a query. DQL auto-charts it. You adjust the visualization config inline. You try a different filter using a param widget — no code change needed.

**3. Author a block.** When the query is right, you run `dql new block "Revenue by Segment"`. A `.dql` file is scaffolded with your SQL, chart config, and a test stub. You fill in the owner and tags.

**4. Preview.** `dql preview blocks/revenue_by_segment.dql --open` renders the chart in the browser with live data. You tweak the SQL. Hot reload. Done.

**5. Commit.** `git add blocks/revenue_by_segment.dql && git commit`. Your analytics answer now has a home, a history, and a diff. The next person who asks gets a file path, not a screenshot.

---

## Good First Step

```bash
npm install -g @duckcodeailabs/dql-cli
dql init my-dql-project --template ecommerce
cd my-dql-project
dql doctor
dql notebook
```

Then author your first block:

```bash
dql new block "Pipeline Health"
dql preview blocks/pipeline_health.dql --open
```

Continue with:

- [Getting Started](./getting-started.md)
- [Examples](./examples.md)
- [FAQ](./faq.md)
- [Migration Guides](./migration-guides/README.md)
