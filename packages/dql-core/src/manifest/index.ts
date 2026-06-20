// Manifest — DQL project compilation artifact

export {
  buildManifest,
  collectInputFiles,
  loadProjectConfig,
  resolveDbtManifestPath,
  resolveDataLexManifestPath,
  type ManifestBuildOptions,
  type DbtImportFilters,
} from './builder.js';

export type {
  DQLManifest,
  ManifestBlock,
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
  ManifestApp,
  ManifestDashboard,
} from './types.js';
