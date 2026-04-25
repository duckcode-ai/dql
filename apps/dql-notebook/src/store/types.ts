// v1.3.2 — three Luna themes (obsidian dark, paper warm light, white plain light).
// `dark`/`light`/`midnight`/`arctic` kept as aliases so persisted state from
// earlier v1.3 releases still loads; normalize in the reducer / App effect.
export type ThemeMode = 'obsidian' | 'paper' | 'white' | 'dark' | 'light' | 'midnight' | 'arctic';

/**
 * v1.3 Track 5 — shell-level audience split.
 * - `studio`: full authoring surface (activity bar, sidebar, cell toolbars, all cell types visible)
 * - `app`: stakeholder read-mostly view (output-only cells + interactive filters; SQL/param/writeback/chat collapse)
 * - `reader`: presentation view — narrative-only, no run controls, no studio chrome.
 *   v1.3.3 Hex-handoff alignment; reader visibility behaves like `app` for now.
 */
export type AppMode = 'studio' | 'app' | 'reader';

export interface NotebookDocMetadata {
  status?: string;
  categories?: string[];
  description?: string;
  projectFilter?: string;
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
}

export type CellType =
  | 'sql'
  | 'markdown'
  | 'dql'
  | 'param'
  | 'chart'
  | 'pivot'
  | 'single_value'
  | 'filter'
  | 'table'
  | 'map'
  | 'writeback'
  | 'python'
  | 'chat';

export type CellStatus = 'idle' | 'running' | 'success' | 'error';

export interface CellChartConfig {
  chart?: string;   // bar | line | area | pie | donut | scatter | heatmap | funnel | waterfall | histogram | gauge | stacked-bar | grouped-bar | kpi | table
  x?: string;       // X-axis column
  y?: string;       // Y-axis column
  color?: string;   // Color-by column
  facet?: string;   // Faceting column (horizontal/vertical split)
  size?: string;    // Size-by column (scatter/bubble)
  title?: string;
  xLabel?: string;
  yLabel?: string;
  legendPosition?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  colorPalette?: 'default' | 'warm' | 'cool' | 'mono' | 'pastel';
  maxItems?: number;
}

export type FilterOperation =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'is_null' | 'is_not_null' | 'in' | 'not_in' | 'between';

export interface FilterRule {
  id: string;
  column: string;
  operation: FilterOperation;
  value: string;
}

export interface FilterGroup {
  id: string;
  combinator: 'and' | 'or';
  rules: FilterRule[];
}

export interface FilterCellConfig {
  mode: 'keep' | 'drop';
  groups: FilterGroup[];
  upstream?: string;   // dataframe handle
}

export interface PivotCellConfig {
  rows: string[];
  columns: string[];
  values: Array<{ column: string; aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct' }>;
  upstream?: string;
}

export interface SingleValueCellConfig {
  metric?: string;       // column name to aggregate
  aggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'last';
  format?: 'number' | 'currency' | 'percent' | 'duration';
  label?: string;
  comparison?: { column?: string; mode?: 'previous' | 'baseline' };
  upstream?: string;
}

export interface TableCellConfig {
  upstream?: string;       // dataframe handle to render
  visibleColumns?: string[];
  pinnedColumns?: string[];
}

export type ChatProviderId = 'claude-agent-sdk' | 'claude-code';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  events?: Array<{ kind: string; payload: unknown }>;
}

export interface ChatBlockProposalSnapshot {
  name: string;
  domain: string;
  owner: string;
  description: string;
  sql: string;
  tags?: string[];
  chartType?: string;
  certified: boolean;
  errors: string[];
  warnings: string[];
}

export interface ChatCellConfig {
  provider: ChatProviderId;
  history: ChatMessage[];
  upstream?: string;
  lastProposal?: ChatBlockProposalSnapshot;
}

export type ParamType = 'text' | 'select' | 'date' | 'number';

export interface ParamConfig {
  paramType: ParamType;
  label: string;
  defaultValue: string;
  options?: string[];
}
export type SidebarPanel = 'files' | 'schema' | 'block_library' | 'connection' | 'reference' | 'lineage' | 'git' | 'apps' | null;
export type DevPanelTab = 'logs' | 'errors';
export type MainView = 'notebook' | 'block_studio' | 'connection' | 'reference' | 'git' | 'apps';

/**
 * Apps consumption-layer surface — list of Apps + currently-open App.
 * Source of truth lives on disk (`apps/<id>/dql.app.json`). The store caches
 * a summarised view for the UI; full documents are lazy-loaded.
 */
