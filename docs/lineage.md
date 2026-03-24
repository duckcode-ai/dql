# Lineage & Trust Chains

DQL tracks how data flows from source tables through blocks, semantic metrics, business domains, and charts — the full "trust chain" from raw data to rendered answer.

> **dbt transforms your data. DQL transforms your data into trusted answers.**
>
> dbt owns the transformation layer (raw → staging → mart). DQL picks up where dbt stops — tracking lineage through the **answer layer**: mart tables → blocks → metrics → domains → charts.

---

## Why Lineage Matters

- **"If I change this table, what breaks?"** — Impact analysis shows every downstream block, metric, and domain affected
- **"Can I trust this dashboard?"** — Trust chains show certification status at every node from source to chart
- **"Where does this data come from?"** — Upstream lineage traces any block back to its source tables
- **"How does data flow between teams?"** — Cross-domain flow detection shows when data crosses business boundaries

---

## Quick Start

```bash
# Step 1: Compile your project to generate the manifest
dql compile

# Step 2: See your project's full lineage graph (reads from manifest)
dql lineage

# Look up any node — block, table, or metric (auto-resolved)
dql lineage raw_orders          # block
dql lineage orders              # source table
dql lineage total_revenue       # metric

# Explicit type lookup
dql lineage --table orders
dql lineage --metric total_revenue

# See cross-domain data flows for a domain
dql lineage --domain finance

# Impact analysis: what breaks if this node changes? (works on any type)
dql lineage --impact orders

# Trust chain: certification status from source to destination
dql lineage --trust-chain raw_orders exec_dashboard

# Export lineage as JSON (for integrations or CI)
dql lineage --format json

# Import dbt lineage as upstream
dql compile --dbt-manifest path/to/manifest.json
```

---

## The `ref()` System

Use `ref("block_name")` in your SQL to declare explicit dependencies between blocks. This is intentionally similar to dbt's `ref()` — familiar to dbt users.

### Before ref()

```dql
block "revenue_summary" {
    domain = "finance"
    type   = "custom"
    query  = """
        SELECT segment, SUM(amount) AS total
        FROM raw_orders_view    -- implicit dependency, invisible to lineage
        GROUP BY segment
    """
}
```

### After ref()

```dql
block "revenue_summary" {
    domain = "finance"
    type   = "custom"
    query  = """
        SELECT segment, SUM(amount) AS total
        FROM ref("raw_orders")  -- explicit dependency, tracked in lineage
        GROUP BY segment
    """
}
```

With `ref()`:
- DQL knows `revenue_summary` depends on `raw_orders`
- The lineage graph shows a `feeds_into` edge between them
- `dql lineage --impact raw_orders` includes `revenue_summary` in affected nodes
- Cross-domain edges are detected automatically (e.g., `raw_orders` in domain "data" → `revenue_summary` in domain "finance")

### ref() with different domain blocks

```dql
block "raw_orders" {
    domain = "data"
    type   = "custom"
    owner  = "data-team"
    query  = """
        SELECT * FROM orders
    """
}

block "revenue_summary" {
    domain = "finance"
    type   = "custom"
    owner  = "finance-team"
    query  = """
        SELECT segment, SUM(amount) AS total
        FROM ref("raw_orders")
        GROUP BY segment
    """
}

block "exec_dashboard" {
    domain = "executive"
    type   = "custom"
    owner  = "ceo"
    query  = """
        SELECT * FROM ref("revenue_summary")
    """
    visualization {
        chart = "line"
        x     = segment
        y     = total
    }
}
```

Running `dql lineage` shows:

```
  DQL Lineage Summary
  ========================================

  Nodes:
    block: 3
    domain: 3
    source_table: 1

  Edges: 7

  Cross-Domain Flows:
    data -> finance (1 edge(s))
    finance -> executive (1 edge(s))

  Domain Trust:
    data: 0/1 certified (0% trust)
    executive: 0/1 certified (0% trust)
    finance: 0/1 certified (0% trust)
```

---

## CLI Commands

### `dql lineage [block] [path]`

Show the full lineage graph summary for a project. If a block name is provided, shows upstream/downstream for that specific block.

