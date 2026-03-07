import type { ConnectionConfig } from './connector.js';

export type SQLParamSpec = { name: string; position: number; literalValue?: unknown };

export function buildParamValues(
  params: SQLParamSpec[],
  variables: Record<string, unknown>,
): unknown[] {
  if (!params || params.length === 0) return [];
  return [...params]
    .sort((a, b) => a.position - b.position)
    .map((p) => {
      if (Object.prototype.hasOwnProperty.call(variables, p.name)) {
        return variables[p.name];
      }
      if (Object.prototype.hasOwnProperty.call(p, 'literalValue')) {
        return p.literalValue;
      }
      return undefined;
    });
}

/**
 * Normalize "$N" placeholders emitted by the compiler to the placeholder syntax
 * expected by each driver.
 *
 * - PostgreSQL: "$1" (no change)
 * - MSSQL: keep "$N" (driver rewrites to "@pN" while binding)
 * - Others (Snowflake/BigQuery/MySQL/SQLite/DuckDB): "?" positional
 */
export function normalizeSQLPlaceholders(
  sql: string,
  driver: ConnectionConfig['driver'],
): string {
  if (!sql) return sql;
  if (driver === 'postgresql' || driver === 'mssql') return sql;

  // Replace $N -> ? outside quoted regions.
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  while (i < sql.length) {
    const ch = sql[i];

    // Handle quote toggles with basic SQL escaping.
    if (ch === "'" && !inDouble && !inBacktick) {
      out += ch;
      // SQL single-quote escape: '' inside string literal.
      if (inSingle && sql[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      i += 1;
      continue;
    }

    if (ch === '"' && !inSingle && !inBacktick) {
      out += ch;
      // Identifier escape: "" inside quoted identifier.
      if (inDouble && sql[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      inDouble = !inDouble;
      i += 1;
      continue;
    }

    if (ch === '`' && !inSingle && !inDouble) {
      out += ch;
      // BigQuery identifier escape: `` inside backticks.
      if (inBacktick && sql[i + 1] === '`') {
        out += '`';
        i += 2;
        continue;
      }
      inBacktick = !inBacktick;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && ch === '$') {
      let j = i + 1;
      if (j < sql.length && sql[j] >= '0' && sql[j] <= '9') {
        while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j++;
        out += '?';
        i = j;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}
