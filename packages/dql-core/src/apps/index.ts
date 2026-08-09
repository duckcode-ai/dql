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

export {
  parseDashboardDocument,
  loadDashboardDocument,
  findDashboardsForApp,
  findAllDashboards,
  isBlockIdRef,
  extractDashboardBlockRefs,
} from './dashboard-document.js';

export {
  createAppBuildDraft,
  applyAppBuildDraftOperations,
  appBuildDraftHash,
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
  AppBuildDraftSource,
  AppBuildReviewTask,
  AppBuildDraftOperation,
} from './app-build-draft.js';
export type {
  DashboardDocument,
  DashboardParam,
  DashboardFilter,
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
  DashboardGridLayout,
  DashboardResponsiveLayouts,
  DashboardLoadResult,
  DashboardParseError,
  DashboardSection,
} from './dashboard-document.js';
