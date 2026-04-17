# Lineage model

DQL's lineage graph answers three questions:

1. **What depends on this?** (impact analysis — downstream)
2. **Where did this come from?** (trust chain — upstream)
3. **What's shared across teams?** (cross-domain detection)

## Node types

| Kind | Source |
| --- | --- |
| `source` | dbt source or warehouse table |
| `model` | dbt model |
| `block` | DQL block |
| `notebook` | DQL notebook |
| `dashboard` | DQL dashboard |
| `metric` / `dimension` | Semantic layer object |

## Edge types

| Kind | Meaning |
| --- | --- |
| `reads` | `A` queries from `B` |
| `contains` | `A` embeds `B` (e.g. notebook contains block) |
| `materializes_to` | `A` is compiled into `B` (e.g. block → dashboard section) |

## Extraction

SQL-level refs are extracted with `node-sql-parser` (**not regex**), which
correctly handles CTEs, subqueries, lateral joins, `QUALIFY`, and dialect
quirks. Semantic refs (`@metric`, `@block`, `@table`) are extracted from
the DQL AST directly.

## Storage

Lineage is persisted in `.dql/cache/manifest.sqlite` and rebuilt
incrementally — only touched subgraphs are recomputed on a file change.
Warm rebuild on a 4,000-model project is under 2s.

## CLI surface

```bash
dql lineage summary
dql lineage impact customers          # downstream of `customers`
dql lineage trust-chain revenue_q4    # upstream of a block
dql lineage cross-domain              # edges that cross domain boundaries
```

## Column-level lineage

Table-level lineage is fully open-source. **Column-level lineage is a
commercial feature** in the DuckCode Cloud build — see the
[OSS/Cloud boundary](https://github.com/duckcode-ai/dql/blob/main/ROADMAP.md#commercial-gate--osscloud-boundary).
The manifest output is identical in both builds; column-level is gated at
the surface, not in the graph.
