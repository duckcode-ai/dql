/**
 * Small adapters from existing authoritative typed decisions/receipts into
 * trace spans. No adapter derives authority from prose or labels.
 */
import type { AgentRun, AgentRunEvent, AgentRouteExecutorResult } from '../agent-run-engine.js';
import type { IntentDecision } from '../intent-controller.js';
import type { AnalyticalCascadeDecisionV1 } from '../analytical-orchestration.js';
import type { AskTraceObserverV1 } from './observer.js';
import type {
  AskTraceSafeActionV1,
  AskTraceSpanNameV1,
  AskTraceTerminalFailureCodeV1,
  CandidateDecisionReasonV1,
  SafeCascadeDecisionTraceV1,
} from './types.js';
import { fingerprint } from './utils.js';

const tierSpan = {
  certified: 'cascade.certified',
  semantic: 'cascade.semantic',
  governed_relational: 'cascade.governed_relational',
  exploratory_sql: 'cascade.exploratory_sql',
  clarify_or_gap: 'cascade.clarify_or_gap',
} as const;

/**
 * The router hands observability an already-authoritative decision. Projecting
 * the same immutable decision into the cascade and freeze spans must not spend
 * a second canonical JSON + SHA-256 pass per Ask. Weak ownership keeps this a
 * pure producer cache: it cannot retain a route or become routing authority.
 */
const safeCascadeDecisionCache = new WeakMap<object, SafeCascadeDecisionTraceV1>();
const safeCascadeAttemptCache = new WeakMap<object, SafeCascadeDecisionTraceV1['attempts'][number]>();

export function recordAuthoritativeRouterDecisionV1(observer: AskTraceObserverV1, decision: IntentDecision): void {
  if (!observer.enabled) return;
  const evidence = decision.retrievalEvidence;
  if (evidence) {
    const snapshot = observer.startSpan({
      name: 'snapshot.acquire', stage: 'snapshot', reasonCode: 'completed',
      payload: { kind: 'snapshot', snapshotId: evidence.snapshotId, sourceFingerprint: evidence.sourceFingerprint, freshness: 'unknown' },
    });
    observer.finishSpan(snapshot, { outcome: 'ok', reasonCode: 'completed' });
    const retrieval = observer.startSpan({
      name: 'retrieval', stage: 'retrieval', reasonCode: 'completed',
      payload: { kind: 'retrieval', candidateCount: evidence.candidateCount, fingerprint: evidence.sourceFingerprint },
    });
    observer.finishSpan(retrieval, { outcome: 'ok', reasonCode: 'completed' });
  }
  const requirements = decision.analyticalCascadeDecision?.requirements;
  // A missing meaning result is not itself a rejected model decision. In
  // particular, deterministic pre-meaning clarifications (such as an
  // undeclared fiscal calendar) deliberately skip the model call. Keep that
  // span non-issue and let the authoritative cascade own the clarification.
  const meaningRejected = Boolean(decision.meaningResolutionErrorCode);
  const meaningResolved = Boolean(decision.meaningResolution);
  const meaningReasonCode = meaningRejected
    ? 'meaning_rejected'
    : meaningResolved
      ? 'meaning_resolved'
      : decision.analyticalCascadeDecision?.stopReason === 'coverage_gap'
        ? 'cascade_unavailable'
        : 'unknown';
  const meaningOutcome = meaningRejected
    ? 'error'
    : decision.requiresClarification || !meaningResolved
      ? 'skipped'
      : 'ok';
  const meaning = observer.startSpan({
    name: 'meaning.resolve', stage: 'meaning', reasonCode: meaningReasonCode,
    payload: {
      kind: 'meaning',
      selectedCandidateIds: uniqueIds([
        ...(decision.meaningResolution?.selectedConceptIds ?? []),
        decision.meaningResolution?.recommendedExecutionId ?? '',
      ]),
      rejectedCandidateIds: uniqueIds((decision.meaningResolution?.rejectedCandidates ?? []).map((candidate) => candidate.id)),
      ...(requirements ? { requirementFingerprint: fingerprint(requirements) } : {}),
      source: decision.source === 'llm' ? 'model' : decision.source === 'cache' ? 'cache' : decision.requiresClarification ? 'selection' : 'heuristic',
    },
  });
  observer.finishSpan(meaning, {
    outcome: meaningOutcome,
    reasonCode: meaningReasonCode,
  });
  // Meaning selections are only traceable when the router preserved the
  // candidate's actual role and retrieval source. Never invent a generic
  // `conversation/context` role simply because this adapter runs after the
  // decision has frozen.
  const metadata = new Map((evidence?.candidateTraceMetadata ?? []).map((entry) => [`${entry.candidateId}\u0000${entry.role}`, entry] as const));
  const recordMeaningCandidates = (candidateIds: string[], decisionKind: 'model_selected' | 'model_rejected') => {
    for (const candidateId of uniqueIds(candidateIds)) {
      for (const entry of [...metadata.values()].filter((item) => item.candidateId === candidateId)) {
        observer.recordCandidateDecision({
          candidateId,
          role: entry.role,
          source: entry.source,
          ...(entry.lanes?.length ? { lanes: entry.lanes, lane: entry.lanes[0]?.lane, laneRank: entry.lanes[0]?.rank } : {}),
          decision: decisionKind,
          reasonCode: decisionKind,
          compatibilityCode: 'unknown',
        });
      }
    }
  };
  recordMeaningCandidates([
    ...(decision.meaningResolution?.selectedConceptIds ?? []),
    decision.meaningResolution?.recommendedExecutionId ?? '',
  ], 'model_selected');
  recordMeaningCandidates((decision.meaningResolution?.rejectedCandidates ?? []).map((candidate) => candidate.id), 'model_rejected');
  if (decision.analyticalCascadeDecision) recordCascadeDecisionV1(observer, decision.analyticalCascadeDecision);
}

