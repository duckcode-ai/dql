/**
 * Provider-neutral wire contract for the one ordinary Ask planning call.
 *
 * This module deliberately knows nothing about SQL, DQL, connectors, or
 * compiler choice. It turns the runtime-owned, 16-card package into a small
 * JSON request and accepts only a candidate-ID/role/operation proposal. The
 * dql-agent runtime validates every ID and owns all later safety decisions.
 */

import type {
  AnalyticalPlannerOperationV1,
  AnalyticalPlannerProposalV1,
  AnalyticalPlannerRequestV1,
  AnalyticalPlannerTaskProposalV1,
  EvidenceCandidateRoleV1,
  TargetedContextRequestV1,
} from '@duckcodeailabs/dql-agent';

const ALLOWED_OPERATIONS = new Set<AnalyticalPlannerOperationV1>([
  'aggregate', 'rank', 'group', 'filter', 'trend', 'compare', 'project',
]);
const ALLOWED_ROLES = new Set<EvidenceCandidateRoleV1>([
  'metric', 'entity_key', 'entity_label', 'categorical_dimension',
  'time_dimension', 'member', 'relationship', 'context',
]);

export function buildAnalyticalPlannerSystemPrompt(): string {
  return [
    'You are the bounded analytical planner for DQL Ask.',
    'Choose only supplied candidate IDs and express only typed business operations and role bindings.',
    'The deterministic verifier owns canonical IDs, filters, joins, grain, additivity, trust, compiler selection, authorization, plan freeze, SQL, DQL, and execution.',
    'Never emit SQL, DQL, table names, column names, raw joins, trust labels, execution routes, or invented identities.',
    'Use only the supplied taskOptions IDs. Select one task when clauses share one compatible analytical tuple; then set that task coveredTaskIds to every supplied task option the one program covers. Select two or three only when independently executable. Every selected task is executed, so never include a task you do not intend to answer.',
    'The frame and advisory hints are retrieval/parser guidance, not an execution tuple. Correct an inferred metric, entity, or dimension only by selecting supplied, locally-qualified cards. The verifier keeps explicit user predicates, time, ranking, and output constraints immutable and owns all safety decisions.',
    'If one important role is missing, request that role with up to four normalized business searchTerms and up to four relatedCandidateIds chosen only from the supplied cards. Never name a candidate ID that was not supplied. The verifier searches the immutable same-snapshot workspace and may admit at most four cards and three relationship paths before one revision.',
    'For a targeted revision, preserve priorSelectedConceptIds, prior task operations, and every prior role binding except the one verifier-proven missing role. You may bind only targetedCandidates to that missing role; do not re-rank or replace unrelated business meaning.',
    'Return only one JSON object: {"version":1,"selectedConceptIds":string[],"confidence":"high"|"medium"|"low","missingInformation":string[],"tasks":[{"version":1,"taskId":"task-1","coveredTaskIds":["task-1"],"selectedConceptIds":string[],"roleBindings":{"metric":string[]},"operations":["aggregate","rank","group","filter","trend","compare","project"]}],"recovery"?:{"version":1,"missingRoles":string[],"searchTerms":string[],"relatedCandidateIds":string[],"relationshipPathIds":string[]}}.',
  ].join('\n');
}

export function buildAnalyticalPlannerUserPrompt(request: AnalyticalPlannerRequestV1): string {
  return JSON.stringify({
    version: request.version,
    planningMode: request.planningMode,
    question: request.question,
    questionFingerprint: request.questionFingerprint,
    frame: request.frame,
    advisoryHints: request.advisoryHints,
    sourceCoverage: request.sourceCoverage,
    taskOptions: request.taskOptions,
    ...(request.priorProposal ? { priorProposal: request.priorProposal } : {}),
    ...(request.priorSelectedConceptIds?.length ? { priorSelectedConceptIds: request.priorSelectedConceptIds } : {}),
    ...(request.verificationFeedback ? { verificationFeedback: request.verificationFeedback } : {}),
    ...(request.targetedCandidates?.length ? { targetedCandidates: request.targetedCandidates } : {}),
    candidateCards: request.candidates,
    deadlineMs: request.deadlineMs,
  });
}

