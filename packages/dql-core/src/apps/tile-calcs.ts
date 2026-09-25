/**
 * Governed calculations on a Dataset tile (RFC 0009 step 3).
 *
 * A calculation is a typed expression over the Dataset's approved measures,
 * never SQL. This module checks it (units, additivity, which quick
 * calculations are true for a measure), parses the formula an author types,
 * and prints it back. The server compiles the same shape into the tile's SQL,
 * so the receipt and fingerprints cover it. Browser-safe: no Node APIs.
 */
import {
  datasetMeasureField,
  datasetPhysicalField,
  type DatasetDescriptor,
  type DatasetMeasureField,
} from '../datasets/descriptor.js';
import type {
  TileCalcExpr,
  TileCalculation,
  TileFilterOperator,
  TileQuery,
  TileQueryFilter,
  TileQuickCalcKind,
} from './tile-query-types.js';

export type { TileCalcExpr, TileCalculation, TileQuickCalcKind } from './tile-query-types.js';

export const MAX_TILE_CALCULATIONS = 12;
const MAX_EXPR_NODES = 40;
const MAX_WHERE = 6;
const WHERE_OPS = new Set<TileFilterOperator>(['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte']);
export const QUICK_CALC_KINDS: readonly TileQuickCalcKind[] = [
  'percent_of_total', 'running_total', 'difference', 'percent_difference', 'rank', 'moving_average', 'year_over_year',
];
/** Year over year pairs a period with the same one a year earlier; these grains have one. */
const YEAR_OVER_YEAR_GRAINS = new Set(['month', 'quarter', 'year']);

export interface TileCalcDiagnostic {
  code: 'INVALID_CALCULATION';
  message: string;
  field?: string;
}

/** What a value means, so arithmetic can refuse mixing units quietly. */
export type TileCalcUnit =
  | { kind: 'currency'; currency?: string }
  | { kind: 'ratio' }
  | { kind: 'count' }
  | { kind: 'number' };

export interface TileCalcFacts {
  unit: TileCalcUnit;
  /** Whether group values add up to the total across entities and across time. */
  additive: { entities: boolean; time: boolean };
  /** A ratio or average: averaging it again would average ratios. */
  ratioLike: boolean;
  constant: boolean;
}

export interface TileCalcOutput {
  id: string;
  label: string;
  kind: 'measure' | 'quick';
  facts: TileCalcFacts;
  format: NonNullable<TileCalculation['format']>;
  /** Plain words for the receipt: "revenue / orders", "Running total of revenue along month". */
  description: string;
}

export interface TileCalcCheck {
  diagnostics: TileCalcDiagnostic[];
  outputs: TileCalcOutput[];
  /** Dataset measures the calculated measures read, selected or not. */
  referencedMeasures: string[];
}

export const QUICK_CALC_LABELS: Record<TileQuickCalcKind, string> = {
  percent_of_total: 'Percent of total',
  running_total: 'Running total',
  difference: 'Difference from previous',
  percent_difference: 'Percent difference from previous',
  rank: 'Rank',
  moving_average: 'Moving average',
  year_over_year: 'Year over year change',
};

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export function normalizeTileCalculations(value: unknown): TileCalculation[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TILE_CALCULATIONS) return undefined;
  const calculations: TileCalculation[] = [];
  for (const item of value) {
    if (!isRecord(item) || !onlyKeys(item, ['id', 'label', 'expr', 'quick', 'format'])) return undefined;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!safeIdentifier(id)) return undefined;
    if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 120)) return undefined;
    const hasExpr = item.expr !== undefined;
    const hasQuick = item.quick !== undefined;
    if (hasExpr === hasQuick) return undefined;
    const calculation: TileCalculation = { id, ...(typeof item.label === 'string' && item.label.trim() ? { label: item.label.trim() } : {}) };
    if (hasExpr) {
      const counter = { nodes: 0 };
      const expr = normalizeExpr(item.expr, counter);
      if (!expr) return undefined;
      calculation.expr = expr;
    } else {
      const quick = normalizeQuick(item.quick);
      if (!quick) return undefined;
      calculation.quick = quick;
    }
    if (item.format !== undefined) {
      const format = normalizeFormat(item.format);
      if (!format) return undefined;
      calculation.format = format;
    }
    calculations.push(calculation);
  }
  return calculations;
}

