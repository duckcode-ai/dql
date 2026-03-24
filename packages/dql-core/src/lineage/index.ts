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
  type LineageNode,
  type LineageEdge,
  type LineageNodeType,
  type LineageEdgeType,
  type LineageGraphJSON,
} from './lineage-graph.js';

export {
  buildLineageGraph,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
  type LineageBuilderOptions,
} from './builder.js';

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
