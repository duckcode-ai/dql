import { useCallback } from 'react';
import { useNotebook, makeCellId } from '../store/NotebookStore';
import { api } from '../api/client';
import { useVariableSubstitution } from './useVariableSubstitution';
import type { Cell, CellChartConfig } from '../store/types';

/**
 * Parse block import from a DQL cell.
 * Supports: @import "./blocks/name.dql"
 *       and @import "./blocks/name.dql" with period = "Q4", segment = "Enterprise"
 */
export function getBlockImportPath(cell: Cell): string | null {
  const info = getBlockImport(cell);
  return info ? info.path : null;
}

export function getBlockImport(cell: Cell): { path: string; params: Record<string, string> } | null {
  if (cell.type !== 'dql') return null;
  const content = cell.content.trim();
  // @import "./path.dql" [with key = "value", ...]
  const m = content.match(/^@import\s+["']([^"']+\.dql)["'](?:\s+with\s+([\s\S]+))?$/i);
  if (!m) return null;
  const path = m[1];
  const params: Record<string, string> = {};
  if (m[2]) {
    for (const part of m[2].split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      let v = part.slice(eq + 1).trim();
      v = v.replace(/^["']|["']$/g, ''); // strip surrounding quotes
      if (k) params[k] = v;
    }
  }
  return { path, params };
}

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
 * Extract default param values and types from a DQL block's params {} section.
 * Returns map of param name → { value, type }.
 */
interface BlockParam {
  value: string;
  type: 'text' | 'number' | 'date';
}

function parseBlockDefaultParams(content: string): Record<string, BlockParam> {
  const paramsMatch = content.match(/params\s*\{([^}]+)\}/is);
  if (!paramsMatch) return {};
  const params: Record<string, BlockParam> = {};
  for (const m of paramsMatch[1].matchAll(/(\w+)\s*(?::\s*(\w+)\s*)?=\s*["']([^"']*)["']/g)) {
    const name = m[1];
    const rawType = m[2]?.toLowerCase();
    const type: BlockParam['type'] =
      rawType === 'number' ? 'number' : rawType === 'date' ? 'date' : 'text';
    params[name] = { value: m[3], type };
  }
  return params;
}

/**
 * Substitute ${param_name} placeholders in SQL with actual values.
 * Type-aware: numbers are unquoted, dates use DATE literal, text is quoted.
 * Throws on missing required params.
 */
function applyBlockParams(
  sql: string,
  values: Record<string, string>,
  paramDefs: Record<string, BlockParam>,
  blockPath?: string,
): string {
  const missing: string[] = [];
  const result = sql.replace(/\$\{(\w+)\}/g, (match, name) => {
    const val = values[name];
    if (val === undefined) {
      missing.push(name);
      return match; // keep placeholder for error message
    }
    const paramType = paramDefs[name]?.type ?? 'text';
    if (paramType === 'number') {
      // Validate numeric to prevent SQL injection
      const num = Number(val);
      return isNaN(num) ? `'${val.replace(/'/g, "''")}'` : String(num);
    }
    if (paramType === 'date') {
      return `DATE '${val.replace(/'/g, "''")}'`;
    }
    return `'${val.replace(/'/g, "''")}'`;
  });
  if (missing.length > 0) {
    const location = blockPath ? ` in block ${blockPath}` : '';
    throw new Error(`Missing required parameter(s): ${missing.join(', ')}${location}`);
  }
  return result;
}

/**
 * Extract executable SQL from raw DQL content string (no cell wrapper).
 * Used for block file imports.
 */
export function extractSqlFromDqlContent(content: string): string | null {
  return extractSqlFromText(content.trim());
}

/**
 * Extract executable SQL from a cell.
 * - sql cells: use content directly
 * - dql cells: extract the SQL inside query = """...""", or plain SQL keywords
 * - markdown/param cells: return null (not executable)
 * - @import cells: handled separately in executeCell (async file read)
 */
function extractSql(cell: Cell): string | null {
  if (cell.type === 'markdown' || cell.type === 'param') return null;
  if (cell.type === 'sql') return cell.content.trim() || null;

  const dqlContent = cell.content.trim();
  if (!dqlContent) return null;

  // @import cells are handled asynchronously in executeCell
  if (/^@import\s+/i.test(dqlContent)) return '__IMPORT__';

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

      let rawSql = extractSql(cell);
      if (!rawSql) return;

      // Resolve @import block references — read the block file and extract its SQL
      if (rawSql === '__IMPORT__') {
        const blockImport = getBlockImport(cell)!;
        try {
          const { content: blockContent } = await api.readNotebook(blockImport.path);
          rawSql = extractSqlFromDqlContent(blockContent);
          if (!rawSql) {
            throw new Error(`No executable SQL found in block: ${blockImport.path}`);
          }
          // Merge block default params with caller-provided params, then substitute
          const paramDefs = parseBlockDefaultParams(blockContent);
          const defaultValues: Record<string, string> = {};
          for (const [k, v] of Object.entries(paramDefs)) defaultValues[k] = v.value;
          const mergedValues = { ...defaultValues, ...blockImport.params };
          if (Object.keys(mergedValues).length > 0 || /\$\{\w+\}/.test(rawSql)) {
            rawSql = applyBlockParams(rawSql, mergedValues, paramDefs, blockImport.path);
          }
          // Store chart config from the imported block's visualization section
          const importedChartConfig = parseDqlChartConfig(blockContent);
          if (importedChartConfig) {
            dispatch({ type: 'UPDATE_CELL', id: cellId, updates: { chartConfig: importedChartConfig } });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          dispatch({
            type: 'UPDATE_CELL',
            id: cellId,
            updates: { status: 'error', error: message, executionCount: (cell.executionCount ?? 0) + 1 },
          });
          return;
        }
      }

      // For inline DQL cells, extract chart config from the visualization block
      if (cell.type === 'dql' && rawSql !== '__IMPORT__') {
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
