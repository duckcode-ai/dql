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
