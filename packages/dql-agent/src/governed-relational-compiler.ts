/**
 * Constrained relational compiler. It accepts only qualified registry IDs and
 * certified relationship proof; the model never writes relations, joins,
 * columns, aliases, parameters, or SQL text.
 *
 * Acceptance: AGT-015, API-006.
 */

import { createHash } from 'node:crypto';
import { getDialect, type DQLManifest, type DqlArtifactReference } from '@duckcodeailabs/dql-core';
import type { ResolvedAnalyticalPlan, ResolvedPlanMemberBinding } from './resolved-analytical-plan.js';

export interface GovernedRelationColumn {
  qualifiedId: string;
  name: string;
  type?: string;
  description?: string;
  isTime?: boolean;
  identities: string[];
}

export interface GovernedRelation {
  qualifiedId: string;
  sqlName: string;
  entityId?: string;
  identities: string[];
  columns: GovernedRelationColumn[];
}

export interface GovernedRelationship {
  qualifiedId: string;
  fromRelationId: string;
  toRelationId: string;
  keys: Array<{ fromColumnId: string; toColumnId: string }>;
  joinType: 'inner' | 'left';
  cardinality: string;
  fanout: string;
  status: string;
  automaticJoinAllowed: boolean;
  staleCertification: boolean;
  identities: string[];
}

export interface GovernedRelationalRegistry {
  snapshotId: string;
  fingerprint: string;
  relations: GovernedRelation[];
  relationships: GovernedRelationship[];
}

export type RelationalAggregate = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';

export interface GovernedRelationalAst {
  kind: 'select';
  fromRelationId: string;
  joins: Array<{ relationshipId: string; relationId: string; joinType: 'inner' | 'left' }>;
  measures: Array<{ columnId: string; aggregate: RelationalAggregate; alias: string }>;
  dimensions: Array<{ columnId: string; alias: string; timeGrain?: string }>;
  filters: Array<{ columnId: string; operator: 'eq' | 'gte' | 'lt'; parameterName: string }>;
  orderBy: Array<{ alias: string; direction: 'asc' | 'desc' }>;
  limit: number;
}

export interface GovernedCompilationReceipt {
  schemaVersion: 1;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  registryFingerprint: string;
  astFingerprint: string;
  sqlFingerprint: string;
  relationIds: string[];
  columnIds: string[];
  relationshipIds: string[];
  parameters: Array<{ name: string; valueFingerprint: string }>;
  outputColumns: string[];
  result?: { rowCount: number; resultFingerprint: string };
}

export type GovernedRelationalCompileResult =
  | {
      status: 'compiled';
      ast: GovernedRelationalAst;
      sql: string;
      parameterValues: Record<string, unknown>;
      receipt: GovernedCompilationReceipt;
    }
  | {
      status: 'blocked';
      code:
        | 'CAPABILITY_MISMATCH'
        | 'SNAPSHOT_MISMATCH'
        | 'MEMBER_UNRESOLVED'
        | 'MEMBER_AMBIGUOUS'
        | 'AGGREGATION_REQUIRED'
        | 'RELATIONSHIP_PROOF_REQUIRED'
        | 'RELATIONSHIP_NOT_EXECUTABLE'
        | 'UNSUPPORTED_TIME_RANGE';
      reason: string;
      candidateIds?: string[];
    };