/** Parse untrusted provider JSON into a minimal typed proposal. */
export function parseAnalyticalPlannerProposal(raw: string): AnalyticalPlannerProposalV1 | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || hasForbiddenExecutionField(record)) return undefined;
  const selectedConceptIds = stringArray(record.selectedConceptIds);
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.map(parseTask).filter((task): task is AnalyticalPlannerTaskProposalV1 => Boolean(task))
    : [];
  if (!selectedConceptIds || tasks.length === 0 || tasks.length > 3) return undefined;
  const confidence = record.confidence === 'high' || record.confidence === 'medium' || record.confidence === 'low'
    ? record.confidence
    : undefined;
  const missingInformation = stringArray(record.missingInformation);
  const recovery = record.recovery === undefined ? undefined : parseRecovery(record.recovery);
  if (record.recovery !== undefined && !recovery) return undefined;
  return {
    version: 1,
    selectedConceptIds,
    tasks,
    ...(confidence ? { confidence } : {}),
    ...(missingInformation ? { missingInformation } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function parseTask(value: unknown): AnalyticalPlannerTaskProposalV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.taskId !== 'string' || !record.taskId.trim() || hasForbiddenExecutionField(record)) return undefined;
  const selectedConceptIds = stringArray(record.selectedConceptIds);
  const coveredTaskIds = record.coveredTaskIds === undefined ? undefined : stringArray(record.coveredTaskIds);
  const operations = stringArray(record.operations);
  if (!selectedConceptIds || (record.coveredTaskIds !== undefined && !coveredTaskIds) || !operations || operations.length === 0 || operations.some((operation) => !ALLOWED_OPERATIONS.has(operation as AnalyticalPlannerOperationV1))) return undefined;
  const roleBindings = parseRoleBindings(record.roleBindings);
  if (!roleBindings) return undefined;
  const preferredCompiler = record.preferredCompiler === 'certified' || record.preferredCompiler === 'metricflow'
    || record.preferredCompiler === 'governed_relational' || record.preferredCompiler === 'exploratory_sql'
    ? record.preferredCompiler
    : undefined;
  const assumptions = stringArray(record.assumptions);
  return {
    version: 1,
    taskId: record.taskId.trim(),
    ...(coveredTaskIds ? { coveredTaskIds } : {}),
    selectedConceptIds,
    roleBindings,
    operations: operations as AnalyticalPlannerOperationV1[],
    ...(preferredCompiler ? { preferredCompiler } : {}),
    ...(assumptions ? { assumptions } : {}),
  };
}

function parseRoleBindings(value: unknown): Partial<Record<EvidenceCandidateRoleV1, string[]>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Partial<Record<EvidenceCandidateRoleV1, string[]>> = {};
  for (const [role, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!ALLOWED_ROLES.has(role as EvidenceCandidateRoleV1)) return undefined;
    const parsed = stringArray(ids);
    if (!parsed) return undefined;
    output[role as EvidenceCandidateRoleV1] = parsed;
  }
  return output;
}

function parseRecovery(value: unknown): TargetedContextRequestV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const missingRoles = stringArray(record.missingRoles);
  const searchTerms = record.searchTerms === undefined ? undefined : stringArray(record.searchTerms);
  const relatedCandidateIds = record.relatedCandidateIds === undefined ? undefined : stringArray(record.relatedCandidateIds);
  // `candidateIds` remains parseable for persisted V1 callers, but new prompt
  // output uses only terms and already-admitted related IDs. Runtime
  // verification rejects hidden IDs before any extension occurs.
  const candidateIds = record.candidateIds === undefined ? undefined : stringArray(record.candidateIds);
  const relationshipPathIds = record.relationshipPathIds === undefined ? undefined : stringArray(record.relationshipPathIds);
  if (record.version !== 1 || !missingRoles
    || (record.searchTerms !== undefined && !searchTerms)
    || (record.relatedCandidateIds !== undefined && !relatedCandidateIds)
    || (record.candidateIds !== undefined && !candidateIds)
    || (record.relationshipPathIds !== undefined && !relationshipPathIds)
    || missingRoles.some((role) => !ALLOWED_ROLES.has(role as EvidenceCandidateRoleV1))
    || (searchTerms?.length ?? 0) > 4
    || (relatedCandidateIds?.length ?? 0) > 4
    || (candidateIds?.length ?? 0) > 4
    || (relationshipPathIds?.length ?? 0) > 3) return undefined;
  return {
    version: 1,
    missingRoles: missingRoles as EvidenceCandidateRoleV1[],
    ...(searchTerms?.length ? { searchTerms } : {}),
    ...(relatedCandidateIds?.length ? { relatedCandidateIds } : {}),
    ...(candidateIds?.length ? { candidateIds } : {}),
    ...(relationshipPathIds?.length ? { relationshipPathIds } : {}),
  };
}

function hasForbiddenExecutionField(record: Record<string, unknown>): boolean {
  return ['sql', 'dql', 'query', 'join', 'route', 'trust', 'authorization', 'compiler'].some((key) => key in record);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) return undefined;
  return [...new Set(value.map((item) => item.trim()))];
}

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
