/**
 * Shared lineage constants, types, and color mappings.
 * Centralizes all lineage-related visual constants to avoid duplication
 * across LineageDAG, LineagePanel, CellLineage, and BlockStudio.
 */

// ---- Shared TypeScript interfaces ----

export interface LineageNode {
  id: string;
  type: string;
  name: string;
  layer?: string;
  domain?: string;
  status?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface LineageEdge {
  source: string;
  target: string;
  type: string;
  sourceDomain?: string;
  targetDomain?: string;
}

export interface LineagePath {
  nodes: LineageNode[];
  edges: LineageEdge[];
  layers: string[];
}

export interface CompletePathResult {
  focalNode: LineageNode;
  upstreamPaths: LineagePath[];
  downstreamPaths: LineagePath[];
  layerSummary: Record<string, number>;
}

// ---- Node type colors ----

export const NODE_TYPE_COLORS: Record<string, string> = {
  source_table: '#8b949e',
  dbt_model: '#ff7b72',
  dbt_source: '#79c0ff',
  block: '#56d364',
  metric: '#388bfd',
  dimension: '#e3b341',
  domain: '#d2a8ff',
  chart: '#f778ba',
  dashboard: '#d2a8ff',
};

// ---- Short type labels (for badges) ----

export const TYPE_LABELS: Record<string, string> = {
  source_table: 'TBL',
  dbt_model: 'DBT',
  dbt_source: 'SRC',
  block: 'BLK',
  metric: 'MET',
  dimension: 'DIM',
  domain: 'DOM',
  chart: 'CHT',
  dashboard: 'DASH',
};

// ---- Full type titles ----

export const TYPE_TITLES: Record<string, string> = {
  source_table: 'Source Table',
  dbt_model: 'dbt Model',
  dbt_source: 'dbt Source',
  block: 'DQL Block',
  metric: 'Metric',
  dimension: 'Dimension',
  domain: 'Domain',
  chart: 'Chart',
  dashboard: 'Notebook',
};

// ---- Edge type colors ----

export const EDGE_TYPE_COLORS: Record<string, string> = {
  reads_from: '#8b949e',
  feeds_into: '#56d364',
  aggregates: '#388bfd',
  visualizes: '#f778ba',
  depends_on: '#ff7b72',
  contains: '#d2a8ff',
  crosses_domain: '#d2a8ff',
};

// ---- Edge type titles ----

export const EDGE_TITLES: Record<string, string> = {
  reads_from: 'reads from',
  feeds_into: 'feeds into',
  aggregates: 'aggregates into',
  visualizes: 'visualizes',
  depends_on: 'dbt depends on',
  contains: 'contains',
  crosses_domain: 'crosses domain',
};

// ---- Lineage layer constants ----

export type LineageLayerName = 'source' | 'transform' | 'answer' | 'consumption';

export const LAYER_COLORS: Record<LineageLayerName, string> = {
  source: '#79c0ff',
  transform: '#ff7b72',
  answer: '#56d364',
  consumption: '#d2a8ff',
};

export const LAYER_LABELS: Record<LineageLayerName, string> = {
  source: 'Sources',
  transform: 'Transform',
  answer: 'Answer',
  consumption: 'Consumption',
};

export const LAYER_ORDER: LineageLayerName[] = ['source', 'transform', 'answer', 'consumption'];

// ---- Status colors ----

export const STATUS_COLORS: Record<string, string> = {
  certified: '#56d364',
  draft: '#8b949e',
  review: '#e3b341',
  deprecated: '#f85149',
};

// ---- Helpers ----

/** Get the layer for a node based on its type (fallback if layer not set) */
export function getNodeLayer(node: LineageNode): LineageLayerName {
  if (node.layer) return node.layer as LineageLayerName;
  switch (node.type) {
    case 'source_table':
    case 'dbt_source':
      return 'source';
    case 'dbt_model':
      return 'transform';
    case 'block':
    case 'metric':
    case 'dimension':
    case 'domain':
      return 'answer';
    case 'chart':
    case 'dashboard':
      return 'consumption';
    default:
      return 'answer';
  }
}

/** Format a node label with its type badge for display */
export function formatNodeLabel(node: LineageNode): string {
  const label = TYPE_LABELS[node.type] ?? node.type.slice(0, 3).toUpperCase();
  return `[${label}] ${node.name}`;
}