export function buildGovernedRelationalRegistry(input: {
  snapshotId: string;
  schemaContext: Array<{
    relation: string;
    name?: string;
    columns: Array<{ name: string; type?: string; description?: string }>;
  }>;
  manifest?: DQLManifest;
}): GovernedRelationalRegistry {
  const provenance = Object.values(input.manifest?.dbtProvenance?.nodes ?? {});
  const entities = Object.values(input.manifest?.modeling?.entities ?? {});
  const relations = input.schemaContext.map((table): GovernedRelation => {
    const dbt = provenance.find((node) => node.relation === table.relation || node.name === table.name || node.name === table.relation);
    const entity = dbt ? entities.find((candidate) => candidate.dbtUniqueId === dbt.uniqueId) : undefined;
    const qualifiedId = dbt?.uniqueId ?? `runtime:relation:${table.relation}`;
    return {
      qualifiedId,
      sqlName: table.relation,
      entityId: entity?.qualifiedId ?? entity?.id,
      identities: unique([qualifiedId, table.relation, table.name, dbt?.name, dbt ? `dbt:model:${dbt.name}` : undefined]),
      columns: table.columns.map((column) => ({
        qualifiedId: `dbt:column:${dbt?.name ?? table.name ?? table.relation}.${column.name}`,
        name: column.name,
        type: column.type,
        description: column.description,
        isTime: /(?:date|time|timestamp)/i.test(column.type ?? '') || /(?:^|_)(date|time|timestamp|month|week|year)(?:_|$)/i.test(column.name),
        identities: unique([
          `dbt:column:${dbt?.name ?? table.name ?? table.relation}.${column.name}`,
          `runtime:column:${table.relation}.${column.name}`,
          `warehouse:column:${table.relation}.${column.name}`,
          `${qualifiedId}::column::${column.name}`,
          `${table.relation}.${column.name}`,
        ]),
      })),
    };
  });
  const byEntity = new Map(relations.flatMap((relation) => relation.entityId ? [[relation.entityId, relation] as const] : []));
  const relationships = Object.values(input.manifest?.modeling?.relationships ?? {}).flatMap((relationship): GovernedRelationship[] => {
    const from = byEntity.get(relationship.from);
    const to = byEntity.get(relationship.to);
    if (!from || !to) return [];
    const keys = relationship.keys.flatMap((key) => {
      const fromColumn = findColumnByName(from, key.from);
      const toColumn = findColumnByName(to, key.to);
      return fromColumn && toColumn ? [{ fromColumnId: fromColumn.qualifiedId, toColumnId: toColumn.qualifiedId }] : [];
    });
    if (keys.length !== relationship.keys.length) return [];
    return [{
      qualifiedId: relationship.qualifiedId,
      fromRelationId: from.qualifiedId,
      toRelationId: to.qualifiedId,
      keys,
      joinType: relationship.joinTypes?.includes('left') ? 'left' : 'inner',
      cardinality: relationship.cardinality,
      fanout: relationship.fanout,
      status: relationship.status,
      automaticJoinAllowed: relationship.automaticJoinAllowed,
      staleCertification: relationship.staleCertification,
      identities: unique([relationship.qualifiedId, relationship.id, relationship.localId]),
    }];
  });
  const payload = { snapshotId: input.snapshotId, relations, relationships };
  return { ...payload, fingerprint: hash(stableStringify(payload)) };
}

