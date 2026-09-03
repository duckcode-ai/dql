/**
 * The governed relational program is written by the HOST, not by the model.
 *
 * V2's contract is that the model owns business interpretation and DQL owns
 * construction. `compile_and_run_dql` broke that contract: it asked the model
 * for a finished `dqlProgram` — a DQL block declaration whose grammar no
 * prompt ever taught. Against a 3,373-model dbt project every analytics
 * question then died the same way. The model sent SQL (or invented a
 * pseudo-language), the block parser refused it, and the bare reason code told
 * it nothing. By then the plan was frozen, so the review-required SQL tier
 * that would have worked was closed too.
 *
 * So the model now sends the DECISIONS — which admitted measure, how to
 * aggregate it, which admitted dimensions and filters, the order and the
 * bound — and the host writes the artifact. Every identifier is resolved
 * against the admitted snapshot before a single character of SQL is composed,
 * and every literal is escaped here, so a composed program cannot name a
 * relation or column the workspace does not already admit.
 */

export interface AskV2RelationalPlanMeasureV1 {
  id: string;
  aggregation?: string;
  alias?: string;
}

export interface AskV2RelationalPlanV1 {
  measures: ReadonlyArray<AskV2RelationalPlanMeasureV1>;
  dimensions?: ReadonlyArray<{ id: string; alias?: string }>;
  filters?: ReadonlyArray<{ id: string; operator: string; value?: unknown; values?: readonly unknown[] }>;
  orderBy?: { reference?: string; direction?: string };
  limit?: number;
}

const ASK_V2_RELATIONAL_AGGREGATIONS: Record<string, string> = {
  sum: 'SUM',
  count: 'COUNT',
  count_distinct: 'COUNT_DISTINCT',
  avg: 'AVG',
  average: 'AVG',
  min: 'MIN',
  max: 'MAX',
  median: 'MEDIAN',
};

const ASK_V2_RELATIONAL_COMPARATORS: Record<string, string> = {
  '=': '=',
  eq: '=',
  '!=': '<>',
  ne: '<>',
  '<>': '<>',
  '>': '>',
  gt: '>',
  '>=': '>=',
  gte: '>=',
  '<': '<',
  lt: '<',
  '<=': '<=',
  lte: '<=',
};

export const ASK_V2_RELATIONAL_AGGREGATION_NAMES = Object.keys(ASK_V2_RELATIONAL_AGGREGATIONS);

export const ASK_V2_RELATIONAL_OPERATOR_NAMES = [
  ...new Set(Object.keys(ASK_V2_RELATIONAL_COMPARATORS)),
  'in',
  'not_in',
  'is_null',
  'is_not_null',
  'is_true',
  'is_false',
];

/** A SQL identifier the host itself resolved from the admitted snapshot. */
/** `dev.customers` is two identifiers; quoting it as one names a table that does not exist. */
function quoteRelation(relation: string): string {
  return relation.split('.').filter(Boolean).map(quoteIdentifier).join('.');
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Literals reach the host as free model text, so they are the one part of a
 * composed program the snapshot has not already proven. Numbers and booleans
 * become bare literals; strings become single-quoted with doubled quotes and
 * no control characters. A value that cannot be rendered that way is refused
 * rather than escaped into something else.
 */
function sqlLiteral(value: unknown): string | undefined {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'string') return undefined;
  if (value.length > 200) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return `'${value.replace(/'/g, "''")}'`;
}

function columnAlias(column: string, used: Set<string>, preferred?: string): string {
  const candidate = typeof preferred === 'string' && /^[a-z_][a-z0-9_]{0,60}$/i.test(preferred.trim())
    ? preferred.trim()
    : column;
  const base = candidate.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([0-9])/, '_$1') || 'value';
  let alias = base;
  let suffix = 2;
  while (used.has(alias)) {
    alias = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(alias);
  return alias;
}

export interface AskV2ComposedRelationalProgram {
  program: string;
  sql: string;
  relation: string;
  outputAliases: string[];
}

export type AskV2RelationalCompositionResult =
  | { ok: true; composed: AskV2ComposedRelationalProgram }
  | { ok: false; reasonCode: string; detail: string };

/**
 * Compose one governed DQL block from a plan whose every identifier the caller
 * has already resolved to a relation and a column through the admission gate.
 *
 * Deliberately single-relation. A cross-relation program needs a proven join
 * path, and a host that quietly invented one would be inventing governance —
 * those requests keep going to the tools that carry a path handle. This is not
 * a narrow case: a dbt mart is pre-joined by construction, which is why every
 * recorded enterprise failure on the GitLab warehouse was single-relation.
 */