function normalizeExpr(value: unknown, counter: { nodes: number }): TileCalcExpr | undefined {
  counter.nodes += 1;
  if (counter.nodes > MAX_EXPR_NODES || !isRecord(value)) return undefined;
  if ('number' in value) {
    return onlyKeys(value, ['number']) && typeof value.number === 'number' && Number.isFinite(value.number) ? { number: value.number } : undefined;
  }
  if ('measure' in value) {
    if (!onlyKeys(value, ['measure', 'where']) || typeof value.measure !== 'string' || !value.measure.trim()) return undefined;
    if (value.where === undefined) return { measure: value.measure.trim() };
    if (!Array.isArray(value.where) || value.where.length === 0 || value.where.length > MAX_WHERE) return undefined;
    const where: TileQueryFilter[] = [];
    for (const raw of value.where) {
      if (!isRecord(raw) || !onlyKeys(raw, ['field', 'op', 'values'])) return undefined;
      if (typeof raw.field !== 'string' || !raw.field.trim() || typeof raw.op !== 'string' || !WHERE_OPS.has(raw.op as TileFilterOperator)) return undefined;
      if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.length > 100) return undefined;
      if (!raw.values.every((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')) return undefined;
      where.push({ field: raw.field.trim(), op: raw.op as TileFilterOperator, values: [...raw.values] });
    }
    return { measure: value.measure.trim(), where };
  }
  if (!onlyKeys(value, ['op', 'left', 'right'])) return undefined;
  if (value.op !== '+' && value.op !== '-' && value.op !== '*' && value.op !== '/') return undefined;
  const left = normalizeExpr(value.left, counter);
  const right = left ? normalizeExpr(value.right, counter) : undefined;
  return left && right ? { op: value.op, left, right } : undefined;
}

function normalizeQuick(value: unknown): TileCalculation['quick'] | undefined {
  if (!isRecord(value) || !onlyKeys(value, ['kind', 'of', 'along', 'within', 'window'])) return undefined;
  if (typeof value.kind !== 'string' || !QUICK_CALC_KINDS.includes(value.kind as TileQuickCalcKind)) return undefined;
  if (typeof value.of !== 'string' || !safeIdentifier(value.of.trim())) return undefined;
  for (const key of ['along', 'within'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !safeIdentifier((value[key] as string).trim()))) return undefined;
  }
  if (value.window !== undefined && (typeof value.window !== 'number' || !Number.isInteger(value.window) || value.window < 2 || value.window > 24)) return undefined;
  return {
    kind: value.kind as TileQuickCalcKind,
    of: value.of.trim(),
    ...(typeof value.along === 'string' ? { along: value.along.trim() } : {}),
    ...(typeof value.within === 'string' ? { within: value.within.trim() } : {}),
    ...(typeof value.window === 'number' ? { window: value.window } : {}),
  };
}

function normalizeFormat(value: unknown): TileCalculation['format'] | undefined {
  if (!isRecord(value) || !onlyKeys(value, ['kind', 'currency', 'decimals'])) return undefined;
  if (value.kind !== 'number' && value.kind !== 'currency' && value.kind !== 'percent') return undefined;
  if (value.currency !== undefined && (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))) return undefined;
  if (value.decimals !== undefined && (typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 6)) return undefined;
  return {
    kind: value.kind,
    ...(typeof value.currency === 'string' ? { currency: value.currency } : {}),
    ...(typeof value.decimals === 'number' ? { decimals: value.decimals } : {}),
  };
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/** What a Dataset measure means for arithmetic. */
export function measureCalcFacts(measure: DatasetMeasureField): TileCalcFacts {
  const unit: TileCalcUnit = measure.format?.kind === 'currency'
    ? { kind: 'currency', ...(measure.format.currency ? { currency: measure.format.currency } : {}) }
    : measure.format?.kind === 'percent' || measure.aggregation === 'ratio'
      ? { kind: 'ratio' }
      : measure.aggregation === 'count' || measure.aggregation === 'count_distinct'
        ? { kind: 'count' }
        : { kind: 'number' };
  const ratioLike = measure.aggregation === 'ratio' || measure.aggregation === 'avg' || unit.kind === 'ratio'
    || Boolean(measure.expression && expressionDivides(measure.expression));
  return {
    unit,
    additive: {
      entities: measure.additivity.entities === 'additive' && !ratioLike,
      time: measure.additivity.time === 'additive' && !ratioLike,
    },
    ratioLike,
    constant: false,
  };
}

function expressionDivides(node: unknown): boolean {
  if (!isRecord(node)) return false;
  if (node.kind === 'binary') return node.operator === '/' || expressionDivides(node.left) || expressionDivides(node.right);
  if (node.kind === 'nullif_zero') return expressionDivides(node.value);
  return false;
}

/**
 * Check every calculation on a query against its Dataset. Refusals name the
 * rule in the author's terms ("orders is a distinct count; …").
 */
export function checkTileCalculations(descriptor: DatasetDescriptor, query: TileQuery): TileCalcCheck {
  const diagnostics: TileCalcDiagnostic[] = [];
  const outputs: TileCalcOutput[] = [];
  const referenced = new Set<string>();
  const calculations = query.calculations ?? [];
  if (calculations.length === 0) return { diagnostics, outputs, referencedMeasures: [] };
  const refuse = (message: string, field?: string) => diagnostics.push({ code: 'INVALID_CALCULATION', message, ...(field ? { field } : {}) });
  if (calculations.length > MAX_TILE_CALCULATIONS) refuse(`A tile can hold at most ${MAX_TILE_CALCULATIONS} calculations.`);
  if (query.detail) refuse('Calculations need grouped rows; a row-detail tile cannot have them.');
  if (query.comparison) refuse('A period-comparison tile already calculates its changes; remove the comparison to add calculations.');
  if (descriptor.kind === 'semantic' || descriptor.execution.route === 'semantic') {
    refuse(`${descriptor.label} is defined in a semantic model; add the calculation there so every tool shares it.`);
  }

  // Outputs a quick calculation may run over: selected measures, then calculated measures.
  const measureOutputs = new Map<string, { label: string; facts: TileCalcFacts; format?: TileCalculation['format'] }>();
  for (const selection of query.measures) {
    const measure = datasetMeasureField(descriptor, selection.measure);
    if (!measure) continue;
    measureOutputs.set((selection.alias ?? measure.name).toLowerCase(), { label: measure.name, facts: measureCalcFacts(measure), ...(measure.format ? { format: measure.format } : {}) });
  }
  const dimensionOutputs = query.dimensions.map((dimension) => ({
    alias: dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field),
    field: dimension.field,
    ...(dimension.timeGrain ? { timeGrain: dimension.timeGrain } : {}),
  }));
  const taken = new Set([...dimensionOutputs.map((output) => output.alias.toLowerCase()), ...measureOutputs.keys()]);

  for (const calculation of calculations) {
    const id = calculation.id;
    if (taken.has(id.toLowerCase())) {
      refuse(`The name ${id} is already used by another column on this tile.`, id);
      continue;
    }
    taken.add(id.toLowerCase());
    if (calculation.expr) {
      const facts = exprFacts(descriptor, calculation.expr, id, refuse, referenced);
      if (!facts) continue;
      if (facts.constant) {
        refuse(`${calculation.label ?? id} has no measure in it; a calculation must use at least one measure.`, id);
        continue;
      }
      const label = calculation.label ?? id;
      measureOutputs.set(id.toLowerCase(), { label, facts, ...(calculation.format ? { format: calculation.format } : {}) });
      outputs.push({
        id,
        label,
        kind: 'measure',
        facts,
        format: calculation.format ?? formatForUnit(facts.unit),
        description: formatTileCalcExpr(calculation.expr),
      });
      continue;
    }
    const quick = calculation.quick!;
    const source = measureOutputs.get(quick.of.toLowerCase());
    if (!source) {
      refuse(`${QUICK_CALC_LABELS[quick.kind]} runs over a measure on this tile; ${quick.of} is not one.`, id);
      continue;
    }
    const verdict = quickCalcVerdict(quick.kind, source, dimensionOutputs, quick);
    if (verdict.refusal) {
      refuse(verdict.refusal, id);
      continue;
    }
    const facts = quickFacts(quick.kind, source.facts);
    const label = calculation.label ?? `${QUICK_CALC_LABELS[quick.kind]} of ${source.label}`;
    outputs.push({
      id,
      label,
      kind: 'quick',
      facts,
      format: calculation.format ?? quickFormat(quick.kind, source.format, facts.unit),
      description: describeQuickCalc(quick, source.label, verdict.along, verdict.within),
    });
  }
  return { diagnostics, outputs, referencedMeasures: [...referenced] };
}

