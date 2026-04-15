/**
 * Lineage Builder — assembles the full answer-layer lineage graph.
 *
 * Walks DQL blocks and semantic layer definitions to build a complete
 * LineageGraph connecting source tables → blocks → metrics → charts,
 * with domain boundaries and certification edges.
 */

import { extractTablesFromSql } from './sql-parser.js';
import { LineageGraph } from './lineage-graph.js';

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

/** dbt model/source input for lineage graph construction */
export interface LineageDbtModelInput {
  /** Table name (alias or model name) */
  name: string;
  /** dbt unique ID */
  uniqueId: string;
  /** Whether this is a dbt model (transformed) or source (raw) */
  type: 'model' | 'source';
  /** Names of upstream dbt models/sources this depends on */
  dependsOn: string[];
  /** Column metadata from dbt manifest */
  columns?: Array<{ name: string; type?: string; description?: string }>;
  schema?: string;
  database?: string;
  materialized?: string;
  description?: string;
}

/** Dashboard/notebook input for lineage graph construction */
export interface LineageDashboardInput {
  name: string;
  /** Block names contained in this dashboard */
  blocks: string[];
  /** Chart names contained in this dashboard */
  charts: string[];
}

export interface LineageBuilderOptions {
  /** Known block names for implicit dependency resolution */
  blockNames?: Set<string>;
  /** dbt models/sources for DAG integration */
  dbtModels?: LineageDbtModelInput[];
  /** Dashboards/notebooks as container nodes */
  dashboards?: LineageDashboardInput[];
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
  const dbtModels = options.dbtModels ?? [];
  const dashboards = options.dashboards ?? [];

  // Build dbt model lookup: table name → dbt node ID
  const dbtModelMap = new Map<string, string>();
  for (const dbt of dbtModels) {
    const nodeId = dbt.type === 'source' ? `dbt_source:${dbt.name}` : `dbt_model:${dbt.name}`;
    dbtModelMap.set(dbt.name.toLowerCase(), nodeId);
  }

  for (const block of blocks) {
    materializedMap.set((block.materializedAs ?? block.name).toLowerCase(), block.name);
  }

  // 1. Add dbt model/source nodes and edges
  for (const dbt of dbtModels) {
    const nodeId = dbt.type === 'source' ? `dbt_source:${dbt.name}` : `dbt_model:${dbt.name}`;
    graph.addNode({
      id: nodeId,
      type: dbt.type === 'source' ? 'dbt_source' : 'dbt_model',
      name: dbt.name,
      columns: dbt.columns,
      metadata: {
        uniqueId: dbt.uniqueId,
        schema: dbt.schema,
        database: dbt.database,
        materialized: dbt.materialized,
        description: dbt.description,
      },
    });
  }

  // Create depends_on edges between dbt models
  for (const dbt of dbtModels) {
    if (dbt.type === 'source') continue;
    const targetId = `dbt_model:${dbt.name}`;
    for (const depName of dbt.dependsOn) {
      const sourceId = dbtModelMap.get(depName.toLowerCase());
      if (sourceId) {
        graph.addEdge({ source: sourceId, target: targetId, type: 'depends_on' });
      }
    }
  }

  // 2. Add block nodes
  for (const block of blocks) {
    graph.addNode({
      id: `block:${block.name}`,
      type: 'block',
      name: block.name,
      domain: block.domain,
      owner: block.owner,
      status: block.status,
      metadata: {
        blockType: block.blockType,
        materializedAs: block.materializedAs,
      },
    });
  }

  // 3. Add metric nodes
  for (const metric of metrics) {
    graph.addNode({
      id: `metric:${metric.name}`,
      type: 'metric',
      name: metric.name,
      domain: metric.domain,
      metadata: { type: metric.type },
    });

    // Metric → source table edge (check dbt models first)
    const tableNodeId = ensureTableOrDbtNode(graph, metric.table, dbtModelMap);
    graph.addEdge({
      source: tableNodeId,
      target: `metric:${metric.name}`,
      type: 'aggregates',
    });
  }

  // 4. Add dimension nodes
  for (const dim of dimensions) {
    graph.addNode({
      id: `dimension:${dim.name}`,
      type: 'dimension',
      name: dim.name,
    });

    const tableNodeId = ensureTableOrDbtNode(graph, dim.table, dbtModelMap);
    graph.addEdge({
      source: tableNodeId,
      target: `dimension:${dim.name}`,
      type: 'reads_from',
    });
  }

  // 5. Process each block's SQL for dependencies
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

    // SQL table references — check dbt models first, then blocks, then external tables
    for (const table of parseResult.tables) {
      const tableLower = table.toLowerCase();

      // Check if table is a dbt model/source
      const dbtNodeId = dbtModelMap.get(tableLower);
      if (dbtNodeId) {
        graph.addEdge({
          source: dbtNodeId,
          target: blockNodeId,
          type: 'reads_from',
        });
        continue;
      }

      // Check if table matches another block's materialized name
      const resolved = materializedMap.get(tableLower);
      if (resolved && resolved !== block.name) {
        graph.addEdge({
          source: `block:${resolved}`,
          target: blockNodeId,
          type: 'feeds_into',
        });
        addCrossDomainEdgeIfNeeded(graph, `block:${resolved}`, blockNodeId);
      } else if (!resolved) {
        // External table dependency
        const tableNodeId = ensureTableNode(graph, table);
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
  }

  // 6. Add dashboard nodes
  for (const dash of dashboards) {
    const dashNodeId = `dashboard:${dash.name}`;
    graph.addNode({
      id: dashNodeId,
      type: 'dashboard',
      name: dash.name,
    });

    // Dashboard contains blocks
    for (const blockName of dash.blocks) {
      if (graph.getNode(`block:${blockName}`)) {
        graph.addEdge({
          source: `block:${blockName}`,
          target: dashNodeId,
          type: 'contains',
        });
      }
    }

    // Dashboard contains charts
    for (const chartName of dash.charts) {
      if (graph.getNode(`chart:${chartName}`)) {
        graph.addEdge({
          source: `chart:${chartName}`,
          target: dashNodeId,
          type: 'contains',
        });
      }
    }
  }

  // 7. Add domain nodes and connect
  addDomainNodes(graph);

  return graph;
}

/**
 * Check if a table name matches a dbt model/source; if so return that node ID.
 * Otherwise fall back to creating a source_table node.
 */
function ensureTableOrDbtNode(
  graph: LineageGraph,
  rawTableName: string,
  dbtModelMap: Map<string, string>,
): string {
  const normalized = normalizeTableName(rawTableName);
  const dbtNodeId = dbtModelMap.get(normalized.toLowerCase());
  if (dbtNodeId && graph.getNode(dbtNodeId)) {
    return dbtNodeId;
  }
  return ensureTableNode(graph, rawTableName);
}

/** Ensure a source_table node exists and return its ID. */
function ensureTableNode(graph: LineageGraph, rawTableName: string): string {
  const tableName = normalizeTableName(rawTableName);
  const nodeId = `table:${tableName}`;
  if (!graph.getNode(nodeId)) {
    graph.addNode({
      id: nodeId,
      type: 'source_table',
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
      name: domain,
      domain,
    });
  }
}