export function composeAskV2RelationalProgram(input: {
  relation: string;
  measures: ReadonlyArray<{ column: string; aggregation?: string; alias?: string }>;
  dimensions?: ReadonlyArray<{ column: string; alias?: string }>;
  filters?: ReadonlyArray<{ column: string; operator: string; value?: unknown; values?: readonly unknown[] }>;
  orderBy?: { alias?: string; direction?: string };
  limit?: number;
  description?: string;
}): AskV2RelationalCompositionResult {
  if (!input.relation.trim() || input.measures.length === 0) {
    return {
      ok: false,
      reasonCode: 'GOVERNED_RELATIONAL_PLAN_INCOMPLETE',
      detail: 'A relational plan needs one admitted relation and at least one measure.',
    };
  }
  const used = new Set<string>();
  const selectParts: string[] = [];
  const groupParts: string[] = [];
  const dimensionAliases: string[] = [];
  for (const dimension of input.dimensions ?? []) {
    const alias = columnAlias(dimension.column, used, dimension.alias);
    selectParts.push(`${quoteIdentifier(dimension.column)} AS ${quoteIdentifier(alias)}`);
    groupParts.push(quoteIdentifier(dimension.column));
    dimensionAliases.push(alias);
  }
  const measureAliases: string[] = [];
  for (const measure of input.measures) {
    const key = (measure.aggregation ?? 'sum').trim().toLowerCase();
    const aggregation = ASK_V2_RELATIONAL_AGGREGATIONS[key];
    if (!aggregation) {
      return {
        ok: false,
        reasonCode: 'GOVERNED_RELATIONAL_PLAN_INCOMPLETE',
        detail: `Unsupported aggregation "${measure.aggregation}". Use one of: ${ASK_V2_RELATIONAL_AGGREGATION_NAMES.join(', ')}.`,
      };
    }
    const alias = columnAlias(measure.column, used, measure.alias);
    const expression = aggregation === 'COUNT_DISTINCT'
      ? `COUNT(DISTINCT ${quoteIdentifier(measure.column)})`
      : `${aggregation}(${quoteIdentifier(measure.column)})`;
    selectParts.push(`${expression} AS ${quoteIdentifier(alias)}`);
    measureAliases.push(alias);
  }
  const whereParts: string[] = [];
  for (const filter of input.filters ?? []) {
    const operator = filter.operator.trim().toLowerCase();
    const column = quoteIdentifier(filter.column);
    if (operator === 'is_null' || operator === 'is_not_null') {
      whereParts.push(`${column} IS ${operator === 'is_null' ? '' : 'NOT '}NULL`);
      continue;
    }
    if (operator === 'is_true' || operator === 'is_false') {
      whereParts.push(`${column} = ${operator === 'is_true' ? 'TRUE' : 'FALSE'}`);
      continue;
    }
    if (operator === 'in' || operator === 'not_in') {
      const values = (filter.values ?? []).map(sqlLiteral);
      if (values.length === 0 || values.some((value) => value === undefined)) {
        return {
          ok: false,
          reasonCode: 'GOVERNED_RELATIONAL_FILTER_VALUE_REJECTED',
          detail: `The "${operator}" filter on ${filter.column} needs a non-empty list of plain string, number, or boolean values.`,
        };
      }
      whereParts.push(`${column} ${operator === 'in' ? 'IN' : 'NOT IN'} (${values.join(', ')})`);
      continue;
    }
    const comparator = ASK_V2_RELATIONAL_COMPARATORS[operator];
    const literal = sqlLiteral(filter.value);
    if (!comparator || literal === undefined) {
      return {
        ok: false,
        reasonCode: 'GOVERNED_RELATIONAL_FILTER_VALUE_REJECTED',
        detail: comparator
          ? `The filter value on ${filter.column} must be a plain string, number, or boolean.`
          : `Unsupported filter operator "${filter.operator}". Use one of: ${ASK_V2_RELATIONAL_OPERATOR_NAMES.join(', ')}.`,
      };
    }
    whereParts.push(`${column} ${comparator} ${literal}`);
  }
  const requestedOrder = input.orderBy?.alias?.trim().toLowerCase();
  const orderAlias = requestedOrder && used.has(requestedOrder)
    ? requestedOrder
    : measureAliases[0] ?? dimensionAliases[0];
  const direction = (input.orderBy?.direction ?? 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
    ? Math.min(input.limit, 1000)
    : undefined;
  const sql = [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${quoteRelation(input.relation)}`,
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '',
    groupParts.length > 0 ? `GROUP BY ${groupParts.join(', ')}` : '',
    orderAlias ? `ORDER BY ${quoteIdentifier(orderAlias)} ${direction}` : '',
    limit ? `LIMIT ${limit}` : '',
  ].filter(Boolean).join('\n');
  const description = (input.description ?? 'Governed relational program composed from admitted identifiers.')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const program = [
    '// dql-format: 1',
    '',
    'block "ask_v2_governed_relational" {',
    '  domain = "uncategorized"',
    '  type = "custom"',
    '  status = "draft"',
    `  description = "${description}"`,
    '  query = """',
    sql.split('\n').map((line) => `    ${line}`).join('\n'),
    '  """',
    '}',
  ].join('\n');
  return {
    ok: true,
    composed: { program, sql, relation: input.relation, outputAliases: [...dimensionAliases, ...measureAliases] },
  };
}