function exprFacts(
  descriptor: DatasetDescriptor,
  expr: TileCalcExpr,
  id: string,
  refuse: (message: string, field?: string) => void,
  referenced: Set<string>,
): TileCalcFacts | undefined {
  if ('number' in expr) {
    return { unit: { kind: 'number' }, additive: { entities: true, time: true }, ratioLike: false, constant: true };
  }
  if ('measure' in expr) {
    const measure = datasetMeasureField(descriptor, expr.measure);
    if (!measure) {
      const column = datasetPhysicalField(descriptor, expr.measure);
      refuse(column
        ? `${expr.measure} is a column, not a measure. Calculations use the Dataset's measures so they keep its rules.`
        : `${expr.measure} is not a measure of ${descriptor.label}.`, id);
      return undefined;
    }
    if (measure.status !== 'approved') {
      refuse(`${measure.name} is a suggested measure; review it before using it in a calculation.`, id);
      return undefined;
    }
    referenced.add(measure.name);
    if (expr.where) {
      if (descriptor.grain.aggregate) {
        refuse(`${descriptor.label} is already aggregated, so ${measure.name} cannot be restricted to some rows; that needs row-level data.`, id);
        return undefined;
      }
      if (measure.expression || !(measure.from || (measure.aggregation === 'ratio' && measure.numerator && measure.denominator))) {
        refuse(`${measure.name} is itself a formula; restrict it by adding a filter to the tile instead.`, id);
        return undefined;
      }
      for (const condition of expr.where) {
        const field = datasetPhysicalField(descriptor, condition.field);
        if (!field || field.status !== 'approved' || !['dimension', 'attribute', 'time', 'key'].includes(field.role)) {
          refuse(`${condition.field} is not an approved field of ${descriptor.label}, so it cannot restrict ${measure.name}.`, id);
          return undefined;
        }
        if (!(condition.values ?? []).every((value) => valueMatches(value, field.type))) {
          refuse(`The value for ${condition.field} does not match its type (${field.type}).`, id);
          return undefined;
        }
        if ((condition.op === 'eq' || condition.op === 'neq' || condition.op === 'gt' || condition.op === 'gte' || condition.op === 'lt' || condition.op === 'lte') && (condition.values ?? []).length !== 1) {
          refuse(`${condition.field} ${condition.op} takes one value.`, id);
          return undefined;
        }
      }
    }
    return measureCalcFacts(measure);
  }
  const left = exprFacts(descriptor, expr.left, id, refuse, referenced);
  const right = exprFacts(descriptor, expr.right, id, refuse, referenced);
  if (!left || !right) return undefined;
  if (left.constant && right.constant) {
    return { unit: { kind: 'number' }, additive: { entities: true, time: true }, ratioLike: false, constant: true };
  }
  const describe = (node: TileCalcExpr) => formatTileCalcExpr(node);
  if (expr.op === '+' || expr.op === '-') {
    if (left.constant || right.constant) {
      // Adding a constant to every group no longer adds up to the total.
      const measure = left.constant ? right : left;
      return { ...measure, additive: { entities: false, time: false }, constant: false };
    }
    if (!sameUnit(left.unit, right.unit)) {
      refuse(`${describe(expr.left)} is ${unitWords(left.unit)} and ${describe(expr.right)} is ${unitWords(right.unit)}; they cannot be ${expr.op === '+' ? 'added' : 'subtracted'}.`, id);
      return undefined;
    }
    return {
      unit: left.unit,
      additive: { entities: left.additive.entities && right.additive.entities, time: left.additive.time && right.additive.time },
      ratioLike: left.ratioLike || right.ratioLike,
      constant: false,
    };
  }
  if (expr.op === '*') {
    if (left.constant || right.constant) return { ...(left.constant ? right : left), constant: false };
    return { unit: { kind: 'number' }, additive: { entities: false, time: false }, ratioLike: false, constant: false };
  }
  // Division.
  if (right.constant) {
    if ('number' in expr.right && expr.right.number === 0) {
      refuse('A calculation cannot divide by zero.', id);
      return undefined;
    }
    return { ...left, constant: false };
  }
  if (left.constant) return { unit: { kind: 'number' }, additive: { entities: false, time: false }, ratioLike: true, constant: false };
  const unit: TileCalcUnit = sameUnit(left.unit, right.unit)
    ? { kind: 'ratio' }
    : left.unit.kind === 'currency' && right.unit.kind === 'count'
      ? left.unit
      : { kind: 'number' };
  return { unit, additive: { entities: false, time: false }, ratioLike: true, constant: false };
}

