import { useCallback } from 'react';
import { useNotebook, makeCellId } from '../store/NotebookStore';
import { api } from '../api/client';
import { useVariableSubstitution } from './useVariableSubstitution';
import type { Cell } from '../store/types';

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

  // DQL block syntax: extract SQL from inside query = """..."""
  // Handles both 'query = """..."""' and bare triple-quote blocks
  const tripleQuoteMatch = dqlContent.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (tripleQuoteMatch) return tripleQuoteMatch[1].trim() || null;

  // Bare triple-quote block (no 'query =' prefix)
  const bareTripleMatch = dqlContent.match(/"""([\s\S]*?)"""/);
  if (bareTripleMatch) return bareTripleMatch[1].trim() || null;

  // Plain SQL in a dql cell (no block syntax): match from first SQL keyword
  // but stop before any DQL-only syntax (visualization/tests/block blocks)
  const sqlKeywordMatch = dqlContent.match(
    /\b(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|SHOW|DESCRIBE|EXPLAIN)\b([\s\S]*)/i
  );
  if (sqlKeywordMatch) {
    // Strip trailing DQL block sections like visualization { ... }
    const raw = sqlKeywordMatch[0];
    const dqlSectionStart = raw.search(/\b(visualization|tests|block)\s*\{/i);
    return (dqlSectionStart > 0 ? raw.slice(0, dqlSectionStart) : raw).trim();
  }

  return null;
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

      // Substitute {{cell_name}} references with inline CTEs
      const { sql } = substituteVariables(rawSql);

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