export function recordCascadeDecisionV1(observer: AskTraceObserverV1, decision: AnalyticalCascadeDecisionV1): void {
  const traceDecision = cascadeThroughFirstFrozenTierV1(decision);
  // The authoritative cascade keeps useful human-facing reason text. Do not
  // leak it into a durable trace: this projection preserves only decision
  // mechanics, qualified IDs, and one-way fingerprints of reasons.
  const safeDecision = safeCascadeDecision(traceDecision);
  const cascade = observer.startSpan({
    name: 'cascade.evaluate', stage: 'cascade',
    reasonCode: traceDecision.stopReason === 'selected' ? 'cascade_selected' : traceDecision.stopReason === 'denied' ? 'cascade_denied' : traceDecision.stopReason === 'ambiguous' ? 'cascade_ambiguous' : traceDecision.stopReason === 'post_freeze_failure' ? 'post_freeze_failure' : 'cascade_unavailable',
    payload: { kind: 'cascade', decision: safeDecision },
  });
  for (const attempt of traceDecision.attempts) {
    const span = observer.startSpan({
      name: (tierSpan[attempt.tier] ?? 'cascade.clarify_or_gap') as Exclude<AskTraceSpanNameV1, 'ask.run' | 'research.run'>,
      stage: 'cascade',
      parentSpanId: cascade,
      reasonCode: attempt.outcome === 'executable' ? 'cascade_selected' : attempt.outcome === 'denied' ? 'cascade_denied' : attempt.outcome === 'ambiguous' ? 'cascade_ambiguous' : attempt.outcome === 'unavailable' ? 'cascade_unavailable' : 'cascade_ineligible',
      payload: { kind: 'cascade', decision: { ...safeDecision, attempts: [safeCascadeAttempt(attempt)] } },
    });
    observer.finishSpan(span, {
      outcome: attempt.outcome === 'executable' ? 'ok' : attempt.outcome === 'denied' ? 'denied' : attempt.outcome === 'unavailable' ? 'unavailable' : attempt.outcome === 'ambiguous' ? 'skipped' : 'skipped',
      reasonCode: attempt.outcome === 'executable' ? 'cascade_selected' : attempt.outcome === 'denied' ? 'cascade_denied' : attempt.outcome === 'ambiguous' ? 'cascade_ambiguous' : attempt.outcome === 'unavailable' ? 'cascade_unavailable' : 'cascade_ineligible',
    });
  }
  observer.finishSpan(cascade, {
    outcome: traceDecision.stopReason === 'denied' ? 'denied' : traceDecision.stopReason === 'post_freeze_failure' ? 'error' : 'ok',
    reasonCode: traceDecision.stopReason === 'selected' ? 'cascade_selected' : traceDecision.stopReason === 'denied' ? 'cascade_denied' : traceDecision.stopReason === 'ambiguous' ? 'cascade_ambiguous' : traceDecision.stopReason === 'post_freeze_failure' ? 'post_freeze_failure' : 'cascade_unavailable',
  });
  recordAuthoritativePlanFreezeV1(observer, traceDecision);
}