export interface AppSummary {
  id: string;
  name: string;
  domain: string;
  description?: string;
  owners: string[];
  tags: string[];
  members: number;
  roles: number;
  policies: number;
  schedules: number;
  dashboards: Array<{ id: string; title: string }>;
  homepage?: { type: 'dashboard'; id: string } | { type: 'notebook'; path: string };
}

export interface ActivePersona {
  userId: string;
  displayName?: string;
  roles: string[];
  attributes: Record<string, string | number | boolean>;
  rlsContext: Record<string, string | number | boolean>;
  appId?: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  executionTime?: number;
  rowCount?: number;
  semanticRefs?: {
    metrics: string[];
    dimensions: string[];
  };
}

export interface RunSnapshotCell {
  cellId: string;
  status: CellStatus;
  result?: QueryResult;
  error?: string;
  executionCount?: number;
  executedAt?: string;
}

export interface RunSnapshot {
  version: 1;
  notebookPath: string;
  capturedAt: string;
  cells: RunSnapshotCell[];
}

/**
 * A bound cell is a live reference to a `.dql` block file.
 * - `bound`: content matches the block file
 * - `forked`: user edited locally, diverged from file
 *
 * `originalContent` is the canonical cell body derived from the block on bind/revert;
 * divergence is detected by comparing `cell.content` to this.
 */
export interface BlockBinding {
  path: string;
  commitSha?: string;
  version?: string;
  state: 'bound' | 'forked';
  originalContent?: string;
}

export interface Cell {
  id: string;
  type: CellType;
  content: string;
  name?: string;
  status: CellStatus;
  result?: QueryResult;
  error?: string;
  executionCount?: number;
  paramConfig?: ParamConfig;
  paramValue?: string;
  chartConfig?: CellChartConfig;      // Chart cell binding (also used for SQL-cell chart view)
  filterConfig?: FilterCellConfig;    // Filter cell
  pivotConfig?: PivotCellConfig;      // Pivot cell
  singleValueConfig?: SingleValueCellConfig;  // Single-value cell
  tableConfig?: TableCellConfig;      // Table cell
  chatConfig?: ChatCellConfig;        // Chat cell (v1.2 Track C)
  upstream?: string;                   // Dataframe handle this cell consumes
  blockBinding?: BlockBinding;         // Present when cell references a .dql block file
  fromSnapshot?: boolean;              // Result was hydrated from .run.json, not executed this session
}

export interface NotebookFile {
  name: string;
  path: string;
  type: 'notebook' | 'workbook' | 'block' | 'dashboard';
  folder: string;
  isNew?: boolean;
}

export interface SchemaColumn {
  name: string;
  type: string;
}

export type GovernanceStatus = 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';

export interface SchemaTable {
  name: string;
  path: string;
  columns: SchemaColumn[];
  expanded?: boolean;
  source?: 'file' | 'database';
  objectType?: string;
  governance?: {
    status?: GovernanceStatus;
    owner?: string;
    domain?: string;
  };
}

export interface SemanticMetric {
  name: string;
  label: string;
  description: string;
  domain: string;
  sql: string;
  type: string;
  table: string;
  tags: string[];
  owner: string | null;
}

export interface SemanticDimension {
  name: string;
  label: string;
  description: string;
  domain?: string;
  sql: string;
  type: string;
  table: string;
  tags: string[];
  owner: string | null;
}

export interface SemanticHierarchy {
  name: string;
  label: string;
  description: string;
  domain?: string;
  levels: Array<{ name: string; label: string }>;
}

export interface SemanticTreeNode {
  id: string;
  label: string;
  kind: 'provider' | 'domain' | 'cube' | 'group' | 'metric' | 'dimension' | 'hierarchy' | 'segment' | 'pre_aggregation';
  count?: number;
  meta?: Record<string, string | number | boolean | null | undefined>;
  children?: SemanticTreeNode[];
}

export interface SemanticObjectDetail {
  id: string;
  kind: 'cube' | 'metric' | 'dimension' | 'hierarchy' | 'segment' | 'pre_aggregation';
  name: string;
  label: string;
  description: string;
  domain: string;
  cube?: string;
  table?: string;
  sql?: string;
  type?: string;
  tags: string[];
  owner: string | null;
  source: {
    provider: string;
    objectType: string;
    objectId: string;
    objectName?: string;
    importedAt?: string;
    extra?: Record<string, unknown>;
  } | null;
  filePath: string | null;
  importedAt: string | null;
  joins?: Array<{ name: string; left: string; right: string; type: string; sql: string }>;
  levels?: Array<{ name: string; label: string; description: string; dimension: string; order: number }>;
  measures?: string[];
  dimensions?: string[];
  timeDimension?: string;
  granularity?: string;
  refreshKey?: string;
}

