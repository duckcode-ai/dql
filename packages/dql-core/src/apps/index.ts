// Apps & dashboards — file format loaders and validators.
//
// `dql.app.json` and `.dqld` are the on-disk shapes. Compiled views
// (`ManifestApp`, `ManifestDashboard`) live in `manifest/types.ts`.

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
export type {
  DashboardDocument,
  DashboardParam,
  DashboardFilter,
  DashboardBlockRef,
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
  DashboardLoadResult,
  DashboardParseError,
  DashboardSection,
} from './dashboard-document.js';
