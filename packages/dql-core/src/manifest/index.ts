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
} from './types.js';
