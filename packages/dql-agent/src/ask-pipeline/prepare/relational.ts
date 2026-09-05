import type { AnalyticalIntentV1, IntentPredicate } from '../intent.js';
import type { VocabularyEntry, VocabularyIndex } from '../vocabulary.js';
import type { PrepareDeps, PreparedCandidate, PreparedRefusal, SqlDialectLike } from './types.js';

/**
 * RELATIONAL: a governed program composed over physical columns.
 *
 * Every ref is bound to a physical `relation.column` (column refs directly,
 * semantic refs through the physical binding the host attached), the
 * relations are joined only along governed join paths, aggregates are
 * composed from the intent, and literals are bound as positional parameters.
 * This is the tier that expresses what the semantic layer cannot: a
 * per-measure scope, a filter on a joined model, a column with no metric.
 *
 * GRAIN SAFETY. Measures that live on different fact relations are never
 * aggregated in one joined query: an order total summed across order lines
 * is inflated by the number of lines. Each fact relation becomes its own
 * aggregate island (grouped by the same keys, filtered the same way), and
 * the islands are joined on those keys afterwards.
 */

interface PhysicalMeasure { alias: string; aggregate: string; expr: string; relation: string; scope: IntentPredicate[] }
interface PhysicalColumn { alias: string; relation: string; column: string; expr: string; role: 'group' | 'display'; grain?: string }
interface BoundPredicate { predicate: IntentPredicate; relation: string; column: string; boolean: boolean }

const DEFAULT_DIALECT: SqlDialectLike = {
  quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
  dateTrunc: (grain, expr) => `date_trunc('${grain}', ${expr})`,
  limitClause: (limit) => `LIMIT ${limit}`,
};

const AGG_SQL: Record<string, (expr: string) => string> = {
  sum: (e) => `SUM(${e})`, avg: (e) => `AVG(${e})`, count: (e) => `COUNT(${e})`, count_distinct: (e) => `COUNT(DISTINCT ${e})`,
  min: (e) => `MIN(${e})`, max: (e) => `MAX(${e})`, median: (e) => `MEDIAN(${e})`,
};

function qualifyRelation(dialect: SqlDialectLike, relation: string): string {
  return relation.split('.').map((part) => dialect.quoteIdentifier(part)).join('.');
}

function qualify(dialect: SqlDialectLike, relation: string, column: string): string {
  return `${qualifyRelation(dialect, relation)}.${dialect.quoteIdentifier(column)}`;
}

function physicalOf(entry: VocabularyEntry | undefined): { relation: string; column?: string; expr?: string; aggregate?: string } | undefined {
  if (!entry) return undefined;
  if (entry.kind === 'column' && entry.model) return { relation: entry.model, column: entry.name };
  return entry.physical;
}

const asBoolean = (value: unknown): boolean | undefined =>
  value === true || value === 1 || String(value).toLowerCase() === 'true' ? true
    : value === false || value === 0 || String(value).toLowerCase() === 'false' ? false
      : undefined;

function predicateSql(dialect: SqlDialectLike, bound: BoundPredicate, params: unknown[]): string {
  const { predicate } = bound;
  const target = qualify(dialect, bound.relation, bound.column);
  const bind = (value: unknown) => { params.push(value); return '?'; };
  // A boolean column compared to "true"/"false" is a boolean test, never a string match.
  if (bound.boolean && (predicate.op === 'eq' || predicate.op === 'neq') && predicate.values.length === 1 && asBoolean(predicate.values[0]) !== undefined) {
    const truth = asBoolean(predicate.values[0]) === (predicate.op === 'eq');
    return `${target} = ${truth ? 'TRUE' : 'FALSE'}`;
  }
  switch (predicate.op) {
    case 'is_true': return `${target} = TRUE`;
    case 'is_false': return `${target} = FALSE`;
    case 'in': return `${target} IN (${predicate.values.map(bind).join(', ')})`;
    case 'not_in': return `${target} NOT IN (${predicate.values.map(bind).join(', ')})`;
    case 'contains': return `LOWER(${target}) LIKE ${bind(`%${String(predicate.values[0] ?? '').toLowerCase()}%`)}`;
    case 'neq': return `${target} <> ${bind(predicate.values[0])}`;
    case 'gt': return `${target} > ${bind(predicate.values[0])}`;
    case 'gte': return `${target} >= ${bind(predicate.values[0])}`;
    case 'lt': return `${target} < ${bind(predicate.values[0])}`;
    case 'lte': return `${target} <= ${bind(predicate.values[0])}`;
    default: {
      const value = predicate.values[0];
      // Text equality is case-insensitive: a quoted "ryan byrd" must find Ryan Byrd.
      return typeof value === 'string' ? `LOWER(${target}) = ${bind(value.toLowerCase())}` : `${target} = ${bind(value)}`;
    }
  }
}

