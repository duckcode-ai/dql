import { createHash } from 'node:crypto';

import {
  datasetAggregateComponentProofCovers,
  datasetAggregateComponentRequirements,
  datasetMeasureField,
  datasetPhysicalField,
  datasetQueryRequiresAggregateComponentEvidence,
  getDialect,
  isTileTimeGrain,
  renderDatasetAggregateExpression,
  tileQueryIsTopNIntent,
  tileQueryHash,
  tileQueryValidationRuns,
  validateTileQuery,
  type DatasetDescriptor,
  type DatasetAggregateComponentProofV1,
  type DatasetMeasureAggregation,
  type TileFilterOperator,
  type TileQuery,
  type TileQueryFilter,
  type TileQueryValidation,
} from '@duckcodeailabs/dql-core';
import type { ConnectionConfig, SQLParamSpec } from '@duckcodeailabs/dql-connectors';

export class TileQueryCompilationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TileQueryCompilationError';
  }
}

export interface CompiledDatasetTileQuery {
  sql: string;
  sqlParams: SQLParamSpec[];
  variables: Record<string, unknown>;
  /** Presentation metadata is derived from the same approved fields that
   * compiled the SQL. Renderers use it instead of guessing a ratio or amount
   * from an output alias. */
  columns: Array<{
    alias: string;
    role: 'dimension' | 'measure';
    ref: string;
    type?: 'string' | 'number' | 'boolean' | 'date' | 'timestamp';
    aggregation?: DatasetMeasureAggregation;
    timeGrain?: string;
    format?: { kind: 'number' | 'currency' | 'percent'; currency?: string };
  }>;
  queryFingerprint: string;
  filterFingerprint: string;
  appliedFilters: Array<{ field: string; op: TileFilterOperator; values: unknown[]; placement: 'where' | 'having' }>;
  /** The Dataset-contract outcome this SQL was compiled under (C8). */
  validation: Pick<TileQueryValidation, 'outcome' | 'adaptations'>;
}

/**
 * Compile a block-backed field tile over the block's complete result set. The
 * source block remains the governed projection; the outer query is the only
 * place that groups, filters, ranks, or limits it. This intentionally never
 * re-aggregates preview rows.
 */
