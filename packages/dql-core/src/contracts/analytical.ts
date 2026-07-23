/**
 * Versioned cross-surface contracts for analytical composition and repair.
 *
 * These types deliberately contain no agent or UI concepts. Ask, Notebook,
 * CLI, MCP, Chat, and execution adapters exchange the same serialized shapes.
 *
 * Acceptance: CONTRACT-002, AGT-017, API-007, SEC-004.
 */

export const ANALYTICAL_QUESTION_FRAME_VERSION = 2 as const;
export const ANALYTICAL_FAILURE_VERSION = 1 as const;
export const ANALYTICAL_FAILURE_V2_VERSION = 2 as const;

export type AnalyticalDimensionRole = 'group_by' | 'filter' | 'display' | 'rank_entity' | 'time_axis';

export type AnalyticalQuestionType = 'definition' | 'scalar' | 'ranking' | 'trend' | 'comparison' | 'diagnosis' | 'research';

export type AnalyticalPeriodKind = 'absolute' | 'current' | 'previous_period' | 'previous_year';

export interface AnalyticalDimensionBindingV2 {
  dimensionId: string;
  role: AnalyticalDimensionRole;
  requestedLabel?: string;
}

export interface AnalyticalMemberBindingV2 {
  dimensionId: string;
  canonicalValues: unknown[];
  source: 'question' | 'clarification' | 'prior_result' | 'parameter';
  confidence: 'exact' | 'high' | 'medium';
  sourceTurnId?: string;
}

export interface AnalyticalPeriodV2 {
  id: string;
  kind: AnalyticalPeriodKind;
  start?: string;
  end?: string;
  alignToPeriodId?: string;
}

export interface AnalyticalTimeContextV2 {
  timeDimensionId?: string;
  timeRole?: string;
  calendarId?: string;
  timezone?: string;
  grain?: string;
  completenessPolicy?: 'partial_current' | 'latest_complete' | 'closed_period';
  periods: AnalyticalPeriodV2[];
}

export interface AnalyticalComparisonV2 {
  basePeriodId: string;
  comparisonPeriodIds: string[];
  alignment?: 'elapsed_period' | 'calendar_period' | 'fiscal_period';
  outputs: Array<'value' | 'absolute_delta' | 'percent_delta'>;
  zeroDenominatorPolicy: 'null' | 'not_applicable';
}

export interface AnalyticalRankingV2 {
  entityDimensionId: string;
  byMetricId: string;
  byPeriodId?: string;
  direction: 'asc' | 'desc';
  limit: number;
  tiePolicy: 'stable_secondary_key' | 'include_ties';
}

export interface AnalyticalRequestedOutputV2 {
  id: string;
  kind: 'dimension' | 'metric_value' | 'delta' | 'percent_delta' | 'rank';
  metricId?: string;
  periodId?: string;
}

export interface AnalyticalAmbiguityV2 {
  field: string;
  candidateIds: string[];
  reasonCode: string;
}

export interface AnalyticalQuestionFrameV2 {
  version: 2;
  interpretedQuestion: string;
  questionType: AnalyticalQuestionType;
  metricConceptIds: string[];
  entityGrainIds: string[];
  dimensions: AnalyticalDimensionBindingV2[];
  memberBindings: AnalyticalMemberBindingV2[];
  timeContext?: AnalyticalTimeContextV2;
  comparison?: AnalyticalComparisonV2;
  ranking?: AnalyticalRankingV2;
  requestedOutputs: AnalyticalRequestedOutputV2[];
  ambiguity: AnalyticalAmbiguityV2[];
}

export type AnalyticalOperation = 'filter' | 'group' | 'trend' | 'compare' | 'rank' | 'window' | 'having';

