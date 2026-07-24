import { useCallback } from 'react';
import { useNotebook } from '../store/NotebookStore';
import type { Cell, ParamType, QueryResult } from '../store/types';
import { HANDLE_RE } from '../utils/handles';

/**
 * Builds a WITH clause from a named cell's result, so that
 * {{cell_name}} can be used as a table reference in downstream SQL.
 *
 * Example: "SELECT * FROM {{revenue_q1}}" becomes
 *   WITH revenue_q1 AS (VALUES ('A', 1), ('B', 2)) SELECT * FROM revenue_q1
 */
function buildCTE(name: string, result: QueryResult): string {
  if (!result.columns.length || !result.rows.length) {
    // Empty CTE — just aliases nothing
    return `${name} AS (SELECT 1 WHERE 1=0)`;
  }

  const cols = result.columns;
  const rows = result.rows.slice(0, 5000); // cap to avoid huge CTEs

  const valueRows = rows
    .map((row) => {
      const vals = cols.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return String(v);
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        // Escape single quotes in strings
        return `'${String(v).replace(/'/g, "''")}'`;
      });
      return `(${vals.join(', ')})`;
    })
    .join(',\n  ');

  const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');

  return `${name} AS (\n  SELECT * FROM (VALUES\n  ${valueRows}\n  ) AS _t(${colList})\n)`;
}

/**
 * Formats a param value as a SQL literal.
 * Numbers and dates are injected as-is; text values are single-quoted.
 */
function formatParamLiteral(value: string, paramType: ParamType): string {
  if (paramType === 'number') {
    const n = Number(value);
    return isNaN(n) ? `'${value.replace(/'/g, "''")}'` : String(n);
  }
  // date and text — single-quoted
  return `'${value.replace(/'/g, "''")}'`;
}

export interface NotebookVariableSubstitution {
  sql: string;
  substituted: string[];
  unresolved: string[];
  ambiguous: string[];
}

/**
 * Pure substitution contract used by single-cell runs and Run all.
 * A completed result remains usable after the UI status returns to `idle`;
 * failed/stale results are never injected. Cell IDs are stable handles, while
 * duplicate display names fail closed instead of silently selecting one cell.
 */
export function substituteNotebookVariables(
  sql: string,
  cells: Cell[],
): NotebookVariableSubstitution {
  const matches = [...sql.matchAll(HANDLE_RE)];
  if (matches.length === 0) {
    return { sql, substituted: [], unresolved: [], ambiguous: [] };
  }

  const handles = new Map<string, Cell[]>();
  for (const cell of cells) {
    const candidates = [cell.id, cell.name?.trim()].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      handles.set(candidate, [...(handles.get(candidate) ?? []), cell]);
    }
  }

  const substituted: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  const cteFragments: string[] = [];
  let rewritten = sql;

  for (const match of matches) {
    const handle = match[1];
    const candidates = handles.get(handle) ?? [];
    if (candidates.length === 0) {
      unresolved.push(handle);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push(handle);
      continue;
    }
    const cell = candidates[0];
    if (cell.type === 'param') {
      const cfg = cell.paramConfig;
      const rawValue = cell.paramValue ?? cfg?.defaultValue ?? '';
      const paramType: ParamType = cfg?.paramType ?? 'text';
      rewritten = rewritten.replace(match[0], formatParamLiteral(rawValue, paramType));
      substituted.push(handle);
      continue;
    }
    if (!cell.result || cell.error || cell.stale) {
      unresolved.push(handle);
      continue;
    }
    cteFragments.push(buildCTE(handle, cell.result));
    rewritten = rewritten.replace(match[0], `"${handle}"`);
    substituted.push(handle);
  }

  if (cteFragments.length > 0) {
    const trimmed = rewritten.trimStart();
    if (/^WITH\s+/i.test(trimmed)) {
      rewritten = rewritten.replace(/^(\s*WITH\s+)/i, `$1${cteFragments.join(',\n')},\n`);
    } else {
      rewritten = `WITH ${cteFragments.join(',\n')}\n${rewritten}`;
    }
  }

  return {
    sql: rewritten,
    substituted: Array.from(new Set(substituted)),
    unresolved: Array.from(new Set(unresolved)),
    ambiguous: Array.from(new Set(ambiguous)),
  };
}

/**
 * Returns a function that rewrites SQL by substituting {{cell_name}}
 * references.  For param cells the value is injected as a SQL literal.
 * For non-param named cells an inline CTE is built from their result.
 */
export function useVariableSubstitution() {
  const { state } = useNotebook();

  const substituteVariables = useCallback(
    (sql: string): NotebookVariableSubstitution => substituteNotebookVariables(sql, state.cells),
    [state.cells],
  );

  return { substituteVariables };
}
