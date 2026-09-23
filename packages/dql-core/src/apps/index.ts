// Apps & dashboards — file format loaders and validators.
//
// `dql.app.json` and `.dqld` are the on-disk shapes. Compiled views
// (`ManifestApp`, `ManifestDashboard`) live in `manifest/types.ts`.

export { normalizeProductDomainContext } from './product-domain-context.js';
export type { ProductDomainContext } from './product-domain-context.js';

export {
  parseAppDocument,
  loadAppDocument,
  findAppDocuments,
  resolveRlsContext,
  memberAttributes,
  appFolderRelPath,
  suggestAppId,
} from './app-document.js';
export type {
  AppDocument,
  AppMember,
  AppRole,
  AppPolicy,
  AppRlsBinding,
  AppSchedule,
  AppScheduleDelivery,
  AppHomepage,
  AppVisibility,
  AppLifecycle,
  AppNotebookRef,
  AppDocumentParseError,
  AppDocumentLoadResult,
} from './app-document.js';

export { readDashboardVizStyle } from './viz-style.js';
export {
  clampGridBox,
  compactGridLayout,
  gridBoxesOverlap,
  moveGridItem,
  nudgeGridItem,
  placeGridCopy,
  resizeGridItem,
  settleGridLayout,
  MAX_TILE_ROWS,
} from './grid-layout.js';
export type { GridBox } from './grid-layout.js';
export type {
  DashboardVizStyle,
  DashboardVizReferenceLine,
  DashboardVizBand,
  DashboardVizAnnotation,
} from './viz-style.js';

export {
  parseDashboardDocument,
  loadDashboardDocument,
  findDashboardsForApp,
  findAllDashboards,
  isBlockIdRef,
  extractDashboardBlockRefs,
  dashboardDatasetParameterFilterErrors,
} from './dashboard-document.js';

export {
  applyDatasetHierarchyDrill,
  datasetHierarchyFields,
  datasetTileVisualizationCompatibility,
  datasetQueryRequiresAggregateComponentEvidence,
  isTileTimeGrain,
  normalizeTileQuery,
  tileQueryIsTopNIntent,
  tileQueryOutputAliases,
  tileQueryValidationRuns,
  tileQueryHash,
  tileQueryMeasure,
  validateTileQuery,
} from './tile-query.js';
export type {
  DatasetTileVisualizationCompatibility,
  DatasetTileVisualizationIssueCode,
  TileFilterOperator,
  TileQuery,
  TileQueryComparison,
  TileQueryComparisonPeriod,
  TileQueryDiagnostic,
  TileQueryDimension,
  TileQueryFilter,
  TileQueryMeasure,
  TileQueryAdaptation,
  TileQueryValidation,
  TileQueryValidationOutcome,
  TileTimeGrain,
  DatasetHierarchyDrillResult,
} from './tile-query.js';

export {
  createAppBuildDraft,
  applyAppBuildDraftOperations,
  appBuildDraftHash,
  appBuildPreviewIntentFingerprint,
  packDashboardLayoutItems,
} from './app-build-draft.js';
export type {
  AppBuildDraft,
  AppBuildFrame,
  AppBuildClarification,
  AppBuildRequirement,
  AppBuildRequirementCoverage,
  AppBuildRunReceipt,
  AppBuildPreflightReceipt,
  AppBuildAuthoringMode,
  AppBuildSourcePolicy,
  AppBuildTemplateId,
  AppBuildDraftSourceKind,
  AppBuildSourceLifecycle,
  AppBuildSourceCapabilities,
  AppBuildDraftSource,
  AppBuildReviewTask,
  AppBuildDraftOperation,
} from './app-build-draft.js';
export type {
  DashboardDocument,
  DashboardParam,
  DashboardFilter,
  DashboardDatasetFilterBinding,
  DashboardBlockRef,
  DashboardSemanticQueryRef,
  DashboardStoryEvidencePlan,
  DashboardStoryFact,
  DashboardStoryClaim,
  DashboardStoryBrief,
  DashboardVizConfig,
  DashboardDisplayMetadata,
  DashboardDisplayMode,
  DashboardDisplayComponent,
  DashboardDisplayLayoutIntent,
  DashboardDisplayTrustState,
  DashboardDisplayReviewStatus,
  DashboardTileFilterBinding,
  DashboardTileParameterBinding,
  DashboardTileSourceEvidence,
  DashboardGridItem,
  DashboardDatasetBinding,
  DashboardInteractions,
  DashboardCrossFilterMapping,
  DashboardDetailInteraction,
  DashboardNavigateInteraction,
  DashboardGridLayout,
  DashboardResponsiveLayouts,
  DashboardLoadResult,
  DashboardParseError,
  DashboardSection,
} from './dashboard-document.js';

export type { AppAnalyticalContextV1 } from './app-analytical-context.js';