export function compileDatasetTileQuery(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  sourceSql: string;
  sourceSqlParams?: SQLParamSpec[];
  sourceVariables?: Record<string, unknown>;
  filters?: TileQueryFilter[];
  having?: TileQueryFilter[];
  parameters?: Record<string, unknown>;
  /**
   * Server-created, run-owned evidence for an aggregate Dataset rollup. This
   * is intentionally an input only to the local runtime compiler; authoring
   * and browser callers cannot mint it.
   */
  aggregateComponentProof?: DatasetAggregateComponentProofV1;
  /** The run's exact binding; a proof made for any other binding does not cover. */
  aggregateComponentBinding?: { sourceId: string; sourceRevision: string; targetFingerprint: string };
  /**
   * Set only after the server parsed the actual complete source as a known
   * aggregate query. It closes a false `grain.aggregate` declaration from
   * opting an already-aggregated source out of the runtime proof gate.
   */
  aggregateSourceDetected?: boolean;
  driver: ConnectionConfig['driver'] | string;
}): CompiledDatasetTileQuery {
  if (!supportedTileDialect(input.driver)) {
    throw new TileQueryCompilationError('DATASET_DIALECT_UNSUPPORTED', `Dataset tiles do not support the ${input.driver} SQL dialect.`);
  }
  // Dashboard/cross-filter mappings are compiled through the exact same
  // authority as authored filters. They must never bypass field status, type,
  // cardinality, or supported-operation validation merely because the browser
  // supplied them separately from the saved tile query.
  const effectiveQuery: TileQuery = {
    ...input.query,
    filters: [...(input.query.filters ?? []), ...(input.filters ?? [])],
    having: [...(input.query.having ?? []), ...(input.having ?? [])],
  };
  const validation = validateTileQuery(input.descriptor, effectiveQuery);
  if (!tileQueryValidationRuns(validation)) {
    const messages = validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ');
    throw new TileQueryCompilationError(
      validation.outcome === 'needs_review' ? 'DATASET_QUERY_REVIEW_REQUIRED' : 'DATASET_QUERY_REJECTED',
      messages || 'The dataset query is not covered by its approved contract.',
    );
  }
  // Structural declaration checks are deliberately not a substitute for live
  // aggregate-component evidence. Until the runtime has produced a
  // target-bound proof, even a measure labelled additive cannot roll an
  // aggregate Dataset up from its native keys/time bucket.
  const aggregateEvidenceRequired = input.aggregateSourceDetected === true
    || datasetQueryRequiresAggregateComponentEvidence(input.descriptor, effectiveQuery);
  if (aggregateEvidenceRequired) {
    const requirements = datasetAggregateComponentRequirements(input.descriptor, effectiveQuery);
    if (!requirements.supported || !datasetAggregateComponentProofCovers(input.aggregateComponentProof, requirements.requirements, {
      ...input.aggregateComponentBinding,
      contractFingerprint: input.descriptor.contractRef.fingerprint,
      timeGrain: input.descriptor.grain.timeGrain ?? '',
    })) {
    throw new TileQueryCompilationError(
      'DATASET_AGGREGATE_COMPONENT_EVIDENCE_REQUIRED',
      `Aggregate Dataset ${input.descriptor.label} needs current component evidence before this rollup can run. Validate the source components against the active warehouse target.`,
    );
    }
  }
  const sourceSql = stripTerminator(input.sourceSql);
  if (!sourceSql) throw new TileQueryCompilationError('DATASET_SOURCE_EMPTY', 'The dataset source has no executable SQL.');
  const dialect = getDialect(input.driver);
  const sourceParams = [...(input.sourceSqlParams ?? [])];
  const variables: Record<string, unknown> = { ...(input.sourceVariables ?? {}) };
  let nextPosition = sourceParams.reduce((maximum, parameter) => Math.max(maximum, parameter.position), 0);
  const sqlParams = sourceParams;
  const appliedFilters: CompiledDatasetTileQuery['appliedFilters'] = [];
  const addBoundValue = (value: unknown, prefix: string): string => {
    nextPosition += 1;
    const name = `__dataset_tile_${prefix}_${nextPosition}`;
    sqlParams.push({ name, position: nextPosition });
    variables[name] = value;
    return `$${nextPosition}`;
  };
  const quote = (identifier: string) => dialect.quoteIdentifier(identifier);
  const physicalExpression = (name: string): string => {
    const field = datasetPhysicalField(input.descriptor, name);
    if (!field) throw new TileQueryCompilationError('DATASET_FIELD_DRIFT', `Dataset field ${name} no longer resolves.`);
    return `ds.${quote(field.name)}`;
  };

  const whereFilters = effectiveQuery.filters ?? [];
  const havingFilters = effectiveQuery.having ?? [];
  const whereClauses = whereFilters.map((filter) => {
    const field = datasetPhysicalField(input.descriptor, filter.field);
    if (!field || field.kind !== 'physical') {
      throw new TileQueryCompilationError('DATASET_FIELD_DRIFT', `Dataset filter field ${filter.field} no longer resolves.`);
    }
    const expression = physicalExpression(filter.field);
    const clause = compileFilter(filter, expression, dialect.ilike.bind(dialect), addBoundValue, field.type, input.driver);
    appliedFilters.push({ field: filter.field, op: filter.op, values: [...(filter.values ?? [])], placement: 'where' });
    return clause;
  });

  if (input.query.detail) {
    const selectedColumns = input.query.detailColumns;
    const fields = selectedColumns?.length
      ? selectedColumns.map((column) => {
        const field = datasetPhysicalField(input.descriptor, column);
        if (!field || field.status !== 'approved') {
          throw new TileQueryCompilationError('DATASET_DETAIL_FIELD_DRIFT', `Detail column ${column} no longer resolves to an approved physical field.`);
        }
        return field;
      })
      : input.descriptor.fields.filter((field): field is NonNullable<ReturnType<typeof datasetPhysicalField>> => field.kind === 'physical' && field.status === 'approved');
    if (fields.length === 0) throw new TileQueryCompilationError('DATASET_DETAIL_FIELDS_MISSING', 'This dataset has no approved physical fields for detail rows.');
    const limit = resolveLimit(input.query.limit, input.parameters);
    if (!limit) throw new TileQueryCompilationError('DATASET_DETAIL_LIMIT_REQUIRED', 'Detail rows require an explicit bounded row limit.');
    const keyFields = input.descriptor.grain.keyFields.map((key) => {
      const field = datasetPhysicalField(input.descriptor, key);
      if (!field || field.status !== 'approved') {
        throw new TileQueryCompilationError('DATASET_DETAIL_KEY_DRIFT', `Declared detail key ${key} no longer resolves to an approved physical field.`);
      }
      return field;
    });
    if (keyFields.length === 0) {
      throw new TileQueryCompilationError('DATASET_DETAIL_KEY_MISSING', 'Detail rows require a declared, validated dataset key.');
    }
    const selectPrefix = !dialect.limitAtEnd && limit ? `TOP ${limit} ` : '';
    const sql = [
      `WITH ds AS (${sourceSql})`,
      `SELECT ${selectPrefix}${fields.map((field) => `ds.${quote(field.name)} AS ${quote(field.name)}`).join(', ')}`,
      'FROM ds',
      ...(whereClauses.length ? [`WHERE ${whereClauses.join(' AND ')}`] : []),
      `ORDER BY ${keyFields.map((field) => `ds.${quote(field.name)} ASC`).join(', ')}`,
      ...(dialect.limitAtEnd && limit ? [dialect.limitClause(limit)] : []),
    ].join('\n');
    return compiledResult(sql, sqlParams, variables, fields.map((field) => ({
      alias: field.name,
      role: 'dimension' as const,
      ref: datasetDimensionRef(field.qualifiedId),
      type: field.type,
    })), input.query, appliedFilters, validation);
  }

  const dimensions = input.query.dimensions.map((selection) => {
    const field = datasetPhysicalField(input.descriptor, selection.field);
    if (!field) throw new TileQueryCompilationError('DATASET_FIELD_DRIFT', `Dataset field ${selection.field} no longer resolves.`);
    // Validation already refused an unknown grain; this guard keeps the grain
    // out of rendered SQL even if a caller reaches here another way.
    if (selection.timeGrain !== undefined && !isTileTimeGrain(selection.timeGrain)) {
      throw new TileQueryCompilationError('DATASET_TIME_GRAIN_INVALID', `${selection.timeGrain} is not a supported time grain.`);
    }
    const alias = safeAlias(selection.alias ?? (selection.timeGrain ? `${field.name}_${selection.timeGrain}` : field.name));
    const expression = selection.timeGrain
      ? dialect.dateTrunc(selection.timeGrain, `ds.${quote(field.name)}`)
      : `ds.${quote(field.name)}`;
    return { alias, expression, field, timeGrain: selection.timeGrain };
  });
  const measures = input.query.measures.map((selection) => {
    const measure = datasetMeasureField(input.descriptor, selection.measure);
    if (!measure) throw new TileQueryCompilationError('DATASET_MEASURE_DRIFT', `Dataset measure ${selection.measure} no longer resolves.`);
    const alias = safeAlias(selection.alias ?? measure.name);
    const expression = compileMeasure(measure, physicalExpression);
    return { alias, expression, format: measure.format, logicalMeasure: measure };
  });
  const aliasExpressions = new Map<string, string>([
    ...dimensions.map((dimension): [string, string] => [dimension.alias.toLowerCase(), dimension.expression]),
    ...measures.map((measure): [string, string] => [measure.alias.toLowerCase(), measure.expression]),
  ]);
  // HAVING refers to the approved logical measure identity. Presentation
  // aliases are deliberately excluded: an alias collision must never redirect
  // a measure predicate to a different expression.
  const selectedMeasureExpressions = new Map<string, string>();
  for (const measure of measures) {
    selectedMeasureExpressions.set(measure.logicalMeasure.name.toLowerCase(), measure.expression);
    selectedMeasureExpressions.set(measure.logicalMeasure.qualifiedId.toLowerCase(), measure.expression);
  }
  const havingClauses = havingFilters.map((filter) => {
    const expression = selectedMeasureExpressions.get(filter.field.toLowerCase());
    if (!expression) {
      throw new TileQueryCompilationError('DATASET_HAVING_FIELD_INVALID', `Having filter ${filter.field} does not resolve to a selected measure.`);
    }
    const clause = compileFilter(filter, expression, dialect.ilike.bind(dialect), addBoundValue, 'number', input.driver);
    appliedFilters.push({ field: filter.field, op: filter.op, values: [...(filter.values ?? [])], placement: 'having' });
    return clause;
  });
  const limit = resolveLimit(input.query.limit, input.parameters);
  const selectPrefix = !dialect.limitAtEnd && limit ? `TOP ${limit} ` : '';
  const selectColumns = [
    ...dimensions.map((dimension) => `${dimension.expression} AS ${quote(dimension.alias)}`),
    ...measures.map((measure) => `${measure.expression} AS ${quote(measure.alias)}`),
  ];
  const orderBy = (input.query.orderBy ?? []).map((order) => {
    const alias = safeAlias(order.alias);
    if (!aliasExpressions.has(alias.toLowerCase())) {
      throw new TileQueryCompilationError('DATASET_ORDER_FIELD_INVALID', `Order field ${order.alias} is not selected by this tile.`);
    }
    return `${quote(alias)} ${order.direction.toUpperCase()}`;
  });
  // A bounded measure-first entity query is Top-N intent. The primary metric
  // sort expresses business rank; the selected dimensions establish a stable
  // total order for ties. Ordinary chronological/dimension sorting and scalar
  // safety caps deliberately keep their authored ordering untouched.
  if (tileQueryIsTopNIntent(input.query)) {
    const orderedAliases = new Set((input.query.orderBy ?? []).map((order) => order.alias.toLowerCase()));
    for (const dimension of dimensions) {
      if (orderedAliases.has(dimension.alias.toLowerCase())) continue;
      orderBy.push(`${quote(dimension.alias)} ASC`);
      orderedAliases.add(dimension.alias.toLowerCase());
    }
  }
  const sql = [
    `WITH ds AS (${sourceSql})`,
    `SELECT ${selectPrefix}${selectColumns.join(', ')}`,
    'FROM ds',
    ...(whereClauses.length ? [`WHERE ${whereClauses.join(' AND ')}`] : []),
    ...(dimensions.length ? [`GROUP BY ${dimensions.map((dimension) => dimension.expression).join(', ')}`] : []),
    ...(havingClauses.length ? [`HAVING ${havingClauses.join(' AND ')}`] : []),
    ...(orderBy.length ? [`ORDER BY ${orderBy.join(', ')}`] : []),
    ...(dialect.limitAtEnd && limit ? [dialect.limitClause(limit)] : []),
  ].join('\n');
  return compiledResult(sql, sqlParams, variables, [
    ...dimensions.map((dimension) => ({
      alias: dimension.alias,
      role: 'dimension' as const,
      ref: datasetDimensionRef(dimension.field.qualifiedId),
      type: dimension.field.type,
      ...(dimension.timeGrain ? { timeGrain: dimension.timeGrain } : {}),
    })),
    ...measures.map((measure) => ({
      alias: measure.alias,
      role: 'measure' as const,
      ref: datasetMeasureRef(measure.logicalMeasure.qualifiedId, measure.logicalMeasure.metricId),
      aggregation: measure.logicalMeasure.aggregation,
      ...(measure.format ? { format: measure.format } : {}),
    })),
  ], input.query, appliedFilters, validation);
}

