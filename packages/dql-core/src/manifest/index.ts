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
  loadDbtRunState,
  applyBlockDataState,
  worseDataState,
  type DbtRunStateIndex,
} from './dbt-freshness.js';

export type {
  DQLManifest,
  ManifestBlock,
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