/**
 * A freeze may be present in the router's initial cascade decision or arrive
 * only when the host validates an exploratory execution receipt. Project the
 * exact authoritative state at either boundary; callers guard late promotion
 * so a plan is never represented as freezing twice.
 */
export function recordAuthoritativePlanFreezeV1(
  observer: AskTraceObserverV1,
  decision: AnalyticalCascadeDecisionV1,
): void {
  if (!observer.enabled || !decision.planFrozen) return;
  const traceDecision = cascadeThroughFirstFrozenTierV1(decision);
  const freeze = observer.startSpan({
    name: 'plan.freeze', stage: 'plan', reasonCode: 'plan_frozen',
    payload: { kind: 'cascade', decision: safeCascadeDecision(traceDecision) },
  });
  observer.finishSpan(freeze, { outcome: 'ok', reasonCode: 'plan_frozen' });
}

/**
 * Defensive projection for legacy/manual callers: once a tier reports an
 * immutable freeze, later attempted tiers cannot be part of the same trace.
 * Router construction already enforces this invariant, but observability must
 * not turn a malformed old receipt into a misleading portable cascade.
 */
function cascadeThroughFirstFrozenTierV1(
  decision: AnalyticalCascadeDecisionV1,
): AnalyticalCascadeDecisionV1 {
  const selectedFreeze = decision.planFrozen === true && decision.selectedTier
    ? decision.selectedTier
    : undefined;
  let normalized = false;
  const normalizedAttempts = decision.attempts.map((attempt) => {
    if (selectedFreeze !== attempt.tier || attempt.planFrozen) return attempt;
    normalized = true;
    return { ...attempt, planFrozen: true };
  });
  const frozenIndex = normalizedAttempts.findIndex((attempt) => attempt.planFrozen);
  if (frozenIndex < 0 || frozenIndex === normalizedAttempts.length - 1) {
    return normalized ? { ...decision, attempts: normalizedAttempts } : decision;
  }
  return {
    ...decision,
    attempts: normalizedAttempts.slice(0, frozenIndex + 1),
  };
}

export function recordEngineTraceEventV1(observer: AskTraceObserverV1, event: AgentRunEvent): void {
  if (!observer.enabled) return;
  if (event.type === 'plan.created') {
    const span = observer.startSpan({ name: 'meaning.package', stage: 'meaning', reasonCode: 'completed', payload: { kind: 'stage', route: event.route } });
    observer.finishSpan(span, { outcome: 'ok', reasonCode: 'completed' });
  } else if (event.type === 'artifact.created') {
    // The artifact is the engine's already-accepted result boundary. Project
    // only its checksum/count/trust into the trace; never copy rows, SQL, or
    // answer text. This lets the trace prove that the selected frozen route
    // and persisted result receipt refer to the same physical result.
    const result = resultTraceProjection(event.payload);
    // An artifact can carry a blocked answer shell or a narration-only
    // receipt. Neither proves that a result was normalized. Require the
    // canonical result fingerprint before recording successful completion.
    if (!result?.resultFingerprint) return;
    const span = observer.startSpan({
      name: 'result.normalize',
      stage: 'result',
      reasonCode: 'result_accepted',
      payload: {
        kind: 'result',
        trustState: event.trustState,
        ...(result?.resultFingerprint ? { resultFingerprint: result.resultFingerprint } : {}),
        ...(result?.rowCount !== undefined ? { rowCount: result.rowCount } : {}),
      },
    });
    observer.finishSpan(span, { outcome: 'ok', reasonCode: 'result_accepted' });
  }
}

function resultTraceProjection(payload: unknown): { resultFingerprint?: string; rowCount?: number } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const artifact = payload as { payload?: unknown };
  if (!artifact.payload || typeof artifact.payload !== 'object' || Array.isArray(artifact.payload)) return undefined;
  const answer = artifact.payload as { result?: unknown };
  if (!answer.result || typeof answer.result !== 'object' || Array.isArray(answer.result)) return undefined;
  const result = answer.result as { resultFingerprint?: unknown; rowCount?: unknown; executionReceipt?: unknown };
  const receipt = result.executionReceipt && typeof result.executionReceipt === 'object' && !Array.isArray(result.executionReceipt)
    ? result.executionReceipt as { resultFingerprint?: unknown }
    : undefined;
  const fingerprint = typeof result.resultFingerprint === 'string'
    ? result.resultFingerprint
    : typeof receipt?.resultFingerprint === 'string'
      ? receipt.resultFingerprint
      : undefined;
  const safeFingerprint = fingerprint && /^(?:sha256:)?[a-f0-9]{64}$/i.test(fingerprint)
    ? fingerprint
    : undefined;
  const rowCount = typeof result.rowCount === 'number'
    && Number.isSafeInteger(result.rowCount)
    && result.rowCount >= 0
    ? result.rowCount
    : undefined;
  return safeFingerprint || rowCount !== undefined
    ? { ...(safeFingerprint ? { resultFingerprint: safeFingerprint } : {}), ...(rowCount !== undefined ? { rowCount } : {}) }
    : undefined;
}

