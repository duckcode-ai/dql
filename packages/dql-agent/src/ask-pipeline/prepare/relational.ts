import type { AnalyticalIntentV1, IntentPredicate } from '../intent.js';
import { suggestSameGrainColumns, suggestSameRelationFields, type VocabularyEntry, type VocabularyIndex } from '../vocabulary.js';
import type { PrepareDeps, PreparedCandidate, PreparedRefusal, RelationalJoinStep, SqlDialectLike } from './types.js';

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

interface PhysicalMeasure { alias: string; aggregate: string; expr: string; relation: string; scope: IntentPredicate[]
  /** Aggregated over every row of the period instead of the row's group: a share's denominator. */
  overall?: boolean }
interface PhysicalColumn { alias: string; relation: string; column: string; expr: string; role: 'group' | 'display'; grain?: string }
interface BoundPredicate { predicate: IntentPredicate; relation: string; column: string; boolean: boolean; text: boolean; typing?: 'text' | 'numeric' | 'unknown' }

/**
 * Case folding belongs to text. A year the interpreter wrote as the string
 * "2017" against an integer season column must compile as a typed equality:
 * LOWER(INTEGER) is not a function any warehouse has, and the whole query
 * dies at the binder for a value that was always comparable.
 */
/**
 * Whether a column holds text. The vocabulary's declared type decides; when a
 * repo's metadata omits it, the column's role does (a key, a label or a
 * categorical value is text, a numeric or time column is not). Unknown stays
 * text, which is the behaviour every existing repo already compiles under.
 */
function columnTyping(entry: { dataType?: string; roles?: readonly string[] } | undefined): 'text' | 'numeric' | 'unknown' {
  const dataType = entry?.dataType?.toLowerCase();
  if (dataType) return /char|text|string|uuid|json|enum/.test(dataType) || !/int|decimal|numeric|number|float|double|real|bool|date|time|year/.test(dataType) ? 'text' : 'numeric';
  const roles = entry?.roles ?? [];
  if (roles.includes('numeric') || roles.includes('time') || roles.includes('boolean')) return 'numeric';
  if (roles.includes('label') || roles.includes('key')) return 'text';
  return 'unknown';
}
function isTextColumn(entry: { dataType?: string; roles?: readonly string[] } | undefined): boolean {
  return columnTyping(entry) === 'text';
}

