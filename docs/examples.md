# Examples

All examples live in `templates/` and can be scaffolded with `dql init --template <name>`.

## Quickstart

```bash
npm install -g @duckcodeailabs/dql-cli
dql init my-project --template starter
cd my-project
dql notebook
```

## Available Templates

| Template | Best for | What you get |
|---|---|---|
| `starter` | First-run experience | Revenue CSV, starter blocks, semantic layer tutorial, welcome notebook |
| `ecommerce` | Commerce analytics | Channel revenue, funnel analysis, semantic cubes, full dataset |
| `saas` | Revenue + retention | MRR, churn pressure, cohort analysis, semantic metrics |
| `taxi` | Time-series and ops | Trip volume, fare trends, borough analysis, semantic dimensions |
| `finance-kpi` | Smallest runnable project | Single KPI block, local CSV, minimal layout |
| `dashboard` | Multi-chart dashboards | Dashboard syntax with KPI, bar, and table charts |
| `workbook` | Multi-page reports | Workbook syntax with multiple pages |
| `duckdb-local` | DuckDB connection path | Local DuckDB driver config, no warehouse needed |

## Scaffold any template

```bash
dql init my-project --template ecommerce
dql init my-project --template finance-kpi
dql init my-project --template dashboard
```

## Suggested Learning Path

### 1. Start with the notebook

```bash
dql notebook
```

### 2. Parse a block and inspect its structure

```bash
dql parse blocks/revenue_by_segment.dql --verbose
```

### 3. Preview and build

```bash
dql preview blocks/revenue_by_segment.dql --open
dql build blocks/revenue_by_segment.dql
dql serve dist/revenue_by_segment --open
```

### 4. Explore the semantic layer

Open the notebook sidebar and click the **Semantic** tab to browse metrics, dimensions, and hierarchies defined in `semantic-layer/`.

### 5. View lineage

```bash
dql lineage
dql lineage --domain revenue
dql lineage "Revenue by Segment"
```

Or click the **Lineage** icon in the notebook sidebar.

### 6. Add block dependencies with ref()

Create a second block that references the first:

```dql
block "Top Segments" {
    domain = "executive"
    type   = "custom"
    query  = """
        SELECT * FROM ref("revenue_by_segment")
        WHERE revenue > 10000
    """
}
```

Run `dql lineage` to see the dependency graph and cross-domain flows.

## Recommended Order

1. `starter` — get oriented
2. `ecommerce` — strongest full demo
3. `saas` — recurring revenue and churn
4. `taxi` — time-series and operations
5. `dashboard` — multi-chart layout
6. `workbook` — multi-page reporting

## Related Docs

- [Getting Started](./getting-started.md)
- [Lineage & Trust Chains](./lineage.md)
- [Semantic Layer Guide](./semantic-layer-guide.md)
- [Language Specification](./dql-language-spec.md)
- [Data Sources](./data-sources.md)