interface QuickVerdict {
  refusal?: string;
  along?: string;
  within?: string;
}

/**
 * Whether a quick calculation is true for this measure on this tile. Menus
 * use it to grey out items with the reason; the checker uses it to refuse.
 */
export function quickCalcVerdict(
  kind: TileQuickCalcKind,
  source: { label: string; facts: TileCalcFacts },
  dimensions: Array<{ alias: string; field: string; timeGrain?: string }>,
  options: { along?: string; within?: string; window?: number } = {},
): QuickVerdict {
  const name = source.label;
  const find = (alias: string | undefined) => (alias ? dimensions.find((dimension) => dimension.alias.toLowerCase() === alias.toLowerCase()) : undefined);
  if (options.along && !find(options.along)) return { refusal: `${options.along} is not a dimension on this tile.` };
  if (options.within && !find(options.within)) return { refusal: `${options.within} is not a dimension on this tile.` };
  const timeDimension = dimensions.find((dimension) => dimension.timeGrain);
  const along = find(options.along) ?? timeDimension ?? dimensions[0];
  const within = find(options.within);
  const why = whyNotAdditive(source);
  if (kind === 'percent_of_total') {
    if (dimensions.length === 0) return { refusal: 'Percent of total needs a dimension to split the total by.' };
    // The total spans every row outside `within`; the measure must add up across them.
    const spansTime = dimensions.some((dimension) => dimension.timeGrain && dimension !== within);
    const spansEntities = dimensions.some((dimension) => !dimension.timeGrain && dimension !== within);
    if ((spansEntities && !source.facts.additive.entities) || (spansTime && !source.facts.additive.time)) {
      return { refusal: `${name} ${why}, so its parts do not add up to a total and a share of it would be wrong.` };
    }
    return { ...(within ? { within: within.alias } : {}) };
  }
  if (kind === 'rank') {
    if (dimensions.length === 0) return { refusal: 'Rank needs a dimension to rank.' };
    return { ...(within ? { within: within.alias } : {}) };
  }
  if (!along) return { refusal: `${QUICK_CALC_LABELS[kind]} needs a dimension to run along.` };
  if (kind === 'running_total') {
    const additive = along.timeGrain ? source.facts.additive.time : source.facts.additive.entities;
    if (!additive) return { refusal: `${name} ${why}, so adding it up along ${along.alias} would double count.` };
  }
  if (kind === 'moving_average' && source.facts.ratioLike) {
    return { refusal: `${name} is a ratio or average; a moving average would average ratios. Average its parts instead.` };
  }
  if (kind === 'year_over_year') {
    if (!along.timeGrain || !YEAR_OVER_YEAR_GRAINS.has(along.timeGrain)) {
      return { refusal: 'Year over year needs a date by month, quarter or year on this tile.' };
    }
  }
  return { along: along.alias };
}

