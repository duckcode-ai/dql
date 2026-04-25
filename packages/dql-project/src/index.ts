export type {
  BlockRecord,
  BlockVersion,
  BlockStatus,
  BlockSearchQuery,
  BlockSearchResult,
  TestResultSummary,
  TestAssertionResult,
  RegistryEvent,
  RegistryEventType,
  RegistryStorage,
} from './types.js';

export { RegistryClient } from './registry-client.js';
export { VersionManager } from './version-manager.js';
export { RegistrySync } from './sync.js';
export type { SyncResult, SyncOptions, ParsedBlock } from './sync.js';
export { MemoryStorage } from './memory-storage.js';
export { SQLiteStorage } from './sqlite-storage.js';
export { ManifestCache } from './manifest-cache.js';
export type {
  TrackedFile,
  CacheHit,
  CacheMiss,
  CacheLookup,
  ManifestCacheOptions,
} from './manifest-cache.js';

// Persona registry — runtime active-user state used by the governance and
// RLS layers. The Apps/Dashboards file format itself lives in dql-core
// (re-exported below for callers that only depend on dql-project).
export {
  PersonaRegistry,
  defaultPersonaRegistry,
  personaFromMember,
  OWNER_DEFAULT,
} from './persona.js';
export type { ActivePersona, UserContextLike } from './persona.js';

export {
  personaVariables,
  mergePersonaVariables,
} from './persona-variables.js';

// Re-exports of the App/Dashboard file formats so consumers can stay on a
// single import surface.
export {
  parseAppDocument,
  loadAppDocument,
  findAppDocuments,
  resolveRlsContext,
  memberAttributes,
  appFolderRelPath,
  suggestAppId,
  parseDashboardDocument,
  loadDashboardDocument,
  findDashboardsForApp,
  findAllDashboards,
  isBlockIdRef,
  extractDashboardBlockRefs,
} from '@duckcodeailabs/dql-core';
export type {
  AppDocument,
  AppMember,
  AppRole,
  AppPolicy,
  AppRlsBinding,
  AppSchedule,
  AppScheduleDelivery,
  AppHomepage,
  AppDocumentParseError,
  AppDocumentLoadResult,
  DashboardDocument,
  DashboardParam,
  DashboardFilter,
  DashboardBlockRef,
  DashboardVizConfig,
  DashboardGridItem,
  DashboardLoadResult,
  DashboardParseError,
} from '@duckcodeailabs/dql-core';
