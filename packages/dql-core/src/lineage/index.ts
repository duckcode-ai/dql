// Lineage analysis — SQL parsing, dependency resolution, graph building, and domain lineage

export {
  analyzeSqlReferences,
  extractTablesFromSql,
  type SqlColumnReference,
  type SqlParseResult,
  type SqlReferenceAnalysis,
} from './sql-parser.js';

export {
  extractColumnLineage,
  type ColumnLineageEntry,
  type ColumnLineageResult,
  type ColumnSource,
} from './column-lineage.js';

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
  type LineageBusinessViewInput,
  type LineageTermInput,
  type LineageBuilderOptions,
} from './builder.js';

export {
  queryLineage,
  queryBusiness360,
  queryCompleteLineagePaths,
  type LineageQuery,
  type LineageQueryResult,
  type Business360Asset,
  type Business360Edge,
  type Business360Gap,
  type Business360Options,
  type Business360Result,
  type Business360ResultV2,
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