export interface SemanticLayerState {
  available: boolean;
  provider: string | null;
  metrics: SemanticMetric[];
  dimensions: SemanticDimension[];
  hierarchies: SemanticHierarchy[];
  domains: string[];
  tags: string[];
  favorites: string[];
  recentlyUsed: string[];
  loading: boolean;
  lastSyncTime: string | null;
}

export interface QueryLogEntry {
  id: string;
  cellName: string;
  rows: number;
  time: number;
  ts: Date;
  error?: string;
}

export interface BlockStudioDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
}

export interface BlockStudioValidation {
  valid: boolean;
  diagnostics: BlockStudioDiagnostic[];
  semanticRefs: {
    metrics: string[];
    dimensions: string[];
    segments: string[];
  };
  chartConfig?: CellChartConfig;
  executableSql?: string | null;
}

export interface BlockStudioPreview {
  sql: string;
  result: QueryResult;
  chartConfig?: CellChartConfig;
}

export interface BlockStudioMetadata {
  name: string;
  path: string | null;
  domain: string;
  description: string;
  owner: string;
  tags: string[];
  reviewStatus?: string;
}

export interface DatabaseSchemaNode {
  id: string;
  label: string;
  kind: 'schema' | 'table' | 'column';
  path?: string;
  type?: string;
  children?: DatabaseSchemaNode[];
}

export interface BlockStudioCatalog {
  semanticTree: SemanticTreeNode | null;
  databaseTree: DatabaseSchemaNode[];
  connection: {
    default: string;
    current: string;
    connections: Record<string, unknown>;
  };
  favorites: string[];
  recentlyUsed: string[];
}

export interface BlockStudioOpenPayload {
  path: string;
  source: string;
  metadata: BlockStudioMetadata;
  companionPath: string | null;
  validation: BlockStudioValidation;
}

export interface NotebookState {
  mainView: MainView;
  themeMode: ThemeMode;
  appMode: AppMode;
  sidebarPanel: SidebarPanel;
  sidebarOpen: boolean;
  files: NotebookFile[];
  filesLoading: boolean;
  activeFile: NotebookFile | null;
  cells: Cell[];
  notebookTitle: string;
  notebookMetadata: NotebookDocMetadata;
  notebookDirty: boolean;
  schemaTables: SchemaTable[];
  schemaLoading: boolean;
  semanticLayer: SemanticLayerState;
  devPanelOpen: boolean;
  devPanelTab: DevPanelTab;
  queryLog: QueryLogEntry[];
  newNotebookModalOpen: boolean;
  newBlockModalOpen: boolean;
  autoSave: boolean;
  executionCounter: number;
  savingFile: boolean;
  lineageFullscreen: boolean;
  lineageFocusNodeId: string | null;
  lineageDrawerOpen: boolean;
  lineageDrawerNodeId: string | null;
  dashboardMode: boolean;
  activeBlockPath: string | null;
  blockStudioDraft: string;
  blockStudioDirty: boolean;
  blockStudioPreview: BlockStudioPreview | null;
  blockStudioValidation: BlockStudioValidation | null;
  blockStudioMetadata: BlockStudioMetadata | null;
  blockStudioCatalog: BlockStudioCatalog | null;
  blockStudioCatalogLoading: boolean;
  inspectorOpen: boolean;
  inspectorContext: InspectorContext | null;
  // Apps surface (Phase 1)
  apps: AppSummary[];
  appsLoading: boolean;
  activeAppId: string | null;
  activeDashboardId: string | null;
  activePersona: ActivePersona | null;
}

export type InspectorContext =
  | { kind: 'cell'; cellId: string }
  | { kind: 'lineage-node'; nodeId: string }
  | { kind: 'metric'; name: string };