export function compileGovernedRelationalPlan(input: {
  plan: ResolvedAnalyticalPlan;
  registry: GovernedRelationalRegistry;
  driver?: string;
  maxRows?: number;
}): GovernedRelationalCompileResult {
  const { plan, registry } = input;
  if (plan.capability !== 'governed_relational') {
    return blocked('CAPABILITY_MISMATCH', `Plan capability ${plan.capability} is not governed relational.`);
  }
  if (plan.snapshotId !== registry.snapshotId) {
    return blocked('SNAPSHOT_MISMATCH', `Plan snapshot ${plan.snapshotId} does not match relational registry ${registry.snapshotId}.`);
  }
  const measures = plan.query.measures.map((binding) => bindColumn(binding, registry));
  const dimensions = plan.query.dimensions.map((binding) => bindColumn(binding, registry));
  const filterColumns = plan.query.filters.map((filter) => bindColumn(filter.binding, registry));
  const failed = [...measures, ...dimensions, ...filterColumns].find((binding) => binding.status !== 'resolved');
  if (failed) {
    return blocked(
      failed.status === 'ambiguous' ? 'MEMBER_AMBIGUOUS' : 'MEMBER_UNRESOLVED',
      failed.reason,
      failed.candidateIds,
    );
  }
  const boundMeasures = measures as ResolvedColumn[];
  const boundDimensions = dimensions as ResolvedColumn[];
  const boundFilters = filterColumns as ResolvedColumn[];
  const relationIds = unique([
    ...boundMeasures.map((item) => item.relation.qualifiedId),
    ...boundDimensions.map((item) => item.relation.qualifiedId),
    ...boundFilters.map((item) => item.relation.qualifiedId),
  ]);
  if (relationIds.length === 0) return blocked('MEMBER_UNRESOLVED', 'The plan does not bind any executable relational columns.');
  const base = boundMeasures[0]?.relation ?? boundDimensions[0]?.relation ?? boundFilters[0]!.relation;
  const joins: GovernedRelationalAst['joins'] = [];
  const joined = new Set([base.qualifiedId]);
  while (joined.size < relationIds.length) {
    const relationship = registry.relationships.find((candidate) =>
      plan.relationshipPathIds.some((identity) => candidate.identities.includes(identity))
      && ((joined.has(candidate.fromRelationId) && relationIds.includes(candidate.toRelationId) && !joined.has(candidate.toRelationId))
        || (joined.has(candidate.toRelationId) && relationIds.includes(candidate.fromRelationId) && !joined.has(candidate.fromRelationId))));
    if (!relationship) {
      return blocked('RELATIONSHIP_PROOF_REQUIRED', `No selected relationship proof connects ${[...joined].join(', ')} to ${relationIds.filter((id) => !joined.has(id)).join(', ')}.`);
    }
    if (relationship.status !== 'certified' || relationship.staleCertification || !relationship.automaticJoinAllowed) {
      return blocked('RELATIONSHIP_NOT_EXECUTABLE', `Relationship ${relationship.qualifiedId} is not fresh, certified, and automatic-join safe.`);
    }
    const next = joined.has(relationship.fromRelationId) ? relationship.toRelationId : relationship.fromRelationId;
    joins.push({ relationshipId: relationship.qualifiedId, relationId: next, joinType: relationship.joinType });
    joined.add(next);
  }
  const astMeasures: GovernedRelationalAst['measures'] = [];
  for (let index = 0; index < boundMeasures.length; index += 1) {
    const aggregation = normalizeAggregate(plan.query.measures[index]!.aggregation);
    if (!aggregation) {
      return blocked('AGGREGATION_REQUIRED', `Measure ${plan.query.measures[index]!.requested} has no allowlisted aggregation.`);
    }
    astMeasures.push({
      columnId: boundMeasures[index]!.column.qualifiedId,
      aggregate: aggregation,
      alias: safeAlias(plan.query.measures[index]!.requested, `measure_${index + 1}`),
    });
  }
  const astDimensions = boundDimensions.map((binding, index) => ({
    columnId: binding.column.qualifiedId,
    alias: safeAlias(plan.query.dimensions[index]!.requested, `dimension_${index + 1}`),
    ...(binding.column.isTime && plan.query.timeGrain ? { timeGrain: plan.query.timeGrain } : {}),
  }));
  const parameters: Record<string, unknown> = {};
  const filters: GovernedRelationalAst['filters'] = plan.query.filters.map((filter, index) => {
    const parameterName = `p${index + 1}`;
    parameters[parameterName] = filter.value;
    return { columnId: boundFilters[index]!.column.qualifiedId, operator: 'eq' as const, parameterName };
  });
  if (plan.query.timeRange && !plan.query.timeBounds) {
    return blocked('UNSUPPORTED_TIME_RANGE', `Time range "${plan.query.timeRange}" has no typed bounds.`);
  }
  if (plan.query.timeBounds) {
    const time = boundDimensions.find((binding) => binding.column.isTime);
    if (!time) return blocked('MEMBER_UNRESOLVED', 'Typed time bounds require a qualified time dimension.');
    parameters.time_start = plan.query.timeBounds.startInclusive;
    parameters.time_end = plan.query.timeBounds.endExclusive;
    filters.push(
      { columnId: time.column.qualifiedId, operator: 'gte', parameterName: 'time_start' },
      { columnId: time.column.qualifiedId, operator: 'lt', parameterName: 'time_end' },
    );
  }
  const orderAlias = astMeasures[0]?.alias ?? astDimensions[0]?.alias;
  const ast: GovernedRelationalAst = {
    kind: 'select',
    fromRelationId: base.qualifiedId,
    joins,
    measures: astMeasures,
    dimensions: astDimensions,
    filters,
    orderBy: orderAlias && plan.query.order ? [{ alias: orderAlias, direction: plan.query.order }] : [],
    limit: Math.min(Math.max(1, plan.query.limit ?? 100), input.maxRows ?? 10_000),
  };
  const sql = renderGovernedRelationalAst(ast, registry, input.driver);
  const outputColumns = [...ast.dimensions.map((item) => item.alias), ...ast.measures.map((item) => item.alias)];
  const receipt: GovernedCompilationReceipt = {
    schemaVersion: 1,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    snapshotId: plan.snapshotId,
    registryFingerprint: registry.fingerprint,
    astFingerprint: hash(stableStringify(ast)),
    sqlFingerprint: hash(sql),
    relationIds,
    columnIds: unique([...ast.dimensions.map((item) => item.columnId), ...ast.measures.map((item) => item.columnId), ...ast.filters.map((item) => item.columnId)]),
    relationshipIds: ast.joins.map((item) => item.relationshipId),
    parameters: Object.entries(parameters).map(([name, value]) => ({ name, valueFingerprint: hash(stableStringify(value)) })),
    outputColumns,
  };
  return { status: 'compiled', ast, sql, parameterValues: parameters, receipt };
}