export interface MetricCapabilityContract {
  metricId: string;
  semanticModelId?: string;
  measureIds: string[];
  primaryEntityId: string;
  /** Result grain used when the question requests no grouping dimension. */
  defaultResultGrainId: string;
  resultGrainIds: string[];
  aggregation: string;
  additivity: {
    entities: 'additive' | 'semi_additive' | 'non_additive';
    time: 'additive' | 'semi_additive' | 'non_additive';
    nonAdditiveDimensionIds?: string[];
  };
  dimensions: Array<{
    dimensionId: string;
    /** Entity grain produced/filtered by this dimension. */
    entityId: string;
    supportedRoles: AnalyticalDimensionRole[];
    relationshipPathIds?: string[];
  }>;
  timeDimensions: Array<{
    dimensionId: string;
    role: string;
    supportedGrains: string[];
    defaultFor?: Array<'scalar' | 'trend' | 'comparison'>;
  }>;
  freshness?: {
    observedThroughFieldId?: string;
    defaultCompletenessPolicy?: 'partial_current' | 'latest_complete' | 'closed_period';
  };
  operations: AnalyticalOperation[];
  supportedOutputKinds: AnalyticalRequestedOutputV2['kind'][];
  /** Certified assets may further restrict the exact output aliases. */
  declaredOutputIds?: string[];
  executionCapabilities: Array<{
    route: 'certified' | 'semantic' | 'governed_sql' | 'exploratory';
    adapterId?: string;
  }>;
  sourceFingerprint: string;
}

export interface AnalyticalPolicyContract {
  policyId: string;
  sourceHash: string;
  metricIds?: string[];
  timeRole?: string;
  calendarId?: string;
  timezone?: string;
  completenessPolicy?: 'partial_current' | 'latest_complete' | 'closed_period';
  comparisonAlignment?: 'elapsed_period' | 'calendar_period' | 'fiscal_period';
  defaultRankingPeriod?: 'current' | 'comparison';
  narrativeGuidance?: string[];
}

export type AnalyticalFailureCode =
  | 'COLUMN_NOT_FOUND'
  | 'RELATION_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'AMBIGUOUS_COLUMN'
  | 'DIALECT_ERROR'
  | 'SNAPSHOT_DRIFT'
  | 'TIMEOUT'
  | 'RESULT_CONTRACT_MISMATCH'
  | 'COMPILATION_FAILED'
  | 'POLICY_DENIED';

export type AnalyticalFailurePhase = 'planning' | 'compilation' | 'validation' | 'execution' | 'result_validation';

export type AnalyticalFailureRecoverability =
  | 'retry_same'
  | 'refresh_snapshot'
  | 'edit_dql'
  | 'edit_sql'
  | 'change_authorized_connection'
  | 'request_access'
  | 'modeling_change'
  | 'none';

export interface AnalyticalFailureV1 {
  version: 1;
  runId: string;
  failureId: string;
  code: AnalyticalFailureCode;
  phase: AnalyticalFailurePhase;
  message: string;
  recoverability: AnalyticalFailureRecoverability;
  failedBindings: Array<{
    qualifiedId?: string;
    role?: string;
    reasonCode: string;
  }>;
  snapshotId: string;
  planFingerprint?: string;
  dqlFingerprint?: string;
  sqlFingerprint?: string;
  safeActions: string[];
}

export type AnalyticalFailureCodeV2 =
  | AnalyticalFailureCode
  | 'SEMANTIC_ADAPTER_NOT_READY'
  | 'SEMANTIC_TARGET_BINDING_MISSING'
  | 'EXECUTION_TARGET_MISMATCH'
  | 'SEMANTIC_SOURCE_DRIFT'
  | 'SEMANTIC_MEMBER_BINDING_FAILED'
  | 'SEMANTIC_PATH_AMBIGUOUS'
  | 'IDENTIFIER_SCOPE_INVALID'
  | 'EXECUTION_CANCELLED'
  | 'SEMANTIC_COMPILATION_TIMEOUT';

export interface AnalyticalFailureV2 extends Omit<AnalyticalFailureV1, 'version' | 'code'> {
  version: 2;
  code: AnalyticalFailureCodeV2;
  expectedTargetFingerprint?: string;
  actualTargetFingerprint?: string;
  adapterId?: string;
  queryId?: string;
  sqlState?: string;
  vendorCode?: string;
}

export type AnalyticalTrustState = 'certified' | 'governed' | 'review_required';

export type AnalyticalRepairChange = 'parameter_only' | 'display_only' | 'dql_source' | 'sql_text' | 'snapshot_refresh' | 'connection_change' | 'reviewed_draft_promotion';