/**
 * Capture only terminal, receipt-derived narration evidence here. Physical
 * provider/tool/SQL spans are emitted at their runtime boundaries; recreating
 * them from counters would invent timing/outcomes and double-count a real
 * execution in the trace.
 */
export function recordExecutionAttemptSummaryV1(observer: AskTraceObserverV1, result: AgentRouteExecutorResult): void {
  if (!observer.enabled) return;
  if (result.narrationIntegrityReceipt) {
    const narration = observer.startSpan({ name: 'narration.verify', stage: 'narration', reasonCode: result.narrationIntegrityReceipt.outcome === 'deterministic_fallback' ? 'narration_fallback' : 'completed', payload: { kind: 'stage', count: result.narrationIntegrityReceipt.factCount } });
    observer.finishSpan(narration, { outcome: result.narrationIntegrityReceipt.outcome === 'error' ? 'error' : 'ok', reasonCode: result.narrationIntegrityReceipt.outcome === 'deterministic_fallback' ? 'narration_fallback' : 'completed' });
  }
}

export function finalizeAgentRunTraceV1(observer: AskTraceObserverV1, run: AgentRun): void {
  if (!observer.enabled) return;
  // A root Research deadline is not a generic request failure. Its child
  // spans/receipts may already show partial progress, and this explicit
  // terminal span lets the root tell the same bounded-deadline story without
  // reconstructing an incident from prose or counters.
  if (run.diagnosticReceipt?.failure?.code === 'RESEARCH_RUN_DEADLINE') {
    const deadline = observer.startSpan({
      // Root spans are owned by the observer and cannot be emitted through
      // the producer API. `research.synthesize` is the precise missing phase:
      // child work ended, but finalization could not start before the deadline.
      name: 'research.synthesize',
      stage: 'research',
      reasonCode: 'run_deadline',
      payload: { kind: 'research', branchStopReason: 'run_deadline' },
    });
    observer.finishSpan(deadline, { outcome: 'error', reasonCode: 'run_deadline' });
  }
  recordFrozenPlanTerminalFailureV1(observer, run);
  const conversation = observer.startSpan({
    name: 'conversation.persist',
    stage: 'conversation',
    reasonCode: 'completed',
    payload: {
      kind: 'conversation',
      persisted: Boolean(run.traceReference || run.answer),
      continuation: (run.conversationBinding ?? 'none') !== 'none',
      binding: run.conversationBinding ?? (run.routeDecision?.followsUp ? 'prior_result' : 'none'),
    },
  });
  observer.finishSpan(conversation, { outcome: 'ok', reasonCode: 'completed' });
  const persistence = observer.startSpan({ name: 'run.persist', stage: 'persistence', reasonCode: 'completed', payload: { kind: 'persistence', recordingStatus: observer.recordingStatus } });
  observer.finishSpan(persistence, { outcome: 'ok', reasonCode: 'completed' });
  const status = run.status === 'cancelled' ? 'cancelled' : run.status === 'blocked' ? 'blocked' : 'completed';
  const reference = observer.finalize({
    status,
    terminalOutcome: run.status,
    trustState: run.trustState,
    selectedTier: run.diagnosticReceiptV3?.cascade?.selectedTier,
    completedAt: run.completedAt,
  });
  if (reference) run.traceReference = reference;
}

/**
 * A router-frozen plan must not be silently downgraded. When its immutable
 * semantic/analytical execution fails, the run artifact is the authoritative
 * terminal boundary. Project only its allowlisted failure code and action so
 * the trace explains the post-freeze stop without retaining compiler text.
 */