function typedLiteral(value: unknown, isText: boolean): unknown {
  if (isText || typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return value;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : value;
}

const DEFAULT_DIALECT: SqlDialectLike = {
  quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
  dateTrunc: (grain, expr) => `date_trunc('${grain}', ${expr})`,
  limitClause: (limit) => `LIMIT ${limit}`,
};

const AGG_SQL: Record<string, (expr: string) => string> = {
  sum: (e) => `SUM(${e})`, avg: (e) => `AVG(${e})`, count: (e) => `COUNT(${e})`, count_distinct: (e) => `COUNT(DISTINCT ${e})`,
  min: (e) => `MIN(${e})`, max: (e) => `MAX(${e})`, median: (e) => `MEDIAN(${e})`,
};

/** The aggregates a CASE can restrict truthfully, and what an excluded row reads as. */
const SCOPABLE_AGGREGATES = new Set(['sum', 'count', 'count_distinct', 'avg', 'min', 'max', 'median']);
const PASS_THROUGH_FUNCTIONS = new Set(['nullif', 'coalesce', 'cast', 'abs', 'round']);

/**
 * A RESTRICTED AGGREGATE. The restriction goes INSIDE the aggregate, so two
 * measures of one relation keep their own populations. Only a sum may read 0
 * for an excluded row: a count would count it, an average would be dragged
 * toward zero by it, and a minimum would become it.
 */
export function restrictedAggregateArgument(expr: string, aggregate: string, conditions: string[]): string {
  if (conditions.length === 0) return expr;
  return `CASE WHEN ${conditions.join(' AND ')} THEN ${expr}${aggregate === 'sum' ? ' ELSE 0' : ''} END`;
}

/**
 * A FORMULA CAN CARRY A PERIOD. A stored rate is one expression —
 * SUM(points) / NULLIF(SUM(games), 0) — and a per-measure restriction belongs
 * inside each of its aggregates, never around the quotient: restricting a
 * quotient restricts nothing, which is why "points per game in 2016 versus
 * 2017" could not be composed at all. Every aggregate call is rewritten by the
 * rule above; a formula holding anything this cannot prove (a call inside a
 * call, a function that is neither an aggregate nor plain arithmetic) is
 * refused rather than approximated.
 */
export function scopeFormulaAggregates(expr: string, renderConditions: () => string[]): string | undefined {
  // The restriction is rendered ONCE PER AGGREGATE, not once: each occurrence
  // carries its own placeholders, and a bound value belongs to exactly one.
  const first = renderConditions();
  if (first.length === 0) return expr;
  let conditions = first;
  let uses = 0;
  let out = '';
  let at = 0;
  let wrapped = 0;
  while (at < expr.length) {
    const call = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(expr.slice(at));
    if (!call) { out += expr.slice(at); break; }
    const open = at + call.index + call[0]!.length;
    out += expr.slice(at, open);
    const name = call[1]!.toLowerCase();
    if (!SCOPABLE_AGGREGATES.has(name)) {
      // Plain arithmetic wrappers are passed through and their arguments are
      // scanned for aggregates of their own; anything else is not proven.
      if (!PASS_THROUGH_FUNCTIONS.has(name)) return undefined;
      at = open;
      continue;
    }
    let depth = 1;
    let cursor = open;
    while (cursor < expr.length && depth > 0) {
      const char = expr[cursor];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) return undefined;
    const inner = expr.slice(open, cursor - 1);
    const distinct = /^\s*distinct\s+/i.exec(inner);
    const argument = distinct ? inner.slice(distinct[0].length) : inner;
    // Only plain arithmetic may live inside a restricted aggregate: an
    // aggregate of an aggregate, a window function, anything unrecognised, is
    // not something this rewrite can prove truthful.
    if ([...argument.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].some((inner) => !PASS_THROUGH_FUNCTIONS.has(inner[1]!.toLowerCase()))) return undefined;
    if (uses > 0) conditions = renderConditions();
    uses += 1;
    out += `${distinct ? 'DISTINCT ' : ''}${restrictedAggregateArgument(argument, distinct ? 'count_distinct' : name, conditions)})`;
    wrapped += 1;
    at = cursor;
  }
  return wrapped > 0 ? out : undefined;
}

// A physical name is rendered as the warehouse knows it; an alias is minted
// by this program and always quoted. Conflating the two named
// "consumption_metrics"."header" on Snowflake — an object that does not exist.
function physical(dialect: SqlDialectLike): (name: string) => string {
  return (name) => (dialect.quotePhysical ?? dialect.quoteIdentifier.bind(dialect))(name);
}

function qualifyRelation(dialect: SqlDialectLike, relation: string): string {
  if (dialect.qualifyRelation) return dialect.qualifyRelation(relation);
  return relation.split('.').map((part) => physical(dialect)(part)).join('.');
}

function qualify(dialect: SqlDialectLike, relation: string, column: string): string {
  return `${qualifyRelation(dialect, relation)}.${physical(dialect)(column)}`;
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
  // A column whose type nobody declared is compared by what the literal is:
  // a number binds as a number, text folds case through a cast, so neither a
  // year on an untyped integer nor a name on an untyped string can fail.
  const unknown = bound.typing === 'unknown';
  const numericLiteral = (value: unknown) => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim());
  const literal = (value: unknown) => (unknown ? typedLiteral(value, !numericLiteral(value)) : typedLiteral(value, bound.text));
  const foldable = unknown ? `LOWER(CAST(${target} AS VARCHAR))` : `LOWER(${target})`;
  switch (predicate.op) {
    case 'is_true': return `${target} = TRUE`;
    case 'is_false': return `${target} = FALSE`;
    case 'in': return `${target} IN (${predicate.values.map((value) => bind(literal(value))).join(', ')})`;
    case 'not_in': return `${target} NOT IN (${predicate.values.map((value) => bind(literal(value))).join(', ')})`;
    // Containment is a text operation; a non-text column is cast for it.
    case 'contains': return `LOWER(${bound.text ? target : `CAST(${target} AS VARCHAR)`}) LIKE ${bind(`%${String(predicate.values[0] ?? '').toLowerCase()}%`)}`;
    case 'neq': return `${target} <> ${bind(literal(predicate.values[0]))}`;
    case 'gt': return `${target} > ${bind(literal(predicate.values[0]))}`;
    case 'gte': return `${target} >= ${bind(literal(predicate.values[0]))}`;
    case 'lt': return `${target} < ${bind(literal(predicate.values[0]))}`;
    case 'lte': return `${target} <= ${bind(literal(predicate.values[0]))}`;
    default: {
      const value = predicate.values[0];
      // Text equality is case-insensitive: a quoted "ryan byrd" must find Ryan Byrd.
      if (typeof value === 'string' && (bound.text || (unknown && !numericLiteral(value)))) return `${foldable} = ${bind(value.toLowerCase())}`;
      return `${target} = ${bind(literal(value))}`;
    }
  }
}

interface VisibleMeasure {
  alias: string;
  kind: 'aggregate' | 'ratio' | 'derived' | 'change';
  /** The physical aggregate for `aggregate`; the parts for `ratio`; the inputs and formula for `derived`. */
  physical?: PhysicalMeasure;
  numerator?: RatioPart;
  denominator?: RatioPart;
  inputs?: Array<{ alias: string; measure: PhysicalMeasure }>;
  expr?: string;
  /** A change: the aliases of the two measures it subtracts, and how it reports them. */
  change?: { base: string; comparison: string; as: 'absolute' | 'percent' };
  /** Additive aggregates read 0 under `population: all`; anything else stays null. */
  zeroFill: boolean;
}

/** A governed derived formula: input aliases, numbers, + - * / and parentheses, nothing else. */
const DERIVED_FORMULA = /^[\sA-Za-z0-9_+\-*/().]+$/;

/** One side of a ratio: a plain aggregate, or a derived formula over island aggregates. */
type RatioPart = { measure: PhysicalMeasure } | { inputs: Array<{ alias: string; measure: PhysicalMeasure }>; expr: string };

const ADDITIVE = new Set(['sum', 'count', 'count_distinct']);