export interface AnalyticalRepairTrustTransition {
  previous: AnalyticalTrustState;
  next: AnalyticalTrustState;
  requiresNewReceipt: boolean;
  requiresReview: boolean;
  preservesCertifiedAssetIdentity: boolean;
}

const DIMENSION_ROLES = new Set<AnalyticalDimensionRole>(['group_by', 'filter', 'display', 'rank_entity', 'time_axis']);
const QUESTION_TYPES = new Set<AnalyticalQuestionType>(['definition', 'scalar', 'ranking', 'trend', 'comparison', 'diagnosis', 'research']);
const PERIOD_KINDS = new Set<AnalyticalPeriodKind>(['absolute', 'current', 'previous_period', 'previous_year']);
const COMPLETENESS_POLICIES = new Set(['partial_current', 'latest_complete', 'closed_period'] as const);
const FAILURE_CODES = new Set<AnalyticalFailureCode>([
  'COLUMN_NOT_FOUND',
  'RELATION_NOT_FOUND',
  'PERMISSION_DENIED',
  'AMBIGUOUS_COLUMN',
  'DIALECT_ERROR',
  'SNAPSHOT_DRIFT',
  'TIMEOUT',
  'RESULT_CONTRACT_MISMATCH',
  'COMPILATION_FAILED',
  'POLICY_DENIED',
]);
const FAILURE_CODES_V2 = new Set<AnalyticalFailureCodeV2>([
  ...FAILURE_CODES,
  'SEMANTIC_ADAPTER_NOT_READY',
  'SEMANTIC_TARGET_BINDING_MISSING',
  'EXECUTION_TARGET_MISMATCH',
  'SEMANTIC_SOURCE_DRIFT',
  'SEMANTIC_MEMBER_BINDING_FAILED',
  'SEMANTIC_PATH_AMBIGUOUS',
  'IDENTIFIER_SCOPE_INVALID',
  'EXECUTION_CANCELLED',
  'SEMANTIC_COMPILATION_TIMEOUT',
]);
const FAILURE_PHASES = new Set<AnalyticalFailurePhase>(['planning', 'compilation', 'validation', 'execution', 'result_validation']);
const RECOVERABILITY = new Set<AnalyticalFailureRecoverability>([
  'retry_same',
  'refresh_snapshot',
  'edit_dql',
  'edit_sql',
  'change_authorized_connection',
  'request_access',
  'modeling_change',
  'none',
]);

/** Strictly normalize an untrusted cross-surface analytical frame. */
export function normalizeAnalyticalQuestionFrameV2(value: unknown): AnalyticalQuestionFrameV2 | undefined {
  const record = objectRecord(value);
  if (!record || record.version !== ANALYTICAL_QUESTION_FRAME_VERSION) return undefined;
  const interpretedQuestion = cleanString(record.interpretedQuestion);
  const questionType = enumValue(record.questionType, QUESTION_TYPES);
  const metricConceptIds = cleanStringArray(record.metricConceptIds);
  const entityGrainIds = cleanStringArray(record.entityGrainIds);
  const dimensions = normalizeDimensions(record.dimensions);
  const memberBindings = normalizeMemberBindings(record.memberBindings);
  const requestedOutputs = normalizeRequestedOutputs(record.requestedOutputs);
  const ambiguity = normalizeAmbiguity(record.ambiguity);
  if (!interpretedQuestion || !questionType || !metricConceptIds || !entityGrainIds || !dimensions || !memberBindings || !requestedOutputs || !ambiguity) return undefined;
  const timeContext = record.timeContext === undefined ? undefined : normalizeTimeContext(record.timeContext);
  const comparison = record.comparison === undefined ? undefined : normalizeComparison(record.comparison);
  const ranking = record.ranking === undefined ? undefined : normalizeRanking(record.ranking);
  if (record.timeContext !== undefined && !timeContext) return undefined;
  if (record.comparison !== undefined && !comparison) return undefined;
  if (record.ranking !== undefined && !ranking) return undefined;
  return {
    version: ANALYTICAL_QUESTION_FRAME_VERSION,
    interpretedQuestion,
    questionType,
    metricConceptIds,
    entityGrainIds,
    dimensions,
    memberBindings,
    ...(timeContext ? { timeContext } : {}),
    ...(comparison ? { comparison } : {}),
    ...(ranking ? { ranking } : {}),
    requestedOutputs,
    ambiguity,
  };
}

