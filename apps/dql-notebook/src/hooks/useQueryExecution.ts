import { useCallback } from 'react';
import { useNotebook, makeCellId } from '../store/NotebookStore';
import { api } from '../api/client';
import { useVariableSubstitution } from './useVariableSubstitution';
import type { Cell, CellChartConfig } from '../store/types';

/**
 * Parse the visualization section of a DQL block into a CellChartConfig.
 * Uses regex instead of the full DQL parser — handles simple cases.
 */
function parseDqlChartConfig(content: string): CellChartConfig | undefined {
  const vizMatch = content.match(/visualization\s*\{([^}]+)\}/is);
  if (!vizMatch) return undefined;
  const body = vizMatch[1];
  const get = (key: string) =>
    body.match(new RegExp(`\\b${key}\\s*=\\s*["']?([\\w-]+)["']?`, 'i'))?.[1];
  const chart = get('chart');
  if (!chart) return undefined;
  return {
    chart,
    x: get('x'),
    y: get('y'),
    color: get('color'),
    title: get('title'),
  };
}

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

function extractSqlFromText(dqlContent: string): string | null {

  // DQL block syntax: extract SQL from inside query = """..."""
  // Handles both 'query = """..."""' and bare triple-quote blocks
  const tripleQuoteMatch = dqlContent.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (tripleQuoteMatch) return tripleQuoteMatch[1].trim() || null;

  // Bare triple-quote block (no 'query =' prefix)
  const bareTripleMatch = dqlContent.match(/"""([\s\S]*?)"""/);
  if (bareTripleMatch) return bareTripleMatch[1].trim() || null;

  // Dashboard/workbook files should be previewed with `dql preview`, not run as SQL
  if (/^\s*(dashboard|workbook)\s+"/i.test(dqlContent)) return null;

  // Plain SQL in a dql cell (no block syntax): match from first SQL keyword
  // but stop before any DQL-only syntax (visualization/tests/block blocks)
  // or before a named-arg boundary like ", identifier =" (from chart.kpi calls)
  const sqlKeywordMatch = dqlContent.match(
    /\b(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|SHOW|DESCRIBE|EXPLAIN)\b([\s\S]*)/i
  );
  if (sqlKeywordMatch) {
    let raw = sqlKeywordMatch[0];
    // Stop before DQL block sections
    const dqlSectionStart = raw.search(/\b(visualization|tests|block)\s*\{/i);
    if (dqlSectionStart > 0) raw = raw.slice(0, dqlSectionStart);
    // Stop at named-arg boundary: ", identifier =" (DQL chart call syntax)
    // Use the same heuristic as scanSQLBoundary: stop at ", word =" at paren depth 1
    raw = trimAtNamedArgBoundary(raw);
    return raw.trim() || null;
  }

  return null;
}

/**
 * Trim SQL text at the first ", identifier =" pattern at paren-depth 1.
 * Mirrors the scanSQLBoundary logic used by the DQL compiler.
 */
function trimAtNamedArgBoundary(sql: string): string {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(' ) { depth++; continue; }
    if (ch === ')') { if (depth > 0) depth--; continue; }
    // Skip string literals
    if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length && sql[i] !== ch) {
        if (sql[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === ',' && depth === 0) {
      // Look ahead for "whitespace identifier ="
      let j = i + 1;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      if (j < sql.length && /[a-zA-Z_]/.test(sql[j])) {
        const identStart = j;
        while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
        let k = j;
        while (k < sql.length && /\s/.test(sql[k])) k++;
        if (k < sql.length && sql[k] === '=' && sql[k + 1] !== '=') {
          // Named-arg boundary — trim here
          return sql.slice(0, i);
        }
      }
    }
  }
  return sql;
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

  return { executeCell, executeAll, executeDependents };
}