function whyNotAdditive(source: { facts: TileCalcFacts; label: string }): string {
  if (source.facts.ratioLike) return 'is a ratio or average';
  if (source.facts.unit.kind === 'count') return 'is a distinct count';
  return 'does not add up across rows';
}

function quickFacts(kind: TileQuickCalcKind, source: TileCalcFacts): TileCalcFacts {
  if (kind === 'percent_of_total' || kind === 'percent_difference' || kind === 'year_over_year') {
    return { unit: { kind: 'ratio' }, additive: { entities: kind === 'percent_of_total', time: false }, ratioLike: true, constant: false };
  }
  if (kind === 'rank') return { unit: { kind: 'number' }, additive: { entities: false, time: false }, ratioLike: false, constant: false };
  if (kind === 'moving_average') return { ...source, additive: { entities: false, time: false }, ratioLike: true };
  return { ...source, additive: { entities: false, time: false } };
}

function quickFormat(kind: TileQuickCalcKind, sourceFormat: TileCalculation['format'] | undefined, unit: TileCalcUnit): NonNullable<TileCalculation['format']> {
  if (kind === 'percent_of_total' || kind === 'percent_difference' || kind === 'year_over_year') return { kind: 'percent', decimals: 1 };
  if (kind === 'rank') return { kind: 'number', decimals: 0 };
  return sourceFormat ?? formatForUnit(unit);
}