export type NotebookAction =
  | { type: 'SET_MAIN_VIEW'; view: MainView }
  | { type: 'SET_THEME'; mode: ThemeMode }
  | { type: 'SET_APP_MODE'; mode: AppMode }
  | { type: 'SET_SIDEBAR_PANEL'; panel: SidebarPanel }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_FILES'; files: NotebookFile[] }
  | { type: 'SET_FILES_LOADING'; loading: boolean }
  | { type: 'OPEN_FILE'; file: NotebookFile; cells: Cell[]; title: string; metadata?: NotebookDocMetadata }
  | { type: 'UPDATE_NOTEBOOK_METADATA'; updates: Partial<NotebookDocMetadata> }
  | { type: 'SET_CELLS'; cells: Cell[] }
  | { type: 'ADD_CELL'; cell: Cell; afterId?: string }
  | { type: 'UPDATE_CELL'; id: string; updates: Partial<Cell> }
  | { type: 'DELETE_CELL'; id: string }
  | { type: 'MOVE_CELL'; id: string; direction: 'up' | 'down' }
  | { type: 'SET_SCHEMA'; tables: SchemaTable[] }
  | { type: 'SET_SCHEMA_LOADING'; loading: boolean }
  | { type: 'TOGGLE_SCHEMA_TABLE'; tableName: string }
  | { type: 'TOGGLE_DEV_PANEL' }
  | { type: 'SET_DEV_PANEL_TAB'; tab: DevPanelTab }
  | { type: 'APPEND_QUERY_LOG'; entry: QueryLogEntry }
  | { type: 'OPEN_NEW_NOTEBOOK_MODAL' }
  | { type: 'CLOSE_NEW_NOTEBOOK_MODAL' }
  | { type: 'OPEN_NEW_BLOCK_MODAL' }
  | { type: 'CLOSE_NEW_BLOCK_MODAL' }
  | { type: 'SET_AUTO_SAVE'; enabled: boolean }
  | { type: 'SET_NOTEBOOK_DIRTY'; dirty: boolean }
  | { type: 'SET_SAVING'; saving: boolean }
  | { type: 'FILE_ADDED'; file: NotebookFile }
  | { type: 'SET_TABLE_COLUMNS'; tableName: string; columns: SchemaColumn[] }
  | { type: 'SET_PARAM_VALUE'; id: string; value: string }
  | { type: 'SET_SEMANTIC_LAYER'; layer: Omit<SemanticLayerState, 'loading'> }
  | { type: 'SET_SEMANTIC_LOADING'; loading: boolean }
  | { type: 'SET_SEMANTIC_FAVORITES'; favorites: string[] }
  | { type: 'ADD_SEMANTIC_RECENT'; name: string }
  | { type: 'SET_SEMANTIC_DOMAINS'; domains: string[]; tags: string[]; lastSyncTime?: string | null }
  | { type: 'TOGGLE_LINEAGE_FULLSCREEN' }
  | { type: 'SET_LINEAGE_FOCUS'; nodeId: string | null }
  | { type: 'OPEN_LINEAGE_DRAWER'; nodeId: string }
  | { type: 'CLOSE_LINEAGE_DRAWER' }
  | { type: 'REORDER_CELL'; fromIndex: number; toIndex: number }
  | { type: 'TOGGLE_DASHBOARD_MODE' }
  | { type: 'OPEN_BLOCK_STUDIO'; file: NotebookFile; payload: BlockStudioOpenPayload }
  | { type: 'SET_BLOCK_STUDIO_DRAFT'; draft: string }
  | { type: 'SET_BLOCK_STUDIO_DIRTY'; dirty: boolean }
  | { type: 'SET_BLOCK_STUDIO_PREVIEW'; preview: BlockStudioPreview | null }
  | { type: 'SET_BLOCK_STUDIO_VALIDATION'; validation: BlockStudioValidation | null }
  | { type: 'SET_BLOCK_STUDIO_METADATA'; metadata: BlockStudioMetadata }
  | { type: 'SET_BLOCK_STUDIO_CATALOG'; catalog: BlockStudioCatalog | null }
  | { type: 'SET_BLOCK_STUDIO_CATALOG_LOADING'; loading: boolean }
  | { type: 'TOGGLE_INSPECTOR' }
  | { type: 'SET_INSPECTOR'; open: boolean; context?: InspectorContext | null }
  | { type: 'SET_INSPECTOR_CONTEXT'; context: InspectorContext | null }
  // Apps surface (Phase 1)
  | { type: 'SET_APPS'; apps: AppSummary[] }
  | { type: 'SET_APPS_LOADING'; loading: boolean }
  | { type: 'OPEN_APP'; appId: string; dashboardId?: string | null }
  | { type: 'OPEN_DASHBOARD'; dashboardId: string }
  | { type: 'SET_ACTIVE_PERSONA'; persona: ActivePersona | null };
