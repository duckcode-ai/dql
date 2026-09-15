/**
 * Join key suggestions for the relationship builder.
 *
 * The builder used to offer only an identical column name, and only the first
 * one. dbt `relationships` tests already state the exact key pair a project
 * enforces, and most other joins follow a naming convention (`customer_id` on
 * orders → `customer_id` or `id` on customers). These are suggestions only: the
 * warehouse profile decides whether the join is safe.
 */

export type RelationshipKeySuggestionSource = 'dbt_test' | 'same_name' | 'named_for_table';

export interface RelationshipKeySuggestion {
  keys: Array<{ from: string; to: string }>;
  source: RelationshipKeySuggestionSource;
  /** Plain-language reason shown beside the suggestion. */
  reason: string;
}

export interface RelationshipSuggestionInput {
  fromColumns: string[];
  toColumns: string[];
  /** Warehouse relation or model name of the "to" side, e.g. `dev.customers`. */
  toRelation?: string;
  fromRelation?: string;
  /** dbt `relationships` tests between the two models, in either direction. */
  dbtTests?: Array<{ fromColumn: string; toColumn: string; reversed: boolean; testName?: string }>;
}

const IDENTIFIER = /(^|_)(id|key|code|number|no)$/i;

function tableName(relation: string | undefined): string | undefined {
  const last = relation?.replace(/["`\[\]]/g, '').split('.').filter(Boolean).pop();
  return last ? last.toLowerCase().replace(/^(stg|dim|fct|fact|int|base|raw)_+/, '') : undefined;
}

function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('ses') || name.endsWith('xes')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

export function suggestRelationshipKeys(input: RelationshipSuggestionInput): RelationshipKeySuggestion[] {
  const fromByLower = new Map(input.fromColumns.map((column) => [column.toLowerCase(), column]));
  const toByLower = new Map(input.toColumns.map((column) => [column.toLowerCase(), column]));
  const output: RelationshipKeySuggestion[] = [];
  const seen = new Set<string>();
  const push = (suggestion: RelationshipKeySuggestion) => {
    const key = suggestion.keys.map((pair) => `${pair.from.toLowerCase()}=${pair.to.toLowerCase()}`).join('&');
    if (seen.has(key)) return;
    seen.add(key);
    output.push(suggestion);
  };

  for (const test of input.dbtTests ?? []) {
    // A test declared on the other model reads the other way round.
    const fromColumn = test.reversed ? test.toColumn : test.fromColumn;
    const toColumn = test.reversed ? test.fromColumn : test.toColumn;
    const from = fromByLower.get(fromColumn.toLowerCase());
    const to = toByLower.get(toColumn.toLowerCase());
    if (!from || !to) continue;
    push({ keys: [{ from, to }], source: 'dbt_test', reason: `dbt test${test.testName ? ` ${test.testName}` : ''} checks ${from} → ${to}` });
  }

  // `customer_id → id` only when the other model has no `customer_id` of its
  // own: a table carrying both usually joins on the same-named key.
  const toTable = tableName(input.toRelation);
  const toId = toByLower.get('id');
  if (toTable && toId) {
    const names = [`${singular(toTable)}_id`, `${toTable}_id`];
    const from = names.map((name) => fromByLower.get(name)).find(Boolean);
    if (from && !toByLower.has(from.toLowerCase())) push({ keys: [{ from, to: toId }], source: 'named_for_table', reason: `${from} is named for ${toTable}` });
  }
  const fromTable = tableName(input.fromRelation);
  const fromId = fromByLower.get('id');
  if (fromTable && fromId) {
    const names = [`${singular(fromTable)}_id`, `${fromTable}_id`];
    const to = names.map((name) => toByLower.get(name)).find(Boolean);
    if (to && !fromByLower.has(to.toLowerCase())) push({ keys: [{ from: fromId, to }], source: 'named_for_table', reason: `${to} is named for ${fromTable}` });
  }

  // Shared identifier-looking names, the key named for the other table first.
  const shared = input.fromColumns.filter((column) => toByLower.has(column.toLowerCase()) && IDENTIFIER.test(column) && column.toLowerCase() !== 'id');
  const preferred = [toTable && `${singular(toTable)}_id`, fromTable && `${singular(fromTable)}_id`].filter(Boolean) as string[];
  shared.sort((a, b) => Number(preferred.includes(b.toLowerCase())) - Number(preferred.includes(a.toLowerCase())));
  for (const column of shared) {
    push({ keys: [{ from: column, to: toByLower.get(column.toLowerCase())! }], source: 'same_name', reason: `both models have ${column}` });
  }
  return output.slice(0, 5);
}