function recordFrozenPlanTerminalFailureV1(observer: AskTraceObserverV1, run: AgentRun): void {
  const frozen = run.routeDecision?.analyticalCascadeDecision?.planFrozen
    ?? run.diagnosticReceiptV3?.planFrozen
    ?? false;
  if (!frozen || run.status !== 'blocked') return;
  const failure = terminalAnalyticalFailureForRun(run);
  if (!failure) return;
  const compilationFailure = failure.phase === 'compilation';
  const semanticCompilation = compilationFailure && isSemanticCompilationForRun(run);
  const span = observer.startSpan({
    // Compilation happens after the plan froze but before a SQL statement
    // exists. Labeling it as result normalization made a compiler refusal look
    // like a warehouse/result problem in both trace views.
    name: semanticCompilation ? 'semantic.compile' : compilationFailure ? 'plan.compile' : 'result.normalize',
    stage: compilationFailure ? 'plan' : 'result',
    reasonCode: 'post_freeze_failure',
    payload: {
      kind: 'result',
      trustState: run.trustState,
      failureCode: failure.code,
      ...(failure.safeAction ? { safeAction: failure.safeAction } : {}),
    },
  });
  observer.finishSpan(span, {
    outcome: failure.code === 'POLICY_DENIED' || failure.code === 'PERMISSION_DENIED'
      ? 'denied'
      : failure.code === 'EXECUTION_CANCELLED'
        ? 'cancelled'
        : 'error',
    reasonCode: 'post_freeze_failure',
  });
}

function isSemanticCompilationForRun(run: AgentRun): boolean {
  // Use the same router-owned condition as V4. A route label or legacy plan
  // capability alone cannot reconstruct a semantic tier after the fact.
  return run.routeDecision?.analyticalCascadeDecision?.selectedTier === 'semantic';
}

function terminalAnalyticalFailureForRun(run: AgentRun): {
  code: AskTraceTerminalFailureCodeV1;
  safeAction?: AskTraceSafeActionV1;
  phase?: 'planning' | 'compilation' | 'validation' | 'execution' | 'result_validation';
} | undefined {
  const executionSetupFailure = run.artifacts
    .map((artifact) => artifact.payload)
    .filter((payload): payload is Record<string, unknown> => Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload))
    .map((payload) => payload.observabilityExecutionFailure)
    .find((candidate): candidate is Record<string, unknown> => Boolean(candidate)
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && isConnectionNotConfiguredFailureV1(candidate as Record<string, unknown>));
  if (executionSetupFailure) {
    return { code: 'CONNECTION_NOT_CONFIGURED', safeAction: 'configure_connection' };
  }
  const warehouseFailure = run.artifacts
    .map((artifact) => artifact.payload)
    .filter((payload): payload is Record<string, unknown> => Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload))
    .map((payload) => payload.warehouseFailure)
    .find((candidate): candidate is Record<string, unknown> => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      const record = candidate as Record<string, unknown>;
      return record.version === 1
        && record.origin === 'warehouse'
        && typeof record.category === 'string';
    });
  const failure = run.artifacts
    .map((artifact) => artifact.payload)
    .filter((payload): payload is Record<string, unknown> => Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload))
    .map((payload) => payload.analyticalFailure)
    .find((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate));
  if (!failure) return undefined;
  const code = safeTerminalFailureCodeV1(failure.code);
  if (!code) return undefined;
  const actions = Array.isArray(failure.safeActions) ? failure.safeActions : [];
  const safeAction = warehouseFailure?.category === 'unknown_relation'
    ? 'change_authorized_connection' as const
    : actions.map(safeTraceActionV1).find((action): action is AskTraceSafeActionV1 => Boolean(action));
  const phase = typeof failure.phase === 'string'
    && ['planning', 'compilation', 'validation', 'execution', 'result_validation'].includes(failure.phase)
    ? failure.phase as 'planning' | 'compilation' | 'validation' | 'execution' | 'result_validation'
    : undefined;
  // A compilation refusal still needs one concrete, stable recovery action in
  // the trace. V4 uses the same `inspect_failure` fallback when the producer
  // supplied no allowlisted action, so inspector and full trace cannot diverge.
  const resolvedSafeAction = safeAction
    ?? (code === 'COMPILATION_FAILED' && phase === 'compilation' ? 'inspect_failure' as const : undefined);
  return { code, ...(resolvedSafeAction ? { safeAction: resolvedSafeAction } : {}), ...(phase ? { phase } : {}) };
}

/**
 * The execution producer emits this tiny strict allowlist only after a frozen
 * plan failed before compilation/SQL handoff. Keep it structural so raw error
 * text can never be promoted into the local trace.
 */
function isConnectionNotConfiguredFailureV1(value: Record<string, unknown>): boolean {
  return value.version === 1
    && value.phase === 'execution'
    && value.cause === 'connection_not_configured'
    && value.safeAction === 'configure_connection';
}

