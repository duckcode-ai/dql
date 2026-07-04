import type { AnalysisQuestionPlan } from './metadata/analysis-planner.js';

export interface AnswerShapeResultLike {
  columns?: unknown;
  rows?: unknown;
  rowCount?: unknown;
}

export interface AnswerShapeValidation {
  warnings: string[];
  missingOutputs: string[];
  columns: string[];
  rowCount?: number;
  topN?: number;
  topNReturned?: number;
}

export function validateAnswerResultShape(
  plan: AnalysisQuestionPlan,
  result: AnswerShapeResultLike,
): AnswerShapeValidation {
  const columns = resultColumnsForShape(result);
  const rowCount = resultRowCount(result);
  const missingOutputs = plan.requestedShape.requiredOutputs.filter((output) =>
    !columns.some((column) => columnCoversRequestedOutput(column, output))
  );
  const warnings: string[] = [];
  if (missingOutputs.length > 0) {
    warnings.push(`The answer is missing requested output column(s): ${missingOutputs.join(', ')}.`);
  }
  const topN = plan.requestedShape.topN;
  const topNReturned = topN && topN.scope !== 'per_group' && rowCount !== undefined && rowCount > topN.n
    ? rowCount
    : undefined;
  if (topN && topNReturned !== undefined) {
    warnings.push(`The user asked for top ${topN.n}, but the answer returned ${topNReturned} rows.`);
  }
  return {
    warnings,
    missingOutputs,
    columns,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(topN ? { topN: topN.n } : {}),
    ...(topNReturned !== undefined ? { topNReturned } : {}),
  };
}

function resultColumnsForShape(result: AnswerShapeResultLike): string[] {
  const columns = Array.isArray(result.columns) ? result.columns : [];
  return columns.map((column) => {
    if (typeof column === 'string') return canonicalResultColumn(column);
    if (column && typeof column === 'object') {
      const record = column as Record<string, unknown>;
      const name = [record.name, record.field, record.key].find((value): value is string =>
        typeof value === 'string' && value.trim().length > 0
      );
      return name ? canonicalResultColumn(name) : '';
    }
    return '';
  }).filter(Boolean);
}

function resultRowCount(result: AnswerShapeResultLike): number | undefined {
  if (typeof result.rowCount === 'number') return result.rowCount;
  return Array.isArray(result.rows) ? result.rows.length : undefined;
}

function columnCoversRequestedOutput(column: string, requiredOutput: string): boolean {
  const required = canonicalResultColumn(requiredOutput);
  if (!required) return true;
  if (column === required) return true;
  const requiredTokens = required.split('_').filter(Boolean);
  const columnTokens = column.split('_').filter(Boolean);
  if (required === 'count') {
    return columnTokens.some((token) => ['count', 'total', 'number', 'num'].includes(token));
  }
  if (required.endsWith('_name')) {
    const entity = requiredTokens[0];
    return Boolean(entity && columnTokens.includes(entity) && (
      columnTokens.includes('name') ||
      columnTokens.includes('title') ||
      column === entity
    ));
  }
  return requiredTokens.every((token) => columnTokens.includes(token));
}

function canonicalResultColumn(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .map((token) => {
      if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
      if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
      return token;
    })
    .join('_');
}