/** Strictly normalize capability metadata before it becomes routing evidence. */
export function normalizeMetricCapabilityContract(value: unknown): MetricCapabilityContract | undefined {
  const record = objectRecord(value);
  const metricId = cleanString(record?.metricId);
  const measureIds = cleanStringArray(record?.measureIds);
  const primaryEntityId = cleanString(record?.primaryEntityId);
  const defaultResultGrainId = cleanString(record?.defaultResultGrainId);
  const resultGrainIds = cleanStringArray(record?.resultGrainIds);
  const aggregation = cleanString(record?.aggregation);
  const sourceFingerprint = cleanString(record?.sourceFingerprint);
  const additivity = normalizeAdditivity(record?.additivity);
  const dimensions = normalizeCapabilityDimensions(record?.dimensions);
  const timeDimensions = normalizeCapabilityTimeDimensions(record?.timeDimensions);
  const operations = normalizeOperations(record?.operations);
  const supportedOutputKinds = normalizeOutputKinds(record?.supportedOutputKinds);
  const executionCapabilities = normalizeExecutionCapabilities(record?.executionCapabilities);
  if (
    !record ||
    !metricId ||
    !measureIds ||
    !primaryEntityId ||
    !defaultResultGrainId ||
    !resultGrainIds ||
    !aggregation ||
    !sourceFingerprint ||
    !additivity ||
    !dimensions ||
    !timeDimensions ||
    !operations ||
    !supportedOutputKinds ||
    !executionCapabilities
  )
    return undefined;
  const freshness = record.freshness === undefined ? undefined : normalizeFreshness(record.freshness);
  const declaredOutputIds = record.declaredOutputIds === undefined ? undefined : cleanStringArray(record.declaredOutputIds);
  if (record.freshness !== undefined && !freshness) return undefined;
  if (record.declaredOutputIds !== undefined && !declaredOutputIds) return undefined;
  return {
    metricId,
    ...(cleanString(record.semanticModelId) ? { semanticModelId: cleanString(record.semanticModelId) } : {}),
    measureIds,
    primaryEntityId,
    defaultResultGrainId,
    resultGrainIds,
    aggregation,
    additivity,
    dimensions,
    timeDimensions,
    ...(freshness ? { freshness } : {}),
    operations,
    supportedOutputKinds,
    ...(declaredOutputIds ? { declaredOutputIds } : {}),
    executionCapabilities,
    sourceFingerprint,
  };
}

/** Strictly normalize a failure returned by any DQL analytical surface. */
export function normalizeAnalyticalFailureV1(value: unknown): AnalyticalFailureV1 | undefined {
  const record = objectRecord(value);
  if (!record || record.version !== ANALYTICAL_FAILURE_VERSION) return undefined;
  const runId = cleanString(record.runId);
  const failureId = cleanString(record.failureId);
  const code = enumValue(record.code, FAILURE_CODES);
  const phase = enumValue(record.phase, FAILURE_PHASES);
  const message = cleanString(record.message);
  const recoverability = enumValue(record.recoverability, RECOVERABILITY);
  const snapshotId = cleanString(record.snapshotId);
  const safeActions = cleanStringArray(record.safeActions);
  if (!runId || !failureId || !code || !phase || !message || !recoverability || !snapshotId || !safeActions) {
    return undefined;
  }
  if (!Array.isArray(record.failedBindings)) return undefined;
  const failedBindings = record.failedBindings.flatMap((item) => {
    const binding = objectRecord(item);
    const reasonCode = cleanString(binding?.reasonCode);
    if (!binding || !reasonCode) return [];
    return [
      {
        ...(cleanString(binding.qualifiedId) ? { qualifiedId: cleanString(binding.qualifiedId) } : {}),
        ...(cleanString(binding.role) ? { role: cleanString(binding.role) } : {}),
        reasonCode,
      },
    ];
  });
  if (failedBindings.length !== record.failedBindings.length) return undefined;
  return {
    version: ANALYTICAL_FAILURE_VERSION,
    runId,
    failureId,
    code,
    phase,
    message,
    recoverability,
    failedBindings,
    snapshotId,
    ...(cleanString(record.planFingerprint) ? { planFingerprint: cleanString(record.planFingerprint) } : {}),
    ...(cleanString(record.dqlFingerprint) ? { dqlFingerprint: cleanString(record.dqlFingerprint) } : {}),
    ...(cleanString(record.sqlFingerprint) ? { sqlFingerprint: cleanString(record.sqlFingerprint) } : {}),
    safeActions,
  };
}