```bash
# Full project summary
dql lineage

# Specific block
dql lineage raw_orders

# From a different directory
dql lineage /path/to/project
dql lineage raw_orders /path/to/project
```

**Summary output:**

```
  DQL Lineage Summary
  ========================================

  Nodes:
    block: 3
    dimension: 1
    domain: 3
    metric: 1
    source_table: 1

  Edges: 7

  Cross-Domain Flows:
    data -> finance (1 edge(s))
    finance -> executive (1 edge(s))

  Domain Trust:
    data: 1/1 certified (100% trust)
    executive: 0/1 certified (0% trust)
    finance: 1/1 certified (100% trust)
```

**Block lineage output:**

```
  Lineage for: raw_orders
  ========================================
  Domain: data
  Owner: data-team

  Upstream (1):
    source_table:orders

  Downstream (2):
    block:revenue_summary (finance)
    block:exec_dashboard (executive)
```

### `dql lineage --domain <name>`

Show all blocks, metrics, and nodes in a specific domain, plus data flows in and out.

```bash
dql lineage --domain finance
```

```
  Domain Lineage: finance
  ========================================

  Blocks: 1
  Certified: 1
  Trust Score: 100%

  Nodes in domain (3):
    block:revenue_summary
    metric:total_revenue
    domain:finance

  Data flows IN from:
    data (1 edge(s))

  Data flows OUT to:
    executive (1 edge(s))
```

### `dql lineage --impact <block>`

Show what breaks if a block changes. Lists all downstream affected nodes grouped by domain.

```bash
dql lineage --impact raw_orders
```

```
  Impact Analysis: raw_orders
  ========================================

  Total downstream affected: 2

  By domain:
    finance: 1 node(s), 1 certified
      - revenue_summary [certified]
    executive: 1 node(s), 0 certified
      - exec_dashboard

  Domain boundaries crossed:
    data -> finance (1 edge(s))
    finance -> executive (1 edge(s))
```

### `dql lineage --trust-chain <from> <to>`

Show the certification status at every node in the path from one block to another.

```bash
dql lineage --trust-chain raw_orders exec_dashboard
```

```
  Trust Chain: raw_orders -> exec_dashboard
  ========================================

  Trust Score: 67% (2/3 certified)

  Chain:
    [CERTIFIED] raw_orders (data) — data-team
      -> [CERTIFIED] revenue_summary (finance) — finance-team
      -> [         ] exec_dashboard (executive) — ceo

  Domain boundaries:
    data -> finance
    finance -> executive
```

### `dql lineage --format json`

Export the full lineage graph as JSON for CI pipelines, external tools, or custom visualizations.

```bash
dql lineage --format json > lineage.json
```

The JSON contains `nodes` and `edges` arrays with full metadata:

```json
{
  "nodes": [
    {
      "id": "block:raw_orders",
      "type": "block",
      "name": "raw_orders",
      "domain": "data",
      "owner": "data-team"
    }
  ],
  "edges": [
    {
      "source": "table:orders",
      "target": "block:raw_orders",
      "type": "reads_from"
    },
    {
      "source": "block:raw_orders",
      "target": "block:revenue_summary",
      "type": "feeds_into"
    },
    {
      "source": "block:raw_orders",
      "target": "block:revenue_summary",
      "type": "crosses_domain",
      "sourceDomain": "data",
      "targetDomain": "finance"
    }
  ]
}
```

---

## Lineage Graph Model

### Node Types

| Type | Description | Example ID |
|------|-------------|------------|
| `source_table` | External table read by blocks | `table:orders` |
| `block` | DQL block (custom or semantic) | `block:revenue_summary` |
| `metric` | Semantic layer metric | `metric:total_revenue` |
| `dimension` | Semantic layer dimension | `dimension:segment` |
| `domain` | Business domain grouping | `domain:finance` |
| `chart` | Visualization attached to a block | `chart:revenue_summary` |

### Edge Types

| Type | Description |
|------|-------------|
| `reads_from` | Block reads from a source table |
| `feeds_into` | Block output feeds into another block (via `ref()`) |
| `aggregates` | Metric aggregates from a source table |
| `visualizes` | Chart visualizes a block or metric |
| `crosses_domain` | Data crosses a business domain boundary |
| `certified_by` | Block certified by a person/process |

