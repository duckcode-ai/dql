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
  ManifestDiagnostic,
  ManifestConflictDetail,
  ManifestConflictSide,
  ManifestDriftDetail,
  ManifestApp,
  ManifestDashboard,
  DbtDataState,
  DbtRunState,
} from './types.js';