/** Strictly normalize the target-bound failure returned by any DQL surface. */
export function normalizeAnalyticalFailureV2(value: unknown): AnalyticalFailureV2 | undefined {
  const record = objectRecord(value);
  if (!record || record.version !== ANALYTICAL_FAILURE_V2_VERSION) return undefined;
  const runId = cleanString(record.runId);
  const failureId = cleanString(record.failureId);
  const code = enumValue(record.code, FAILURE_CODES_V2);
  const phase = enumValue(record.phase, FAILURE_PHASES);
  const message = cleanString(record.message);
  const recoverability = enumValue(record.recoverability, RECOVERABILITY);
  const snapshotId = cleanString(record.snapshotId);
  const safeActions = cleanStringArray(record.safeActions);
  if (!runId || !failureId || !code || !phase || !message || !recoverability || !snapshotId || !safeActions) {
    return undefined;
  }
  if (!Array.isArray(record.failedBindings)) return undefined;
  const failedBindings = record.failedBindings.flatMap((item) => {
    const binding = objectRecord(item);
    const reasonCode = cleanString(binding?.reasonCode);
    if (!binding || !reasonCode) return [];
    return [{
      ...(cleanString(binding.qualifiedId) ? { qualifiedId: cleanString(binding.qualifiedId) } : {}),
      ...(cleanString(binding.role) ? { role: cleanString(binding.role) } : {}),
      reasonCode,
    }];
  });
  if (failedBindings.length !== record.failedBindings.length) return undefined;
  return {
    version: ANALYTICAL_FAILURE_V2_VERSION,
    runId,
    failureId,
    code,
    phase,
    message,
    recoverability,
    failedBindings,
    snapshotId,
    ...(cleanString(record.planFingerprint) ? { planFingerprint: cleanString(record.planFingerprint) } : {}),
    ...(cleanString(record.dqlFingerprint) ? { dqlFingerprint: cleanString(record.dqlFingerprint) } : {}),
    ...(cleanString(record.sqlFingerprint) ? { sqlFingerprint: cleanString(record.sqlFingerprint) } : {}),
    ...(cleanString(record.expectedTargetFingerprint) ? { expectedTargetFingerprint: cleanString(record.expectedTargetFingerprint) } : {}),
    ...(cleanString(record.actualTargetFingerprint) ? { actualTargetFingerprint: cleanString(record.actualTargetFingerprint) } : {}),
    ...(cleanString(record.adapterId) ? { adapterId: cleanString(record.adapterId) } : {}),
    ...(cleanString(record.queryId) ? { queryId: cleanString(record.queryId) } : {}),
    ...(cleanString(record.sqlState) ? { sqlState: cleanString(record.sqlState) } : {}),
    ...(cleanString(record.vendorCode) ? { vendorCode: cleanString(record.vendorCode) } : {}),
    safeActions,
  };
}

