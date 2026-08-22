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

/**
 * An artifact-owned mapping from a requested analytical role to the exact
 * output alias emitted by a frozen execution authority.
 *
 * These bindings are intentionally narrow.  They are not retrieval aliases:
 * callers may only supply them from the selected certified artifact or the
 * immutable resolved plan that selected it.  In particular, a nearby metric,
 * block tag, or description can never make a returned column satisfy a
 * requested output here.
 */
export interface AnswerShapeOutputBinding {
  /** The role/term the frozen plan resolved (for example `customer`). */
  requested: string;
  /** The declared output name the selected artifact actually returns. */
  output: string;
  /** `measure` remains strict; dimensions and entity labels are role bindings. */
  role: 'measure' | 'dimension' | 'entity_label';
  /** Explicit authored aliases for a dimension/entity role, if any. */
  aliases?: string[];
}

export interface AnswerShapeValidationOptions {
  /** Artifact-local aliases from the frozen execution authority only. */
  outputBindings?: readonly AnswerShapeOutputBinding[];
  /**
   * A frozen certified plan must prove requested measures through its own
   * binding. This is deliberately off for semantic/generated results, where a
   * governed projection such as `beverage_revenue` legitimately answers a
   * plain-English spend request.
   */
  requireBoundMeasures?: boolean;
}

export function validateAnswerResultShape(
  plan: AnalysisQuestionPlan,
  result: AnswerShapeResultLike,
  options: AnswerShapeValidationOptions = {},
): AnswerShapeValidation {
  const columns = resultColumnsForShape(result);
  const rowCount = resultRowCount(result);
  const missingOutputs = plan.requestedShape.requiredOutputs.filter((output) => {
    const bindingMatches = columns.some((column) => outputBindingCoversRequestedOutput(
      column,
      output,
      options.outputBindings ?? [],
    ));
    if (bindingMatches) return false;
    if (options.requireBoundMeasures && isRequestedMeasureOutput(plan, output)) return true;
    return !columns.some((column) => columnCoversRequestedOutput(column, output));
  });
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
  const NAME_TOKENS = ['name', 'title', 'label', 'nm', 'description', 'desc'];
  if (required.endsWith('_name')) {
    const entity = requiredTokens[0];
    const hasNameToken = columnTokens.some((token) => NAME_TOKENS.includes(token));
    // Entity match tolerates common abbreviations (product↔prod, customer↔cust)
    // via a shared 4-char stem, so aliases like prod_name / cust_name / p_name
    // don't false-miss.
    const stem = (token: string) => token.slice(0, 4);
    const hasEntityToken = Boolean(entity && columnTokens.some((token) =>
      token === entity || token.startsWith(stem(entity)) || entity.startsWith(stem(token)),
    ));
    // A bare `name`/`label` column (single token) covers any *_name requirement.
    const bareNameColumn = columnTokens.length === 1 && hasNameToken;
    return (hasEntityToken && hasNameToken) || column === entity || bareNameColumn;
  }
  return requiredTokens.every((token) => columnTokens.some((columnToken) => outputTokensEquivalent(token, columnToken)));
}

function isRequestedMeasureOutput(plan: AnalysisQuestionPlan, output: string): boolean {
  const required = canonicalResultColumn(output);
  return plan.requestedShape.measures.some((measure) => {
    const candidate = canonicalResultColumn(measure);
    if (!candidate || !required) return false;
    if (candidate === required) return true;
    const candidateTokens = candidate.split('_').filter(Boolean);
    const requiredTokens = required.split('_').filter(Boolean);
    return candidateTokens.length === 1
      && requiredTokens.length === 1
      && outputTokensEquivalent(candidateTokens[0]!, requiredTokens[0]!);
  });
}

function outputBindingCoversRequestedOutput(
  column: string,
  requiredOutput: string,
  bindings: readonly AnswerShapeOutputBinding[],
): boolean {
  const required = canonicalResultColumn(requiredOutput);
  if (!required) return true;
  return bindings.some((binding) => {
    if (canonicalResultColumn(binding.output) !== column) return false;
    const requested = canonicalResultColumn(binding.requested);
    const aliases = (binding.aliases ?? []).map(canonicalResultColumn);
    const requestedRoleMatches = requested === required || aliases.includes(required);
    if (!requestedRoleMatches) return false;
    // A measure binding must have been created from the frozen plan's strict
    // declared measure proof.  We therefore require its exact requested role,
    // rather than applying broad column similarity a second time.
    return binding.role === 'measure' || binding.role === 'dimension' || binding.role === 'entity_label';
  });
}

// Keep this deliberately small and business-semantic. These are common measure
// words that users interchange in plain English; matching them prevents a
// correctly selected certified contract from being rejected merely because its
// governed output uses `revenue` while the question says `spend`.
const OUTPUT_TOKEN_EQUIVALENCE: ReadonlyArray<ReadonlySet<string>> = [
  // `canonicalResultColumn` singularizes ordinary English plurals before this
  // comparison. Keep the singular form here as well: otherwise a certified
  // `revenue` output is incorrectly rejected for "sales by category" after
  // `sales` becomes `sale`, and a frozen certified plan is misreported as a
  // generated-route mismatch. This is deliberately limited to the revenue
  // family; unrelated business measures (for example BCM) remain distinct.
  new Set(['spend', 'spending', 'revenue', 'sales', 'sale']),
  new Set(['count', 'number', 'num', 'quantity', 'qty']),
];

function outputTokensEquivalent(required: string, column: string): boolean {
  if (required === column) return true;
  return OUTPUT_TOKEN_EQUIVALENCE.some((group) => group.has(required) && group.has(column));
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
