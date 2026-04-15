/**
 * Lineage Builder — assembles the full answer-layer lineage graph.
 *
 * Walks DQL blocks and semantic layer definitions to build a complete
 * LineageGraph connecting source tables → blocks → metrics → charts,
 * with domain boundaries and certification edges.
 */

import { extractTablesFromSql } from './sql-parser.js';
import { LineageGraph, getLayerForNodeType } from './lineage-graph.js';

// ---- Input types (kept simple to avoid coupling to specific packages) ----

export interface LineageBlockInput {
  name: string;
  sql: string;
  domain?: string;
  owner?: string;
  status?: 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';
  certifiedBy?: string;
  /** Block type: custom, semantic, etc. */
  blockType?: string;
  /** Metric reference for semantic blocks */
  metricRef?: string;
  /** Chart type from visualization config */
  chartType?: string;
  /** Materialized table/view name */
  materializedAs?: string;
  /** File path of the block definition */
  filePath?: string;
}

export interface LineageMetricInput {
  name: string;
  table: string;
  domain: string;
  type: string;
}

export interface LineageDimensionInput {
  name: string;
  table: string;
}

export interface LineageBuilderOptions {
  /** Known block names for implicit dependency resolution */
  blockNames?: Set<string>;
  dbtModels?: LineageDbtModelInput[];
  dashboards?: LineageDashboardInput[];
}

export interface LineageDbtModelInput {
  name: string;
  uniqueId: string;
  type: 'model' | 'source';
  dependsOn: string[];
  columns?: Array<{ name: string; type?: string; description?: string }>;
  schema?: string;
  database?: string;
  materialized?: string;
  description?: string;
}

export interface LineageDashboardInput {
  name: string;
  blocks: string[];
  charts: string[];
  /** File path of the notebook */
  filePath?: string;
  /** Block names referenced via ref() in SQL cells */
  refDependencies?: string[];
  /** Table names referenced in SQL cells (for tracing non-block SQL) */
  tableDependencies?: string[];
}

/**
 * Build a complete lineage graph from blocks and semantic definitions.
 */