/** Apply the RFC 0005 trust matrix before a derived repair is exposed. */
export function analyticalRepairTrustTransition(input: {
  previous: AnalyticalTrustState;
  change: AnalyticalRepairChange;
  governedValidationPassed?: boolean;
}): AnalyticalRepairTrustTransition {
  if (input.change === 'parameter_only' || input.change === 'display_only' || input.change === 'snapshot_refresh' || input.change === 'connection_change') {
    return {
      previous: input.previous,
      next: input.previous,
      requiresNewReceipt: input.change !== 'display_only',
      requiresReview: false,
      preservesCertifiedAssetIdentity: input.previous === 'certified',
    };
  }
  if (input.change === 'dql_source') {
    return {
      previous: input.previous,
      next: input.governedValidationPassed ? 'governed' : 'review_required',
      requiresNewReceipt: true,
      requiresReview: true,
      preservesCertifiedAssetIdentity: false,
    };
  }
  if (input.change === 'reviewed_draft_promotion') {
    return {
      previous: input.previous,
      next: input.governedValidationPassed ? 'governed' : 'review_required',
      requiresNewReceipt: true,
      requiresReview: true,
      preservesCertifiedAssetIdentity: false,
    };
  }
  return {
    previous: input.previous,
    next: 'review_required',
    requiresNewReceipt: true,
    requiresReview: true,
    preservesCertifiedAssetIdentity: false,
  };
}

function normalizeDimensions(value: unknown): AnalyticalDimensionBindingV2[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => {
    const record = objectRecord(item);
    const dimensionId = cleanString(record?.dimensionId);
    const role = enumValue(record?.role, DIMENSION_ROLES);
    if (!record || !dimensionId || !role) return [];
    return [
      {
        dimensionId,
        role,
        ...(cleanString(record.requestedLabel) ? { requestedLabel: cleanString(record.requestedLabel) } : {}),
      },
    ];
  });
  return result.length === value.length ? result : undefined;
}

function normalizeMemberBindings(value: unknown): AnalyticalMemberBindingV2[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => {
    const record = objectRecord(item);
    const dimensionId = cleanString(record?.dimensionId);
    const source = enumValue(record?.source, new Set(['question', 'clarification', 'prior_result', 'parameter'] as const));
    const confidence = enumValue(record?.confidence, new Set(['exact', 'high', 'medium'] as const));
    if (!record || !dimensionId || !source || !confidence || !Array.isArray(record.canonicalValues)) return [];
    return [
      {
        dimensionId,
        canonicalValues: [...record.canonicalValues],
        source,
        confidence,
        ...(cleanString(record.sourceTurnId) ? { sourceTurnId: cleanString(record.sourceTurnId) } : {}),
      },
    ];
  });
  return result.length === value.length ? result : undefined;
}

function normalizeTimeContext(value: unknown): AnalyticalTimeContextV2 | undefined {
  const record = objectRecord(value);
  if (!record || !Array.isArray(record.periods)) return undefined;
  const periods = record.periods.flatMap((item) => {
    const period = objectRecord(item);
    const id = cleanString(period?.id);
    const kind = enumValue(period?.kind, PERIOD_KINDS);
    if (!period || !id || !kind) return [];
    return [
      {
        id,
        kind,
        ...(cleanString(period.start) ? { start: cleanString(period.start) } : {}),
        ...(cleanString(period.end) ? { end: cleanString(period.end) } : {}),
        ...(cleanString(period.alignToPeriodId) ? { alignToPeriodId: cleanString(period.alignToPeriodId) } : {}),
      },
    ];
  });
  if (periods.length !== record.periods.length) return undefined;
  const completenessPolicy = record.completenessPolicy === undefined ? undefined : enumValue(record.completenessPolicy, COMPLETENESS_POLICIES);
  if (record.completenessPolicy !== undefined && !completenessPolicy) return undefined;
  return {
    ...(cleanString(record.timeDimensionId) ? { timeDimensionId: cleanString(record.timeDimensionId) } : {}),
    ...(cleanString(record.timeRole) ? { timeRole: cleanString(record.timeRole) } : {}),
    ...(cleanString(record.calendarId) ? { calendarId: cleanString(record.calendarId) } : {}),
    ...(cleanString(record.timezone) ? { timezone: cleanString(record.timezone) } : {}),
    ...(cleanString(record.grain) ? { grain: cleanString(record.grain) } : {}),
    ...(completenessPolicy ? { completenessPolicy } : {}),
    periods,
  };
}

