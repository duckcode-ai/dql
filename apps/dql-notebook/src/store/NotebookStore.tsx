/**
 * Notebook store — Zustand-backed, API-compatible with the previous reducer.
 *
 * Migration strategy
 * - Internal: Zustand store holds state + a `dispatch(action)` method that
 *   runs the original pure reducer. This keeps every existing
 *   `dispatch({...})` call site working unchanged.
 * - External: `useNotebook()` still returns `{ state, dispatch }`. Existing
 *   38 consumers stay put.
 * - New perf win: `useNotebookStore(selector)` subscribes to a slice with
 *   shallow equality — use this for hot paths (lineage, schema tree,
 *   semantic tree). Replaces unnecessary re-renders from full Context changes.
 * - Convenience hooks (`useCells`, `useFiles`, `useSemantic`, `useActiveFile`,
 *   `useInspector`) cover the common slicing patterns.
 */
import React, { createContext, useContext, type ReactNode } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { NotebookState, NotebookAction, Cell } from './types';

// Persisted shell preference — defaults to 'studio' so the full authoring
// surface shows on first load. Reading localStorage synchronously so the
// initial render doesn't flash the wrong mode.
function readInitialAppMode(): 'studio' | 'app' {
  if (typeof window === 'undefined') return 'studio';
  const stored = window.localStorage?.getItem('dql-app-mode');
  return stored === 'app' ? 'app' : 'studio';
}

// Hex-handoff default: paper (warm off-white). Honors persisted choice.
function readInitialThemeMode(): 'obsidian' | 'paper' | 'white' {
  if (typeof window === 'undefined') return 'paper';
  const stored = window.localStorage?.getItem('dql-theme');
  if (stored === 'obsidian' || stored === 'paper' || stored === 'white') return stored;
  if (stored === 'midnight' || stored === 'dark') return 'obsidian';
  if (stored === 'arctic') return 'white';
  if (stored === 'light') return 'paper';
  return 'paper';
}

const initialState: NotebookState = {
  mainView: 'notebook',
  themeMode: readInitialThemeMode(),
  appMode: readInitialAppMode(),
  sidebarPanel: 'files',
  sidebarOpen: true,
  files: [],
  filesLoading: false,
  activeFile: null,
  cells: [],
  notebookTitle: '',
  notebookMetadata: {},
  notebookDirty: false,
  schemaTables: [],
  schemaLoading: false,
  semanticLayer: {
    available: false,
    provider: null,
    metrics: [],
    dimensions: [],
    hierarchies: [],
    domains: [],
    tags: [],
    favorites: [],
    recentlyUsed: [],
    loading: false,
    lastSyncTime: null,
  },
  devPanelOpen: false,
  devPanelTab: 'logs',
  queryLog: [],
  newNotebookModalOpen: false,
  newBlockModalOpen: false,
  autoSave: false,
  executionCounter: 0,
  savingFile: false,
  lineageFullscreen: false,
  lineageFocusNodeId: null,
  lineageDrawerOpen: false,
  lineageDrawerNodeId: null,
  dashboardMode: false,
  activeBlockPath: null,
  blockStudioDraft: '',
  blockStudioDirty: false,
  blockStudioPreview: null,
  blockStudioValidation: null,
  blockStudioMetadata: null,
  blockStudioCatalog: null,
  blockStudioCatalogLoading: false,
  inspectorOpen: false,
  inspectorContext: null,
  apps: [],
  appsLoading: false,
  activeAppId: null,
  activeDashboardId: null,
  activePersona: null,
};

/**
 * Pure reducer — identical semantics to the previous useReducer version.
 * Kept as a free function so the action surface stays declarative and the
 * store definition below is tiny.
 */
