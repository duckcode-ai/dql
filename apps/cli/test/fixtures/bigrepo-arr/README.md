# bigrepo-arr fixture

A reduced slice of a real enterprise dbt project (GitLab's public
`snowflake-dbt`), kept because the failure this repository spent months chasing
only appears at scale and only with real vocabulary.

**What it reproduces.** Ask "top 10 customer accounts by net arr" against a
warehouse where three hundred model names contain `arr`, `account`, or
`customer`. Two of those models can actually answer it:

- `mart_arr` — 77 documented columns including `arr`, `arr_month`,
  `crm_account_name`, `dim_crm_account_id`.
- `mart_crm_opportunity` — 436 documented columns including `net_arr`.

Everything else is a plausible-looking distraction with the same words in its
name: retention reports, forecast tables, score models. That is exactly the
condition under which the recorded runs admitted a support report and a single
column card, never showed the model a relation with its columns, and watched
the analyst invent `customer_account_name` until the budget died.

**Why it is committed.** No other fixture in this repository has more than five
dbt nodes, and synthetic generators use names like `col 01`, which cannot
reproduce lexical admission of real names. Model bodies, tests, macros, sources
and lineage are stripped; only the identity, description and column list each
node contributes to retrieval is kept. There is no warehouse and no data — the
behaviour under test is which relations reach the analyst and whether their
columns are admissible, which needs no rows.
