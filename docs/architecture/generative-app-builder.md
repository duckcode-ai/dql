# Local generative App builder

DQL's OSS app builder is intentionally file-first. AI can help plan an App,
but the committed output is still ordinary `dql.app.json` and `.dqld` files
that reviewers can diff, edit, and certify.

The pipeline is:

1. `planAppFromPrompt` creates an `AppPlan` from the prompt plus local KG
   context: certified blocks, business terms/views, dashboards, apps, dbt, and
   semantic metadata.
2. `validateAppPlan` checks that certified tiles really point to certified
   blocks and that generated sections are visibly draft/review items.
3. `generateAppFromPlan` writes:
   - `apps/<app-id>/dql.app.json`
   - `apps/<app-id>/dashboards/<page-id>.dqld`
   - `apps/<app-id>/README.md`

Generated Apps are always local draft artifacts. Certified tiles retain their
certified source state. Narrative and placeholder sections stay uncertified
with review tasks until a human turns them into certified DQL blocks.

```bash
dql app generate "Build a weekly revenue health app for the COO"
dql app build
```

This keeps the OSS experience useful for a single user while preserving the
commercial boundary: hosted deployment, multi-user approvals, scheduling
automation, RBAC enforcement beyond local metadata, and organization-wide
review queues belong outside the OSS builder.
