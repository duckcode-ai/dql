import { useCallback } from 'react';
import { useNotebook, makeCellId } from '../store/NotebookStore';
import { api } from '../api/client';
import type { Cell } from '../store/types';

/**
 * Extract executable SQL from a cell.
 * - sql cells: use content directly
 * - dql cells: extract SELECT ... portions
 * - markdown cells: return null (not executable)
 */
function extractSql(cell: Cell): string | null {
  if (cell.type === 'markdown') return null;
  if (cell.type === 'sql') return cell.content.trim() || null;

  // dql: extract SELECT/WITH/INSERT/UPDATE/DELETE statements via simple regex
  const dqlContent = cell.content.trim();
  if (!dqlContent) return null;

  // Try to find SQL keywords at line start or as the whole content
  const sqlMatch = dqlContent.match(
    /\b(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|SHOW|DESCRIBE|EXPLAIN)\b[\s\S]*/i
  );
  if (sqlMatch) return sqlMatch[0].trim();

  // Fall back to using content as-is
  return dqlContent;
}

export function useQueryExecution() {
  const { state, dispatch } = useNotebook();

  const executeCell = useCallback(
    async (cellId: string) => {
      const cell = state.cells.find((c) => c.id === cellId);
      if (!cell) return;

      const sql = extractSql(cell);
      if (!sql) return;

      const start = Date.now();

      // Mark running
      dispatch({
        type: 'UPDATE_CELL',
        id: cellId,
        updates: { status: 'running', error: undefined, result: undefined },
      });

      try {
        const result = await api.executeQuery(sql);
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

  return { executeCell, executeAll };
}
