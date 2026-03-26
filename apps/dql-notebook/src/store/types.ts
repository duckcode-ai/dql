export type ThemeMode = 'dark' | 'light';
export type CellType = 'sql' | 'markdown' | 'dql' | 'param';
export type CellStatus = 'idle' | 'running' | 'success' | 'error';

export interface CellChartConfig {
  chart?: string;   // bar | line | area | pie | donut | scatter | heatmap | funnel | waterfall | histogram | gauge | stacked-bar | grouped-bar | kpi | table
  x?: string;       // X-axis column
  y?: string;       // Y-axis column
  color?: string;   // Color-by column
  title?: string;
}

export type ParamType = 'text' | 'select' | 'date' | 'number';

export interface ParamConfig {
  paramType: ParamType;
  label: string;
  defaultValue: string;
  options?: string[];
}
export type SidebarPanel = 'files' | 'schema' | 'outline' | 'connection' | 'reference' | 'semantic' | 'lineage' | null;
export type DevPanelTab = 'logs' | 'errors';

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
  type: string;
  table: string;
  tags: string[];
  owner: string | null;
}

export interface SemanticDimension {
  name: string;
  label: string;
  description: string;
  type: string;
  table: string;
  tags: string[];
}

export interface SemanticHierarchy {
  name: string;
  label: string;
  description: string;
  domain?: string;
  levels: Array<{ name: string; label: string }>;
}

export interface SemanticLayerState {
  available: boolean;
  provider: string | null;
  metrics: SemanticMetric[];
  dimensions: SemanticDimension[];
  hierarchies: SemanticHierarchy[];
  loading: boolean;
}

export interface QueryLogEntry {
  id: string;
  cellName: string;
  rows: number;
  time: number;
  ts: Date;
  error?: string;
}

export interface NotebookState {
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
  dashboardMode: boolean;
}

export type NotebookAction =
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
  | { type: 'TOGGLE_LINEAGE_FULLSCREEN' }
  | { type: 'REORDER_CELL'; fromIndex: number; toIndex: number }
  | { type: 'TOGGLE_DASHBOARD_MODE' };