export function composeRelational(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): { candidate?: PreparedCandidate; refusal?: PreparedRefusal } {
  const dialect = deps.dialect ?? DEFAULT_DIALECT;
  const refuse = (code: PreparedRefusal['code'], message: string, repairable = false): { refusal: PreparedRefusal } => ({ refusal: { tier: 'relational', code, message, repairable } });

  const bindPredicate = (predicate: IntentPredicate): BoundPredicate | PreparedRefusal => {
    const entry = vocabulary.get(predicate.ref);
    const physical = physicalOf(entry);
    if (!physical?.column) return { tier: 'relational', code: 'not_relational', message: `${predicate.ref} has no physical column binding`, repairable: false };
    return { predicate, relation: physical.relation, column: physical.column, boolean: Boolean(entry?.roles.includes('boolean')), text: isTextColumn(entry), typing: columnTyping(entry) };
  };

  // Measures, each bound to the fact relation it reads. A ratio contributes
  // two hidden aggregates and is projected afterwards as their quotient.
  const measures: PhysicalMeasure[] = [];
  const visible: VisibleMeasure[] = [];
  const usedJoins: RelationalJoinStep[] = [];
  const bindMeasure = (ref: string, alias: string, aggregation: string | undefined, scope: IntentPredicate[], overall = false): PhysicalMeasure | PreparedRefusal => {
    const entry = vocabulary.get(ref);
    const physical = physicalOf(entry);
    if (!physical && entry?.engineOnly) return { tier: 'relational', code: 'not_relational', message: `${ref} needs the semantic engine: ${entry.engineOnly}; the relational tier will not approximate it`, repairable: false };
    if (!physical) return { tier: 'relational', code: 'not_relational', message: `${ref} has no physical binding`, repairable: false };
    // The vocabulary owns a metric's aggregate; an intent aggregation applies to raw columns only.
    const aggregate = entry?.kind === 'column' ? (aggregation ?? physical.aggregate) : (physical.aggregate ?? aggregation);
    if (!aggregate || (!AGG_SQL[aggregate] && aggregate !== 'derived')) return { tier: 'relational', code: 'not_relational', message: `${ref} needs an aggregation`, repairable: true };
    const expr = physical.expr ?? (physical.column ? qualify(dialect, physical.relation, physical.column) : undefined);
    if (!expr) return { tier: 'relational', code: 'not_relational', message: `${ref} has no expression`, repairable: false };
    // A stored rate carries its own period by restricting each aggregate in
    // its formula; a formula this cannot rewrite says so instead.
    if (aggregate === 'derived' && scope.length && !scopeFormulaAggregates(expr, () => ['1 = 1'])) {
      return { tier: 'relational', code: 'not_relational', message: `${ref} is a derived metric whose formula cannot carry a per-measure restriction`, repairable: false };
    }
    const bound: PhysicalMeasure = { alias, aggregate, expr, relation: physical.relation, scope, ...(overall ? { overall: true } : {}) };
    measures.push(bound);
    return bound;
  };
  // A ratio part or a derived measure whose vocabulary entry is itself a
  // cross-relation formula binds every input as its own island aggregate.
  const bindFormula = (ref: string, prefix: string, scope: IntentPredicate[]): { inputs: Array<{ alias: string; measure: PhysicalMeasure }>; expr: string } | PreparedRefusal => {
    const entry = vocabulary.get(ref)!;
    if (!DERIVED_FORMULA.test(entry.derived!.expr)) return { tier: 'relational', code: 'not_relational', message: `${ref} has a formula the relational tier cannot evaluate safely`, repairable: false };
    const inputs: Array<{ alias: string; measure: PhysicalMeasure }> = [];
    for (const input of entry.derived!.inputs) {
      // A restriction on the formula is a restriction on each of its inputs.
      const bound = bindMeasure(input.ref, `${prefix}_${input.alias}`, undefined, scope);
      if ('tier' in bound) return bound;
      inputs.push({ alias: input.alias, measure: bound });
    }
    return { inputs, expr: entry.derived!.expr };
  };
  const bindPart = (ref: string, prefix: string, scope: IntentPredicate[], aggregation?: string, overall = false): RatioPart | PreparedRefusal => {
    const entry = vocabulary.get(ref);
    if (entry?.derived && !physicalOf(entry)) {
      if (overall) return { tier: 'relational', code: 'not_relational', message: `${ref} is a derived metric; an overall denominator needs a simple aggregate`, repairable: false };
      return bindFormula(ref, prefix, scope);
    }
    const bound = bindMeasure(ref, prefix, aggregation, scope, overall);
    return 'tier' in bound ? bound : { measure: bound };
  };
  for (const [index, measure] of intent.measures.entries()) {
    if (measure.change) {
      // Its parts are two measures of this reading; they are resolved after the
      // loop, when every alias is known.
      visible.push({ alias: measure.alias ?? `change_${index + 1}`, kind: 'change', change: measure.change, zeroFill: false });
      continue;
    }
    if (measure.derived) {
      const alias = measure.alias ?? measure.ref.replace(/^ratio:/, '').replace(/[^A-Za-z0-9_]+/g, '_');
      const numerator = bindPart(measure.derived.numerator, `__num_${index + 1}`, measure.scope ?? [], measure.derived.numeratorAggregation);
      if ('tier' in numerator) return { refusal: numerator };
      const denominator = bindPart(measure.derived.denominator, `__den_${index + 1}`, measure.scope ?? [], measure.derived.denominatorAggregation, measure.derived.denominatorScope === 'overall');
      if ('tier' in denominator) return { refusal: denominator };
      visible.push({ alias, kind: 'ratio', numerator, denominator, zeroFill: false });
      continue;
    }
    const entry = vocabulary.get(measure.ref);
    const alias = measure.alias ?? entry?.name ?? measure.ref.split('.').pop() ?? 'value';
    if (entry?.derived && !physicalOf(entry)) {
      // A derived metric over several relations: each input is its own
      // island aggregate and the governed formula is evaluated afterwards.
      const formula = bindFormula(measure.ref, `__in_${index + 1}`, measure.scope ?? []);
      if ('tier' in formula) return { refusal: formula };
      visible.push({ alias, kind: 'derived', inputs: formula.inputs, expr: formula.expr, zeroFill: false });
      continue;
    }
    const bound = bindMeasure(measure.ref, alias, measure.aggregation, measure.scope ?? []);
    if ('tier' in bound) return { refusal: bound };
    visible.push({ alias, kind: 'aggregate', physical: bound, zeroFill: ADDITIVE.has(bound.aggregate) });
  }
  if (measures.length === 0) return refuse('not_relational', 'no measure to compose');
  // A change subtracts two measures of this reading. Both must be plain
  // aggregates that are actually projected, or the difference is a name with
  // nothing behind it.
  for (const measure of visible) {
    if (measure.kind !== 'change') continue;
    const parts = [measure.change!.base, measure.change!.comparison];
    // A period's rate is a ratio of this reading; the change between two
    // periods' rates compares the two ratios after both are computed.
    const missing = parts.filter((alias) => !visible.some((item) => (item.kind === 'aggregate' || item.kind === 'ratio' || item.kind === 'derived') && item.alias === alias));
    if (missing.length) return refuse('relational_compose_failed', `${measure.alias} compares ${parts.join(' and ')}, and this reading has no measure aliased ${missing.join(', ')}; give each period its own measure with that alias`, true);
  }

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
  // A threshold on an aggregated measure applies over the composed result.
  const thresholds = intent.filters.filter((predicate) => predicate.on === 'aggregate' || /^measure:\d+$/.test(predicate.ref));
  for (const predicate of intent.filters) {
    if (thresholds.includes(predicate)) continue;
    const bound = bindPredicate(predicate);
    if ('tier' in bound) return { refusal: bound };
    filters.push(bound);
  }
  let window: { relation: string; column: string; start: string; end: string } | undefined;
  if (intent.time?.window) {
    // A window is a restriction like any other: it is applied or the tier
    // refuses. It is never dropped.
    const physical = intent.time.ref ? physicalOf(vocabulary.get(intent.time.ref)) : undefined;
    if (!intent.time.ref) return { refusal: { tier: 'relational', code: 'not_relational', message: `the time window ${intent.time.window.start}..${intent.time.window.end} names no time dimension, and the measures' models declare none or several; say which time axis to use`, repairable: true } };
    if (!physical?.column) return { refusal: { tier: 'relational', code: 'not_relational', message: `${intent.time.ref} has no physical column to bound the time window on`, repairable: true } };
    window = { relation: physical.relation, column: physical.column, start: intent.time.window.start, end: intent.time.window.end };
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

  // POPULATION: every member of the grain's entity, from its own relation.
  // Entity-bound filters restrict the population; fact filters and the
  // window restrict only what is counted for each member.
  let population: { relation: string; filters: BoundPredicate[] } | undefined;
  if (intent.population === 'all') {
    const key = intent.groupBy.find((group) => group.role === 'key');
    const keyColumn = key ? columns.find((column) => column.role === 'group' && column.column === physicalOf(vocabulary.get(key.ref))?.column) : undefined;
    if (!key || !keyColumn) return refuse('not_relational', 'including every member needs an entity key in groupBy with a physical relation', true);
    if (columns.some((column) => column.grain)) return refuse('not_relational', 'including every member cannot be combined with a time axis');
    const off = columns.filter((column) => column.relation !== keyColumn.relation);
    if (off.length) return refuse('not_relational', `including every member of ${keyColumn.relation} needs its columns from that relation; ${off.map((column) => `${column.relation}.${column.column}`).join(', ')} live elsewhere`, true);
    population = { relation: keyColumn.relation, filters: filters.filter((filter) => filter.relation === keyColumn.relation) };
  }

  const everyRelation = new Set<string>([...measures.map((m) => m.relation), ...columns.map((c) => c.relation), ...filters.map((f) => f.relation), ...(window ? [window.relation] : []), ...[...scopes.values()].flat().map((s) => s.relation)]);
  const denial = deps.policyDenies?.([...everyRelation]);
  if (denial) return refuse('policy_denied', denial);

  // One island per fact relation; an overall denominator is its own
  // ungrouped island on that relation (same restrictions, no GROUP BY), so a
  // share divides each group by the whole period rather than by itself.
  const islandKeyOf = (measure: PhysicalMeasure) => (measure.overall ? `${measure.relation}#overall` : measure.relation);
  const islandOrder: string[] = [];
  for (const measure of measures) if (!islandOrder.includes(islandKeyOf(measure))) islandOrder.push(islandKeyOf(measure));
  const params: unknown[] = [];
  const joinedAll = new Set<string>();
  const islandSql: string[] = [];
  /** Fields read from the measures' own relation because the same column lives there. */
  const rebound = new Set<string>();
  for (const islandKey of islandOrder) {
    const base = islandKey.replace(/#overall$/, '');
    const overallIsland = islandKey.endsWith('#overall');
    const islandMeasures = measures.filter((measure) => islandKeyOf(measure) === islandKey);
    const islandColumns = overallIsland ? [] : columns;
    // The window binds to the island's own same-named time column when it
    // has one (an order date lives on orders and on order lines alike);
    // joining a finer relation only to filter by time would multiply rows.
    const islandWindow = window
      ? (vocabulary.entries.some((candidate) => candidate.kind === 'dimension' && candidate.roles.includes('time') && candidate.physical?.relation === base && candidate.physical.column === window!.column)
        ? { ...window, relation: base }
        : window)
      : undefined;
    // THE IDENTITY LIVES WHERE THE FACTS LIVE. A grouping, a label or a
    // filter on another relation with no governed join path is read from the
    // column of the SAME NAME on the relation this island measures, when it
    // has one: a player dimension defined on the season table and the
    // player_name column of the game table are the same column, spelled twice.
    // A name that is merely similar is never substituted — that stays a
    // refusal the interpreter can repair.
    // A dimension counts as much as a raw column: a project that declares the
    // season on both its season table and its game table has spelled one
    // column twice, and which spelling the reading happened to name should not
    // decide whether the question can be answered.
    const sameNameOnBase = (relation: string, column: string): boolean =>
      relation !== base
      && (deps.joinPath?.(base, relation)?.length ?? 0) === 0
      && vocabulary.entries.some((candidate) =>
        (candidate.kind === 'column' || candidate.kind === 'dimension')
        && (candidate.physical?.relation ?? candidate.model) === base
        && (candidate.physical?.column ?? candidate.name).toLowerCase() === column.toLowerCase());
    const islandColumnsBound = islandColumns.map((column) => {
      if (!sameNameOnBase(column.relation, column.column)) return column;
      const bound = qualify(dialect, base, column.column);
      rebound.add(`${column.relation}.${column.column} read from ${base}.${column.column}, the same column on the relation the measures come from`);
      return { ...column, relation: base, expr: column.grain ? dialect.dateTrunc(column.grain, bound) : bound };
    });
    const islandFilters = filters.map((filter) => {
      if (!sameNameOnBase(filter.relation, filter.column)) return filter;
      rebound.add(`${filter.relation}.${filter.column} read from ${base}.${filter.column}, the same column on the relation the measures come from`);
      return { ...filter, relation: base };
    });
    // A measure's own restriction is read the same way: "season = 2016" on the
    // season table restricts the game table's season column just as truthfully
    // when that is where this island's facts live.
    const islandScopes = new Map<PhysicalMeasure, BoundPredicate[]>();
    for (const measure of islandMeasures) {
      islandScopes.set(measure, (scopes.get(measure) ?? []).map((scope) => {
        if (!sameNameOnBase(scope.relation, scope.column)) return scope;
        rebound.add(`${scope.relation}.${scope.column} read from ${base}.${scope.column}, the same column on the relation the measures come from`);
        return { ...scope, relation: base };
      }));
    }
    const needed = new Set<string>([...islandColumnsBound.map((c) => c.relation), ...islandFilters.map((f) => f.relation), ...(islandWindow ? [islandWindow.relation] : []), ...islandMeasures.flatMap((m) => (islandScopes.get(m) ?? []).map((s) => s.relation))]);
    const joins: string[] = [];
    const joined = new Set([base]);
    for (const relation of needed) {
      if (joined.has(relation)) continue;
      const path = deps.joinPath?.(base, relation);
      // Mixed grains with no declared path is a reading the interpreter can
      // fix (measures from one relation, a period or grouping from another).
      if (!path || path.length === 0) {
        const moved = suggestSameGrainColumns(vocabulary, intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]), relation);
        // The base relation is where the measures and the period already live,
        // so the fields must move THERE, not the other way round.
        const fields = suggestSameRelationFields(vocabulary, [...intent.filters.map((filter) => filter.ref), ...intent.groupBy.map((group) => group.ref), ...intent.display], base);
        const hint = moved.length ? ` The same facts exist on ${relation}: ${moved.map((item) => `${item.from} -> ${item.to} (${item.aggregation})`).join('; ')}; read every measure from there and keep the period.` : '';
        const fieldHint = fields.length ? ` The same fields exist on ${base}: ${fields.map((item) => `${item.from} -> ${item.to}`).join('; ')}; restrict and group there instead.` : '';
        const unproven = deps.unprovenJoinPath?.(base, relation) ?? [];
        return { refusal: { tier: 'relational', code: 'join_path_required', message: `no governed join path from ${base} to ${relation}; read the question over one relation, taking the measures from the relation that carries the period or grouping.${hint}${fieldHint}`, repairable: true, relations: [base, relation], ...(unproven.length ? { unproven } : {}) } };
      }
      for (const step of path) {
        if (joined.has(step.relation)) continue;
        joins.push(`JOIN ${qualifyRelation(dialect, step.relation)} ON ${step.on}`);
        joined.add(step.relation);
        usedJoins.push(step);
      }
    }
    for (const relation of joined) joinedAll.add(relation);
    // Positional parameters bind in text order: the SELECT list (measure scopes)
    // precedes the WHERE clause (filters, window), so scopes push first.
    let unscopable: string | undefined;
    const measureSql = islandMeasures.map((measure) => {
      const scope = islandScopes.get(measure) ?? [];
      // Rendering a predicate pushes its bound values, so a formula that
      // repeats the restriction renders it again rather than reusing the text.
      const render = () => scope.map((predicate) => predicateSql(dialect, predicate, params));
      if (measure.aggregate === 'derived') {
        const scoped = scope.length === 0 ? measure.expr : scopeFormulaAggregates(measure.expr, render);
        if (!scoped) { unscopable = measure.alias; return ''; }
        return `${scoped} AS ${dialect.quoteIdentifier(measure.alias)}`;
      }
      const expr = restrictedAggregateArgument(measure.expr, measure.aggregate, render());
      return `${AGG_SQL[measure.aggregate]!(expr)} AS ${dialect.quoteIdentifier(measure.alias)}`;
    });
    if (unscopable) return refuse('not_relational', `${unscopable} is a derived metric whose formula cannot carry a per-measure restriction`, false);
    const where: string[] = [];
    for (const filter of islandFilters) where.push(predicateSql(dialect, filter, params));
    if (islandWindow) {
      const target = qualify(dialect, islandWindow.relation, islandWindow.column);
      params.push(islandWindow.start, islandWindow.end);
      where.push(`${target} >= ?`, `${target} < ?`);
    }
    const select = [...islandColumnsBound.map((column) => `${column.expr} AS ${dialect.quoteIdentifier(column.alias)}`), ...measureSql];
    islandSql.push([
      `SELECT ${select.join(', ')}`,
      `FROM ${qualifyRelation(dialect, base)}`,
      ...joins,
      ...(where.length ? [`WHERE ${where.join(' AND ')}`] : []),
      ...(islandColumnsBound.length ? [`GROUP BY ${islandColumnsBound.map((column) => column.expr).join(', ')}`] : []),
    ].join('\n'));
  }

  // The final projection: keys, then each visible measure. A ratio divides
  // its hidden aggregates; under a population, additive aggregates zero-fill.
  const q = (name: string) => dialect.quoteIdentifier(name);
  const names = islandOrder.map((_, index) => `island_${index + 1}`);
  const islandOf = (measure: PhysicalMeasure) => names[islandOrder.indexOf(islandKeyOf(measure))]!;
  // Grouped islands join on the keys; overall islands hold one row and cross-join.
  const groupedNames = names.filter((_, index) => !islandOrder[index]!.endsWith('#overall'));
  const overallNames = names.filter((_, index) => islandOrder[index]!.endsWith('#overall'));
  const crossOverall = overallNames.map((name) => `CROSS JOIN ${name}`);
  // Every input alias becomes its island column; a divisor is guarded.
  const renderFormula = (inputs: Array<{ alias: string; measure: PhysicalMeasure }>, expr: string): string => {
    let formula = expr;
    const sorted = [...inputs].sort((a, b) => b.alias.length - a.alias.length);
    for (const input of sorted) formula = formula.replace(new RegExp(`\\b${input.alias}\\b`, 'g'), `CAST(${islandOf(input.measure)}.${q(input.measure.alias)} AS DOUBLE)`);
    return `(${formula.replace(/\/\s*(CAST\([^()]*\([^()]*\)[^()]*\)|\([^()]*\)|[A-Za-z0-9_.]+)/g, (_match, divisor: string) => `/ NULLIF(${divisor}, 0)`)})`;
  };
  const renderPart = (part: RatioPart): string => 'measure' in part
    ? `CAST(${islandOf(part.measure)}.${q(part.measure.alias)} AS DOUBLE)`
    : renderFormula(part.inputs, part.expr);
  const columnOfAlias = (alias: string): string => {
    const target = visible.find((item) => item.alias === alias && (item.physical || item.kind === 'ratio' || item.kind === 'derived'))!;
    if (target.kind === 'ratio') return `(${renderPart(target.numerator!)} / NULLIF(${renderPart(target.denominator!)}, 0))`;
    if (target.kind === 'derived') return `(${renderFormula(target.inputs!, target.expr!)})`;
    return `CAST(${islandOf(target.physical!)}.${q(target.alias)} AS DOUBLE)`;
  };
  const projected = (measure: VisibleMeasure): string => {
    if (measure.kind === 'change') {
      const base = columnOfAlias(measure.change!.base);
      const comparison = columnOfAlias(measure.change!.comparison);
      const difference = `(${comparison} - ${base})`;
      return `${measure.change!.as === 'percent' ? `(${difference} / NULLIF(${base}, 0))` : difference} AS ${q(measure.alias)}`;
    }
    if (measure.kind === 'ratio') return `${renderPart(measure.numerator!)} / NULLIF(${renderPart(measure.denominator!)}, 0) AS ${q(measure.alias)}`;
    if (measure.kind === 'derived') return `${renderFormula(measure.inputs!, measure.expr!)} AS ${q(measure.alias)}`;
    const value = `${islandOf(measure.physical!)}.${q(measure.alias)}`;
    return `${population && measure.zeroFill ? `COALESCE(${value}, 0)` : value} AS ${q(measure.alias)}`;
  };
  const needsProjection = population !== undefined || islandSql.length > 1 || visible.some((measure) => measure.kind === 'ratio' || measure.kind === 'derived' || measure.kind === 'change');
  // Thresholds are rendered over the aggregated columns by alias.
  const thresholdSql = (extraParams: unknown[]): string[] => thresholds.map((predicate) => {
    const at = Number(predicate.ref.slice('measure:'.length));
    const alias = visible[at]?.alias;
    if (!alias) return '';
    const bind = (value: unknown) => { extraParams.push(value); return '?'; };
    const target = dialect.quoteIdentifier(alias);
    switch (predicate.op) {
      case 'gt': return `${target} > ${bind(predicate.values[0])}`;
      case 'gte': return `${target} >= ${bind(predicate.values[0])}`;
      case 'lt': return `${target} < ${bind(predicate.values[0])}`;
      case 'lte': return `${target} <= ${bind(predicate.values[0])}`;
      case 'eq': return `${target} = ${bind(predicate.values[0])}`;
      case 'neq': return `${target} <> ${bind(predicate.values[0])}`;
      default: return '';
    }
  }).filter(Boolean);
  for (const predicate of thresholds) {
    const at = Number(predicate.ref.slice('measure:'.length));
    if (!visible[at]) return refuse('not_relational', `${predicate.ref} names no measure of this reading`, true);
    if (!['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(predicate.op)) return refuse('not_relational', `a threshold on ${visible[at]!.alias} needs a comparison, not ${predicate.op}`, true);
  }

  // Ordering and limit apply to the final projection.
  let orderBy = '';
  // A limit with no ordering returns whichever rows the warehouse happened to
  // produce and calls them the top ones. A lookup may take any few rows; a
  // ranking may not.
  if (intent.limit !== undefined && !intent.ordering && intent.expectedShape !== 'lookup') {
    return refuse('relational_compose_failed', `this reading takes the first ${intent.limit} rows with no ordering, so which rows come back is arbitrary; order by one of ${visible.map((measure) => measure.alias).join(', ')}`, true);
  }
  let orderingAlias: string | undefined;
  if (intent.ordering) {
    const measureIndex = intent.ordering.ref.startsWith('measure:') ? Number(intent.ordering.ref.slice('measure:'.length)) || 0 : intent.measures.findIndex((measure) => measure.ref === intent.ordering!.ref);
    const target = measureIndex >= 0
      ? visible[measureIndex]?.alias
      : visible.find((measure) => measure.alias === intent.ordering!.ref.replace(/^(?:metric|measure|column|dimension):/, ''))?.alias
        ?? columns.find((column) => vocabulary.get(intent.ordering!.ref)?.physical?.column === column.column || vocabulary.get(intent.ordering!.ref)?.name === column.column)?.alias;
    // An ordering that names nothing in this reading must not simply vanish: a
    // limit over an unordered query returns an arbitrary ten rows and calls
    // them the top ten.
    if (!target) return refuse('relational_compose_failed', `the ordering ${intent.ordering.ref} names nothing this reading projects; order by one of ${[...visible.map((measure) => measure.alias), ...columns.map((column) => column.alias)].join(', ')}`, true);
    orderBy = `\nORDER BY ${dialect.quoteIdentifier(target)} ${intent.ordering.direction.toUpperCase()}`;
    orderingAlias = target;
  } else if (columns.some((column) => column.grain)) {
    orderBy = `\nORDER BY ${columns.filter((column) => column.grain).map((column) => dialect.quoteIdentifier(column.alias)).join(', ')}`;
  }
  // A question that asks for THE best fetches one row more than it shows: two
  // rows with the same value are two leaders, and picking one of them without
  // saying so is a coin toss presented as an answer.
  const tieProbe = intent.limit === 1 && orderingAlias ? { column: orderingAlias, limit: 1 } : undefined;
  const limit = intent.limit ? `\n${dialect.limitClause(intent.limit + (tieProbe ? 1 : 0))}` : '';

  let sql: string;
  const proof: string[] = [...rebound];
  const keys = columns.map((column) => column.alias);
  const thresholdParams: unknown[] = [];
  const thresholdWhere = thresholdSql(thresholdParams);
  const withThresholds = (body: string): string => {
    if (!thresholdWhere.length) return body + orderBy + limit;
    params.push(...thresholdParams);
    proof.push(`applied after aggregation: ${thresholds.map((predicate) => `${visible[Number(predicate.ref.slice('measure:'.length))]!.alias} ${predicate.op} ${predicate.values.join('/')}`).join(', ')}`);
    return `SELECT * FROM (\n${body}\n) AS aggregated\nWHERE ${thresholdWhere.join(' AND ')}${orderBy}${limit}`;
  };
  if (!needsProjection) {
    sql = withThresholds(islandSql[0]!);
    proof.push(`composed over ${[...joinedAll].join(', ')} along governed join paths${measures.some((m) => m.scope.length) ? ' with per-measure scope' : ''}`);
  } else {
    const ctes = islandSql.map((body, index) => `${names[index]} AS (\n${body}\n)`);
    let outer: string;
    if (population) {
      // The population CTE enumerates the members; islands attach by key.
      const populationParams: unknown[] = [];
      const populationWhere = population.filters.map((filter) => predicateSql(dialect, filter, populationParams));
      params.unshift(...populationParams);
      ctes.unshift(`population AS (\nSELECT DISTINCT ${columns.map((column) => `${column.expr} AS ${q(column.alias)}`).join(', ')}\nFROM ${qualifyRelation(dialect, population.relation)}${populationWhere.length ? `\nWHERE ${populationWhere.join(' AND ')}` : ''}\n)`);
      const joins = groupedNames.map((name) => `LEFT JOIN ${name} ON ${keys.map((key) => `population.${q(key)} = ${name}.${q(key)}`).join(' AND ')}`);
      outer = [
        `SELECT ${[...keys.map((key) => `population.${q(key)} AS ${q(key)}`), ...visible.map(projected)].join(', ')}`,
        'FROM population',
        ...joins,
        ...crossOverall,
      ].join('\n');
      proof.push(`every member of ${population.relation} is a row (${columns.length ? keys.join(', ') : 'no key'}); ${visible.filter((measure) => measure.zeroFill).map((measure) => measure.alias).join(', ') || 'no measure'} read 0 where nothing matched${visible.some((measure) => !measure.zeroFill) ? `; ${visible.filter((measure) => !measure.zeroFill).map((measure) => measure.alias).join(', ')} stay null` : ''}`);
    } else if (keys.length === 0) {
      outer = `SELECT ${visible.map(projected).join(', ')}\nFROM ${names.join(' CROSS JOIN ')}`;
    } else if (groupedNames.length === 1) {
      outer = [`SELECT ${[...keys.map((key) => `${groupedNames[0]}.${q(key)} AS ${q(key)}`), ...visible.map(projected)].join(', ')}`, `FROM ${groupedNames[0]}`, ...crossOverall].join('\n');
    } else {
      ctes.push(`grain_keys AS (\n${groupedNames.map((name) => `SELECT ${keys.map(q).join(', ')} FROM ${name}`).join('\nUNION\n')}\n)`);
      const joins = groupedNames.map((name) => `LEFT JOIN ${name} ON ${keys.map((key) => `grain_keys.${q(key)} = ${name}.${q(key)}`).join(' AND ')}`);
      outer = [
        `SELECT ${[...keys.map((key) => `grain_keys.${q(key)} AS ${q(key)}`), ...visible.map(projected)].join(', ')}`,
        'FROM grain_keys',
        ...joins,
        ...crossOverall,
      ].join('\n');
    }
    sql = withThresholds(`WITH ${ctes.join(',\n')}\n${outer}`);
    if (islandSql.length > 1) proof.push(`composed as ${islandSql.length} aggregate islands (${islandOrder.join(' | ')}) joined on ${keys.length ? keys.join(', ') : 'a single row'}, so measures of different grains never multiply each other`);
    else if (!population) proof.push(`composed over ${[...joinedAll].join(', ')} along governed join paths${measures.some((m) => m.scope.length) ? ' with per-measure scope' : ''}`);
    for (const measure of visible) {
      if (measure.kind === 'ratio') proof.push(`${measure.alias} = ${partLabel(vocabulary, measure.numerator!)} / ${partLabel(vocabulary, measure.denominator!)}${'measure' in measure.denominator! && measure.denominator.measure.overall ? ' over every row of the period (the denominator is not grouped, and is summed before any ranking or limit)' : ''}, divided after each part is aggregated (null when the denominator is 0)`);
      if (measure.kind === 'change') proof.push(`${measure.alias} = ${measure.change!.comparison} - ${measure.change!.base}${measure.change!.as === 'percent' ? `, over ${measure.change!.base}` : ''}, computed after both are aggregated${measure.change!.as === 'percent' ? ' (null when the earlier value is 0)' : ''}`);
      if (measure.kind === 'derived') proof.push(`${measure.alias} = ${measure.expr}, with ${measure.inputs!.map((input) => `${input.alias} = ${labelOf(vocabulary, input.measure)} on ${input.measure.relation}`).join(', ')}, evaluated after each input is aggregated on its own relation`);
    }
  }
  return {
    candidate: {
      tier: 'relational', trust: 'governed', sql, params,
      columns: [...columns.map((column) => column.alias), ...visible.map((measure) => measure.alias)],
      proof, ...(tieProbe ? { tieProbe } : {}), ...(usedJoins.length ? { joins: usedJoins } : {}),
      relations: [...new Set([...islandOrder.map((islandKey) => islandKey.replace(/#overall$/, '')), ...usedJoins.map((step) => step.relation)])],
    },
  };
}

function partLabel(vocabulary: VocabularyIndex, part: RatioPart): string {
  return 'measure' in part ? labelOf(vocabulary, part.measure) : `(${part.expr})`;
}

function labelOf(vocabulary: VocabularyIndex, measure: PhysicalMeasure): string {
  const entry = vocabulary.entries.find((candidate) => candidate.physical?.relation === measure.relation && (candidate.physical?.expr === measure.expr || (candidate.physical?.column && qualifyMatches(measure.expr, candidate.physical.column))));
  return entry?.label ?? entry?.name ?? measure.expr;
}

function qualifyMatches(expr: string, column: string): boolean {
  return expr.replace(/"/g, '').endsWith(`.${column}`);
}

export function prepareRelational(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): { candidates: PreparedCandidate[]; refusals: PreparedRefusal[] } {
  try {
    const composed = composeRelational(intent, vocabulary, deps);
    return composed.candidate ? { candidates: [composed.candidate], refusals: [] } : { candidates: [], refusals: [composed.refusal!] };
  } catch (error) {
    return { candidates: [], refusals: [{ tier: 'relational', code: 'relational_compose_failed', message: error instanceof Error ? error.message : String(error), repairable: false }] };
  }
}