export function renderGovernedRelationalAst(
  ast: GovernedRelationalAst,
  registry: GovernedRelationalRegistry,
  driver?: string,
): string {
  const dialect = getDialect(driver);
  const relations = new Map(registry.relations.map((relation) => [relation.qualifiedId, relation]));
  const aliases = new Map<string, string>([[ast.fromRelationId, 'r0']]);
  ast.joins.forEach((join, index) => aliases.set(join.relationId, `r${index + 1}`));
  const locateColumn = (columnId: string): { relation: GovernedRelation; column: GovernedRelationColumn } => {
    for (const relation of registry.relations) {
      const column = relation.columns.find((candidate) => candidate.qualifiedId === columnId);
      if (column) return { relation, column };
    }
    throw new Error(`Unknown governed column ${columnId}`);
  };
  const expression = (columnId: string): string => {
    const { relation, column } = locateColumn(columnId);
    return `${aliases.get(relation.qualifiedId)}.${dialect.quoteIdentifier(column.name)}`;
  };
  const selections = [
    ...ast.dimensions.map((item) => {
      const raw = expression(item.columnId);
      return `${item.timeGrain ? dialect.dateTrunc(item.timeGrain, raw) : raw} AS ${dialect.quoteIdentifier(item.alias)}`;
    }),
    ...ast.measures.map((item) => {
      const raw = expression(item.columnId);
      const aggregate = item.aggregate === 'count_distinct' ? `COUNT(DISTINCT ${raw})` : `${item.aggregate.toUpperCase()}(${raw})`;
      return `${aggregate} AS ${dialect.quoteIdentifier(item.alias)}`;
    }),
  ];
  let sql = `SELECT\n  ${selections.join(',\n  ')}\nFROM ${quoteRelation(relations.get(ast.fromRelationId)!.sqlName, dialect.quoteIdentifier.bind(dialect))} AS r0`;
  const joined = new Set([ast.fromRelationId]);
  for (const join of ast.joins) {
    const relationship = registry.relationships.find((candidate) => candidate.qualifiedId === join.relationshipId)!;
    const relation = relations.get(join.relationId)!;
    const conditions = relationship.keys.map((key) => `${expression(key.fromColumnId)} = ${expression(key.toColumnId)}`);
    sql += `\n${join.joinType.toUpperCase()} JOIN ${quoteRelation(relation.sqlName, dialect.quoteIdentifier.bind(dialect))} AS ${aliases.get(relation.qualifiedId)} ON ${conditions.join(' AND ')}`;
    joined.add(relation.qualifiedId);
  }
  if (ast.filters.length) {
    const operators = { eq: '=', gte: '>=', lt: '<' } as const;
    sql += `\nWHERE ${ast.filters.map((filter) => `${expression(filter.columnId)} ${operators[filter.operator]} :${filter.parameterName}`).join(' AND ')}`;
  }
  if (ast.measures.length && ast.dimensions.length) {
    sql += `\nGROUP BY ${ast.dimensions.map((item) => item.timeGrain ? dialect.dateTrunc(item.timeGrain, expression(item.columnId)) : expression(item.columnId)).join(', ')}`;
  }
  if (ast.orderBy.length) sql += `\nORDER BY ${ast.orderBy.map((item) => `${dialect.quoteIdentifier(item.alias)} ${item.direction.toUpperCase()}`).join(', ')}`;
  if (dialect.limitAtEnd) sql += `\n${dialect.limitClause(ast.limit)}`;
  return sql;
}

