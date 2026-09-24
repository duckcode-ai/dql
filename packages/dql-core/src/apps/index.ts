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
  firstFreeGridCell,
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
  readDriverDefinition,
  readDashboardNarrative,
  readDashboardCanvas,
  DASHBOARD_DRIVER_GRAINS,
  MAX_DRIVER_DIMENSIONS,
  DRIVER_ALL_DIMENSIONS,
  MAX_TILE_DESCRIPTION,
  MAX_TILE_OWNER,
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
  DashboardDriverDefinition,
  DashboardDriverGrain,
  DashboardNarrative,
  DashboardNarrativeBlock,
  DashboardCanvas,
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

export {
  buildStoryBindingCatalog,
  figureLabel,
  validateStoryText,
  splitStoryText,
  storyBindingKeys,
  formatStoryValue,
  STORY_BINDING_PATTERN,
  MAX_STORY_TEXT,
  MAX_STORY_BLOCKS,
} from './story-bindings.js';
export type { StoryBinding, StoryBindingCatalog, StoryBindingTileInput, StoryTextIssue } from './story-bindings.js';

export { checkCanvasHtml, fillCanvasHtml, escapeHtml, MAX_CANVAS_HTML } from './canvas-page.js';
export type { CanvasIssue, CheckedCanvas } from './canvas-page.js';
export { READER_TRUST_LABELS, isDataTileForTrust, readerTileTrust, readerTrustCounts, readerTrustSummary } from './reader-trust.js';
export type { ReaderTrust, ReaderTrustItem, ReaderTrustState, ReaderTrustTile } from './reader-trust.js';
export { evaluateMonitors, readAppMonitors, MAX_MONITORS_PER_SCHEDULE } from './monitors.js';
export type { AppMonitor, AppMonitorCondition, MonitorEvaluation, MonitorPreviousValue, MonitorStatus } from './monitors.js';
