# Why DQL

DQL exists to make analytics outputs durable, reviewable, and reusable.

Instead of scattering logic across saved queries, dashboards, notebooks, and chat transcripts, DQL packages an analytics asset into a single file that can live in Git.

## The Problem DQL Solves

Many teams already have SQL, BI dashboards, metrics, notebooks, and AI-generated queries. The problem is not only query generation — it is keeping the useful answers consistent over time.

Common pain points:

- the same SQL gets copied into many places
- nobody knows which version is trusted
- chart settings and business logic drift apart
- important queries are hard to test
- AI-generated answers disappear into chat history
- reuse depends on tribal knowledge instead of shared assets

DQL turns those one-off answers into reusable blocks.

## What DQL Is

DQL is a Git-native language for analytics blocks.

A DQL block can include:

- metadata
- SQL or semantic references
- parameters
- visualization settings
- assertions

That makes one file useful across authoring, preview, testing, versioning, and later product workflows.

## Why Not Just Keep Using Raw SQL?

Raw SQL is a great starting point, but it usually lacks:

- ownership metadata
- tags and discoverability
- chart configuration
- reusable parameters
- lightweight assertions
- a consistent packaging format

DQL keeps SQL, but wraps it in a more durable artifact.

## Why Not Just Use a BI Tool?

BI tools are useful for exploration and presentation, but teams often outgrow saved-query sprawl.

DQL is useful when you want assets that are:

- stored in Git
- easy to diff and review
- portable across tools
- connected to code review and CI
- reusable outside one vendor UI

## Why Not Just Use dbt?

dbt and DQL solve different problems.

- dbt is strong for transformations, modeling, and semantic definitions
- DQL is strong for packaging reusable analytics answers and views

Many teams should use both:

- dbt for modeling and metrics
- DQL for durable answer assets, visualization-ready blocks, and local preview workflows

## Why DQL in the AI Era?

AI makes it easier to generate SQL quickly, but generation is only part of the workflow.

Teams still need to decide:

- which result is trusted
- how to reuse it
- how to review changes
- how to attach tests and metadata
- how to keep the answer stable over time

DQL is valuable because it gives generated or hand-written analytics work a durable contract.

In short:

- AI can propose
- DQL helps teams keep and reuse what matters

## What Makes DQL Useful for Open Source Users

The open-source DQL workflow is designed to be local-first and tool-light:

- scaffold a project with `dql init`
- validate with `dql parse`
- preview locally with `dql preview`
- build static bundles with `dql build`
- serve them with `dql serve`

You can try it without DuckCode Studio and without warehouse credentials by starting with local CSV or DuckDB-backed examples.

## Best Fit

DQL is a good fit when you want:

- analytics assets in Git
- reusable charted or query-only blocks
- testable answer definitions
- local preview outside a larger product
- a bridge between SQL, semantic models, and presentation

## Not the Best Fit

DQL may be unnecessary if:

- you only need one-off SQL exploration
- you never intend to reuse or version the result
- your entire workflow already lives comfortably inside one BI tool
- you are looking for a notebook UI or AI coworker product rather than a language/tooling layer

## Good First Step

If you want to evaluate DQL quickly, start here:

```bash
dql init my-dql-project
cd my-dql-project
dql new block "Pipeline Health"
dql preview blocks/pipeline_health.dql --open
```

Then continue with:

- [Getting Started](./getting-started.md)
- [Examples](./examples.md)
- [FAQ](./faq.md)
- [Migration Guides](./migration-guides/README.md)