export function composeRelational(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): { candidate?: PreparedCandidate; refusal?: PreparedRefusal } {
  const dialect = deps.dialect ?? DEFAULT_DIALECT;
  const refuse = (code: PreparedRefusal['code'], message: string, repairable = false): { refusal: PreparedRefusal } => ({ refusal: { tier: 'relational', code, message, repairable } });

  const bindPredicate = (predicate: IntentPredicate): BoundPredicate | PreparedRefusal => {
    const entry = vocabulary.get(predicate.ref);
    const physical = physicalOf(entry);
    if (!physical?.column) return { tier: 'relational', code: 'not_relational', message: `${predicate.ref} has no physical column binding`, repairable: false };
    return { predicate, relation: physical.relation, column: physical.column, boolean: Boolean(entry?.roles.includes('boolean')) };
  };

  // Measures, each bound to the fact relation it reads.
  const measures: PhysicalMeasure[] = [];
  for (const measure of intent.measures) {
    const entry = vocabulary.get(measure.ref);
    const physical = physicalOf(entry);
    if (!physical) return refuse('not_relational', `${measure.ref} has no physical binding`);
    // The vocabulary owns a metric's aggregate; an intent aggregation applies to raw columns only.
    const aggregate = entry?.kind === 'column' ? (measure.aggregation ?? physical.aggregate) : (physical.aggregate ?? measure.aggregation);
    if (!aggregate || (!AGG_SQL[aggregate] && aggregate !== 'derived')) return refuse('not_relational', `${measure.ref} needs an aggregation`, true);
    if (aggregate === 'derived' && measure.scope?.length) return refuse('not_relational', `${measure.ref} is a derived metric and cannot take a per-measure scope`);
    const expr = physical.expr ?? (physical.column ? qualify(dialect, physical.relation, physical.column) : undefined);
    if (!expr) return refuse('not_relational', `${measure.ref} has no expression`);
    const alias = measure.alias ?? entry?.name ?? measure.ref.split('.').pop() ?? 'value';
    measures.push({ alias, aggregate, expr, relation: physical.relation, scope: measure.scope ?? [] });
  }
  if (measures.length === 0) return refuse('not_relational', 'no measure to compose');

  // Grouping and display columns, shared by every island.
  const columns: PhysicalColumn[] = [];
  const addColumn = (ref: string, role: 'group' | 'display', grain?: string): PreparedRefusal | undefined => {
    const entry = vocabulary.get(ref);
    const physical = physicalOf(entry);
    if (!physical?.column) return { tier: 'relational', code: 'not_relational', message: `${ref} has no physical column binding`, repairable: false };
    const base = qualify(dialect, physical.relation, physical.column);
    const alias = grain ? `${physical.column}_${grain}` : physical.column;
    if (columns.some((column) => column.alias === alias)) return undefined;
    columns.push({ alias, relation: physical.relation, column: physical.column, expr: grain ? dialect.dateTrunc(grain, base) : base, role, ...(grain ? { grain } : {}) });
    return undefined;
  };
  for (const group of intent.groupBy) { const refusal = addColumn(group.ref, 'group', group.role === 'time' ? group.grain : undefined); if (refusal) return { refusal }; }
  for (const ref of intent.display) { const refusal = addColumn(ref, 'display'); if (refusal) return { refusal }; }

  // Global filters and the time window, shared by every island.
  const filters: BoundPredicate[] = [];
  for (const predicate of intent.filters) {
    const bound = bindPredicate(predicate);
    if ('tier' in bound) return { refusal: bound };
    filters.push(bound);
  }
  let window: { relation: string; column: string; start: string; end: string } | undefined;
  if (intent.time?.window && intent.time.ref) {
    const physical = physicalOf(vocabulary.get(intent.time.ref));
    if (physical?.column) window = { relation: physical.relation, column: physical.column, start: intent.time.window.start, end: intent.time.window.end };
  }
  const scopes = new Map<PhysicalMeasure, BoundPredicate[]>();
  for (const measure of measures) {
    const bound: BoundPredicate[] = [];
    for (const predicate of measure.scope) {
      const item = bindPredicate(predicate);
      if ('tier' in item) return { refusal: item };
      bound.push(item);
    }
    scopes.set(measure, bound);
  }

  const everyRelation = new Set<string>([...measures.map((m) => m.relation), ...columns.map((c) => c.relation), ...filters.map((f) => f.relation), ...(window ? [window.relation] : []), ...[...scopes.values()].flat().map((s) => s.relation)]);
  const denial = deps.policyDenies?.([...everyRelation]);
  if (denial) return refuse('policy_denied', denial);

  // One island per fact relation.
  const islandOrder: string[] = [];
  for (const measure of measures) if (!islandOrder.includes(measure.relation)) islandOrder.push(measure.relation);
  const params: unknown[] = [];
  const joinedAll = new Set<string>();
  const islandSql: string[] = [];
  for (const base of islandOrder) {
    const islandMeasures = measures.filter((measure) => measure.relation === base);
    const needed = new Set<string>([...columns.map((c) => c.relation), ...filters.map((f) => f.relation), ...(window ? [window.relation] : []), ...islandMeasures.flatMap((m) => (scopes.get(m) ?? []).map((s) => s.relation))]);
    const joins: string[] = [];
    const joined = new Set([base]);
    for (const relation of needed) {
      if (joined.has(relation)) continue;
      const path = deps.joinPath?.(base, relation);
      if (!path || path.length === 0) return refuse('join_path_required', `no governed join path from ${base} to ${relation}`);
      for (const step of path) {
        if (joined.has(step.relation)) continue;
        joins.push(`JOIN ${qualifyRelation(dialect, step.relation)} ON ${step.on}`);
        joined.add(step.relation);
      }
    }
    for (const relation of joined) joinedAll.add(relation);
    const where: string[] = [];
    for (const filter of filters) where.push(predicateSql(dialect, filter, params));
    if (window) {
      const target = qualify(dialect, window.relation, window.column);
      params.push(window.start, window.end);
      where.push(`${target} >= ?`, `${target} < ?`);
    }
    const measureSql = islandMeasures.map((measure) => {
      if (measure.aggregate === 'derived') return `${measure.expr} AS ${dialect.quoteIdentifier(measure.alias)}`;
      const conditions = (scopes.get(measure) ?? []).map((scope) => predicateSql(dialect, scope, params));
      const expr = conditions.length === 0
        ? measure.expr
        : measure.aggregate === 'count' || measure.aggregate === 'count_distinct'
          ? `CASE WHEN ${conditions.join(' AND ')} THEN ${measure.expr} END`
          : `CASE WHEN ${conditions.join(' AND ')} THEN ${measure.expr} ELSE 0 END`;
      return `${AGG_SQL[measure.aggregate]!(expr)} AS ${dialect.quoteIdentifier(measure.alias)}`;
    });
    const select = [...columns.map((column) => `${column.expr} AS ${dialect.quoteIdentifier(column.alias)}`), ...measureSql];
    islandSql.push([
      `SELECT ${select.join(', ')}`,
      `FROM ${qualifyRelation(dialect, base)}`,
      ...joins,
      ...(where.length ? [`WHERE ${where.join(' AND ')}`] : []),
      ...(columns.length ? [`GROUP BY ${columns.map((column) => column.expr).join(', ')}`] : []),
    ].join('\n'));
  }

  // Ordering and limit apply to the final projection.
  let orderBy = '';
  if (intent.ordering) {
    const measureIndex = intent.ordering.ref.startsWith('measure:') ? Number(intent.ordering.ref.slice('measure:'.length)) || 0 : intent.measures.findIndex((measure) => measure.ref === intent.ordering!.ref);
    const target = measureIndex >= 0 ? measures[measureIndex]?.alias : columns.find((column) => vocabulary.get(intent.ordering!.ref)?.physical?.column === column.column || vocabulary.get(intent.ordering!.ref)?.name === column.column)?.alias;
    if (target) orderBy = `\nORDER BY ${dialect.quoteIdentifier(target)} ${intent.ordering.direction.toUpperCase()}`;
  } else if (columns.some((column) => column.grain)) {
    orderBy = `\nORDER BY ${columns.filter((column) => column.grain).map((column) => dialect.quoteIdentifier(column.alias)).join(', ')}`;
  }
  const limit = intent.limit ? `\n${dialect.limitClause(intent.limit)}` : '';

  let sql: string;
  let proof: string;
  if (islandSql.length === 1) {
    sql = islandSql[0]! + orderBy + limit;
    proof = `composed over ${[...joinedAll].join(', ')} along governed join paths${measures.some((m) => m.scope.length) ? ' with per-measure scope' : ''}`;
  } else {
    const names = islandOrder.map((_, index) => `island_${index + 1}`);
    const q = (name: string) => dialect.quoteIdentifier(name);
    const keys = columns.map((column) => column.alias);
    const ctes = islandSql.map((body, index) => `${names[index]} AS (\n${body}\n)`);
    let outer: string;
    if (keys.length === 0) {
      outer = `SELECT ${measures.map((measure) => `${names[islandOrder.indexOf(measure.relation)]}.${q(measure.alias)} AS ${q(measure.alias)}`).join(', ')}\nFROM ${names.join(' CROSS JOIN ')}`;
    } else {
      ctes.push(`grain_keys AS (\n${names.map((name) => `SELECT ${keys.map(q).join(', ')} FROM ${name}`).join('\nUNION\n')}\n)`);
      const joins = names.map((name) => `LEFT JOIN ${name} ON ${keys.map((key) => `grain_keys.${q(key)} = ${name}.${q(key)}`).join(' AND ')}`);
      outer = [
        `SELECT ${[...keys.map((key) => `grain_keys.${q(key)} AS ${q(key)}`), ...measures.map((measure) => `${names[islandOrder.indexOf(measure.relation)]}.${q(measure.alias)} AS ${q(measure.alias)}`)].join(', ')}`,
        'FROM grain_keys',
        ...joins,
      ].join('\n');
    }
    sql = `WITH ${ctes.join(',\n')}\n${outer}${orderBy}${limit}`;
    proof = `composed as ${islandSql.length} aggregate islands (${islandOrder.join(' | ')}) joined on ${keys.length ? keys.join(', ') : 'a single row'}, so measures of different grains never multiply each other`;
  }
  return {
    candidate: {
      tier: 'relational', trust: 'governed', sql, params,
      columns: [...columns.map((column) => column.alias), ...measures.map((measure) => measure.alias)],
      proof: [proof],
    },
  };
}

export function prepareRelational(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): { candidates: PreparedCandidate[]; refusals: PreparedRefusal[] } {
  try {
    const composed = composeRelational(intent, vocabulary, deps);
    return composed.candidate ? { candidates: [composed.candidate], refusals: [] } : { candidates: [], refusals: [composed.refusal!] };
  } catch (error) {
    return { candidates: [], refusals: [{ tier: 'relational', code: 'relational_compose_failed', message: error instanceof Error ? error.message : String(error), repairable: false }] };
  }
}
