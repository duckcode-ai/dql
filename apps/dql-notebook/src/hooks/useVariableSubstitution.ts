import { useCallback } from 'react';
import { useNotebook } from '../store/NotebookStore';
import type { Cell, QueryResult } from '../store/types';

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
 * Returns a function that rewrites SQL by substituting {{cell_name}}
 * references with inline CTEs from successful cell results.
 */
export function useVariableSubstitution() {
  const { state } = useNotebook();

  const substituteVariables = useCallback(
    (sql: string): { sql: string; substituted: string[] } => {
      const pattern = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
      const matches = [...sql.matchAll(pattern)];

      if (matches.length === 0) return { sql, substituted: [] };

      const substituted: string[] = [];
      const cteFragments: string[] = [];
      let rewritten = sql;

      // Build a map of named cells with successful results
      const namedResults = new Map<string, QueryResult>();
      for (const cell of state.cells) {
        const name = cell.name?.trim();
        if (name && cell.status === 'success' && cell.result) {
          namedResults.set(name, cell.result);
        }
      }

      for (const match of matches) {
        const varName = match[1];
        if (namedResults.has(varName)) {
          cteFragments.push(buildCTE(varName, namedResults.get(varName)!));
          // Replace {{cell_name}} with just the name (it'll be resolved via CTE)
          rewritten = rewritten.replace(match[0], `"${varName}"`);
          substituted.push(varName);
        }
      }

      if (cteFragments.length === 0) return { sql, substituted: [] };

      // Prepend WITH clause, handling existing WITH
      const trimmed = rewritten.trimStart();
      const hasExistingWith = /^WITH\s+/i.test(trimmed);

      if (hasExistingWith) {
        // Insert our CTEs at the start of the existing WITH list
        rewritten = rewritten.replace(/^(\s*WITH\s+)/i, `$1${cteFragments.join(',\n')},\n`);
      } else {
        rewritten = `WITH ${cteFragments.join(',\n')}\n${rewritten}`;
      }

      return { sql: rewritten, substituted };
    },
    [state.cells],
  );

  return { substituteVariables };
}