function safeTerminalFailureCodeV1(value: unknown): AskTraceTerminalFailureCodeV1 | undefined {
  const codes: readonly AskTraceTerminalFailureCodeV1[] = [
    'COLUMN_NOT_FOUND', 'RELATION_NOT_FOUND', 'PERMISSION_DENIED', 'AMBIGUOUS_COLUMN', 'DIALECT_ERROR',
    'SNAPSHOT_DRIFT', 'TIMEOUT', 'RESULT_CONTRACT_MISMATCH', 'COMPILATION_FAILED', 'POLICY_DENIED',
    'SEMANTIC_ADAPTER_NOT_READY', 'SEMANTIC_TARGET_BINDING_MISSING', 'EXECUTION_TARGET_MISMATCH',
    'SEMANTIC_SOURCE_DRIFT', 'SEMANTIC_MEMBER_BINDING_FAILED', 'SEMANTIC_PATH_AMBIGUOUS',
    'IDENTIFIER_SCOPE_INVALID', 'CONNECTION_NOT_CONFIGURED', 'EXECUTION_CANCELLED', 'SEMANTIC_COMPILATION_TIMEOUT',
  ];
  return typeof value === 'string' && codes.includes(value as AskTraceTerminalFailureCodeV1)
    ? value as AskTraceTerminalFailureCodeV1
    : undefined;
}

function safeTraceActionV1(value: unknown): AskTraceSafeActionV1 | undefined {
  const actions: readonly AskTraceSafeActionV1[] = [
    'inspect_failure', 'retry_same_plan', 'retry_same_request', 'refresh_snapshot', 'edit_dql',
    'open_sql_notebook', 'request_access', 'change_authorized_connection', 'reapply_semantic_runtime',
    'configure_connection', 'review_analytical_failure',
  ];
  return typeof value === 'string' && actions.includes(value as AskTraceSafeActionV1)
    ? value as AskTraceSafeActionV1
    : undefined;
}

export function traceCandidateReasonForCandidateV1(input: { exact?: boolean; aliases?: string[]; eligible?: boolean; selected?: boolean; excluded?: boolean }): CandidateDecisionReasonV1 {
  if (input.selected) return 'model_selected';
  if (input.excluded || input.eligible === false) return 'below_fused_limit';
  if (input.exact) return 'exact_name_match';
  if ((input.aliases?.length ?? 0) > 0) return 'alias_match';
  return 'fused_relevance_fill';
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((value) => value.trim()).filter(Boolean))].slice(0, 32);
}

function safeCascadeDecision(decision: AnalyticalCascadeDecisionV1): SafeCascadeDecisionTraceV1 {
  const cached = safeCascadeDecisionCache.get(decision);
  if (cached) return cached;
  const safe: SafeCascadeDecisionTraceV1 = {
    ...(decision.selectedTier ? { selectedTier: decision.selectedTier } : {}),
    planFrozen: decision.planFrozen,
    stopReason: decision.stopReason,
    ...(decision.requirements.time?.requiresDeclaredFiscalCalendar ? { requiresDeclaredFiscalCalendar: true } : {}),
    ...(decision.terminalGap ? {
      terminalGap: {
        code: decision.terminalGap.code,
        requirement: decision.terminalGap.requirement,
        witnessCandidateIds: uniqueIds(decision.terminalGap.witnessCandidateIds),
      },
    } : {}),
    sourceCoverage: decision.sourceCoverage.slice(0, 16).map((coverage) => ({
      source: coverage.source,
      status: coverage.status,
      candidateIds: uniqueIds(coverage.candidateIds),
      ...(coverage.reason ? { reasonFingerprint: fingerprint(coverage.reason) } : {}),
    })),
    attempts: decision.attempts.slice(0, 8).map(safeCascadeAttempt),
  };
  safeCascadeDecisionCache.set(decision, safe);
  return safe;
}

function safeCascadeAttempt(attempt: AnalyticalCascadeDecisionV1['attempts'][number]): SafeCascadeDecisionTraceV1['attempts'][number] {
  const cached = safeCascadeAttemptCache.get(attempt);
  if (cached) return cached;
  const safe: SafeCascadeDecisionTraceV1['attempts'][number] = {
    tier: attempt.tier,
    outcome: attempt.outcome,
    candidateIds: uniqueIds(attempt.candidateIds),
    planFrozen: attempt.planFrozen,
    reasonFingerprint: fingerprint(attempt.reason),
  };
  safeCascadeAttemptCache.set(attempt, safe);
  return safe;
}