function formatForUnit(unit: TileCalcUnit): NonNullable<TileCalculation['format']> {
  if (unit.kind === 'currency') return { kind: 'currency', ...(unit.currency ? { currency: unit.currency } : {}) };
  if (unit.kind === 'ratio') return { kind: 'percent', decimals: 1 };
  return { kind: 'number' };
}

function sameUnit(left: TileCalcUnit, right: TileCalcUnit): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'currency' && right.kind === 'currency') return !left.currency || !right.currency || left.currency === right.currency;
  return true;
}

function unitWords(unit: TileCalcUnit): string {
  if (unit.kind === 'currency') return unit.currency ? `money (${unit.currency})` : 'money';
  if (unit.kind === 'ratio') return 'a rate';
  if (unit.kind === 'count') return 'a count';
  return 'a number';
}

function describeQuickCalc(quick: NonNullable<TileCalculation['quick']>, of: string, along?: string, within?: string): string {
  const base = `${QUICK_CALC_LABELS[quick.kind]} of ${of}`;
  if (quick.kind === 'percent_of_total' || quick.kind === 'rank') return within ? `${base} within each ${within}` : base;
  if (quick.kind === 'moving_average') return `${quick.window ?? 3}-period moving average of ${of} along ${along}`;
  return along ? `${base} along ${along}` : base;
}

/** Output aliases a calculation adds, for column lists and ordering. */
export function tileCalculationOutputs(query: TileQuery): Array<{ alias: string; kind: 'measure' }> {
  return (query.calculations ?? []).map((calculation) => ({ alias: calculation.id, kind: 'measure' as const }));
}

/** Every Dataset measure a query's calculated measures read. */
export function tileCalcMeasureReferences(query: TileQuery): string[] {
  const names = new Set<string>();
  const walk = (node: TileCalcExpr): void => {
    if ('measure' in node) names.add(node.measure);
    else if ('op' in node) { walk(node.left); walk(node.right); }
  };
  for (const calculation of query.calculations ?? []) if (calculation.expr) walk(calculation.expr);
  return [...names];
}

// ---------------------------------------------------------------------------
// Formula text
// ---------------------------------------------------------------------------

const PRECEDENCE: Record<'+' | '-' | '*' | '/', number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/** Print a calculation the way an author would type it. */
export function formatTileCalcExpr(expr: TileCalcExpr, name: (measure: string) => string = (measure) => measure): string {
  const print = (node: TileCalcExpr, parent = 0, rightSide = false): string => {
    if ('number' in node) return String(node.number);
    if ('measure' in node) {
      const reference = formulaName(name(node.measure));
      if (!node.where?.length) return reference;
      const text = `${reference} where ${node.where.map(printCondition).join(' and ')}`;
      return parent > 0 ? `(${text})` : text;
    }
    const own = PRECEDENCE[node.op];
    const text = `${print(node.left, own)} ${node.op} ${print(node.right, own, true)}`;
    return own < parent || (rightSide && own === parent) ? `(${text})` : text;
  };
  return print(expr);
}

function formulaName(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !RESERVED.has(value.toLowerCase()) ? value : `\`${value.replaceAll('`', '')}\``;
}

