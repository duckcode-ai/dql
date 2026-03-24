# Project Structure

The public DQL workflow is Git-native. A typical project looks like this:

```text
my-dql-project/
  dql.config.json                   # Project config: connection, semantic layer, port
  blocks/
    clean_orders.dql                # Data domain block
    revenue_by_segment.dql          # Finance domain block (uses ref("clean_orders"))
    exec_dashboard.dql              # Executive domain block (uses ref("revenue_by_segment"))
  semantic-layer/
    metrics/
      revenue.yaml                  # Metric definitions (appear in lineage)
    dimensions/
      segment.yaml                  # Dimension definitions
    hierarchies/
      revenue_time.yaml             # Drill paths
    cubes/
      revenue_cube.yaml             # Cube definitions
  data/
    orders.csv                      # Local sample data
    revenue.csv
  notebooks/
    welcome.dqlnb                   # Interactive notebook
  dashboards/                       # Optional: dashboard .dql files
  workbooks/                        # Optional: workbook .dql files
```

## Conventions

- **`blocks/`** holds durable reusable DQL blocks — one block per `.dql` file
- **`ref("block_name")`** in SQL creates explicit dependencies between blocks, tracked in lineage
- **`domain`** field on blocks creates business domain groupings — lineage tracks cross-domain flows
- **`semantic-layer/`** defines metrics, dimensions, hierarchies, and cubes in YAML — these appear as nodes in the lineage graph
- **`notebooks/`** stores interactive `.dqlnb` notebooks for exploration
- **`data/`** holds local CSV/Parquet files for DuckDB-powered local analysis

## Recommended Workflow

1. **Explore** — `dql notebook` to prototype queries against your data
2. **Author** — `dql new block "Name"` to create a reusable block; use `ref()` for dependencies
3. **Validate** — `dql parse` for syntax, `dql certify` for governance
4. **Lineage** — `dql lineage` to see data flow, `dql lineage --impact` before changes
5. **Commit** — Git review ensures a second set of eyes on ownership, tests, and dependencies

## Data Flow Example

```
source table: orders
    ↓ reads_from
block: clean_orders (domain: data, owner: data-team)
    ↓ feeds_into (via ref())
block: revenue_by_segment (domain: finance, owner: finance-team)
    ↓ feeds_into (via ref())
block: exec_dashboard (domain: executive, owner: ceo)
    ↓ visualizes
chart: bar (segment × revenue)
```

At every node: who owns it, which domain, and certification status. `dql lineage` shows this automatically.
