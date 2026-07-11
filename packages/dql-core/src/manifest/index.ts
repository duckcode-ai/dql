// Manifest — DQL project compilation artifact

export {
  buildManifest,
  collectInputFiles,
  loadProjectConfig,
  resolveDataLexManifestPath,
  resolveDbtManifestPath,
  type ManifestBuildOptions,
  type DbtImportFilters,
} from './builder.js';

export { detectOutputDrift } from './output-drift.js';
export {
  loadDbtFirstModeling,
  siblingDbtArtifact,
  type DbtFirstModelingLoadResult,
} from './dbt-first-modeling.js';
export {
  planDataLexMigration,
  applyDataLexMigration,
  type DataLexMigrationInput,
  type DataLexMigrationFile,
  type DataLexMigrationLoss,
  type DataLexMigrationReport,
  type DataLexMigrationPlan,
} from './datalex-migration.js';
export {
  writeDomainDeclaration,
  deleteDomainDeclaration,
  renderDomainDeclaration,
  resolveDomainDeclPath,
  domainFolderSlug,
  type DomainInput,
  type WrittenDomain,
} from './domain-writer.js';
export {
  loadDbtRunState,
  applyBlockDataState,
  worseDataState,
  type DbtRunStateIndex,
} from './dbt-freshness.js';

export type {
  DQLManifest,
  ManifestBlock,
  ManifestDomain,
  ManifestTerm,
  ManifestBusinessView,
  ManifestNotebook,
  ManifestNotebookCell,
  ManifestMetric,
  ManifestDimension,
  ManifestSource,
  ManifestLineage,
  ManifestLineageNode,
  ManifestLineageEdge,
  ManifestDbtImport,
  ManifestDbtProvenance,
  ManifestDbtNodeProvenance,
  ManifestMetricFlowProvenance,
  ManifestDbtFirstModeling,
  ManifestDomainPackage,
  ManifestModelEntity,
  ManifestModelRelationship,
  ManifestRelationshipCardinality,
  ManifestFanoutPolicy,
  ManifestModelContract,
  ManifestConformanceDeclaration,
  ManifestModelRule,
  ManifestDomainRelationshipLineage,
  ManifestDiagnostic,
  ManifestConflictDetail,
  ManifestConflictSide,
  ManifestDriftDetail,
  ManifestApp,
  ManifestDashboard,
  DbtDataState,
  DbtRunState,
} from './types.js';
