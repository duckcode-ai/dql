import {
  buildGeneratedAnalyticalSqlSignature,
  buildSqlOutputExpressionSignature,
  type MetricCapabilityContract,
} from '@duckcodeailabs/dql-core';
import type { ResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import type { LocalContextPack, MetadataObject } from './metadata/catalog.js';

export const GENERATED_ANALYTICAL_TUPLE_DRIFT_MESSAGE =
  'Generated query changed the resolved analytical plan and was not executed';

export type GeneratedAnalyticalTupleDriftCode =
  | 'PLAN_AUTHORITY_MISMATCH'
  | 'EXECUTION_AUTHORITY_MISMATCH'
  | 'CAPABILITY_AUTHORITY_MISMATCH'
  | 'SNAPSHOT_AUTHORITY_MISMATCH'
  | 'TARGET_AUTHORITY_MISMATCH'
  | 'METRIC_TUPLE_DRIFT'
  | 'DIMENSION_TUPLE_DRIFT'
  | 'FILTER_TUPLE_DRIFT'
  | 'ORDER_TUPLE_DRIFT'
  | 'LIMIT_TUPLE_DRIFT'
  | 'OUTPUT_TUPLE_DRIFT'
  | 'GRAIN_TUPLE_DRIFT'
  | 'RELATIONSHIP_TUPLE_DRIFT'
  | 'RELATION_TUPLE_DRIFT'
  | 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'
  | 'GROUPING_TUPLE_DRIFT'
  | 'JOIN_PREDICATE_TUPLE_DRIFT'
  | 'SET_OPERATION_TUPLE_DRIFT'
  | 'WINDOW_TUPLE_DRIFT'
  | 'SQL_PARSE_EVIDENCE_MISSING';

export interface GeneratedAnalyticalProposalV1 {
  version: 1;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  executionId: string;
  capabilityFingerprint: string;
  targetFingerprint: string;
  sql: string;
}

export type GeneratedAnalyticalProposalValidation =
  | { ok: true }
  | {
      ok: false;
      code: 'GENERATED_ANALYTICAL_TUPLE_DRIFT';
      message: typeof GENERATED_ANALYTICAL_TUPLE_DRIFT_MESSAGE;
      driftCodes: GeneratedAnalyticalTupleDriftCode[];
    };

/**
 * Structural gate for the one optional generated-SQL proposal downstream of a
 * frozen RAP. The proposal carries identifiers, not prose. Both the declared
 * parser-owned SQL semantics are checked before a warehouse executor can be
 * called. The proposal cannot self-report tuple fields or spoof a metric by
 * assigning its output alias to a different expression.
 */
export function validateGeneratedAnalyticalProposal(input: {
  plan: ResolvedAnalyticalPlan;
  proposal: GeneratedAnalyticalProposalV1;
  expectedTargetFingerprint: string;
  contextPack?: LocalContextPack;
  dialect?: string;
}): GeneratedAnalyticalProposalValidation {
  const { plan, proposal } = input;
  const frame = plan.analyticalFrame;
  const driftCodes: GeneratedAnalyticalTupleDriftCode[] = [];
  if (plan.mode !== 'authoritative' || proposal.planId !== plan.planId || proposal.planFingerprint !== plan.fingerprint) {
    driftCodes.push('PLAN_AUTHORITY_MISMATCH');
  }
  if (!plan.executionId || proposal.executionId !== plan.executionId) driftCodes.push('EXECUTION_AUTHORITY_MISMATCH');
  if (!plan.selectedCapabilityFingerprint || proposal.capabilityFingerprint !== plan.selectedCapabilityFingerprint) {
    driftCodes.push('CAPABILITY_AUTHORITY_MISMATCH');
  }
  if (proposal.snapshotId !== plan.snapshotId) driftCodes.push('SNAPSHOT_AUTHORITY_MISMATCH');
  if (proposal.targetFingerprint !== input.expectedTargetFingerprint) driftCodes.push('TARGET_AUTHORITY_MISMATCH');

  const expectedMetricIds = frame?.metricConceptIds ?? plan.query.measures.flatMap((binding) => binding.qualifiedId ? [binding.qualifiedId] : []);
  const expectedDimensionIds = frame?.dimensions.map((dimension) => dimension.dimensionId) ?? plan.query.dimensions.flatMap((binding) => binding.qualifiedId ? [binding.qualifiedId] : []);
  const expectedOrder = frame?.ranking
    ? { metricId: frame.ranking.byMetricId, direction: frame.ranking.direction }
    : plan.query.order && expectedMetricIds.length === 1
      ? { metricId: expectedMetricIds[0]!, direction: plan.query.order }
      : undefined;
  const expectedLimit = frame?.ranking?.limit ?? plan.query.limit;
  const expectedOutputs = frame?.requestedOutputs.map((output) => output.id)
    ?? plan.outputContract.fields
    ?? [...plan.outputContract.dimensions, ...plan.outputContract.measures];
  const signature = buildGeneratedAnalyticalSqlSignature(proposal.sql, input.dialect);
  if (!signature) {
    driftCodes.push('SQL_PARSE_EVIDENCE_MISSING');
  } else {
    const sqlOutputs = signature.outputs.map((output) => output.outputAlias);
    if (!sameSet(sqlOutputs, expectedOutputs)) driftCodes.push('OUTPUT_TUPLE_DRIFT');
    const capability = plan.selectedCapability;
    if (!capability || expectedMetricIds.length !== 1) {
      driftCodes.push('METRIC_TUPLE_DRIFT');
    } else {
      const metricOutput = frame?.requestedOutputs.find((output) => output.kind === 'metric_value' && output.metricId === expectedMetricIds[0]);
      const actualMetric = metricOutput ? signature.outputs.find((output) => normalizeId(output.outputAlias) === normalizeId(metricOutput.id)) : undefined;
      if (!actualMetric || !metricExpressionMatchesCapability(actualMetric, metricOutput!.id, capability, input.dialect)) {
        driftCodes.push('AGGREGATE_EXPRESSION_TUPLE_DRIFT');
      }
    }
    const expectedDimensionLeaves = expectedDimensionIds.map(normalizeId);
    const dimensionOutputs = frame?.requestedOutputs.filter((output) => output.kind === 'dimension') ?? [];
    for (const output of dimensionOutputs) {
      const signatureOutput = signature.outputs.find((candidate) => normalizeId(candidate.outputAlias) === normalizeId(output.id));
      if (!signatureOutput || signatureOutput.aggregateFunctions.length > 0 || signatureOutput.columns.length !== 1
        || !expectedDimensionLeaves.includes(normalizeId(signatureOutput.columns[0]!))) {
        driftCodes.push('DIMENSION_TUPLE_DRIFT');
      }
    }
    const expectedGroups = [...new Set(dimensionOutputs.map((output) => normalizeId(output.id)))].sort();
    if (expectedGroups.join('|') !== signature.groupByColumns.map(normalizeId).sort().join('|')) driftCodes.push('GROUPING_TUPLE_DRIFT');
    const expectedFilterExpression = expectedFilterSignature(plan, input.dialect);
    if (expectedFilterExpression !== signature.filterExpression) driftCodes.push('FILTER_TUPLE_DRIFT');
    if (expectedOrder) {
      const expectedOrderOutput = frame?.requestedOutputs.find((output) => output.kind === 'metric_value' && output.metricId === expectedOrder.metricId)?.id
        ?? expectedOrder.metricId.split(/[:.]/).at(-1)!;
      if (signature.orderBy.length !== 1
        || normalizeId(signature.orderBy[0]!.expression) !== normalizeId(expectedOrderOutput)
        || signature.orderBy[0]!.direction !== expectedOrder.direction) driftCodes.push('ORDER_TUPLE_DRIFT');
    } else if (signature.orderBy.length > 0) driftCodes.push('ORDER_TUPLE_DRIFT');
    const actualLimit = signature.limit?.kind === 'literal' ? signature.limit.value : undefined;
    if (actualLimit !== expectedLimit) driftCodes.push('LIMIT_TUPLE_DRIFT');
    compareSet(plan.sourceRelationIds.map(normalizeId), signature.sourceRelations.map(normalizeId), 'RELATION_TUPLE_DRIFT', driftCodes);
    if (!joinsMatchFrozenRelationships(signature.joins, plan.relationshipPathIds, input.contextPack?.objects ?? [])) {
      driftCodes.push('JOIN_PREDICATE_TUPLE_DRIFT');
    }
    if (signature.setOperations.length > 0) driftCodes.push('SET_OPERATION_TUPLE_DRIFT');
    if (signature.hasWindow) driftCodes.push('WINDOW_TUPLE_DRIFT');
  }

  const uniqueCodes = [...new Set(driftCodes)];
  return uniqueCodes.length === 0
    ? { ok: true }
    : {
        ok: false,
        code: 'GENERATED_ANALYTICAL_TUPLE_DRIFT',
        message: GENERATED_ANALYTICAL_TUPLE_DRIFT_MESSAGE,
        driftCodes: uniqueCodes,
      };
}

function metricExpressionMatchesCapability(
  actual: {
    canonicalExpression: string;
    aggregateInputs: Array<{ func: string; distinct: boolean; column?: string; relation?: string }>;
  },
  outputId: string,
  capability: MetricCapabilityContract,
  dialect?: string,
): boolean {
  const measureLeaves = [...new Set(capability.measureIds.map(normalizeId))];
  if (measureLeaves.length !== 1) return false;
  const column = parserIdentifier(measureLeaves[0]!);
  const alias = parserIdentifier(normalizeId(outputId));
  if (!column || !alias) return false;
  const aggregation = capability.aggregation.toLowerCase();
  const expression = aggregation === 'count_distinct'
    ? `COUNT(DISTINCT ${column})`
    : ['sum', 'count', 'avg', 'average', 'min', 'max'].includes(aggregation)
      ? `${aggregation === 'average' ? 'AVG' : aggregation.toUpperCase()}(${column})`
      : undefined;
  if (!expression) return false;
  const expected = buildSqlOutputExpressionSignature(`SELECT ${expression} AS ${alias} FROM generated_authority`, alias, dialect);
  const expectedOperator = aggregation === 'count_distinct'
    ? 'COUNT'
    : aggregation === 'average' ? 'AVG' : aggregation.toUpperCase();
  const expectedRelation = capability.semanticModelId ? normalizeId(capability.semanticModelId) : undefined;
  const aggregateInput = actual.aggregateInputs.length === 1 ? actual.aggregateInputs[0] : undefined;
  return expected?.canonicalExpression === actual.canonicalExpression
    && aggregateInput?.func === expectedOperator
    && aggregateInput.distinct === (aggregation === 'count_distinct')
    && normalizeId(aggregateInput.column ?? '') === measureLeaves[0]
    && Boolean(expectedRelation)
    && normalizeId(aggregateInput.relation ?? '') === expectedRelation;
}

function expectedFilterSignature(plan: ResolvedAnalyticalPlan, dialect?: string): string | undefined {
  const bindings = plan.analyticalFrame?.memberBindings ?? [];
  if (bindings.length === 0) return undefined;
  const predicates = bindings.flatMap((binding) => {
    const identifier = parserIdentifier(normalizeId(binding.dimensionId));
    return identifier ? binding.canonicalValues.map((value) => `${identifier} = ${sqlLiteral(value)}`) : [];
  });
  const expectedPredicateCount = bindings.reduce((count, binding) => count + binding.canonicalValues.length, 0);
  if (predicates.length !== expectedPredicateCount || predicates.length === 0) return '__invalid_frozen_filter__';
  return buildGeneratedAnalyticalSqlSignature(`SELECT 1 AS proof FROM generated_authority WHERE ${predicates.join(' AND ')}`, dialect)?.filterExpression;
}

function joinsMatchFrozenRelationships(
  joins: Array<{ leftRelation?: string; leftColumn: string; rightRelation?: string; rightColumn: string; joinType?: string }>,
  relationshipIds: string[],
  objects: MetadataObject[],
): boolean {
  if (joins.length === 0) return relationshipIds.length === 0;
  const relationships = relationshipIds.flatMap((id) => {
    const matches = objects.filter((object) => [object.objectKey, object.fullName, object.name, object.payload?.qualifiedId].includes(id));
    return matches.length === 1 ? matches : [];
  });
  if (relationships.length !== relationshipIds.length) return false;
  const expected = relationships.flatMap(relationshipJoinSignatures);
  const actual = joins.map(joinSignature);
  return expected.length > 0 && expected.length === actual.length && sameSet(expected, actual);
}

function relationshipJoinSignatures(object: MetadataObject): string[] {
  const payload = object.payload ?? {};
  const fromRelation = stringValue(payload.fromRelation);
  const toRelation = stringValue(payload.toRelation);
  const cardinality = stringValue(payload.cardinality);
  const fanout = stringValue(payload.fanout);
  const authorizedJoinType = normalizeJoinType(stringValue(payload.joinType) ?? 'INNER JOIN');
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  if (!fromRelation || !toRelation || !cardinality || fanout !== 'safe' || keys.length === 0) return [];
  return keys.flatMap((key) => {
    if (!key || typeof key !== 'object') return [];
    const from = stringValue((key as Record<string, unknown>).from);
    const to = stringValue((key as Record<string, unknown>).to);
    return from && to
      ? [canonicalJoinSignature(fromRelation, from, toRelation, to, authorizedJoinType)]
      : [];
  });
}

function joinSignature(join: {
  leftRelation?: string;
  leftColumn: string;
  rightRelation?: string;
  rightColumn: string;
  joinType?: string;
}): string {
  if (!join.leftRelation || !join.rightRelation) return '__unresolved_join__';
  return canonicalJoinSignature(
    join.leftRelation,
    join.leftColumn,
    join.rightRelation,
    join.rightColumn,
    normalizeJoinType(join.joinType),
  );
}

function canonicalJoinSignature(
  leftRelation: string,
  leftColumn: string,
  rightRelation: string,
  rightColumn: string,
  joinType: string,
): string {
  const endpoints = [
    `${normalizeId(leftRelation)}.${normalizeId(leftColumn)}`,
    `${normalizeId(rightRelation)}.${normalizeId(rightColumn)}`,
  ].sort();
  return `${joinType}:${endpoints.join('=')}`;
}

function normalizeJoinType(value: string | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, ' ').toUpperCase() ?? '';
  return normalized === 'JOIN' ? 'INNER JOIN' : normalized;
}

function sqlLiteral(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parserIdentifier(value: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compareSet(
  expected: string[],
  actual: string[],
  code: GeneratedAnalyticalTupleDriftCode,
  codes: GeneratedAnalyticalTupleDriftCode[],
): void {
  if (!sameSet(expected, actual)) codes.push(code);
}

function sameSet(expected: string[], actual: string[]): boolean {
  return [...new Set(expected)].sort().join('|') === [...new Set(actual)].sort().join('|');
}

function normalizeId(value: string): string {
  return value.replace(/["`]/g, '').split(/[:.]/).at(-1)!.toLowerCase();
}