export function buildLineageGraph(
  blocks: LineageBlockInput[],
  metrics: LineageMetricInput[],
  dimensions: LineageDimensionInput[],
  options: LineageBuilderOptions = {},
): LineageGraph {
  const graph = new LineageGraph();
  const blockNames = options.blockNames ?? new Set(blocks.map((b) => b.name));
  const materializedMap = new Map<string, string>();
  const dbtNodeMap = new Map<string, string>();
  const dbtUniqueIdMap = new Map<string, string>();

  for (const block of blocks) {
    materializedMap.set((block.materializedAs ?? block.name).toLowerCase(), block.name);
  }

  for (const dbtModel of options.dbtModels ?? []) {
    const nodeId = `${dbtModel.type === 'model' ? 'dbt_model' : 'dbt_source'}:${dbtModel.name}`;
    dbtNodeMap.set(dbtModel.name.toLowerCase(), nodeId);
    // Also index by schema-qualified name for SQL references like "schema.table"
    if (dbtModel.schema) {
      dbtNodeMap.set(`${dbtModel.schema}.${dbtModel.name}`.toLowerCase(), nodeId);
    }
    if (dbtModel.database && dbtModel.schema) {
      dbtNodeMap.set(`${dbtModel.database}.${dbtModel.schema}.${dbtModel.name}`.toLowerCase(), nodeId);
    }
    dbtUniqueIdMap.set(dbtModel.uniqueId, nodeId);
    const nodeType = dbtModel.type === 'model' ? 'dbt_model' as const : 'dbt_source' as const;
    graph.addNode({
      id: nodeId,
      type: nodeType,
      layer: getLayerForNodeType(nodeType),
      name: dbtModel.name,
      metadata: {
        uniqueId: dbtModel.uniqueId,
        schema: dbtModel.schema,
        database: dbtModel.database,
        materialized: dbtModel.materialized,
        description: dbtModel.description,
      },
      columns: dbtModel.columns,
    });
  }

  for (const dbtModel of options.dbtModels ?? []) {
    const targetId = dbtUniqueIdMap.get(dbtModel.uniqueId);
    if (!targetId) continue;
    for (const dependency of dbtModel.dependsOn) {
      const sourceId = dbtUniqueIdMap.get(dependency);
      if (!sourceId) continue;
      graph.addEdge({
        source: sourceId,
        target: targetId,
        type: 'depends_on',
      });
    }
  }

  // 1. Add block nodes
  for (const block of blocks) {
    graph.addNode({
      id: `block:${block.name}`,
      type: 'block',
      layer: 'answer',
      name: block.name,
      domain: block.domain,
      owner: block.owner,
      status: block.status,
      metadata: {
        blockType: block.blockType,
        materializedAs: block.materializedAs,
        filePath: block.filePath,
      },
    });
  }

  // 2. Add metric nodes
  for (const metric of metrics) {
    graph.addNode({
      id: `metric:${metric.name}`,
      type: 'metric',
      layer: 'answer',
      name: metric.name,
      domain: metric.domain,
      metadata: { type: metric.type },
    });

    // Metric → source table edge
    const tableNodeId = ensureTableNode(graph, metric.table, dbtNodeMap);
    graph.addEdge({
      source: tableNodeId,
      target: `metric:${metric.name}`,
      type: 'aggregates',
    });
  }

  // 3. Add dimension nodes
  for (const dim of dimensions) {
    graph.addNode({
      id: `dimension:${dim.name}`,
      type: 'dimension',
      layer: 'answer',
      name: dim.name,
    });

    const tableNodeId = ensureTableNode(graph, dim.table, dbtNodeMap);
    graph.addEdge({
      source: tableNodeId,
      target: `dimension:${dim.name}`,
      type: 'reads_from',
    });
  }

  // 4. Process each block's SQL for dependencies
  for (const block of blocks) {
    const blockNodeId = `block:${block.name}`;
    const parseResult = extractTablesFromSql(block.sql);

    // ref() calls → block-to-block edges
    for (const ref of parseResult.refs) {
      if (blockNames.has(ref)) {
        graph.addEdge({
          source: `block:${ref}`,
          target: blockNodeId,
          type: 'feeds_into',
        });
        addCrossDomainEdgeIfNeeded(graph, `block:${ref}`, blockNodeId);
      }
    }

    // SQL table references
    for (const table of parseResult.tables) {
      const resolved = materializedMap.get(table.toLowerCase());
      const normalizedTable = normalizeTableName(table).toLowerCase();
      // Try full name first, then strip schema prefix for fallback
      const dbtResolved = dbtNodeMap.get(normalizedTable)
        ?? (normalizedTable.includes('.') ? dbtNodeMap.get(normalizedTable.split('.').pop()!) : undefined);
      if (dbtResolved) {
        graph.addEdge({
          source: dbtResolved,
          target: blockNodeId,
          type: 'reads_from',
        });
      } else if (resolved && resolved !== block.name) {
        // Table matches another block's materialized name
        graph.addEdge({
          source: `block:${resolved}`,
          target: blockNodeId,
          type: 'feeds_into',
        });
        addCrossDomainEdgeIfNeeded(graph, `block:${resolved}`, blockNodeId);
      } else if (!resolved) {
        // External table dependency
        const tableNodeId = ensureTableNode(graph, table, dbtNodeMap);
        graph.addEdge({
          source: tableNodeId,
          target: blockNodeId,
          type: 'reads_from',
        });
      }
    }

    // @metric() references in SQL → block depends on metric
    for (const metRef of parseResult.metricRefs) {
      const metricNodeId = `metric:${metRef}`;
      if (graph.getNode(metricNodeId)) {
        graph.addEdge({
          source: metricNodeId,
          target: blockNodeId,
          type: 'aggregates',
        });
        addCrossDomainEdgeIfNeeded(graph, metricNodeId, blockNodeId);
      }
    }

    // @dim() references in SQL → block depends on dimension
    for (const dimRef of parseResult.dimensionRefs) {
      const dimNodeId = `dimension:${dimRef}`;
      if (graph.getNode(dimNodeId)) {
        graph.addEdge({
          source: dimNodeId,
          target: blockNodeId,
          type: 'reads_from',
        });
      }
    }

    // Semantic block → metric edge
    if (block.blockType === 'semantic' && block.metricRef) {
      const metricNodeId = `metric:${block.metricRef}`;
      if (graph.getNode(metricNodeId)) {
        graph.addEdge({
          source: metricNodeId,
          target: blockNodeId,
          type: 'aggregates',
        });
        addCrossDomainEdgeIfNeeded(graph, metricNodeId, blockNodeId);
      }
    }

    // Chart visualization edge
    if (block.chartType) {
      const chartNodeId = `chart:${block.name}`;
      graph.addNode({
        id: chartNodeId,
        type: 'chart',
        layer: 'consumption',
        name: `${block.name} (${block.chartType})`,
        domain: block.domain,
        metadata: { chartType: block.chartType },
      });
      graph.addEdge({
        source: blockNodeId,
        target: chartNodeId,
        type: 'visualizes',
      });
    }

    // Certification is stored as node metadata (status + certifiedBy), not as an edge.
    // Self-loops would confuse graph traversal without adding lineage value.
  }

  for (const dashboard of options.dashboards ?? []) {
    const dashboardId = `dashboard:${dashboard.name}`;
    graph.addNode({
      id: dashboardId,
      type: 'dashboard',
      layer: 'consumption',
      name: dashboard.name,
      metadata: { filePath: dashboard.filePath },
    });
    for (const blockName of dashboard.blocks) {
      if (!graph.getNode(`block:${blockName}`)) continue;
      // Edge direction: block feeds into dashboard (data flows block → dashboard)
      graph.addEdge({
        source: `block:${blockName}`,
        target: dashboardId,
        type: 'contains',
      });
    }
    for (const chartName of dashboard.charts) {
      if (!graph.getNode(`chart:${chartName}`)) continue;
      graph.addEdge({
        source: `chart:${chartName}`,
        target: dashboardId,
        type: 'contains',
      });
    }
    // Add edges for blocks referenced via ref() in notebook SQL cells
    for (const refBlock of dashboard.refDependencies ?? []) {
      if (!graph.getNode(`block:${refBlock}`)) continue;
      graph.addEdge({
        source: `block:${refBlock}`,
        target: dashboardId,
        type: 'contains',
      });
    }
    // Add edges for tables referenced in notebook SQL cells
    for (const table of dashboard.tableDependencies ?? []) {
      const tableNodeId = ensureTableNode(graph, table, dbtNodeMap);
      graph.addEdge({
        source: tableNodeId,
        target: dashboardId,
        type: 'reads_from',
      });
    }
  }

  // 5. Add domain nodes and connect
  addDomainNodes(graph);

  return graph;
}