function normalizeComparison(value: unknown): AnalyticalComparisonV2 | undefined {
  const record = objectRecord(value);
  const basePeriodId = cleanString(record?.basePeriodId);
  const comparisonPeriodIds = cleanStringArray(record?.comparisonPeriodIds);
  if (!record || !basePeriodId || !comparisonPeriodIds || !Array.isArray(record.outputs)) return undefined;
  const outputs = record.outputs.filter((item): item is AnalyticalComparisonV2['outputs'][number] => item === 'value' || item === 'absolute_delta' || item === 'percent_delta');
  const zeroDenominatorPolicy = record.zeroDenominatorPolicy === 'null' || record.zeroDenominatorPolicy === 'not_applicable' ? record.zeroDenominatorPolicy : undefined;
  const alignment = record.alignment === 'elapsed_period' || record.alignment === 'calendar_period' || record.alignment === 'fiscal_period' ? record.alignment : undefined;
  if (record.alignment !== undefined && !alignment) return undefined;
  if (outputs.length !== record.outputs.length || !zeroDenominatorPolicy) return undefined;
  return {
    basePeriodId,
    comparisonPeriodIds,
    ...(alignment ? { alignment } : {}),
    outputs,
    zeroDenominatorPolicy,
  };
}

function normalizeRanking(value: unknown): AnalyticalRankingV2 | undefined {
  const record = objectRecord(value);
  const entityDimensionId = cleanString(record?.entityDimensionId);
  const byMetricId = cleanString(record?.byMetricId);
  const direction = record?.direction === 'asc' || record?.direction === 'desc' ? record.direction : undefined;
  const tiePolicy = record?.tiePolicy === 'stable_secondary_key' || record?.tiePolicy === 'include_ties' ? record.tiePolicy : undefined;
  const limit = positiveInteger(record?.limit);
  if (!record || !entityDimensionId || !byMetricId || !direction || !tiePolicy || !limit) return undefined;
  return {
    entityDimensionId,
    byMetricId,
    ...(cleanString(record.byPeriodId) ? { byPeriodId: cleanString(record.byPeriodId) } : {}),
    direction,
    limit,
    tiePolicy,
  };
}

function normalizeRequestedOutputs(value: unknown): AnalyticalRequestedOutputV2[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => {
    const record = objectRecord(item);
    const id = cleanString(record?.id);
    const kind: AnalyticalRequestedOutputV2['kind'] | undefined =
      record?.kind === 'dimension' || record?.kind === 'metric_value' || record?.kind === 'delta' || record?.kind === 'percent_delta' || record?.kind === 'rank'
        ? record.kind
        : undefined;
    if (!record || !id || !kind) return [];
    return [
      {
        id,
        kind,
        ...(cleanString(record.metricId) ? { metricId: cleanString(record.metricId) } : {}),
        ...(cleanString(record.periodId) ? { periodId: cleanString(record.periodId) } : {}),
      },
    ];
  });
  return result.length === value.length ? result : undefined;
}

function normalizeAmbiguity(value: unknown): AnalyticalAmbiguityV2[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => {
    const record = objectRecord(item);
    const field = cleanString(record?.field);
    const candidateIds = cleanStringArray(record?.candidateIds);
    const reasonCode = cleanString(record?.reasonCode);
    return record && field && candidateIds && reasonCode ? [{ field, candidateIds, reasonCode }] : [];
  });
  return result.length === value.length ? result : undefined;
}

function normalizeAdditivity(value: unknown): MetricCapabilityContract['additivity'] | undefined {
  const record = objectRecord(value);
  const entities = record?.entities === 'additive' || record?.entities === 'semi_additive' || record?.entities === 'non_additive' ? record.entities : undefined;
  const time = record?.time === 'additive' || record?.time === 'semi_additive' || record?.time === 'non_additive' ? record.time : undefined;
  const nonAdditiveDimensionIds = record?.nonAdditiveDimensionIds === undefined ? undefined : cleanStringArray(record.nonAdditiveDimensionIds);
  if (!record || !entities || !time || (record.nonAdditiveDimensionIds !== undefined && !nonAdditiveDimensionIds)) return undefined;
  return {
    entities,
    time,
    ...(nonAdditiveDimensionIds ? { nonAdditiveDimensionIds } : {}),
  };
}

