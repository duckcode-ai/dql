import React, { createContext, useContext, useReducer, type ReactNode } from 'react';
import type { NotebookState, NotebookAction, Cell } from './types';

const initialState: NotebookState = {
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
  devPanelOpen: false,
  devPanelTab: 'logs',
  queryLog: [],
  newNotebookModalOpen: false,
  executionCounter: 0,
  savingFile: false,
};

function notebookReducer(state: NotebookState, action: NotebookAction): NotebookState {
  switch (action.type) {
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

    case 'SET_NOTEBOOK_DIRTY':
      return { ...state, notebookDirty: action.dirty };

    case 'SET_SAVING':
      return { ...state, savingFile: action.saving };

    case 'FILE_ADDED':
      return { ...state, files: [...state.files, action.file] };

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
  return {
    id: makeCellId(),
    type,
    content,
    status: 'idle',
  };
}
