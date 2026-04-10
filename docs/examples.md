# Examples

DQL works best on top of a real dbt project. The recommended starting point is the [Jaffle Shop semantic-layer course repo](https://github.com/dbt-labs/Semantic-Layer-Online-Course), because it already includes dbt semantic models and metrics.

## Quickstart

```bash
git clone https://github.com/dbt-labs/Semantic-Layer-Online-Course.git jaffle-shop
cd jaffle-shop
pip install dbt-duckdb && dbt deps && dbt build --profiles-dir .
npm install -g @duckcodeailabs/dql-cli
dql init . && dql notebook
```

## Suggested Learning Path

### 1. Start with the notebook

```bash
dql notebook
```

### 2. Create and parse a block

```bash
dql new block "Top Customers" --domain finance
dql parse blocks/top_customers.dql --verbose
```

### 3. Preview and build

```bash
dql preview blocks/top_customers.dql --open
dql build blocks/top_customers.dql
dql serve dist/top_customers --open
```

### 4. Explore the semantic layer

Open the notebook sidebar and click the **Semantic** tab to browse metrics, dimensions, and hierarchies from the dbt project.

### 5. View lineage

```bash
dql compile --dbt-manifest target/manifest.json
dql lineage
dql lineage --domain finance
```

Or click the **Lineage** icon in the notebook sidebar.

### 6. Add block dependencies with ref()

Create a second block that references the first:

```dql
block "Top Segments" {
    domain = "executive"
    type   = "custom"
    query  = """
        SELECT * FROM ref("top_customers")
        WHERE total_spend > 100
    """
}
```

Run `dql lineage` to see the dependency graph and cross-domain flows.

## Related Docs

- [Getting Started](./getting-started.md)
- [Lineage & Trust Chains](./lineage.md)
- [Semantic Layer Guide](./semantic-layer-guide.md)
- [Language Specification](./dql-language-spec.md)
- [Data Sources](./data-sources.md)
