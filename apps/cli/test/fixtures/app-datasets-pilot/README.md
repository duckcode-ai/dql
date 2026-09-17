# App Builder Dataset pilot

This small fixture is a live-SQL App Builder pilot, not an imported extract.
Run `scripts/seed-eval-warehouse.mjs` with `seeds/seed.json`, then choose the
certified order-line block Dataset or the model-scoped native semantic Dataset
in App Studio. Validate the block's declared keys against that target; its
proof is written only under `.dql/local/datasets/proofs.json`. The third
customer-day block remains an aggregate-source safety case, not a substitute
for the semantic source.

The normal field builder can create these eight tiles without editing JSON:

1. Revenue KPI
2. Distinct orders KPI
3. Distinct customers KPI
4. Margin-rate KPI
5. Revenue by region
6. Revenue by month
7. Order-line detail table
8. Semantic commerce totals

Expected whole-source values are revenue `130`, distinct orders `6`, distinct
customers `3`, and margin rate `67 / 130` (about `51.54%`). Monthly customer
counts are `[1, 2, 2]`, which deliberately do not add up to the whole-source
count. `O-100` and `O-104` each have multiple lines; `C-001` spans three
periods; one revenue row is NULL; and one row has a zero ratio denominator.
Those facts make a non-live preview aggregate or an incorrect count/ratio
lowering fail visibly.

The same fixture also supplies the native-semantic conversion lane. A test
creates one persisted legacy native semantic revenue tile with the exact
model, metric, source revision, and snapshot identities resolved from this
fixture. Conversion must compare that tile with its mapped Dataset query in
one current DuckDB read scope before it can change the local App draft. This is
a local OSS fixture only: it does not represent an Ossie service, source
certification, or hosted approval workflow.