export function finalizeGovernedCompilationReceipt(
  receipt: GovernedCompilationReceipt,
  result: { columns: unknown[]; rows: unknown[]; rowCount: number },
): GovernedCompilationReceipt {
  const actual = result.columns.map((column) => typeof column === 'string' ? column : String(column));
  const missing = receipt.outputColumns.filter((column) => !actual.includes(column));
  if (missing.length) throw new Error(`Result contract is missing: ${missing.join(', ')}.`);
  return {
    ...receipt,
    result: {
      rowCount: result.rowCount,
      resultFingerprint: hash(stableStringify({ columns: actual, rows: result.rows, rowCount: result.rowCount })),
    },
  };
}

export function renderGovernedRelationalDqlArtifact(
  compiled: Extract<GovernedRelationalCompileResult, { status: 'compiled' }>,
): DqlArtifactReference {
  const name = `resolved_plan_${compiled.receipt.planId.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(-40)}`;
  const declarations = Object.entries(compiled.parameterValues).map(([parameter, value]) => {
    const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    return `    ${parameter}: ${type}`;
  });
  const parameterizedSql = compiled.sql.replace(/:([a-zA-Z][a-zA-Z0-9_]*)\b/g, (_match, parameter: string) => `\${${parameter}}`);
  const source = [
    `block "${name}" {`,
    '  type = "custom"',
    '  status = "draft"',
    ...(declarations.length ? ['  params {', ...declarations, '  }'] : []),
    '  query = """',
    ...parameterizedSql.split('\n').map((line) => `    ${line}`),
    '  """',
    '}',
  ].join('\n');
  return {
    kind: 'sql_block',
    name,
    source,
    compiledSql: compiled.sql,
    parameterValues: compiled.parameterValues,
    persistence: 'transient',
    trustState: 'governed',
    limit: compiled.ast.limit,
  };
}

type ResolvedColumn = { status: 'resolved'; relation: GovernedRelation; column: GovernedRelationColumn };
type ColumnBinding = ResolvedColumn | { status: 'missing' | 'ambiguous'; reason: string; candidateIds: string[] };

function bindColumn(binding: ResolvedPlanMemberBinding, registry: GovernedRelationalRegistry): ColumnBinding {
  if (binding.status !== 'resolved' || !binding.qualifiedId) {
    return { status: binding.status === 'ambiguous' ? 'ambiguous' : 'missing', reason: `${binding.requested} is ${binding.status}.`, candidateIds: binding.candidateIds };
  }
  const matches = registry.relations.flatMap((relation) => relation.columns
    .filter((column) => column.qualifiedId === binding.qualifiedId || column.identities.includes(binding.qualifiedId!))
    .map((column) => ({ relation, column })));
  if (matches.length !== 1) {
    return { status: matches.length > 1 ? 'ambiguous' : 'missing', reason: `${binding.qualifiedId} resolves to ${matches.length} columns.`, candidateIds: matches.map((item) => item.column.qualifiedId) };
  }
  return { status: 'resolved', ...matches[0]! };
}

function normalizeAggregate(value: string | undefined): RelationalAggregate | undefined {
  const normalized = value?.toLowerCase().replace(/\s+/g, '_');
  if (normalized === 'sum' || normalized === 'avg' || normalized === 'min' || normalized === 'max' || normalized === 'count' || normalized === 'count_distinct') return normalized;
  if (normalized === 'average') return 'avg';
  if (normalized === 'distinct_count') return 'count_distinct';
  return undefined;
}

function findColumnByName(relation: GovernedRelation, name: string): GovernedRelationColumn | undefined {
  return relation.columns.find((column) => column.name === name);
}

function blocked(code: Extract<GovernedRelationalCompileResult, { status: 'blocked' }>['code'], reason: string, candidateIds?: string[]): GovernedRelationalCompileResult {
  return { status: 'blocked', code, reason, ...(candidateIds?.length ? { candidateIds } : {}) };
}

function safeAlias(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function quoteRelation(value: string, quote: (value: string) => string): string {
  return value.split('.').map(quote).join('.');
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
    .sort();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
