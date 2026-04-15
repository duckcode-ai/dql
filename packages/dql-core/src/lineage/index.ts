// Lineage analysis — SQL parsing, dependency resolution, graph building, and domain lineage

export {
  extractTablesFromSql,
  type SqlParseResult,
} from './sql-parser.js';

export {
  resolveDependencies,
  getUpstream,
  getDownstream,
  type BlockDependencyInfo,
  type DependencyResolutionResult,
} from './dependency-resolver.js';

export {
  LineageGraph,
  getLayerForNodeType,
  type LineageNode,
  type LineageEdge,
  type LineageNodeType,
  type LineageEdgeType,
  type LineageLayer,
  type LineageGraphJSON,
} from './lineage-graph.js';

export {
  buildLineageGraph,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
  type LineageDbtModelInput,
  type LineageDashboardInput,
  type LineageBuilderOptions,
} from './builder.js';

export {
  queryLineage,
  queryCompleteLineagePaths,
  type LineageQuery,
  type LineageQueryResult,
  type LineagePath,
  type CompletePathResult,
  type CompletePathOptions,
} from './query.js';

export {
  buildTrustChain,
  analyzeImpact,
  detectDomainFlows,
  getDomainTrustOverview,
  type TrustChain,
  type TrustChainNode,
  type ImpactAnalysis,
  type DomainImpact,
  type DomainFlow,
} from './domain-lineage.js';
