# Lineage Workflow

Use lineage when you need to explain where a DQL answer came from, what it depends on, and which notebooks or downstream analytics will be affected by a change.

For the open-source product, the core lineage story is:

- source tables
- dbt sources and dbt models
- DQL blocks
- notebooks
- business domains and cross-domain flow

## Recommended Demo Path

Use Jaffle Shop and the ready-made notebook asset:

- [dbt + Jaffle Shop Walkthrough](../01-start-here/dbt-jaffle-shop.md)
- [Jaffle Shop Lineage Demo notebook](../examples/jaffle-shop-lineage-demo.dqlnb)

Copy the demo notebook into your project:

```bash
mkdir -p notebooks
cp docs/examples/jaffle-shop-lineage-demo.dqlnb notebooks/
```

## Typical Flow

1. Build the dbt project so `target/manifest.json` exists
2. Compile DQL with dbt lineage imported
3. Open the notebook UI
4. Search for a block or notebook in the Lineage sidebar
5. Open a block in Block Studio and inspect the `Lineage` tab
6. Use CLI focus/search commands when you want a terminal view or JSON output

## Commands

```bash
dql compile --dbt-manifest target/manifest.json

dql lineage
dql lineage --search revenue
dql lineage --focus revenue_by_customer_type
dql lineage --dashboard "Jaffle Shop Lineage Demo"
dql lineage --dbt
dql lineage --impact revenue_by_customer_type
```

## UI Walkthrough

### Notebook Lineage Sidebar

Use the sidebar when you want to move quickly through the graph:

1. Open `Lineage`
2. Search for a source table, dbt model, DQL block, or notebook
3. Click a result to open a focused subgraph
4. Use `Open Graph View` for the fullscreen DAG

### Fullscreen Lineage Graph

Use the fullscreen graph when you want the broader path:

- filter to source tables, dbt models, DQL blocks, notebooks, or domains
- focus on one node instead of showing the whole project
- inspect cross-domain flow visually

### Block Studio Lineage Tab

Use Block Studio when you are editing one block and need immediate context:

- the active block auto-focuses lineage
- `Path Summary` shows upstream provenance and downstream consumption
- `Source to Block` helps explain dbt and table lineage
- `Block to Consumption` helps explain notebook and analytics usage

## What Good Open-Source Lineage Looks Like

For a dbt-backed DQL project, users should be able to read a chain like:

```text
dbt source -> dbt model -> dbt model -> DQL block -> notebook
```

Or across domains:

```text
customer domain -> finance domain -> executive domain
```

That is the core open-source adoption story. Column lineage, cross-tool SaaS connectors, and AI lineage queries remain out of scope for OSS.

## Read Next

- [Lineage Guide](../lineage.md)
- [Block Authoring Workflow](./block-authoring-workflow.md)
