// Manifest — DQL project compilation artifact

export {
  buildManifest,
  collectInputFiles,
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
} from './types.js';
