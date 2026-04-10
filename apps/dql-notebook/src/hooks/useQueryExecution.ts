import { useCallback, useRef } from 'react';
import { useNotebook, makeCellId } from '../store/NotebookStore';
import { api } from '../api/client';
import { useVariableSubstitution } from './useVariableSubstitution';
import type { Cell } from '../store/types';
import { extractSqlFromText, parseDqlChartConfig } from '../utils/block-studio';

// Global map of running AbortControllers keyed by cellId
const runningControllers = new Map<string, AbortController>();

/**
 * Extract executable SQL from a cell.
 * - sql cells: use content directly
 * - dql cells: extract the SQL inside query = """...""", or plain SQL keywords
 * - markdown/param cells: return null (not executable)
 */
function extractSql(cell: Cell): string | null {
  if (cell.type === 'markdown' || cell.type === 'param') return null;
  if (cell.type === 'sql') return cell.content.trim() || null;

  const dqlContent = cell.content.trim();
  if (!dqlContent) return null;

  return extractSqlFromText(dqlContent);
}

export function useQueryExecution() {
  const { state, dispatch } = useNotebook();
  const { substituteVariables } = useVariableSubstitution();

  const executeCell = useCallback(
    async (cellId: string) => {
      const cell = state.cells.find((c) => c.id === cellId);
      if (!cell) return;

      const rawSql = extractSql(cell);
      if (!rawSql) return;

      // For inline DQL cells, extract chart config from the visualization block
      if (cell.type === 'dql') {
        const dqlChartConfig = parseDqlChartConfig(cell.content);
        if (dqlChartConfig && JSON.stringify(dqlChartConfig) !== JSON.stringify(cell.chartConfig)) {
          dispatch({ type: 'UPDATE_CELL', id: cellId, updates: { chartConfig: dqlChartConfig } });
        }
      }

      // Substitute {{cell_name}} references with inline CTEs
      const { sql } = substituteVariables(rawSql);

      const start = Date.now();

      // Cancel any previous execution for this cell
      const prev = runningControllers.get(cellId);
      if (prev) prev.abort();

      const controller = new AbortController();
      runningControllers.set(cellId, controller);

      // Mark running
      dispatch({
        type: 'UPDATE_CELL',
        id: cellId,
        updates: { status: 'running', error: undefined, result: undefined },
      });

      try {
        const result = await api.executeQuery(sql, controller.signal);
        const elapsed = Date.now() - start;

        const nextCount = (cell.executionCount ?? 0) + 1;

        dispatch({
          type: 'UPDATE_CELL',
          id: cellId,
          updates: {
            status: 'success',
            result: {
              ...result,
              executionTime: result.executionTime ?? elapsed,
              rowCount: result.rowCount ?? result.rows.length,
            },
            executionCount: nextCount,
          },
        });

        dispatch({
          type: 'APPEND_QUERY_LOG',
          entry: {
            id: makeCellId(),
            cellName: cell.name ?? cell.id,
            rows: result.rowCount ?? result.rows.length,
            time: result.executionTime ?? elapsed,
            ts: new Date(),
          },
        });

        // Reset border color after 2 seconds
        setTimeout(() => {
          dispatch({
            type: 'UPDATE_CELL',
            id: cellId,
            updates: { status: 'idle' },
          });
        }, 2000);
      } catch (err) {
        // If aborted, show cancelled status instead of error
        if (controller.signal.aborted) {
          dispatch({
            type: 'UPDATE_CELL',
            id: cellId,
            updates: { status: 'idle', error: undefined },
          });
          return;
        }

        const elapsed = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);

        dispatch({
          type: 'UPDATE_CELL',
          id: cellId,
          updates: {
            status: 'error',
            error: message,
            executionCount: (cell.executionCount ?? 0) + 1,
          },
        });

        dispatch({
          type: 'APPEND_QUERY_LOG',
          entry: {
            id: makeCellId(),
            cellName: cell.name ?? cell.id,
            rows: 0,
            time: elapsed,
            ts: new Date(),
            error: message,
          },
        });
      } finally {
        runningControllers.delete(cellId);
      }
    },
    [state.cells, dispatch]
  );

  const executeAll = useCallback(async () => {
    for (const cell of state.cells) {
      if (cell.type !== 'markdown') {
        await executeCell(cell.id);
      }
    }
  }, [state.cells, executeCell]);

  const executeDependents = useCallback(
    async (paramName: string) => {
      if (!paramName) return;
      const pattern = `{{${paramName}}}`;
      for (const cell of state.cells) {
        if (cell.type === 'markdown' || cell.type === 'param') continue;
        if (cell.content.includes(pattern)) {
          await executeCell(cell.id);
        }
      }
    },
    [state.cells, executeCell]
  );

  const cancelCell = useCallback((cellId: string) => {
    const controller = runningControllers.get(cellId);
    if (controller) {
      controller.abort();
      runningControllers.delete(cellId);
    }
    dispatch({
      type: 'UPDATE_CELL',
      id: cellId,
      updates: { status: 'idle' },
    });
  }, [dispatch]);

  return { executeCell, executeAll, executeDependents, cancelCell };
}
