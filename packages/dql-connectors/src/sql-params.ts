import type { ConnectionConfig } from './connector.js';

export type SQLParamSpec = { name: string; position: number; literalValue?: unknown };

export interface ExpandedSQLParams {
  sql: string;
  params: SQLParamSpec[];
  variables: Record<string, unknown>;
}

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
      return null;
    });
}

/**
 * Expand array-valued template variables into ordinary positional placeholders.
 *
 * DQL blocks keep one business parameter such as `${team_set}` so app filters
 * and review metadata stay readable. At execution time, an array value is
 * rewritten from `IN ($1)` to `IN ($1, $2, ...)` with one bind value per item.
 */
export function expandArrayParameters(
  sql: string,
  params: SQLParamSpec[],
  variables: Record<string, unknown>,
): ExpandedSQLParams {
  if (!params || params.length === 0) return { sql, params: [], variables };

  const sorted = [...params].sort((a, b) => a.position - b.position);
  const replacements = new Map<number, string>();
  const expandedParams: SQLParamSpec[] = [];
  const expandedVariables: Record<string, unknown> = { ...(variables ?? {}) };
  let nextPosition = 1;

  for (const param of sorted) {
    const value = Object.prototype.hasOwnProperty.call(expandedVariables, param.name)
      ? expandedVariables[param.name]
      : Object.prototype.hasOwnProperty.call(param, 'literalValue')
        ? param.literalValue
        : null;

    if (Array.isArray(value)) {
      const values = value.length > 0 ? value : [null];
      const names: string[] = [];
      for (let index = 0; index < values.length; index += 1) {
        const name = `${param.name}_${param.position}_${index + 1}`;
        names.push(name);
        expandedVariables[name] = values[index];
        expandedParams.push({ name, position: nextPosition });
        nextPosition += 1;
      }
      replacements.set(param.position, names.map((name) => {
        const spec = expandedParams.find((candidate) => candidate.name === name);
        return `$${spec?.position ?? nextPosition}`;
      }).join(', '));
      continue;
    }

    replacements.set(param.position, `$${nextPosition}`);
    expandedParams.push({ ...param, position: nextPosition });
    nextPosition += 1;
  }

  return {
    sql: rewritePositionalPlaceholders(sql, replacements),
    params: expandedParams,
    variables: expandedVariables,
  };
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
  if (driver === 'postgresql' || driver === 'mssql' || driver === 'redshift' || driver === 'fabric') return sql;

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

function rewritePositionalPlaceholders(sql: string, replacements: Map<number, string>): string {
  if (!sql || replacements.size === 0) return sql;
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'" && !inDouble && !inBacktick) {
      out += ch;
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
        while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j += 1;
        const position = Number(sql.slice(i + 1, j));
        const replacement = replacements.get(position);
        if (replacement) {
          out += replacement;
          i = j;
          continue;
        }
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}