function notebookReducer(state: NotebookState, action: NotebookAction): NotebookState {
  switch (action.type) {
    case 'SET_MAIN_VIEW':
      return { ...state, mainView: action.view, lineageFullscreen: false, lineageFocusNodeId: null };

    case 'SET_THEME': {
      // Sync the data-theme attribute BEFORE React re-renders. Inline-style
      // reads like `t.activityBarBg` resolve the Luna CSS var at render time;
      // if we wait for a post-render useEffect to flip data-theme, children
      // paint one frame of stale colors (v1.3 Track 9 — four-theme switch).
      if (typeof document !== 'undefined') {
        const luna =
          action.mode === 'dark' || action.mode === 'midnight' ? 'obsidian'
          : action.mode === 'light' ? 'paper'
          : action.mode === 'arctic' ? 'white'
          : action.mode;
        document.documentElement.setAttribute('data-theme', luna);
        try {
          window.localStorage?.setItem('dql-theme', action.mode);
        } catch {
          // ignore quota / privacy-mode failures
        }
      }
      return { ...state, themeMode: action.mode };
    }

    case 'SET_APP_MODE': {
      if (typeof window !== 'undefined') {
        try {
          window.localStorage?.setItem('dql-app-mode', action.mode);
        } catch {
          // ignore quota / privacy-mode failures — it's a preference
        }
      }
      return { ...state, appMode: action.mode };
    }

    case 'SET_SIDEBAR_PANEL': {
      const fullPagePanels = ['connection', 'reference', 'git', 'apps'] as const;
      const isFullPage = (action.panel as string | null) !== null
        && (fullPagePanels as readonly string[]).includes(action.panel as string);
      return {
        ...state,
        sidebarPanel: action.panel,
        sidebarOpen: action.panel !== null && !isFullPage,
        lineageFullscreen: false,
        lineageFocusNodeId: null,
        mainView:
          action.panel === 'connection'
            ? 'connection'
            : action.panel === 'reference'
              ? 'reference'
              : action.panel === 'git'
                ? 'git'
                : action.panel === 'apps'
                  ? 'apps'
                  : state.activeFile?.type === 'block'
                    ? 'block_studio'
                    : 'notebook',
      };
    }

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen };

    case 'SET_FILES':
      return { ...state, files: action.files };

    case 'SET_FILES_LOADING':
      return { ...state, filesLoading: action.loading };

    case 'OPEN_FILE':
      return {
        ...state,
        activeFile: action.file,
        cells: action.cells,
        notebookTitle: action.title,
        notebookMetadata: action.metadata ?? {},
        notebookDirty: false,
        mainView: action.file.type === 'block' ? 'block_studio' : 'notebook',
        activeBlockPath: action.file.type === 'block' ? action.file.path : null,
        blockStudioDraft: action.file.type === 'block' ? state.blockStudioDraft : '',
        blockStudioDirty: false,
        blockStudioPreview: action.file.type === 'block' ? state.blockStudioPreview : null,
        blockStudioValidation: action.file.type === 'block' ? state.blockStudioValidation : null,
        blockStudioMetadata: action.file.type === 'block' ? state.blockStudioMetadata : null,
        lineageFullscreen: false,
        lineageFocusNodeId: null,
      };

    case 'OPEN_BLOCK_STUDIO':
      return {
        ...state,
        activeFile: action.file,
        cells: [],
        notebookTitle: action.payload.metadata.name,
        notebookDirty: false,
        mainView: 'block_studio',
        dashboardMode: false,
        activeBlockPath: action.payload.path,
        blockStudioDraft: action.payload.source,
        blockStudioDirty: false,
        blockStudioPreview: null,
        blockStudioValidation: action.payload.validation,
        blockStudioMetadata: action.payload.metadata,
        lineageFullscreen: false,
        lineageFocusNodeId: action.payload.metadata?.name ? `block:${action.payload.metadata.name}` : null,
      };

    case 'SET_CELLS':
      return { ...state, cells: action.cells, notebookDirty: true };

    case 'UPDATE_NOTEBOOK_METADATA': {
      const current = state.notebookMetadata;
      let changed = false;
      for (const key of Object.keys(action.updates) as Array<keyof typeof action.updates>) {
        if (current[key] !== action.updates[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return state;
      return {
        ...state,
        notebookMetadata: { ...current, ...action.updates },
        notebookDirty: true,
      };
    }

    case 'ADD_CELL': {
      if (!action.afterId) {
        return { ...state, cells: [...state.cells, action.cell], notebookDirty: true };
      }
      const idx = state.cells.findIndex((c) => c.id === action.afterId);
      if (idx === -1) {
        return { ...state, cells: [...state.cells, action.cell], notebookDirty: true };
      }
      const newCells = [...state.cells];
      newCells.splice(idx + 1, 0, action.cell);
      return { ...state, cells: newCells, notebookDirty: true };
    }

    case 'UPDATE_CELL': {
      const cells = state.cells.map((c) =>
        c.id === action.id ? { ...c, ...action.updates } : c
      );
      const executionCounter =
        action.updates.executionCount !== undefined
          ? state.executionCounter + 1
          : state.executionCounter;
      return { ...state, cells, notebookDirty: true, executionCounter };
    }

    case 'DELETE_CELL':
      return {
        ...state,
        cells: state.cells.filter((c) => c.id !== action.id),
        notebookDirty: true,
      };

    case 'MOVE_CELL': {
      const idx = state.cells.findIndex((c) => c.id === action.id);
      if (idx === -1) return state;
      const newCells = [...state.cells];
      if (action.direction === 'up' && idx > 0) {
        [newCells[idx - 1], newCells[idx]] = [newCells[idx], newCells[idx - 1]];
      } else if (action.direction === 'down' && idx < newCells.length - 1) {
        [newCells[idx], newCells[idx + 1]] = [newCells[idx + 1], newCells[idx]];
      }
      return { ...state, cells: newCells, notebookDirty: true };
    }

    case 'REORDER_CELL': {
      const { fromIndex, toIndex } = action;
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= state.cells.length || toIndex >= state.cells.length) return state;
      const newCells = [...state.cells];
      const [moved] = newCells.splice(fromIndex, 1);
      newCells.splice(toIndex, 0, moved);
      return { ...state, cells: newCells, notebookDirty: true };
    }

    case 'SET_SCHEMA':
      return { ...state, schemaTables: action.tables };

    case 'SET_SCHEMA_LOADING':
      return { ...state, schemaLoading: action.loading };

    case 'TOGGLE_SCHEMA_TABLE':
      return {
        ...state,
        schemaTables: state.schemaTables.map((t) =>
          t.name === action.tableName ? { ...t, expanded: !t.expanded } : t
        ),
      };

    case 'TOGGLE_DEV_PANEL':
      return { ...state, devPanelOpen: !state.devPanelOpen };

    case 'SET_DEV_PANEL_TAB':
      return { ...state, devPanelTab: action.tab };

    case 'APPEND_QUERY_LOG':
      return { ...state, queryLog: [...state.queryLog, action.entry] };

    case 'OPEN_NEW_NOTEBOOK_MODAL':
      return { ...state, newNotebookModalOpen: true };

    case 'CLOSE_NEW_NOTEBOOK_MODAL':
      return { ...state, newNotebookModalOpen: false };

    case 'OPEN_NEW_BLOCK_MODAL':
      return { ...state, newBlockModalOpen: true };

    case 'CLOSE_NEW_BLOCK_MODAL':
      return { ...state, newBlockModalOpen: false };

    case 'SET_AUTO_SAVE':
      return { ...state, autoSave: action.enabled };

    case 'SET_NOTEBOOK_DIRTY':
      return { ...state, notebookDirty: action.dirty };

    case 'SET_SAVING':
      return { ...state, savingFile: action.saving };

    case 'FILE_ADDED':
      return { ...state, files: [...state.files, action.file] };

    case 'SET_TABLE_COLUMNS':
      return {
        ...state,
        schemaTables: state.schemaTables.map((t) =>
          t.name === action.tableName ? { ...t, columns: action.columns } : t
        ),
      };

    case 'SET_PARAM_VALUE':
      return {
        ...state,
        cells: state.cells.map((c) =>
          c.id === action.id ? { ...c, paramValue: action.value } : c
        ),
        notebookDirty: true,
      };

    case 'SET_SEMANTIC_LAYER':
      return {
        ...state,
        semanticLayer: { ...action.layer, loading: false },
      };

    case 'SET_SEMANTIC_LOADING':
      return {
        ...state,
        semanticLayer: { ...state.semanticLayer, loading: action.loading },
      };

    case 'SET_SEMANTIC_FAVORITES':
      return {
        ...state,
        semanticLayer: { ...state.semanticLayer, favorites: action.favorites },
      };

    case 'ADD_SEMANTIC_RECENT': {
      const nextRecent = [action.name, ...state.semanticLayer.recentlyUsed.filter((item) => item !== action.name)].slice(0, 12);
      return {
        ...state,
        semanticLayer: { ...state.semanticLayer, recentlyUsed: nextRecent },
      };
    }

    case 'SET_SEMANTIC_DOMAINS':
      return {
        ...state,
        semanticLayer: {
          ...state.semanticLayer,
          domains: action.domains,
          tags: action.tags,
          lastSyncTime: action.lastSyncTime ?? state.semanticLayer.lastSyncTime,
        },
      };

    case 'TOGGLE_LINEAGE_FULLSCREEN':
      return { ...state, lineageFullscreen: !state.lineageFullscreen };

    case 'SET_LINEAGE_FOCUS':
      return { ...state, lineageFocusNodeId: action.nodeId };

    case 'OPEN_LINEAGE_DRAWER':
      return { ...state, lineageDrawerOpen: true, lineageDrawerNodeId: action.nodeId };

    case 'CLOSE_LINEAGE_DRAWER':
      return { ...state, lineageDrawerOpen: false, lineageDrawerNodeId: null };

    case 'TOGGLE_DASHBOARD_MODE':
      return { ...state, dashboardMode: !state.dashboardMode };

    case 'SET_BLOCK_STUDIO_DRAFT':
      return { ...state, blockStudioDraft: action.draft, blockStudioDirty: true };

    case 'SET_BLOCK_STUDIO_DIRTY':
      return { ...state, blockStudioDirty: action.dirty };

    case 'SET_BLOCK_STUDIO_PREVIEW':
      return { ...state, blockStudioPreview: action.preview };

    case 'SET_BLOCK_STUDIO_VALIDATION':
      return { ...state, blockStudioValidation: action.validation };

    case 'SET_BLOCK_STUDIO_METADATA':
      return {
        ...state,
        blockStudioMetadata: action.metadata,
        notebookTitle: action.metadata.name,
        blockStudioDirty: true,
      };

    case 'SET_BLOCK_STUDIO_CATALOG':
      return { ...state, blockStudioCatalog: action.catalog };

    case 'SET_BLOCK_STUDIO_CATALOG_LOADING':
      return { ...state, blockStudioCatalogLoading: action.loading };

    case 'TOGGLE_INSPECTOR':
      return { ...state, inspectorOpen: !state.inspectorOpen };

    case 'SET_INSPECTOR':
      return {
        ...state,
        inspectorOpen: action.open,
        inspectorContext: action.context === undefined ? state.inspectorContext : action.context,
      };

    case 'SET_INSPECTOR_CONTEXT':
      return {
        ...state,
        inspectorContext: action.context,
        inspectorOpen: action.context !== null ? true : state.inspectorOpen,
      };

    case 'SET_APPS':
      return { ...state, apps: action.apps };

    case 'SET_APPS_LOADING':
      return { ...state, appsLoading: action.loading };

    case 'OPEN_APP': {
      const app = state.apps.find((a) => a.id === action.appId) ?? null;
      const dashboardId = action.dashboardId !== undefined
        ? action.dashboardId
        : (app?.homepage?.type === 'dashboard' ? app.homepage.id : (app?.dashboards[0]?.id ?? null));
      return {
        ...state,
        mainView: 'apps',
        activeAppId: action.appId,
        activeDashboardId: dashboardId,
      };
    }

    case 'OPEN_DASHBOARD':
      return { ...state, activeDashboardId: action.dashboardId };

    case 'SET_ACTIVE_PERSONA':
      return { ...state, activePersona: action.persona };

    default:
      return state;
  }
}

/** Zustand store shape: flat state + a single dispatch(action) method. */
interface StoreShape extends NotebookState {
  dispatch: (action: NotebookAction) => void;
}

/**
 * The singleton store. Exported for tests and rare cross-component access
 * (e.g. event handlers outside React). Components should prefer the hooks
 * below so subscriptions are tracked.
 */
export const useNotebookStore: UseBoundStore<StoreApi<StoreShape>> = create<StoreShape>((set, get) => ({
  ...initialState,
  dispatch: (action: NotebookAction) => {
    const next = notebookReducer(get(), action);
    // Drop the dispatch fn from the reducer's returned state — reducer only
    // sees NotebookState, so we preserve dispatch ourselves.
    set(next);
  },
}));

/** Direct store handle (non-reactive). Use sparingly. */
export const notebookStoreApi = useNotebookStore;

// --- compat layer ---------------------------------------------------------

interface NotebookContextValue {
  state: NotebookState;
  dispatch: React.Dispatch<NotebookAction>;
}

/**
 * Compatibility context — retained only so tests that wrapped with a custom
 * Provider still work. Production code bypasses this and reads from the
 * Zustand store directly via `useNotebook()`.
 */
const NotebookContext = createContext<NotebookContextValue | null>(null);

export function NotebookProvider({ children }: { children: ReactNode }) {
  // Cross-tab theme sync: if a sibling tab changes `dql-theme`, mirror it here.
  React.useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'dql-theme' || !e.newValue) return;
      const mode = e.newValue;
      if (mode === 'obsidian' || mode === 'paper' || mode === 'white' || mode === 'midnight' || mode === 'arctic' || mode === 'dark' || mode === 'light') {
        useNotebookStore.getState().dispatch({ type: 'SET_THEME', mode: mode as any });
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  return <>{children}</>;
}

/**
 * Compat hook with the same `{ state, dispatch }` shape as the old reducer
 * version. Every existing consumer keeps working unchanged. Re-renders on
 * *any* state change — for fine-grained subscriptions, use the slice hooks
 * below or call `useNotebookStore(selector)` directly.
 */
export function useNotebook(): NotebookContextValue {
  // Pull the whole state (minus dispatch) as one snapshot. useShallow keeps
  // this from triggering a re-render when unrelated refs change identity
  // via a new object literal — but any field mutation still re-renders,
  // preserving the old behavior for consumers that read arbitrary fields.
  const state = useNotebookStore(
    useShallow((s) => {
      const { dispatch: _d, ...rest } = s;
      return rest as NotebookState;
    }),
  );
  const dispatch = useNotebookStore((s) => s.dispatch);
  // Honor a test-supplied context if present.
  const ctx = useContext(NotebookContext);
  return ctx ?? { state, dispatch };
}

// --- slice hooks (use these for new or refactored components) ------------

/** Files + loading + active file */
export function useFiles() {
  return useNotebookStore(
    useShallow((s) => ({
      files: s.files,
      filesLoading: s.filesLoading,
      activeFile: s.activeFile,
      notebookTitle: s.notebookTitle,
      notebookDirty: s.notebookDirty,
      savingFile: s.savingFile,
    })),
  );
}

/** Just the cells array + execution counter (notebook body) */
export function useCells() {
  return useNotebookStore(
    useShallow((s) => ({
      cells: s.cells,
      executionCounter: s.executionCounter,
    })),
  );
}

/** Semantic layer slice */
export function useSemantic() {
  return useNotebookStore((s) => s.semanticLayer);
}

/** Schema panel slice */
export function useSchema() {
  return useNotebookStore(
    useShallow((s) => ({
      schemaTables: s.schemaTables,
      schemaLoading: s.schemaLoading,
    })),
  );
}

/** Inspector / shell slice (sidebar, main view, panels, modals, lineage focus) */
export function useInspector() {
  return useNotebookStore(
    useShallow((s) => ({
      mainView: s.mainView,
      sidebarPanel: s.sidebarPanel,
      sidebarOpen: s.sidebarOpen,
      themeMode: s.themeMode,
      lineageFullscreen: s.lineageFullscreen,
      lineageFocusNodeId: s.lineageFocusNodeId,
      dashboardMode: s.dashboardMode,
    })),
  );
}

/** Get the dispatch function without subscribing to any state */
export function useDispatch(): React.Dispatch<NotebookAction> {
  return useNotebookStore((s) => s.dispatch);
}

// --- helpers (unchanged) -------------------------------------------------

export function makeCellId(): string {
  return `cell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeCell(type: Cell['type'], content = ''): Cell {
  const base: Cell = {
    id: makeCellId(),
    type,
    content,
    status: 'idle',
  };
  if (type === 'param') {
    base.content = '';
    base.paramConfig = {
      paramType: 'text',
      label: 'Parameter',
      defaultValue: '',
      options: [],
    };
  }
  if (type === 'chart') {
    base.chartConfig = { chart: 'bar' };
  }
  if (type === 'filter') {
    base.filterConfig = {
      mode: 'keep',
      groups: [{ id: `g_${Math.random().toString(36).slice(2, 8)}`, combinator: 'and', rules: [] }],
    };
  }
  if (type === 'pivot') {
    base.pivotConfig = { rows: [], columns: [], values: [] };
  }
  if (type === 'single_value') {
    base.singleValueConfig = { aggregation: 'count', format: 'number' };
  }
  if (type === 'table') {
    base.tableConfig = {};
  }
  if (type === 'chat') {
    base.chatConfig = { provider: 'claude-agent-sdk', history: [] };
  }
  return base;
}