---

## Notebook Lineage Panel

The notebook sidebar includes a **Lineage** panel (graph icon between Semantic and Outline) that shows:

- **Summary bar** — total blocks, metrics, source tables, and domains
- **Block detail** — click any block to see its upstream and downstream dependencies
- **Cross-domain flows** — which domains send data to or receive data from other domains
- **Collapsible sections** — Blocks, Metrics, Source Tables, and Domains

The panel reads from the same lineage API that powers the CLI commands.

---

## Lineage API Endpoints

The notebook server exposes lineage data via REST:

| Endpoint | Description |
|----------|-------------|
| `GET /api/lineage` | Full lineage graph as JSON |
| `GET /api/lineage/block/:name` | Subgraph for a specific block (upstream/downstream) |
| `GET /api/lineage/domain/:name` | Domain-scoped view |
| `GET /api/lineage/impact/:block` | Impact analysis result |
| `GET /api/lineage/trust-chain?from=X&to=Y` | Trust chain between two blocks |

---

## How DQL Builds Lineage

DQL constructs the lineage graph automatically from your project:

1. **SQL parsing** — Extracts table references from `FROM`, `JOIN`, and `INTO` clauses in each block's SQL
2. **ref() resolution** — Explicit `ref("block_name")` calls create `feeds_into` edges between blocks
3. **Semantic layer** — Metric `table` fields connect metrics to their source tables via `aggregates` edges
4. **Visualization config** — `chart` types in blocks create `visualizes` edges
5. **Domain fields** — `domain` on blocks and metrics creates domain nodes and `crosses_domain` edges when data flows between different domains

No manual lineage configuration needed — it's all derived from your existing `.dql` files and semantic YAML.

---

## Tutorial: Add Lineage to an Existing Project

### Step 1 — Add ref() between blocks

If you have blocks that depend on each other, replace direct table references with `ref()`:

```dql
-- Before: implicit dependency
query = """
    SELECT * FROM clean_orders
    WHERE amount > 100
"""

-- After: explicit dependency tracked in lineage
query = """
    SELECT * FROM ref("clean_orders")
    WHERE amount > 100
"""
```

### Step 2 — Add domain metadata

Ensure each block has a `domain` field:

```dql
block "clean_orders" {
    domain = "data"
    owner  = "data-team"
    ...
}

block "revenue_report" {
    domain = "finance"
    owner  = "finance-team"
    ...
}
```

### Step 3 — View your lineage

```bash
dql lineage
```

You'll see:
- All blocks and their source table dependencies
- Cross-domain flows where data crosses team boundaries
- Domain trust scores based on certification status

### Step 4 — Investigate specific flows

```bash
# What does revenue_report depend on?
dql lineage revenue_report

# What breaks if clean_orders changes?
dql lineage --impact clean_orders

# What does the finance domain look like?
dql lineage --domain finance

# Full trust chain from source to report
dql lineage --trust-chain clean_orders revenue_report
```

---

## DQL + dbt: Complementary Lineage

dbt tracks lineage at the transformation layer: `raw_table → staging_model → mart_table`.

DQL extends lineage through the answer layer:

```
dbt territory:     raw_table → staging_model → mart_table
                   ─────────────────────────────────────
DQL territory:              mart_table
                               ↓
                            block (owner: data-team, domain: data, certified ✓)
                               ↓
                            semantic_metric (domain: finance, certified ✓)
                               ↓
                            dashboard_block (domain: executive, certified ✓)
                               ↓
                            rendered_chart (end user sees this)
```

At every node: who owns it, which domain, certification status, what changed upstream.

If you use dbt, configure your connection to point at dbt's target warehouse and use DQL's semantic layer with `"provider": "dbt"` to inherit your dbt metrics. DQL's lineage then tracks everything from the mart table forward.

---

## Next Steps

- [Authoring Blocks](./authoring-blocks.md) — create blocks with `ref()` and domain metadata
- [Semantic Layer Guide](./semantic-layer-guide.md) — define metrics that appear in lineage
- [CLI Reference](./cli-reference.md) — full `dql lineage` command reference
- [Data Sources](./data-sources.md) — connect to your warehouse for real lineage
