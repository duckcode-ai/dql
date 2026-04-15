export type ThemeMode = 'dark' | 'light';
export type CellType = 'sql' | 'markdown' | 'dql' | 'param';
export type CellStatus = 'idle' | 'running' | 'success' | 'error';

export interface CellChartConfig {
  chart?: string;   // bar | line | area | pie | donut | scatter | heatmap | funnel | waterfall | histogram | gauge | stacked-bar | grouped-bar | kpi | table
  x?: string;       // X-axis column
  y?: string;       // Y-axis column
  color?: string;   // Color-by column
  title?: string;
  xLabel?: string;
  yLabel?: string;
  legendPosition?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  colorPalette?: 'default' | 'warm' | 'cool' | 'mono' | 'pastel';
  maxItems?: number;
}

export type ParamType = 'text' | 'select' | 'date' | 'number';

export interface ParamConfig {
  paramType: ParamType;
  label: string;
  defaultValue: string;
  options?: string[];
}
export type SidebarPanel = 'files' | 'schema' | 'block_library' | 'connection' | 'reference' | 'semantic' | 'lineage' | null;
export type DevPanelTab = 'logs' | 'errors';
export type MainView = 'notebook' | 'block_studio' | 'connection' | 'reference';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  executionTime?: number;
  rowCount?: number;
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
  chartConfig?: CellChartConfig;  // Explicit chart config from DQL visualization block
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
  sidebarPanel: SidebarPanel;
  sidebarOpen: boolean;
  files: NotebookFile[];
  filesLoading: boolean;
  activeFile: NotebookFile | null;
  cells: Cell[];
  notebookTitle: string;
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
  dashboardMode: boolean;
  activeBlockPath: string | null;
  blockStudioDraft: string;
  blockStudioDirty: boolean;
  blockStudioPreview: BlockStudioPreview | null;
  blockStudioValidation: BlockStudioValidation | null;
  blockStudioMetadata: BlockStudioMetadata | null;
  blockStudioCatalog: BlockStudioCatalog | null;
  blockStudioCatalogLoading: boolean;
}

export type NotebookAction =
  | { type: 'SET_MAIN_VIEW'; view: MainView }
  | { type: 'SET_THEME'; mode: ThemeMode }
  | { type: 'SET_SIDEBAR_PANEL'; panel: SidebarPanel }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_FILES'; files: NotebookFile[] }
  | { type: 'SET_FILES_LOADING'; loading: boolean }
  | { type: 'OPEN_FILE'; file: NotebookFile; cells: Cell[]; title: string }
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
  | { type: 'REORDER_CELL'; fromIndex: number; toIndex: number }
  | { type: 'TOGGLE_DASHBOARD_MODE' }
  | { type: 'OPEN_BLOCK_STUDIO'; file: NotebookFile; payload: BlockStudioOpenPayload }
  | { type: 'SET_BLOCK_STUDIO_DRAFT'; draft: string }
  | { type: 'SET_BLOCK_STUDIO_DIRTY'; dirty: boolean }
  | { type: 'SET_BLOCK_STUDIO_PREVIEW'; preview: BlockStudioPreview | null }
  | { type: 'SET_BLOCK_STUDIO_VALIDATION'; validation: BlockStudioValidation | null }
  | { type: 'SET_BLOCK_STUDIO_METADATA'; metadata: BlockStudioMetadata }
  | { type: 'SET_BLOCK_STUDIO_CATALOG'; catalog: BlockStudioCatalog | null }
  | { type: 'SET_BLOCK_STUDIO_CATALOG_LOADING'; loading: boolean };