function printCondition(condition: TileQueryFilter): string {
  const values = (condition.values ?? []).map(printValue);
  const field = formulaName(condition.field);
  if (condition.op === 'in') return `${field} in (${values.join(', ')})`;
  if (condition.op === 'not_in') return `${field} not in (${values.join(', ')})`;
  const symbol = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[condition.op as 'eq'] ?? '=';
  return `${field} ${symbol} ${values[0]}`;
}

function printValue(value: unknown): string {
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  return String(value);
}

const RESERVED = new Set(['where', 'and', 'in', 'not', 'true', 'false']);

export type TileFormulaParse =
  | { ok: true; expr: TileCalcExpr }
  | { ok: false; message: string; at: number };

interface Token {
  kind: 'number' | 'name' | 'string' | 'symbol' | 'end';
  text: string;
  value?: string | number;
  at: number;
}

/**
 * Parse a formula typed by an author (`revenue / orders`,
 * `(revenue where region = 'US') / revenue`) into the typed expression.
 * Names resolve to the Dataset's measures and, after `where`, to its fields.
 * The result still goes through `checkTileCalculations`.
 */
export function parseTileFormula(text: string, descriptor: DatasetDescriptor): TileFormulaParse {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    const failure = error as { message: string; at?: number };
    return { ok: false, message: failure.message, at: failure.at ?? 0 };
  }
  let index = 0;
  const peek = () => tokens[index]!;
  const next = () => tokens[index++]!;
  const fail = (message: string, token = peek()): never => {
    throw Object.assign(new Error(message), { at: token.at });
  };
  const isSymbol = (symbol: string) => peek().kind === 'symbol' && peek().text === symbol;
  const isWord = (word: string) => peek().kind === 'name' && peek().text.toLowerCase() === word && !peek().value;

  const measureNames = () => descriptor.fields.filter((field): field is DatasetMeasureField => field.kind === 'measure' && field.status === 'approved').map((field) => field.name);

  const expression = (): TileCalcExpr => {
    let left = term();
    while (isSymbol('+') || isSymbol('-')) {
      const op = next().text as '+' | '-';
      left = { op, left, right: term() };
    }
    return left;
  };
  const term = (): TileCalcExpr => {
    let left = factor();
    while (isSymbol('*') || isSymbol('/')) {
      const op = next().text as '*' | '/';
      left = { op, left, right: factor() };
    }
    return left;
  };
  const factor = (): TileCalcExpr => {
    const token = peek();
    if (token.kind === 'symbol' && token.text === '-') {
      next();
      const inner = factor();
      return 'number' in inner ? { number: -inner.number } : { op: '*', left: { number: -1 }, right: inner };
    }
    if (token.kind === 'number') {
      next();
      return { number: token.value as number };
    }
    if (token.kind === 'symbol' && token.text === '(') {
      next();
      const inner = expression();
      if (!isSymbol(')')) fail('A ")" is missing.');
      next();
      return inner;
    }
    if (token.kind === 'name') {
      next();
      const name = String(token.value ?? token.text);
      const measure = datasetMeasureField(descriptor, name);
      if (!measure) {
        const column = datasetPhysicalField(descriptor, name);
        const known = measureNames();
        fail(column
          ? `${name} is a column. Use a measure: ${known.slice(0, 6).join(', ')}${known.length > 6 ? ', …' : ''}.`
          : `${name} is not a measure of ${descriptor.label}. Measures: ${known.slice(0, 6).join(', ')}${known.length > 6 ? ', …' : ''}.`, token);
      }
      if (isWord('where')) {
        next();
        const where: TileQueryFilter[] = [condition()];
        while (isWord('and')) {
          next();
          where.push(condition());
        }
        return { measure: measure!.name, where };
      }
      return { measure: measure!.name };
    }
    if (token.kind === 'string') return fail('A quoted value can only follow a field after "where".');
    return fail(token.kind === 'end' ? 'The formula ends too early.' : `Unexpected "${token.text}".`);
  };
  const literal = (type: string): string | number | boolean => {
    const token = next();
    if (token.kind === 'string') return String(token.value);
    if (token.kind === 'number') return type === 'string' ? String(token.value) : token.value as number;
    if (token.kind === 'name' && (token.text.toLowerCase() === 'true' || token.text.toLowerCase() === 'false')) return token.text.toLowerCase() === 'true';
    return fail('Expected a value, such as \'US\' or 100.', token);
  };
  const condition = (): TileQueryFilter => {
    const token = next();
    if (token.kind !== 'name') return fail('Expected a field name after "where".', token);
    const name = String(token.value ?? token.text);
    const field = datasetPhysicalField(descriptor, name);
    if (!field) return fail(`${name} is not a field of ${descriptor.label}.`, token);
    const fieldName = field.name;
    if (isWord('not')) {
      next();
      if (!isWord('in')) fail('Expected "in" after "not".');
      next();
      return { field: fieldName, op: 'not_in', values: list(field.type) };
    }
    if (isWord('in')) {
      next();
      return { field: fieldName, op: 'in', values: list(field.type) };
    }
    const symbol = next();
    const op = symbol.kind === 'symbol' ? ({ '=': 'eq', '!=': 'neq', '<>': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' } as Record<string, TileFilterOperator>)[symbol.text] : undefined;
    if (!op) return fail('Expected =, !=, >, >=, <, <= or in.', symbol);
    return { field: fieldName, op: op!, values: [literal(field.type)] };
  };
  const list = (type: string): Array<string | number | boolean> => {
    if (!isSymbol('(')) fail('Expected "(" to start the list of values.');
    next();
    const values = [literal(type)];
    while (isSymbol(',')) {
      next();
      values.push(literal(type));
    }
    if (!isSymbol(')')) fail('A ")" is missing after the list of values.');
    next();
    return values;
  };

  try {
    if (!text.trim()) return { ok: false, message: 'Type a formula, such as revenue / orders.', at: 0 };
    const expr = expression();
    if (peek().kind !== 'end') fail(`Unexpected "${peek().text}".`);
    return { ok: true, expr };
  } catch (error) {
    const failure = error as { message: string; at?: number };
    return { ok: false, message: failure.message, at: failure.at ?? 0 };
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    const at = index;
    if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (!match) throw Object.assign(new Error(`"${char}" is not a number.`), { at });
      index += match[0].length;
      tokens.push({ kind: 'number', text: match[0], value: Number(match[0]), at });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(index))!;
      index += match[0].length;
      tokens.push({ kind: 'name', text: match[0], at });
      continue;
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end < 0) throw Object.assign(new Error('A closing ` is missing.'), { at });
      const name = text.slice(index + 1, end).trim();
      index = end + 1;
      tokens.push({ kind: 'name', text: name, value: name, at });
      continue;
    }
    if (char === "'" || char === '"') {
      let value = '';
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        const current = text[cursor]!;
        if (current === char) {
          if (text[cursor + 1] === char) { value += char; cursor += 2; continue; }
          closed = true;
          break;
        }
        value += current;
        cursor += 1;
      }
      if (!closed) throw Object.assign(new Error('A closing quote is missing.'), { at });
      index = cursor + 1;
      tokens.push({ kind: 'string', text: value, value, at });
      continue;
    }
    const two = text.slice(index, index + 2);
    if (two === '>=' || two === '<=' || two === '!=' || two === '<>') {
      tokens.push({ kind: 'symbol', text: two, at });
      index += 2;
      continue;
    }
    if ('+-*/(),=<>'.includes(char)) {
      tokens.push({ kind: 'symbol', text: char, at });
      index += 1;
      continue;
    }
    throw Object.assign(new Error(`"${char}" cannot be used in a formula.`), { at });
  }
  tokens.push({ kind: 'end', text: '', at: text.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A calculation id that does not collide with the tile's other columns. */
export function uniqueCalculationId(query: TileQuery, base: string): string {
  const stem = (base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'calc').replace(/^([0-9])/, 'c_$1').slice(0, 48);
  const taken = new Set([
    ...query.dimensions.map((dimension) => (dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field)).toLowerCase()),
    ...query.measures.map((measure) => (measure.alias ?? measure.measure).toLowerCase()),
    ...(query.calculations ?? []).map((calculation) => calculation.id.toLowerCase()),
  ]);
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; suffix < 1000; suffix += 1) if (!taken.has(`${stem}_${suffix}`)) return `${stem}_${suffix}`;
  return `${stem}_${Date.now()}`;
}

function valueMatches(value: unknown, type: string): boolean {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'date' || type === 'timestamp') return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
