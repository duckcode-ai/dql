# Block Studio dbt-first workflow

> ~8 minutes · ends with one draft SQL block and one draft semantic block ready for certification

Block Studio is the main workspace for turning dbt models, dbt semantic
metrics, or legacy SQL into trusted DQL blocks.

The intended flow is:

```text
Connect dbt -> Pick model or metric -> Build block -> Validate -> Save draft -> Certify -> Use in Apps
```

DQL does not replace dbt. dbt owns models, transformations, tests, and semantic
definitions. DQL owns reusable answer blocks, chart configuration, notebooks,
Apps, AI pins, certification labels, and answer-level lineage.

## 1. Open Block Studio

Start the notebook UI:

```bash
npx dql notebook ./dql
```

Click **Blocks**. If no block is selected, Block Studio shows four starting
paths:

- **Create SQL Block from dbt Model**
- **Create Semantic Block from dbt Metric**
- **Import SQL**
- **Ask AI to Generate Block**

The start page also shows dbt status: project path, `manifest.json`,
`catalog.json`, `semantic_manifest.json`, and setup hints.

## 2. SQL block from a dbt model

Use this when you need explicit SQL.

1. Click **Create SQL Block from dbt Model**.
2. Pick or type a block name.
3. Use the schema/dbt explorer to insert tables and columns.
4. Write normal SQL against warehouse tables or dbt-built models.
5. Run, inspect results, then save as draft.

Example:

```dql
block "Daily Transaction Volume" {
  domain = "cards"
  type = "custom"
  status = "draft"
  description = "Daily card transaction volume."
  owner = "analytics"
  tags = ["cards", "daily"]

  query = """
SELECT
  transaction_date,
  SUM(amount) AS transaction_volume
FROM analytics.fct_card_transactions
GROUP BY transaction_date
ORDER BY transaction_date
"""

  visualization {
    chart = "line"
    x = transaction_date
    y = transaction_volume
  }
}
```

If you click a semantic metric while editing a SQL block, DQL does not silently
mix it into the query. The UI asks whether to create a Semantic Block or insert
an advanced semantic reference explicitly.

## 3. Semantic block from a metric

Use this when dbt Semantic Layer or DQL semantic metadata already defines the
business metric.

1. Click **Create Semantic Block from dbt Metric**.
2. Pick the metric.
3. Add dimensions, optional time dimension, grain, and chart intent.
4. Validate the generated DQL.
5. Save as draft.

Example:

```dql
block "Approval Rate by Region" {
  domain = "cards"
  type = "semantic"
  status = "draft"
  description = "Approval rate by region from the dbt semantic layer."
  owner = "analytics"
  tags = ["cards", "approval"]

  metric = "approval_rate"

  visualization {
    chart = "single_value"
    y = approval_rate
  }
}
```

Semantic blocks hide raw `SELECT` editing by default. If you need custom SQL,
create a SQL Block instead.

## 4. Import legacy SQL

Use **Import SQL** for one-time migration, not daily authoring.

The wizard is:

```text
Source -> Split Preview -> Review -> Save -> Done
```

Supported first-pass sources:

- paste SQL
- upload one `.sql` file
- upload multiple `.sql` files
- project-relative folder path

The importer splits semicolon-delimited statements and common `GO` batches,
detects tables and parameters, generates draft DQL candidates, and defaults
visualization to `table`. Review candidates before saving. AI enrichment is
optional and must be approved by the user.

## 5. Certify

Certification is a trust label in OSS. It is not RBAC.

Before clicking **Certify**, confirm:

- metadata is present
- validation has no errors
- the block runs successfully
- tests pass
- chart config is valid
- lineage is captured
- AI-generated changes were reviewed

Certification changes useful blocks from `draft` or `review` to `certified`.
Certified blocks appear in the block library and can be added to App dashboard
pages.

## 6. Lineage

SQL blocks track detected tables and dbt model/source matches.

Semantic blocks track:

```text
dbt source -> dbt model -> semantic metric -> DQL block -> dashboard page -> App
```

Run these commands after dbt artifacts change:

```bash
dbt build
npx dql compile ./dql
npx dql sync dbt ./dql
cd dql && npx dql agent reindex
```

## Verify it worked

- Block Studio dbt status shows `manifest.json` present.
- A SQL block validates and runs against a dbt model or warehouse table.
- A semantic block validates from a metric without raw SQL editing.
- Imported SQL saves as draft blocks instead of replacing current work.
- The Lineage tab shows source/model/metric/block/App context after compile.