function compiledResult(
  sql: string,
  sqlParams: SQLParamSpec[],
  variables: Record<string, unknown>,
  columns: CompiledDatasetTileQuery['columns'],
  query: TileQuery,
  appliedFilters: CompiledDatasetTileQuery['appliedFilters'],
  validation: TileQueryValidation,
): CompiledDatasetTileQuery {
  return {
    validation: { outcome: validation.outcome, adaptations: validation.adaptations },
    sql,
    sqlParams,
    variables,
    columns,
    queryFingerprint: tileQueryHash(query),
    filterFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(appliedFilters.map((filter) => ({ ...filter, values: [...filter.values] })))).digest('hex')}`,
    appliedFilters,
  };
}

function compileMeasure(
  measure: NonNullable<ReturnType<typeof datasetMeasureField>>,
  physicalExpression: (name: string) => string,
): string {
  if (measure.expression) {
    if (!measure.expressionFingerprint) {
      throw new TileQueryCompilationError('DATASET_CALCULATED_MEASURE_UNBOUND', `Calculated measure ${measure.name} has no reviewed expression fingerprint.`);
    }
    return renderDatasetAggregateExpression(measure.expression, { physicalField: physicalExpression });
  }
  if (measure.aggregation === 'sum') return `SUM(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'count') return `COUNT(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'count_distinct') return `COUNT(DISTINCT ${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'ratio') {
    const numerator = physicalExpression(requiredMeasureInput(measure.numerator, measure.name));
    const denominator = physicalExpression(requiredMeasureInput(measure.denominator, measure.name));
    // Ratios remain 0..1. `1.0 *` deliberately promotes integer aggregates
    // before division for SQLite, DuckDB, PostgreSQL-family, SQL Server, and
    // the warehouse dialects DQL supports. Without it, SQLite and some
    // PostgreSQL-style integer paths silently truncate 1/4 to 0. The NULLIF
    // is kept on the denominator so zero and all-null denominator groups yield
    // NULL rather than a fabricated zero or an execution error.
    return `((1.0 * SUM(${numerator})) / NULLIF(SUM(${denominator}), 0))`;
  }
  if (measure.aggregation === 'avg') return `AVG(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'min') return `MIN(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  if (measure.aggregation === 'max') return `MAX(${physicalExpression(requiredMeasureInput(measure.from, measure.name))})`;
  throw new TileQueryCompilationError('DATASET_MEASURE_UNSUPPORTED', `Measure ${measure.name} uses an unsupported aggregation.`);
}

function datasetDimensionRef(qualifiedId: string): string {
  return qualifiedId.startsWith('dimension:') || qualifiedId.startsWith('entity:')
    ? qualifiedId
    : `dimension:${qualifiedId}`;
}

function datasetMeasureRef(qualifiedId: string, metricId?: string): string {
  if (metricId) return metricId.startsWith('metric:') ? metricId : `metric:${metricId}`;
  return qualifiedId.startsWith('measure:') || qualifiedId.startsWith('metric:')
    ? qualifiedId
    : `measure:${qualifiedId}`;
}

function requiredMeasureInput(value: string | undefined, measure: string): string {
  if (!value?.trim()) throw new TileQueryCompilationError('DATASET_MEASURE_INPUT_MISSING', `Measure ${measure} is missing its approved physical input.`);
  return value;
}

function compileFilter(
  filter: TileQueryFilter,
  expression: string,
  ilike: (column: string, pattern: string) => string,
  addBoundValue: (value: unknown, prefix: string) => string,
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'timestamp',
  driver: string,
): string {
  const values = filter.values ?? [];
  const bind = (value: unknown) => typedFilterParameter(addBoundValue(value, filter.field), fieldType, driver);
  if (filter.op === 'eq') return `${expression} = ${bind(values[0])}`;
  if (filter.op === 'neq') return `${expression} <> ${bind(values[0])}`;
  if (filter.op === 'gt') return `${expression} > ${bind(values[0])}`;
  if (filter.op === 'gte') return `${expression} >= ${bind(values[0])}`;
  if (filter.op === 'lt') return `${expression} < ${bind(values[0])}`;
  if (filter.op === 'lte') return `${expression} <= ${bind(values[0])}`;
  if (filter.op === 'between') return `${expression} BETWEEN ${bind(values[0])} AND ${bind(values[1])}`;
  if (filter.op === 'contains') {
    // Tile filters are literal user search text, never an implicit wildcard
    // language, and the escaped value is bound so quotes remain data. BigQuery
    // has no ESCAPE clause: its LIKE escapes with a backslash. Every other
    // supported dialect takes an explicit escape character.
    if (driver.trim().toLowerCase() === 'bigquery') {
      return ilike(expression, addBoundValue(`%${escapeLikeLiteral(String(values[0]), '\\')}%`, filter.field));
    }
    return `${ilike(expression, addBoundValue(`%${escapeLikeLiteral(String(values[0]), '!')}%`, filter.field))} ESCAPE '!'`;
  }
  const placeholders = values.map(bind);
  return `${expression} ${filter.op === 'in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`;
}

/**
 * Node DuckDB binds ISO instants as VARCHAR values. A raw timestamp comparison
 * therefore fails before the governed predicate can run. Cast only typed
 * temporal Dataset fields; string/number/boolean bindings remain untouched.
 * The rendering is deliberately dialect-specific where a warehouse has no
 * portable TIMESTAMP spelling.
 */
function typedFilterParameter(
  placeholder: string,
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'timestamp',
  driver: string,
): string {
  const normalizedDriver = driver.trim().toLowerCase();
  if (fieldType === 'date') return normalizedDriver === 'sqlite' ? `date(${placeholder})` : `CAST(${placeholder} AS DATE)`;
  if (fieldType !== 'timestamp') return placeholder;
  if (normalizedDriver === 'sqlite') return `datetime(${placeholder})`;
  if (normalizedDriver === 'mysql') return `CAST(${placeholder} AS DATETIME)`;
  if (normalizedDriver === 'mssql' || normalizedDriver === 'fabric') return `CAST(${placeholder} AS DATETIME2)`;
  return `CAST(${placeholder} AS TIMESTAMP)`;
}

function escapeLikeLiteral(value: string, escape: '!' | '\\'): string {
  return value.replaceAll(escape, `${escape}${escape}`).replaceAll('%', `${escape}%`).replaceAll('_', `${escape}_`);
}

function resolveLimit(limit: TileQuery['limit'], parameters: Record<string, unknown> | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const value = typeof limit === 'number' ? limit : parameters?.[limit.param];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TileQueryCompilationError('DATASET_LIMIT_INVALID', 'Tile limit must resolve to an integer from 1 through 10,000.');
  }
  return value;
}

function safeAlias(value: string): string {
  const alias = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new TileQueryCompilationError('DATASET_ALIAS_INVALID', `Tile alias ${value} is not a safe identifier.`);
  }
  return alias;
}

/**
 * Dialects whose rendered tile SQL (DATE_TRUNC, ILIKE/LIKE escaping, typed
 * temporal parameters, LIMIT) is pinned by golden tests in
 * tile-query-compiler.test.ts. Others refuse with a typed error rather than
 * run SQL nobody has checked: ClickHouse rejects `CAST(… AS TIMESTAMP)`,
 * SQL Server and MySQL truncate dates differently, and so on. Widen this list
 * only together with a golden for the dialect.
 */
export const DATASET_TILE_DIALECTS: readonly string[] = ['duckdb', 'file', 'postgresql', 'redshift', 'snowflake', 'bigquery'];

function supportedTileDialect(driver: string): boolean {
  return DATASET_TILE_DIALECTS.includes(driver);
}

function stripTerminator(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}
