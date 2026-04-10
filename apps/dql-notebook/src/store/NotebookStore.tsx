import React, { createContext, useContext, useReducer, type ReactNode } from 'react';
import type { NotebookState, NotebookAction, Cell } from './types';

const initialState: NotebookState = {
  mainView: 'notebook',
  themeMode: 'dark',
  sidebarPanel: 'files',
  sidebarOpen: true,
  files: [],
  filesLoading: false,
  activeFile: null,
  cells: [],
  notebookTitle: '',
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
  dashboardMode: false,
  activeBlockPath: null,
  blockStudioDraft: '',
  blockStudioDirty: false,
  blockStudioPreview: null,
  blockStudioValidation: null,
  blockStudioMetadata: null,
  blockStudioCatalog: null,
  blockStudioCatalogLoading: false,
};

function notebookReducer(state: NotebookState, action: NotebookAction): NotebookState {
  switch (action.type) {
    case 'SET_MAIN_VIEW':
      return { ...state, mainView: action.view };

    case 'SET_THEME':
      return { ...state, themeMode: action.mode };

    case 'SET_SIDEBAR_PANEL':
      return { ...state, sidebarPanel: action.panel, sidebarOpen: action.panel !== null };

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
        notebookDirty: false,
        mainView: action.file.type === 'block' ? 'block_studio' : 'notebook',
        activeBlockPath: action.file.type === 'block' ? action.file.path : null,
        blockStudioDraft: action.file.type === 'block' ? state.blockStudioDraft : '',
        blockStudioDirty: false,
        blockStudioPreview: action.file.type === 'block' ? state.blockStudioPreview : null,
        blockStudioValidation: action.file.type === 'block' ? state.blockStudioValidation : null,
        blockStudioMetadata: action.file.type === 'block' ? state.blockStudioMetadata : null,
      };

    case 'OPEN_BLOCK_STUDIO':
      return {
        ...state,
        activeFile: action.file,
        cells: [],
        notebookTitle: action.payload.metadata.name,
        notebookDirty: false,
        mainView: 'block_studio',
        sidebarOpen: false,
        dashboardMode: false,
        activeBlockPath: action.payload.path,
        blockStudioDraft: action.payload.source,
        blockStudioDirty: false,
        blockStudioPreview: null,
        blockStudioValidation: action.payload.validation,
        blockStudioMetadata: action.payload.metadata,
      };

    case 'SET_CELLS':
      return { ...state, cells: action.cells, notebookDirty: true };

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
      // Increment executionCounter when a cell completes
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

    default:
      return state;
  }
}

interface NotebookContextValue {
  state: NotebookState;
  dispatch: React.Dispatch<NotebookAction>;
}

const NotebookContext = createContext<NotebookContextValue | null>(null);

export function NotebookProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(notebookReducer, initialState);
  return (
    <NotebookContext.Provider value={{ state, dispatch }}>
      {children}
    </NotebookContext.Provider>
  );
}

export function useNotebook(): NotebookContextValue {
  const ctx = useContext(NotebookContext);
  if (!ctx) throw new Error('useNotebook must be used within NotebookProvider');
  return ctx;
}

// Helper to generate a unique cell ID
export function makeCellId(): string {
  return `cell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Helper to create a blank cell
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
  return base;
}