function normalizeCapabilityDimensions(value: unknown): MetricCapabilityContract['dimensions'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => {
    const record = objectRecord(item);
    const dimensionId = cleanString(record?.dimensionId);
    const entityId = cleanString(record?.entityId);
    if (!record || !dimensionId || !entityId || !Array.isArray(record.supportedRoles)) return [];
    const supportedRoles = record.supportedRoles.flatMap((role) => {
      const normalized = enumValue(role, DIMENSION_ROLES);
      return normalized ? [normalized] : [];
    });
    const relationshipPathIds = record.relationshipPathIds === undefined ? undefined : cleanStringArray(record.relationshipPathIds);
    if (supportedRoles.length !== record.supportedRoles.length || (record.relationshipPathIds !== undefined && !relationshipPathIds)) return [];
    return [
      {
        dimensionId,
        entityId,
        supportedRoles,
        ...(relationshipPathIds ? { relationshipPathIds } : {}),
      },
    ];
  });
  return result.length === value.length ? result : undefined;
}

function normalizeCapabilityTimeDimensions(value: unknown): MetricCapabilityContract['timeDimensions'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => {
    const record = objectRecord(item);
    const dimensionId = cleanString(record?.dimensionId);
    const role = cleanString(record?.role);
    const supportedGrains = cleanStringArray(record?.supportedGrains);
    if (!record || !dimensionId || !role || !supportedGrains) return [];
    const rawDefaultFor = record.defaultFor;
    const defaultFor =
      rawDefaultFor === undefined
        ? undefined
        : Array.isArray(rawDefaultFor)
          ? rawDefaultFor.filter((entry): entry is 'scalar' | 'trend' | 'comparison' => entry === 'scalar' || entry === 'trend' || entry === 'comparison')
          : undefined;
    if (rawDefaultFor !== undefined && (!defaultFor || !Array.isArray(rawDefaultFor) || defaultFor.length !== rawDefaultFor.length)) return [];
    return [
      {
        dimensionId,
        role,
        supportedGrains,
        ...(defaultFor ? { defaultFor } : {}),
      },
    ];
  });
  return result.length === value.length ? result : undefined;
}

function normalizeFreshness(value: unknown): NonNullable<MetricCapabilityContract['freshness']> | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const defaultCompletenessPolicy = record.defaultCompletenessPolicy === undefined ? undefined : enumValue(record.defaultCompletenessPolicy, COMPLETENESS_POLICIES);
  if (record.defaultCompletenessPolicy !== undefined && !defaultCompletenessPolicy) return undefined;
  return {
    ...(cleanString(record.observedThroughFieldId) ? { observedThroughFieldId: cleanString(record.observedThroughFieldId) } : {}),
    ...(defaultCompletenessPolicy ? { defaultCompletenessPolicy } : {}),
  };
}

function normalizeOperations(value: unknown): AnalyticalOperation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<AnalyticalOperation>(['filter', 'group', 'trend', 'compare', 'rank', 'window', 'having']);
  const result = value.flatMap((item) => {
    const operation = enumValue(item, allowed);
    return operation ? [operation] : [];
  });
  return result.length === value.length ? result : undefined;
}

function normalizeOutputKinds(value: unknown): AnalyticalRequestedOutputV2['kind'][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<AnalyticalRequestedOutputV2['kind']>(['dimension', 'metric_value', 'delta', 'percent_delta', 'rank']);
  const result = value.flatMap((item) => {
    const kind = enumValue(item, allowed);
    return kind ? [kind] : [];
  });
  return result.length === value.length ? result : undefined;
}

function normalizeExecutionCapabilities(value: unknown): MetricCapabilityContract['executionCapabilities'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set(['certified', 'semantic', 'governed_sql', 'exploratory'] as const);
  const result = value.flatMap((item) => {
    const record = objectRecord(item);
    const route = enumValue(record?.route, allowed);
    if (!record || !route) return [];
    return [
      {
        route,
        ...(cleanString(record.adapterId) ? { adapterId: cleanString(record.adapterId) } : {}),
      },
    ];
  });
  return result.length === value.length ? result : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map(cleanString);
  return result.every((item): item is string => Boolean(item)) ? result : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