/** Ensure a source_table node exists and return its ID. */
function ensureTableNode(
  graph: LineageGraph,
  rawTableName: string,
  dbtNodeMap?: Map<string, string>,
): string {
  const tableName = normalizeTableName(rawTableName);
  const dbtNodeId = dbtNodeMap?.get(tableName.toLowerCase());
  if (dbtNodeId) return dbtNodeId;
  const nodeId = `table:${tableName}`;
  if (!graph.getNode(nodeId)) {
    graph.addNode({
      id: nodeId,
      type: 'source_table',
      layer: 'source',
      name: tableName,
    });
  }
  return nodeId;
}

/**
 * Normalize DuckDB reader function calls to plain table names.
 * e.g., "read_csv_auto('./data/revenue.csv')" → "revenue"
 */
function normalizeTableName(name: string): string {
  const readerMatch = name.match(
    /^(?:read_csv_auto|read_csv|read_parquet|read_json|read_json_auto)\s*\(\s*['"]([^'"]+)['"]\s*\)$/i,
  );
  if (readerMatch) {
    // Extract filename without extension from the path
    const path = readerMatch[1];
    const filename = path.split('/').pop() ?? path;
    return filename.replace(/\.(csv|parquet|json)$/i, '');
  }
  return name;
}

/** Add a crosses_domain edge if source and target are in different domains. */
function addCrossDomainEdgeIfNeeded(graph: LineageGraph, sourceId: string, targetId: string): void {
  const sourceNode = graph.getNode(sourceId);
  const targetNode = graph.getNode(targetId);

  if (sourceNode?.domain && targetNode?.domain && sourceNode.domain !== targetNode.domain) {
    graph.addEdge({
      source: sourceId,
      target: targetId,
      type: 'crosses_domain',
      sourceDomain: sourceNode.domain,
      targetDomain: targetNode.domain,
    });
  }
}

/** Add domain nodes and connect blocks/metrics to their domains. */
function addDomainNodes(graph: LineageGraph): void {
  const domains = graph.getDomains();

  for (const domain of domains) {
    const domainNodeId = `domain:${domain}`;
    graph.addNode({
      id: domainNodeId,
      type: 'domain',
      layer: 'answer',
      name: domain,
      domain,
    });
  }
}
