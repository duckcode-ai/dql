/**
 * Semantic reference resolver for SQL cells.
 *
 * Resolves `@metric(name)` and `@dim(name)` references in plain SQL strings
 * by looking up the metric/dimension definition in the SemanticLayer and
 * inlining the SQL expression.
 *
 * Example:
 *   Input:  SELECT @dim(segment), @metric(total_revenue) FROM fct_revenue GROUP BY @dim(segment)
 *   Output: SELECT segment_tier AS segment, SUM(amount) AS total_revenue FROM fct_revenue GROUP BY segment_tier
 */

import type { SemanticLayer } from '@duckcodeailabs/dql-core';

/** Pattern to match @metric(name) or @dim(name) references. */
const SEMANTIC_REF_PATTERN = /@(metric|dim|dimension)\(\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\)/g;

export interface SemanticRefResolution {
  /** The resolved SQL with all semantic references expanded. */
  resolvedSql: string;
  /** Names of metrics that were resolved. */
  resolvedMetrics: string[];
  /** Names of dimensions that were resolved. */
  resolvedDimensions: string[];
  /** Any references that could not be resolved. */
  unresolvedRefs: string[];
}

/**
 * Check if a SQL string contains any semantic references.
 */
export function hasSemanticRefs(sql: string): boolean {
  return SEMANTIC_REF_PATTERN.test(sql);
}

/**
 * Resolve all `@metric(name)` and `@dim(name)` references in a SQL string.
 *
 * - `@metric(total_revenue)` → expands to the metric's SQL expression with an alias
 * - `@dim(segment)` or `@dimension(segment)` → expands to the dimension's SQL expression with an alias
 *
 * If a reference can't be found in the semantic layer, it is left as-is and
 * added to `unresolvedRefs` so the caller can report a helpful error.
 */
export function resolveSemanticRefs(
  sql: string,
  semanticLayer: SemanticLayer | undefined,
): SemanticRefResolution {
  const resolvedMetrics: string[] = [];
  const resolvedDimensions: string[] = [];
  const unresolvedRefs: string[] = [];

  if (!semanticLayer) {
    // No semantic layer — check if there are refs that need resolving
    const refs: string[] = [];
    sql.replace(SEMANTIC_REF_PATTERN, (_match, _type, name) => {
      refs.push(name);
      return _match;
    });
    if (refs.length > 0) {
      return {
        resolvedSql: sql,
        resolvedMetrics: [],
        resolvedDimensions: [],
        unresolvedRefs: refs,
      };
    }
    return { resolvedSql: sql, resolvedMetrics: [], resolvedDimensions: [], unresolvedRefs: [] };
  }

  // Track which position in the SQL each ref appears to handle GROUP BY correctly
  // (in GROUP BY, we should NOT include the alias or aggregation wrapper)
  const resolvedSql = sql.replace(SEMANTIC_REF_PATTERN, (match, refType: string, name: string) => {
    if (refType === 'metric') {
      const metric = semanticLayer.getMetric(name);
      if (!metric) {
        unresolvedRefs.push(`metric:${name}`);
        return match;
      }
      resolvedMetrics.push(name);
      // In SELECT context: wrap with aggregation and alias
      // In GROUP BY / WHERE context: just the raw expression
      // We use a heuristic: check if this ref appears after GROUP BY, ORDER BY, WHERE, HAVING
      return `${metric.sql} AS ${sanitizeAlias(name)}`;
    }

    // dim or dimension
    const dim = semanticLayer.getDimension(name);
    if (!dim) {
      unresolvedRefs.push(`dimension:${name}`);
      return match;
    }
    resolvedDimensions.push(name);
    return `${dim.sql} AS ${sanitizeAlias(name)}`;
  });

  // Second pass: fix GROUP BY / ORDER BY / WHERE / HAVING clauses
  // In these clauses, we should use just the raw SQL without alias
  const fixedSql = fixClauseRefs(resolvedSql, semanticLayer);

  return {
    resolvedSql: fixedSql,
    resolvedMetrics,
    resolvedDimensions,
    unresolvedRefs,
  };
}

/**
 * In GROUP BY, ORDER BY, WHERE, HAVING clauses, replace "expr AS alias" with just "expr".
 * This is needed because SQL doesn't allow aliases in GROUP BY for most databases.
 */
function fixClauseRefs(sql: string, semanticLayer: SemanticLayer): string {
  // Find all "expression AS alias" patterns that appear after GROUP BY, ORDER BY, WHERE, HAVING
  const clausePattern = /\b(GROUP\s+BY|ORDER\s+BY|WHERE|HAVING)\b/gi;
  const match = clausePattern.exec(sql);
  if (!match) return sql;

  const clauseStart = match.index;
  const beforeClause = sql.substring(0, clauseStart);
  const clauseAndAfter = sql.substring(clauseStart);

  // In the clause portion, strip " AS alias" from resolved refs
  const fixed = clauseAndAfter.replace(/(\S+)\s+AS\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, expr, _alias) => {
    return expr;
  });

  return beforeClause + fixed;
}

/**
 * Sanitize a name to be a valid SQL alias.
 */
function sanitizeAlias(name: string): string {
  return name.replace(/\./g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Get a list of available semantic references for autocomplete.
 */
export function getSemanticRefCompletions(
  semanticLayer: SemanticLayer | undefined,
): Array<{ type: 'metric' | 'dimension'; name: string; label: string; description: string }> {
  if (!semanticLayer) return [];

  const completions: Array<{ type: 'metric' | 'dimension'; name: string; label: string; description: string }> = [];

  for (const metric of semanticLayer.listMetrics()) {
    completions.push({
      type: 'metric',
      name: metric.name,
      label: metric.label,
      description: metric.description ?? '',
    });
  }

  for (const dim of semanticLayer.listDimensions()) {
    completions.push({
      type: 'dimension',
      name: dim.name,
      label: dim.label,
      description: dim.description ?? '',
    });
  }

  return completions;
}
