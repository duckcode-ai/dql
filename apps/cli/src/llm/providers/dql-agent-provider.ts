import {
  classifyProviderFailure,
  deadlineScale,
  planAnalystTurn,
  attachAskTraceObserverV1,
  analyticalErrorDetail,
  rerankCandidates,
  askTraceObserverForV1,
  type AskTraceObserverV1,
  type ProviderAttemptTraceV1,
  type ProviderFailureDiagnosticV1,
} from '@duckcodeailabs/dql-agent';
import { buildAnalystLoopTools } from '../analyst-loop-tools.js';
import { buildAskV2AnalystSystemPrompt, buildAskV2TextToolContract } from './ask-v2-analyst-prompt.js';
import { parseAnalyticalTimeWindow, resolvePlanTimeRange, type AnalyticalTimeWindowV1 } from '@duckcodeailabs/dql-agent';
import {
  ClaudeProvider,
  KGStore,
  MemoryStore,
  defaultKgPath,
  defaultMemoryPath,
  GeminiProvider,
  loadAgentSemanticLayer,
  OllamaProvider,
  OpenAIProvider,
  answer,
  createAnalyticalFailure,
  buildAnalysisQuestionPlan,
  buildCertifiedBlockInvocationInput,
  certifiedBlockProvesRequestedTopN,
  buildAnalyticalRequirementSet,
  buildLocalContextPack,
  contextRetrievalBudgetForQuestion,
  ensureAgentProjectReady,
  isLikelyClarificationReply,
  type AgentAnswer,
  type AgentDqlArtifactReference,
  type CertifiedFitConfirmation,
  type CertifiedFitConfirmationRequest,
  type AgentFollowUpContext,
  type AgentConversationBindingV1,
  type AgentMemberBinding,
  type AgentPriorResultReference,
  type AgentProvider,
  type ProviderToolLoopOptions,
  type AgentResultPayload,
  type ConversationSnapshot,
  type ConversationResultMemberSetV1,
  type LocalContextPack,
  type ProviderDispatchEvent,
  type ProviderDispatchCompletionEvent,
  type Skill,
  isTrustedConversationTurn,
  createProviderDispatchEgressReceipt,
  createProviderEgressReceipt,
  assertProviderPayloadAllowed,
  prepareProviderContextForDispatch,
  prepareProviderWireEnvelopeForDispatch,
  prepareServerOwnedProviderSchemaContext,
  projectEmbeddingProvider,
  answerAgentic,
  trimCertifiedBlockResultToRequestedTopN,
  runAgenticToolLoopDetailed,
  ASK_V2_BUDGETS,
  createAskToolKernelV2,
  releaseAskV2CertifiedTierLock,
  setAskV2TierState,
  recordAskV2ResearchLedger,
  evidenceCandidateRoles,
  qualifyAuthorizationReferences,
  scopeContextPackToExploratoryCandidateClosure,
  createAnalystLaneHandler,
  askAgentV2WorkspaceMatches,
  materializeAskV2WorkspaceTierTruth,
  askV2SemanticCandidateAuthorityFingerprint,
  askV2ExecutableSemanticRoles,
  finishAskAgentV2Turn,
  observeAskAgentV2Tool,
  mintAskV2ExecutionReceiptV1,
  defaultProviderResultEgressPolicyV2,
  parseProposal,
  renderContextValidationRefusalForUser,
  validateSqlAgainstLocalContext,
  resolveOrchestratorPolicy,
  type AgenticLane,
  type OrchestratorPolicy,
  type AskAgentStateV4,
  type AskV2ExecutionCapabilityV1,
  type AskV2ExecutionReceipt,
  type AskAgentToolWorkspaceV2,
  type AskSemanticCapabilityHandleV1,
  type AskCertifiedArtifactHandleV1,
  type AskToolNameV2,
  type AskToolObservationV1,
  type AskV2ResearchBranchReceiptInput,
  type AgentEvidenceCandidate,
  type AgentToolDefinition,
  type AnswerLoopInput,
  type KGNode,
} from '@duckcodeailabs/dql-agent';
import {
  CassetteStore,
  evalCassetteCanonicalizationV2,
  resolveCassetteModeFromEnv,
  withCassette,
} from '../../commands/agent-eval-cassette.js';
import {
  buildManifest,
  normalizeDqlArtifactReference,
  resolveDbtManifestPath,
  type ProviderDispatchPhaseV1,
  type ProviderEgressPurpose,
  type ProviderEgressReceiptV1,
} from '@duckcodeailabs/dql-core';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunRequest, AgentRunner, AgentTurn, BlockProposal, ProviderId } from '../types.js';
import { buildAnswerLoopTools, createGroundingContextExpander } from '../answer-loop-tools.js';
import { getSemanticRuntimeStatus } from '../../semantic-runtime.js';
import { blockProposalDqlMetadata } from '../proposal-metadata.js';
import { getEffectiveProviderConfig } from '../../settings/provider-settings.js';
import { ClaudeCodeCliProvider, CodexCliProvider } from '../../providers/subscription-cli.js';
import { ClaudeOAuthProvider, claudeOAuthConnected } from '../../providers/oauth/claude-oauth.js';
import { CodexOAuthProvider, codexOAuthConnected } from '../../providers/oauth/codex-oauth.js';

/**
 * Providers the governed answer-loop runner can drive. Beyond the API-key/local
 * providers this includes the subscription CLI providers (`claude-code`, `codex`) —
 * used as plain completion backends here, distinct from the MCP `claudeCodeRunner`.
 */
type SimpleProviderId =
  | Extract<ProviderId, 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom-openai'>
  | 'claude-code'
  | 'codex';

/**
 * The local runtime rejects a missing connection before it hands a statement
 * to a connector. Keep this check structural: parsing a user-facing message
 * here would let an unrelated warehouse failure disappear from SQL telemetry.
 */
function isPreSqlConnectionConfigurationError(error: unknown): boolean {
  const detail = analyticalErrorDetail(error);
  return detail?.origin === 'host'
    && detail.stage === 'execute'
    && detail.code === 'connection_not_configured';
}

interface ProviderSpec {
  label: string;
  setup: string;
  create(projectRoot: string): AgentProvider;
}

const SPECS: Record<SimpleProviderId, ProviderSpec> = {
  anthropic: {
    label: 'Anthropic Claude',
    setup: 'Configure Anthropic in Settings or set ANTHROPIC_API_KEY. Optional: ANTHROPIC_MODEL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'anthropic');
      return new ClaudeProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    },
  },
  openai: {
    label: 'OpenAI',
    setup: 'Configure OpenAI in Settings or set OPENAI_API_KEY. Optional: OPENAI_MODEL and OPENAI_BASE_URL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'openai');
      return new OpenAIProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl });
    },
  },
  gemini: {
    label: 'Gemini',
    setup: 'Configure Gemini in Settings or set GEMINI_API_KEY. Optional: GEMINI_MODEL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'gemini');
      return new GeminiProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    },
  },
  ollama: {
    label: 'Ollama',
    setup: 'Start Ollama and configure OLLAMA_BASE_URL / OLLAMA_MODEL in Settings or env.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'ollama');
      return new OllamaProvider({ model: config.model, baseUrl: config.baseUrl });
    },
  },
  'custom-openai': {
    label: 'Custom OpenAI-compatible',
    setup: 'Configure a custom OpenAI-compatible endpoint in Settings with base URL, model, and optional API key.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'custom-openai');
      return new OpenAIProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, allowNoApiKey: true });
    },
  },
  'claude-code': {
    label: 'Claude subscription',
    setup: 'Open Settings → Claude subscription and click "Sign in with Claude" (or install the `claude` CLI and run `claude /login`).',
    // OAuth-first: use the browser-login token when connected; fall back to the CLI-passthrough otherwise.
    create: (projectRoot) => {
      const model = getEffectiveProviderConfig(projectRoot, 'claude-code').model;
      return claudeOAuthConnected(projectRoot)
        ? new ClaudeOAuthProvider({ projectRoot, model })
        : new ClaudeCodeCliProvider({ model });
    },
  },
  codex: {
    label: 'ChatGPT subscription',
    setup: 'Open Settings → ChatGPT subscription and click "Sign in with ChatGPT" (or install the `codex` CLI and run `codex login`).',
    create: (projectRoot) => {
      const model = getEffectiveProviderConfig(projectRoot, 'codex').model;
      return codexOAuthConnected(projectRoot)
        ? new CodexOAuthProvider({ projectRoot, model })
        : new CodexCliProvider({ model });
    },
  },
};

/**
 * Capture a content-free provider failure at the closest boundary. Local
 * runtime may later choose a user-facing headline, but must not need raw
 * provider errors or URLs to reconstruct the cause.
 */
function providerBoundaryDiagnostic(input: {
  providerId: SimpleProviderId;
  projectRoot: string;
  phase: ProviderFailureDiagnosticV1['phase'];
  error?: unknown;
  code?: string;
}): ProviderFailureDiagnosticV1 {
  const config = getEffectiveProviderConfig(input.projectRoot, input.providerId);
  const message = input.error instanceof Error ? input.error.message : String(input.error ?? 'provider readiness failed');
  const code = input.code
    ?? (input.error && typeof input.error === 'object' ? String((input.error as { code?: unknown }).code ?? '') : '');
  const fingerprint = (value: string | undefined): string | undefined => value?.trim()
    ? `sha256:${createHash('sha256').update(value.trim()).digest('hex')}`
    : undefined;
  let origin: string | undefined;
  if (config.baseUrl) {
    try {
      origin = new URL(config.baseUrl).origin;
    } catch {
      // The full malformed URL never leaves this function; its fingerprint is
      // still a useful support correlation key without disclosing content.
      origin = config.baseUrl;
    }
  }
  return classifyProviderFailure({
    code,
    message,
    phase: input.phase,
    providerFingerprint: fingerprint(input.providerId),
    modelFingerprint: fingerprint(config.model),
    baseOriginFingerprint: fingerprint(origin),
  });
}

/** One-way runtime correlation only; never persist the provider/model string. */
function runtimeFingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Tool names are executable contract identifiers, not user/model supplied
 * values. Keep even that narrow surface allowlisted so an unexpected provider
 * payload cannot turn a trace into a metadata side channel.
 */
const TRACEABLE_ASK_TOOL_KINDS = new Set([
  'check_compatibility',
  'compile_resolved_analytical_plan',
  'compile_semantic_query',
  'describe_notebook_dataset',
  'execute_local_analysis',
  'explain_metric',
  'get_table_schema',
  'list_notebook_datasets',
  'preview_query',
  'propose_cross_source_join',
  'query_semantic_model',
  'sample_notebook_dataset',
  'scan_manifest',
  'search_metadata',
  'search_project_files',
  'search_semantic_layer',
  'search_values',
  'validate_sql',
]);

const ASK_TRACE_TOOL_CALLBACK = Symbol('dql.askTraceToolCallback');

/**
 * A same-provider transport retry is minted only by this physical runner after
 * it observed a typed transient failure.  The public option field is carried
 * to providers for receipt correlation, but it is not itself authority to
 * borrow an earlier receipt.
 */
const RUNNER_OWNED_RETRY_LINEAGE: unique symbol = Symbol('dql.runnerOwnedRetryLineage');

type RunnerOwnedProviderToolLoopOptions = ProviderToolLoopOptions & {
  [RUNNER_OWNED_RETRY_LINEAGE]?: {
    parentAttemptIndex: number;
    phase: ProviderDispatchPhaseV1;
    purpose: ProviderEgressPurpose;
  };
};

function frozenExploratoryRepairAuthorityForRequest(req: AgentRunRequest): boolean {
  const plan = req.resolvedAnalyticalPlan;
  return req.orchestrationMode !== 'research'
    && req.selectedCascadeTier === 'exploratory_sql'
    && plan?.mode === 'authoritative'
    && plan.capability === 'bounded_exploration'
    && Boolean(plan.planId && plan.fingerprint && plan.snapshotId)
    && (plan.sourceRelationIds?.length ?? 0) > 0
    && Boolean(
      req.generatedProposalTargetFingerprint
      && req.prepareExploratorySqlExecution
      && req.executeAgenticGeneratedSql,
    );
}

function repairAuthorityAdmissionError(): Error {
  return Object.assign(new Error(
    'Repair transport admission denied because this ordinary Ask has no matching frozen exploratory repair authority.',
  ), { code: 'PROVIDER_REPAIR_AUTHORITY_ADMISSION_DENIED' });
}

function retryLineageAdmissionError(): Error {
  return Object.assign(new Error(
    'Provider retry admission denied because retry lineage was not minted by this runner after a transient same-provider failure.',
  ), { code: 'PROVIDER_RETRY_LINEAGE_ADMISSION_DENIED' });
}

type TraceAwareToolCallback = NonNullable<ProviderToolLoopOptions['onToolCall']> & {
  [ASK_TRACE_TOOL_CALLBACK]?: true;
};

function recordPhysicalToolCallTrace(
  observer: AskTraceObserverV1,
  event: Parameters<NonNullable<ProviderToolLoopOptions['onToolCall']>>[0],
  attemptIndex: number,
): void {
  if (!observer.enabled) return;
  const now = Date.now();
  const duration = Math.max(0, Math.min(86_400_000, event.durationMs ?? 0));
  const startedAt = new Date(now - duration).toISOString();
  const completedAt = new Date(now).toISOString();
  const call = {
    version: 1 as const,
    toolCallId: `tool-${attemptIndex}`,
    toolKind: TRACEABLE_ASK_TOOL_KINDS.has(event.name) ? event.name : 'unknown_tool',
    attemptIndex,
    ...(event.isError ? { safeErrorCode: 'tool_error' } : {}),
  };
  const span = observer.startSpan({
    name: 'tool.call',
    stage: 'tool',
    startedAt,
    payload: { kind: 'tool', call },
    reasonCode: 'started',
  });
  observer.finishSpan(span, {
    completedAt,
    outcome: event.isError ? 'error' : 'ok',
    reasonCode: event.isError ? 'tool_failure' : 'completed',
    payload: { kind: 'tool', call },
  });
}

function createAskTraceToolCallback(observer: AskTraceObserverV1): TraceAwareToolCallback {
  let attemptIndex = 0;
  const callback: TraceAwareToolCallback = (event) => {
    recordPhysicalToolCallTrace(observer, event, ++attemptIndex);
  };
  Object.defineProperty(callback, ASK_TRACE_TOOL_CALLBACK, {
    value: true,
    enumerable: false,
  });
  return callback;
}

/** A redacted structural correlation, never a hash of values/rows/prompt text. */
function v2ToolShapeFingerprint(value: unknown): string {
  const shape = (candidate: unknown, depth = 0): unknown => {
    if (depth > 4) return 'truncated';
    if (candidate === null) return 'null';
    if (Array.isArray(candidate)) return { array: candidate.length, sample: candidate.slice(0, 3).map((item) => shape(item, depth + 1)) };
    if (typeof candidate === 'object') return {
      object: Object.keys(candidate as Record<string, unknown>).sort().slice(0, 24),
    };
    return typeof candidate;
  };
  return runtimeFingerprint(JSON.stringify(shape(value)));
}

function v2CanonicalToolName(name: string): AskToolNameV2 {
  if (name === 'search_semantic_layer') return 'inspect_semantic_candidates';
  // A provider/tool-loop callback confirms only that a physical tool returned.
  // It is not a successful compile or execution, so map it to inspection. The
  // V2 controller alone records an execution after it has a bound result.
  if (name === 'compile_semantic_query' || name === 'query_semantic_model') return 'inspect_semantic_candidates';
  if (name === 'scan_manifest' || name === 'get_table_schema' || name === 'propose_cross_source_join') return 'inspect_relational_context';
  if (name === 'validate_sql' || name === 'preview_query' || name === 'execute_local_analysis') return 'inspect_relational_context';
  if (name === 'search_values') return 'search_values';
  return 'inspect_ask_context';
}

function observeV2ToolCall(
  state: AskAgentStateV4 | undefined,
  event: Parameters<NonNullable<ProviderToolLoopOptions['onToolCall']>>[0],
): void {
  if (!state) return;
  const tool = v2CanonicalToolName(event.name);
  const structuredCode = event.output
    && typeof event.output === 'object'
    && !Array.isArray(event.output)
    && typeof (event.output as { code?: unknown }).code === 'string'
    ? (event.output as { code: string }).code
    : undefined;
  const deadline = structuredCode === 'RUN_SOFT_TARGET_EXCEEDED'
    || structuredCode === 'RUN_DEADLINE_INSUFFICIENT';
  // Native and text callbacks report only a physical tool boundary.  They are
  // deliberately non-freezing: a successful tool transport is not proof that
  // the candidate/compiler/result contract completed. The final result below
  // records the only eligible/executed tier observation.
  const observation: AskToolObservationV1 = {
    version: 1,
    tool,
    // Availability is a source-level state. A successful physical call is an
    // eligible observation; it never freezes a plan because the canonical
    // execution tool records that only after connection/result validation.
    outcome: event.isError ? 'error' : 'eligible',
    reasonCode: deadline ? structuredCode : event.isError ? `tool_${event.name}_error` : `tool_${event.name}_completed`,
    candidateIds: [],
    ...(typeof event.durationMs === 'number' ? { durationMs: Math.max(0, event.durationMs) } : {}),
    inputFingerprint: v2ToolShapeFingerprint(event.input),
    ...(event.output === undefined ? {} : { outputFingerprint: v2ToolShapeFingerprint(event.output) }),
    origin: deadline ? 'narration' : 'tool',
    ...(deadline ? {
      safeAction: 'review_validated_result',
      provider: {
        phase: 'narration' as const,
        cause: 'run_deadline' as const,
        retryable: false,
        safeAction: 'review_validated_result',
      },
    } : {}),
  };
  observeAskAgentV2Tool(state, observation);
}

function v2TierForAnswer(result: AgentAnswer): {
  tier?: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql';
  tool: AskToolNameV2;
} {
  const source = [result.result?.answerTier, result.route?.tier, result.sourceTier]
    .filter((value): value is string => typeof value === 'string')
    .join('|')
    .toLowerCase();
  if (source.includes('certified')) return { tier: 'certified', tool: 'run_certified' };
  if (source.includes('semantic')) return { tier: 'semantic', tool: 'compile_and_run_semantic' };
  if (source.includes('relational') || source.includes('dql')) return { tier: 'governed_relational', tool: 'compile_and_run_dql' };
  if (source.includes('generated') || source.includes('exploratory') || source.includes('manifest')) {
    return { tier: 'exploratory_sql', tool: 'validate_and_run_sql' };
  }
  return { tool: 'finish_answer' };
}

/** Persist one terminal V2 result without invoking a second routing/SQL path. */
function finishV2AnswerFromResult(state: AskAgentStateV4 | undefined, result: AgentAnswer): void {
  if (!state) return;
  if (result.askAgentV2Outcome) {
    finishAskAgentV2Turn(state, result.askAgentV2Outcome);
    return;
  }
  if (result.kind === 'no_answer') {
    finishAskAgentV2Turn(state, {
      version: 2,
      kind: result.observabilityExecutionFailure || result.executionError ? 'execution_failure' : 'gap',
      reasonCode: result.refusalCode ?? 'ASK_V2_NO_ANSWER',
      safeAction: result.observabilityExecutionFailure ? 'configure_connection' : 'review_recorded_observations_then_retry',
      origin: result.observabilityExecutionFailure || result.executionError ? 'execution' : 'validation',
    });
    return;
  }
  // Definitions, general/context answers and provider narration have no
  // warehouse result. They must not be marked as an executed analytical tier.
  const hasValidatedResult = Boolean(result.result
    && (typeof result.result.rowCount === 'number'
      || typeof result.result.executionReceipt === 'object'
      || Boolean(result.analyticalFacts)));
  const route = v2TierForAnswer(result);
  observeAskAgentV2Tool(state, {
    version: 1,
    tool: route.tool,
    outcome: hasValidatedResult && route.tier ? 'executed' : 'eligible',
    ...(route.tier ? { tier: route.tier } : {}),
    reasonCode: 'ASK_V2_VALIDATED_RESULT',
    candidateIds: state.resolvedPlan?.candidateIds ?? state.candidatePlan?.candidateIds ?? [],
    ...(state.resolvedPlan?.id ? { planId: state.resolvedPlan.id } : {}),
    origin: hasValidatedResult ? 'execution' : 'narration',
  });
  finishAskAgentV2Turn(state, {
    version: 2,
    kind: 'finish_answer',
    reasonCode: 'ASK_V2_VALIDATED_RESULT',
    origin: result.analyticalNarrative || !hasValidatedResult ? 'narration' : 'execution',
  });
}

/**
 * Mint the only runner-to-host V2 completion carrier at the point the
 * provider-owned tool runtime has advanced its state. The caller must not try
 * to recreate this from its original request because that request may be an
 * immutable pre-execution copy used by the engine.
 */
function askV2ExecutionReceiptFromTerminalState(
  state: AskAgentStateV4 | undefined,
  capability: AskV2ExecutionCapabilityV1 | undefined,
  result: AgentAnswer | undefined,
): AskV2ExecutionReceipt | undefined {
  return mintAskV2ExecutionReceiptV1({
    state,
    capability,
    result: result?.result,
  });
}

/**
 * The V2 serving controller intentionally does not call `answer()`.
 *
 * `answer()` is the V1 business interpreter; using it after a V2 provider
 * selects a tool would recreate the old double-routing failure (and can make a
 * second SQL proposal).  This adapter exposes only snapshot-bound tools and
 * calls the already-provided compiler/execution boundaries directly.  It is
 * deliberately small: route intelligence is the provider's bounded tool
 * choice; DQL validates identifiers, priority, SQL and execution authority.
 */
function v2CandidateId(candidate: AgentEvidenceCandidate): string {
  return candidate.qualifiedId ?? candidate.id;
}

function v2WorkspaceForInput(
  input: AnswerLoopInput,
  state: AskAgentStateV4,
): AskAgentToolWorkspaceV2 | undefined {
  const bridge = input.askAgentV2Workspace;
  const workspace = bridge?.getToolWorkspace?.();
  if (!workspace || workspace.version !== 1) return undefined;
  if (workspace.snapshotId !== state.snapshotId || workspace.sourceFingerprint !== state.sourceFingerprint) return undefined;
  return workspace;
}

/** Provider-safe card projection. Values, paths, SQL, credentials, and raw rows stay host-only. */
function v2SafeCard(
  candidate: AgentEvidenceCandidate,
  workspace?: AskAgentToolWorkspaceV2,
): Record<string, unknown> {
  return {
    id: v2CandidateId(candidate),
    kind: candidate.kind,
    roles: evidenceCandidateRoles(candidate),
    trustTier: candidate.trustTier,
    name: candidate.name,
    ...(candidate.definition ? { definition: candidate.definition } : {}),
    ...(candidate.formula ? { formula: candidate.formula } : {}),
    ...(candidate.aggregation ? { aggregation: candidate.aggregation } : {}),
    ...(candidate.semanticModel ? { semanticModel: candidate.semanticModel } : {}),
    ...(candidate.primaryEntity ? { primaryEntity: candidate.primaryEntity } : {}),
    ...(candidate.dataType ? { dataType: candidate.dataType } : {}),
    ...(candidate.dimensions?.length ? { dimensions: candidate.dimensions.slice(0, 16) } : {}),
    // `dimensions` above are display labels, and they read exactly like
    // identifiers — so a model breaking a metric down by "customer" sent that,
    // and was refused. Worse, a label can be genuinely unresolvable: two
    // entities declared `customer` on different models collide on runtime
    // name, so DQL drops both and nothing that label names is reachable.
    // Publish the identifiers the compiler will actually accept, alongside the
    // labels, so the breakdown can be built rather than guessed.
    ...(candidate.dimensions?.length && workspace
      ? (() => {
        const ids = candidate.dimensions.slice(0, 16).flatMap((label) => {
          const resolved = resolveV2SemanticCapabilityReference({
            reference: label,
            role: 'dimension',
            candidates: workspace.candidates ?? [],
            capabilities: workspace.semanticCapabilities,
          });
          return resolved ? [resolved] : [];
        });
        const unique = [...new Set(ids)];
        return unique.length ? { compatibleDimensionIds: unique } : {};
      })()
      : {}),
    // A relation the planner cannot describe is a relation it cannot query.
    // The catalog knows these columns and the SQL validator already checks
    // against them; showing them is what lets a query be built instead of
    // guessed. `describe_relation` serves the full list when this prefix is
    // not enough.
    ...(candidate.columns?.length
      ? {
        columns: candidate.columns.slice(0, 40).map((column) => ({
          name: column.name,
          ...(column.type ? { type: column.type } : {}),
        })),
        ...(candidate.columnCount && candidate.columnCount > Math.min(40, candidate.columns.length)
          ? { columnCount: candidate.columnCount, columnsTruncated: true }
          : {}),
      }
      : {}),
    ...(candidate.timeGrains?.length ? { timeGrains: candidate.timeGrains.slice(0, 8) } : {}),
    ...(candidate.sourceObjects?.length ? { sourceObjects: candidate.sourceObjects.slice(0, 12) } : {}),
    ...(candidate.relationshipEvidence?.length ? { relationshipEvidence: candidate.relationshipEvidence.slice(0, 8) } : {}),
    compatibility: candidate.compatibility,
    ...(candidate.compatibilityFacts?.length ? { compatibilityFacts: candidate.compatibilityFacts.slice(0, 8) } : {}),
  };
}

function selectV2SemanticEngine(input: {
  metricCapabilities: readonly AskSemanticCapabilityHandleV1[];
}):
  | { ok: true; engine: NonNullable<AskSemanticCapabilityHandleV1['selectedEngine']> }
  | { ok: false; outcome: 'ineligible'; reasonCode: 'SEMANTIC_ENGINE_UNAVAILABLE' } {
  // Metrics are the compiler authority, but engine selection belongs solely
  // to the local host. New V2 handles carry `selectedEngine` from the
  // project preference/readiness probe. For a pre-additive handle, retain the
  // one-engine compatibility read only; never infer among several engines or
  // accept a provider-supplied engine/display/runtime name.
  const selected = input.metricCapabilities.map((capability) => (
    capability.selectedEngine
      ?? (capability.engines.length === 1 ? capability.engines[0] : undefined)
  ));
  if (selected.length === 0 || selected.some((engine) => !engine)) {
    return { ok: false, outcome: 'ineligible', reasonCode: 'SEMANTIC_ENGINE_UNAVAILABLE' };
  }
  const engine = selected[0]!;
  if (selected.some((candidateEngine) => candidateEngine !== engine)) {
    // A multi-metric tuple must have one host-selected target. Do not ask the
    // provider to arbitrate adapters: an unavailable semantic tier can safely
    // advance before freeze.
    return { ok: false, outcome: 'ineligible', reasonCode: 'SEMANTIC_ENGINE_UNAVAILABLE' };
  }
  return { ok: true, engine };
}

function v2StringArray(value: unknown, max = 24): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))].slice(0, max)
    : [];
}

/**
 * Semantic bindings cross the provider boundary as opaque candidate IDs, but
 * the compiler needs one normalized, snapshot-bound shape.  Do not silently
 * drop malformed filters: doing so would freeze a plan different from the
 * plan the controller asked to execute.
 */
function normalizeV2SemanticFilters(value: unknown):
  | { ok: true; filters: Array<{ dimensionId: string; value: string | number | boolean }> }
  | { ok: false; reasonCode: 'SEMANTIC_FILTERS_INVALID' } {
  if (value === undefined) return { ok: true, filters: [] };
  if (!Array.isArray(value) || value.length > 8) return { ok: false, reasonCode: 'SEMANTIC_FILTERS_INVALID' };
  const filters: Array<{ dimensionId: string; value: string | number | boolean }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reasonCode: 'SEMANTIC_FILTERS_INVALID' };
    const record = entry as Record<string, unknown>;
    const dimensionId = typeof record.dimensionId === 'string' ? record.dimensionId.trim() : '';
    const filterValue = record.value;
    if (!dimensionId
      || (typeof filterValue !== 'string' && typeof filterValue !== 'number' && typeof filterValue !== 'boolean')) {
      return { ok: false, reasonCode: 'SEMANTIC_FILTERS_INVALID' };
    }
    filters.push({ dimensionId, value: filterValue });
  }
  return { ok: true, filters };
}

/**
 * A time grain is a declared property of the selected time capability.  The
 * provider cannot introduce a convenient alias such as "monthly" or rely on
 * an arbitrary candidate's default grain after choosing another candidate.
 */
function normalizeV2SemanticTimeBinding(input: {
  timeDimensionId: unknown;
  timeGrain: unknown;
  /**
   * A grain explicitly present in the immutable user turn. When an admitted
   * axis was selected but the controller omitted its grain, this is the only
   * host-owned value that may complete it; never default to another declared
   * grain merely because it appears first on the card.
   */
  requiredTimeGrain?: V2RequestedTimeGrain;
  resolveTimeCandidate: (id: string) => AgentEvidenceCandidate | undefined;
}):
  | { ok: true; timeId?: string; time?: AgentEvidenceCandidate; timeGrain?: string }
  | { ok: false; reasonCode: 'SEMANTIC_TIME_DIMENSION_INVALID' | 'SEMANTIC_TIME_GRAIN_WITHOUT_TIME_DIMENSION' | 'SEMANTIC_TIME_GRAIN_NOT_DECLARED' | 'SEMANTIC_TIME_GRAIN_MISMATCH' } {
  const suppliedTimeId = input.timeDimensionId;
  const suppliedTimeGrain = input.timeGrain;
  if (suppliedTimeGrain !== undefined && typeof suppliedTimeGrain !== 'string') {
    return { ok: false, reasonCode: 'SEMANTIC_TIME_GRAIN_NOT_DECLARED' };
  }
  const requested = typeof suppliedTimeGrain === 'string' ? suppliedTimeGrain.trim().toLowerCase() : undefined;
  if (suppliedTimeGrain !== undefined && !requested) return { ok: false, reasonCode: 'SEMANTIC_TIME_GRAIN_NOT_DECLARED' };
  if (input.requiredTimeGrain && requested && requested !== input.requiredTimeGrain) {
    return { ok: false, reasonCode: 'SEMANTIC_TIME_GRAIN_MISMATCH' };
  }
  if (suppliedTimeId === undefined || suppliedTimeId === null) {
    if (suppliedTimeGrain !== undefined && suppliedTimeGrain !== null) {
      return { ok: false, reasonCode: 'SEMANTIC_TIME_GRAIN_WITHOUT_TIME_DIMENSION' };
    }
    return { ok: true };
  }
  const timeId = typeof suppliedTimeId === 'string' ? suppliedTimeId.trim() : '';
  if (!timeId) return { ok: false, reasonCode: 'SEMANTIC_TIME_DIMENSION_INVALID' };
  const time = input.resolveTimeCandidate(timeId);
  const declaredGrains = (time?.timeGrains ?? [])
    .filter((grain): grain is string => typeof grain === 'string' && grain.trim().length > 0)
    .map((grain) => grain.trim());
  if (!time || declaredGrains.length === 0) return { ok: false, reasonCode: 'SEMANTIC_TIME_DIMENSION_INVALID' };
  const required = input.requiredTimeGrain;
  const expectedGrain = requested ?? required;
  const timeGrain = expectedGrain
    ? declaredGrains.find((grain) => grain.toLowerCase() === expectedGrain)
    : declaredGrains[0];
  if (!timeGrain) return { ok: false, reasonCode: 'SEMANTIC_TIME_GRAIN_NOT_DECLARED' };
  // Persist the opaque snapshot candidate identity, never a provider-supplied
  // runtime name.  The compiler resolves this canonical ID through the
  // immutable capability below.
  return { ok: true, timeId: v2CandidateId(time), time, timeGrain };
}

type V2SemanticCapabilityRole = 'metric' | 'dimension' | 'time_dimension' | 'filter_dimension';

function normalizeV2SemanticRuntimeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Does this candidate's own model DEFINE the referenced entity, rather than
 * merely point at it?
 *
 * MetricFlow declares a join by naming the same entity `primary` on the model
 * that owns it and `foreign` on the model referencing it, so `customer` is
 * admitted from both `customers` and `orders`. Matched on name alone the
 * reference is ambiguous and resolves to neither — which makes every breakdown
 * by that entity unanswerable in an entirely correct semantic layer.
 *
 * Ownership is read from the qualified identity (`...:entity:customers.customer`)
 * because the declared `primaryEntity` is not populated on every snapshot. A
 * model whose name is the entity's plural owns it; anything else is a foreign
 * reference. When no candidate owns the name, the reference stays ambiguous.
 */
function ownsReferencedEntity(candidate: AgentEvidenceCandidate, runtimeName: string): boolean {
  if (normalizeV2SemanticRuntimeName(candidate.primaryEntity ?? '') === runtimeName) return true;
  const leaf = (candidate.qualifiedId ?? candidate.id).split(':').pop() ?? '';
  const [model, member] = leaf.split('.');
  if (!model || !member) return false;
  if (normalizeV2SemanticRuntimeName(member) !== runtimeName) return false;
  const owner = normalizeV2SemanticRuntimeName(model);
  return owner === runtimeName || owner === `${runtimeName}s` || owner === `${runtimeName}es`;
}

function v2SemanticCandidateMatchesRole(
  candidate: AgentEvidenceCandidate,
  role: V2SemanticCapabilityRole,
): boolean {
  return askV2ExecutableSemanticRoles(candidate)?.includes(role) ?? false;
}

/**
 * A V2 semantic handle is authoritative only for the exact retained card it
 * captured. Candidate ID equality alone is insufficient: a malformed or
 * stale snapshot can contain two cards under one opaque ID with different
 * MetricFlow time-dimension or model contracts. The host withholds divergent
 * duplicates; this recheck prevents the provider from resolving a different
 * card than the one the host admitted.
 */
function v2SemanticCapabilityMatchesCandidate(
  capability: AskSemanticCapabilityHandleV1 | undefined,
  candidate: AgentEvidenceCandidate,
  role: V2SemanticCapabilityRole,
): capability is AskSemanticCapabilityHandleV1 {
  const candidateId = v2CandidateId(candidate);
  return Boolean(
    capability
      && capability.candidateId === candidateId
      && capability.roles.includes(role)
      && capability.isCurrent()
      && v2SemanticCandidateMatchesRole(candidate, role)
      && capability.fingerprint === askV2SemanticCandidateAuthorityFingerprint(candidate),
  );
}

/**
 * V2 normally receives opaque qualified IDs.  Some native/text tool callers
 * still submit a compiler-facing runtime name from the safe card.  Accept
 * only a unique, exact runtime-name match from the currently visible,
 * snapshot-bound capability set; this is not alias or lexical resolution.
 *
 * When a concrete semantic metric and a generic semantic measure share a
 * runtime name, prefer the concrete metric.  A tie at the same authority
 * level remains ambiguous and is rejected pre-freeze.
 */
function resolveV2SemanticCapabilityReference(input: {
  reference: string;
  role: V2SemanticCapabilityRole;
  candidates: readonly AgentEvidenceCandidate[];
  capabilities: ReadonlyMap<string, AskSemanticCapabilityHandleV1> | undefined;
}): string | undefined {
  const reference = input.reference.trim();
  if (!reference) return undefined;
  if (!input.capabilities) return undefined;

  const directMatches = [...new Set(input.candidates.flatMap((candidate) => {
    const candidateId = v2CandidateId(candidate);
    const capability = input.capabilities!.get(candidateId);
    return candidateId === reference
      && v2SemanticCapabilityMatchesCandidate(capability, candidate, input.role)
      ? [candidateId]
      : [];
  }))];
  if (directMatches.length === 1) return directMatches[0];

  // Pre-V2 snapshots used a domain + leaf dimension identity, while current
  // semantic cards use the owning model-qualified registry identity. Permit a
  // persisted old opaque ID only when it resolves to exactly one currently
  // admitted capability. A shared `metric_time` legacy alias stays ambiguous
  // rather than selecting an arbitrary model's time axis.
  if (reference.startsWith('semantic:')) {
    const aliasMatches = input.candidates.flatMap((candidate) => {
      const candidateId = v2CandidateId(candidate);
      const capability = input.capabilities!.get(candidateId);
      return v2SemanticCapabilityMatchesCandidate(capability, candidate, input.role)
        && (candidate.aliases ?? []).some((alias) => alias === reference)
        ? [candidateId]
        : [];
    });
    const uniqueAliases = [...new Set(aliasMatches)];
    if (uniqueAliases.length === 1) return uniqueAliases[0];
  }

  // MetricFlow itself renders a dimension as `entity__name` and a model file
  // qualifies it as `model.name`. A model that has just read MetricFlow-shaped
  // cards echoes those spellings back; refusing them as unknown identifiers
  // rejected exactly the field the snapshot admitted. Resolution works on the
  // LEAF name; the qualifier (when present) must agree with the candidate's
  // own identity so `orders__ordered_at` can never grab `order_items.ordered_at`.
  const qualifierSplit = /__|\./.test(reference) ? reference.split(/__|\./) : undefined;
  const leafReference = qualifierSplit ? qualifierSplit[qualifierSplit.length - 1]! : reference;
  const referenceQualifier = qualifierSplit && qualifierSplit.length > 1
    ? normalizeV2SemanticRuntimeName(qualifierSplit[qualifierSplit.length - 2]!)
    : undefined;
  const runtimeName = normalizeV2SemanticRuntimeName(leafReference);
  const matches = input.candidates.flatMap((candidate) => {
    const candidateId = v2CandidateId(candidate);
    const capability = input.capabilities!.get(candidateId);
    if (!v2SemanticCapabilityMatchesCandidate(capability, candidate, input.role)
      || normalizeV2SemanticRuntimeName(capability.runtimeName) !== runtimeName) return [];
    if (referenceQualifier) {
      const identity = normalizeV2SemanticRuntimeName(candidateId);
      const owner = normalizeV2SemanticRuntimeName(candidate.semanticModel ?? candidate.primaryEntity ?? '');
      const identityLeafModel = (() => {
        const leaf = candidateId.split(':').pop() ?? '';
        const parts = leaf.split('.');
        return parts.length > 1 ? normalizeV2SemanticRuntimeName(parts[parts.length - 2]!) : '';
      })();
      const qualifierAgrees = owner === referenceQualifier
        || identityLeafModel === referenceQualifier
        || identityLeafModel === `${referenceQualifier}s`
        || identity.includes(`:${referenceQualifier}.`)
        || identity.includes(`${referenceQualifier}s.`);
      if (!qualifierAgrees) return [];
    }
    const authority = input.role === 'metric'
      ? candidate.kind === 'semantic_metric'
        ? 0
        : candidate.semanticObjectType === 'metric'
          ? 1
          : 2
      // A DIMENSION/ENTITY reference is routinely declared on several models:
      // MetricFlow expresses a join by naming the same entity `primary` on the
      // model that owns it and `foreign` on the model that points at it. Both
      // are admitted, both answer to the same label, so "customer" matched two
      // candidates and resolved to neither — an idiomatic, correct semantic
      // layer made every breakdown by that entity unanswerable.
      //
      // A foreign declaration is a join reference, not a competing definition.
      // The model whose own primary entity IS this reference owns the identity
      // and wins. When no candidate owns it, the reference stays ambiguous.
      : ownsReferencedEntity(candidate, runtimeName)
        ? 0
        : 1;
    return [{ candidateId, authority }];
  });
  const bestAuthority = matches.reduce<number | undefined>((current, match) => (
    current === undefined || match.authority < current ? match.authority : current
  ), undefined);
  if (bestAuthority !== undefined) {
    const best = [...new Set(matches
      .filter((match) => match.authority === bestAuthority)
      .map((match) => match.candidateId))];
    if (best.length === 1) return best[0];
  }

  // Last resort: a DECLARED alias of exactly one admitted candidate.
  //
  // People — and models reading a card whose `dimensions` are display labels —
  // say "customer", not `semantic:uncategorized:dimension:customers.customer_name`.
  // Aliases were only consulted for references that already looked like
  // identifiers, so a business label matched nothing and the turn was refused
  // while the field it named sat admitted in the same snapshot.
  //
  // This resolves a NAME the modeler themselves attached to a candidate the
  // host already admitted for this role, and only when exactly one candidate
  // claims it. Ambiguity stays ambiguous, and nothing outside the admitted set
  // becomes reachable — so this widens what can be SAID, never what can be RUN.
  // A qualified reference whose qualifier agrees with no candidate must stay
  // unresolved — the label fallback below matches by LEAF name, and letting
  // `products__ordered_at` reach it would hand back another model's field.
  if (referenceQualifier) return undefined;
  const aliasMatches = [...new Set(input.candidates.flatMap((candidate) => {
    const candidateId = v2CandidateId(candidate);
    const capability = input.capabilities!.get(candidateId);
    if (!v2SemanticCapabilityMatchesCandidate(capability, candidate, input.role)) return [];
    const names = [candidate.name, ...(candidate.aliases ?? [])]
      .filter((name): name is string => typeof name === 'string')
      .map(normalizeV2SemanticRuntimeName);
    return names.includes(runtimeName) ? [candidateId] : [];
  }))];
  return aliasMatches.length === 1 ? aliasMatches[0] : undefined;
}

type V2MetricTimeCompatibility =
  | { constrained: false }
  | { constrained: true; compatibleTimeIds: ReadonlySet<string> };

type V2RequestedTimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

interface V2ExplicitTimeRequirement {
  grain?: V2RequestedTimeGrain;
  fiscalPeriod?: string;
  /**
   * A bounded window the answer must be restricted to. Carried so the HOST
   * can compute the concrete date bounds and inject them as range filters —
   * the analyst binds WHICH time axis, never the window's values.
   */
  window?: AnalyticalTimeWindowV1;
  /** A fiscal token is not a reason to invent a calendar or date role. */
  requiresDeclaredFiscalCalendar: boolean;
}

/**
 * Read only the immutable user turn when deciding whether a missing semantic
 * time binding can be mechanically completed. This deliberately does not
 * inspect provider prose, a legacy plan, or a prior controller tool result.
 */
function v2ExplicitTimeRequirement(question: string): V2ExplicitTimeRequirement {
  const time = buildAnalyticalRequirementSet({ question }).time;
  return {
    ...(time?.grain ? { grain: time.grain } : {}),
    ...(time?.window ? { window: time.window } : {}),
    ...(time?.fiscalPeriod ? { fiscalPeriod: time.fiscalPeriod } : {}),
    requiresDeclaredFiscalCalendar: time?.requiresDeclaredFiscalCalendar === true,
  };
}

/** Canonical and retained legacy identities are safe equality aliases only. */
function v2SemanticCandidateIdentityReferences(candidate: AgentEvidenceCandidate): ReadonlySet<string> {
  return new Set([
    v2CandidateId(candidate),
    candidate.id,
    candidate.qualifiedId ?? '',
    ...(candidate.aliases ?? []),
  ].map((value) => value.trim()).filter(Boolean));
}

/**
 * Resolve a selected metric's declared time contract against the admitted
 * cards. A registry migration can retain an old opaque time-card ID as an
 * alias, but a runtime/display name is never enough to establish this link.
 */
function v2MetricCompatibleTimeCandidates(input: {
  metrics: readonly AgentEvidenceCandidate[] | undefined;
  candidates: readonly AgentEvidenceCandidate[];
}): {
  candidates: AgentEvidenceCandidate[];
  /** True only when every selected metric declared at least one time axis. */
  allMetricsDeclareTimeDimensions: boolean;
} {
  const timeCandidates = input.candidates.filter((candidate) => v2SemanticCandidateMatchesRole(candidate, 'time_dimension'));
  if (!input.metrics?.length) return { candidates: timeCandidates, allMetricsDeclareTimeDimensions: false };
  const declaredByMetric = input.metrics.map((metric) => [
    ...new Set((metric.analyticalCapability?.timeDimensions ?? [])
      .map((dimension) => dimension.dimensionId.trim())
      .filter(Boolean)),
  ]);
  // Existing explicit controller bindings remain compatible with legacy
  // semantic cards that did not retain metric-to-axis declarations. What
  // they do not authorize is host selection of an omitted time axis: without
  // a declaration there is no immutable proof that any candidate belongs to
  // the selected metric.
  if (declaredByMetric.some((ids) => ids.length === 0)) {
    return { candidates: timeCandidates, allMetricsDeclareTimeDimensions: false };
  }
  return {
    candidates: timeCandidates.filter((candidate) => {
    const references = v2SemanticCandidateIdentityReferences(candidate);
    return declaredByMetric.every((declared) => declared.some((id) => references.has(id)));
    }),
    allMetricsDeclareTimeDimensions: true,
  };
}

/**
 * The semantic registry, not a shared runtime name, proves which time axes a
 * selected metric may use. A capability-less legacy metric retains the
 * existing unconstrained path; once any selected metric supplies a declared
 * time contract, every selected metric must agree on an admitted time ID.
 */
function v2MetricTimeCompatibility(
  metrics: readonly AgentEvidenceCandidate[] | undefined,
): V2MetricTimeCompatibility {
  if (!metrics || metrics.length === 0) return { constrained: false };
  const declared = metrics.map((metric) => [
    ...new Set((metric.analyticalCapability?.timeDimensions ?? [])
      .map((dimension) => dimension.dimensionId.trim())
      .filter(Boolean)),
  ]);
  if (declared.every((ids) => ids.length === 0)) return { constrained: false };
  if (declared.some((ids) => ids.length === 0)) {
    return { constrained: true, compatibleTimeIds: new Set() };
  }
  const [first, ...rest] = declared;
  const compatibleTimeIds = new Set(first);
  for (const ids of rest) {
    for (const id of compatibleTimeIds) {
      if (!ids.includes(id)) compatibleTimeIds.delete(id);
    }
  }
  return { constrained: true, compatibleTimeIds };
}

function v2ScalarBindings(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) result[key] = item;
  }
  return result;
}

function v2CertifiedArtifactHandle(value: unknown): AskCertifiedArtifactHandleV1 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<AskCertifiedArtifactHandleV1>;
  return candidate.version === 1
    && typeof candidate.revisionFingerprint === 'string'
    && typeof candidate.isCurrent === 'function'
    ? candidate as AskCertifiedArtifactHandleV1
    : undefined;
}

/**
 * A complete certified fit is the one V2 ordinary-Ask zero-provider path.
 *
 * The host computes this from the immutable retrieval lease, captures the
 * artifact at that time, and gives V2 one opaque candidate ID.  This helper
 * deliberately does not look up the mutable KG, infer another block, or use
 * a card count as proof.  If any part of the captured authority is missing we
 * return undefined and let the normal bounded tool runtime decide the turn.
 */
function v2ExactCertifiedCandidate(
  state: AskAgentStateV4 | undefined,
  workspace: AskAgentToolWorkspaceV2 | undefined,
  questionPlan?: ReturnType<typeof buildAnalysisQuestionPlan>,
): {
  candidateId: string;
  candidate: AgentEvidenceCandidate;
  artifact: AskCertifiedArtifactHandleV1;
  invocation?: ReturnType<typeof buildCertifiedBlockInvocationInput>;
} | undefined {
  const candidateId = state?.exactCertifiedCandidateId;
  const certifiedTier = state?.tierStates?.certified;
  if (!candidateId || !workspace || certifiedTier?.status !== 'complete') return undefined;
  const completeCandidateIds = [...new Set(certifiedTier.candidateIds)];
  if (!state.retainedCandidateIds.includes(candidateId)
    || completeCandidateIds.length !== 1
    || completeCandidateIds[0] !== candidateId
    || !workspace.certifiedCompleteCandidateIds?.includes(candidateId)) return undefined;
  const candidate = workspace.candidates.find((value) => v2CandidateId(value) === candidateId);
  const artifact = v2CertifiedArtifactHandle(workspace.certifiedArtifacts?.get(candidateId));
  let artifactCurrent = false;
  try {
    artifactCurrent = artifact?.isCurrent() === true;
  } catch {
    artifactCurrent = false;
  }
  if (!candidate || candidate.kind !== 'certified_block' || candidate.trustTier !== 'certified' || !artifact || !artifactCurrent) return undefined;
  const invocation = questionPlan
    ? buildCertifiedBlockInvocationInput(artifact.artifact as KGNode, questionPlan, questionPlan.question)
    : undefined;
  if (questionPlan && !certifiedBlockProvesRequestedTopN(artifact.artifact as KGNode, questionPlan, {
    exactCertifiedQuestionMatch: workspace.exactCertifiedQuestionCandidateIds?.includes(candidateId) === true,
    uniqueCompleteCertifiedFit: true,
    hostEnforcedRowLimit: workspace.certifiedHostEnforcesInvocationRowLimit === true
      ? invocation?.rowLimit
      : undefined,
  })) return undefined;
  return { candidateId, candidate, artifact, ...(invocation ? { invocation } : {}) };
}

/**
 * Execute the one host-proven exact certified fit without opening a provider
 * turn.  This is intentionally a small sibling of `run_certified`, not a
 * call into the legacy answer loop: the same V2 kernel mints the immutable
 * execution plan, checks the captured artifact immediately before execution,
 * and records the actual result.  A post-freeze failure stays terminal; it
 * cannot silently re-enter planning or fall through to generated SQL.
 */
async function executeAskV2ExactCertifiedFastPath(
  input: AnswerLoopInput,
  state: AskAgentStateV4 | undefined,
): Promise<AgentAnswer | undefined> {
  if (!state || state.mode !== 'authoritative_v2' || !input.executeCertifiedBlock) return undefined;
  const workspace = v2WorkspaceForInput(input, state);
  // An exact Tier 1 fit can skip a provider turn, but it cannot skip the
  // certified artifact's declared input contract. Build the same typed
  // invocation as the ordinary certified path before we freeze the plan so
  // defaults, question-derived top-N values, and validation have one owner.
  const questionPlan = buildAnalysisQuestionPlan(input.question, input.followUp);
  const exact = v2ExactCertifiedCandidate(state, workspace, questionPlan);
  if (!exact) return undefined;
  const invocation = exact.invocation ?? buildCertifiedBlockInvocationInput(
    exact.artifact.artifact as KGNode,
    questionPlan,
    input.question,
  );

  const kernel = createAskToolKernelV2(state);
  const observe = (outcome: AskToolObservationV1['outcome'], reasonCode: string, extra: Partial<AskToolObservationV1> = {}) => {
    observeAskAgentV2Tool(state, {
      version: 1,
      tool: 'run_certified',
      outcome,
      tier: 'certified',
      reasonCode,
      candidateIds: [exact.candidateId],
      origin: extra.origin ?? 'execution',
      ...extra,
    });
  };

  // Tier 1 truth was materialized from the immutable workspace before this
  // path was selected. It is provenance, not a synthetic `run_certified`
  // invocation: adding an execution-tool observation here would consume the
  // progression slot that belongs to the actual authorization/freeze/run.
  const bindingFingerprint = v2ExecutionBindingFingerprint({
    state,
    tier: 'certified',
    candidateIds: [exact.candidateId],
    bindings: {
      artifactRevision: exact.artifact.revisionFingerprint,
      parameters: invocation.parameters ?? {},
      parameterSources: invocation.parameterSources ?? {},
      rowLimit: invocation.rowLimit ?? null,
    },
  });
  const authorization = kernel.canCall('run_certified', {
    candidateIds: [exact.candidateId],
    bindingFingerprint,
    // This is a server-owned exact-fit capability, never a provider-visible
    // tool argument. The kernel rechecks the current unique Tier 1 tuple.
    directExactCertifiedExecution: true,
  });
  if (!authorization.ok) {
    observe('denied', authorization.reasonCode ?? 'ASK_V2_TOOL_DENIED', { origin: 'validation' });
    finishAskAgentV2Turn(state, {
      version: 2,
      kind: 'denied',
      reasonCode: authorization.reasonCode ?? 'ASK_V2_TOOL_DENIED',
      safeAction: 'inspect_recorded_observations_then_retry',
      origin: 'validation',
    });
    return askV2NoAnswer(input, 'denied', authorization.reasonCode ?? 'ASK_V2_TOOL_DENIED', 'validation');
  }
  if (!exact.artifact.isCurrent()) {
    observe('denied', 'CERTIFIED_ARTIFACT_STALE', { origin: 'validation' });
    finishAskAgentV2Turn(state, {
      version: 2,
      kind: 'denied',
      reasonCode: 'CERTIFIED_ARTIFACT_STALE',
      safeAction: 'refresh_metadata_then_retry',
      origin: 'validation',
    });
    return askV2NoAnswer(input, 'denied', 'CERTIFIED_ARTIFACT_STALE', 'validation');
  }

  // This observation freezes the plan before compiler/connection work.  It
  // must remain in the receipt if the executor fails.
  observe('eligible', 'ASK_V2_EXECUTION_AUTHORIZED', {
    planId: `ask-v2:certified:${bindingFingerprint.slice(-24)}`,
    frozen: true,
    executionAuthorized: true,
    inputFingerprint: bindingFingerprint,
    origin: 'freeze',
  });
  if (!exact.artifact.isCurrent()) {
    observe('error', 'CERTIFIED_ARTIFACT_STALE', { origin: 'validation' });
    finishAskAgentV2Turn(state, {
      version: 2,
      kind: 'execution_failure',
      reasonCode: 'CERTIFIED_ARTIFACT_STALE',
      safeAction: 'refresh_metadata_then_retry',
      origin: 'validation',
    });
    return askV2NoAnswer(input, 'execution_failure', 'CERTIFIED_ARTIFACT_STALE', 'validation');
  }
  if (!input.executeCertifiedBlock || !exact.artifact.artifact || typeof exact.artifact.artifact !== 'object') {
    observe('unavailable', 'CERTIFIED_EXECUTOR_UNAVAILABLE', { origin: 'execution' });
    finishAskAgentV2Turn(state, {
      version: 2,
      kind: 'execution_failure',
      reasonCode: 'CERTIFIED_EXECUTOR_UNAVAILABLE',
      safeAction: 'check_connection_then_retry',
      origin: 'execution',
    });
    return askV2NoAnswer(input, 'execution_failure', 'CERTIFIED_EXECUTOR_UNAVAILABLE', 'execution');
  }
  try {
    const result = trimCertifiedBlockResultToRequestedTopN(
      await input.executeCertifiedBlock(exact.artifact.artifact as KGNode, invocation),
      questionPlan,
    );
    observe('executed', 'CERTIFIED_EXECUTED', {
      // The terminal receipt binds the execution observation to the exact
      // host-minted frozen plan. A candidate ID alone is only retrieval
      // membership and cannot prove that this specific plan executed.
      planId: state.resolvedPlan?.id,
      origin: 'execution',
    });
    finishAskAgentV2Turn(state, {
      version: 2,
      kind: 'finish_answer',
      reasonCode: 'CERTIFIED_EXECUTED',
      origin: 'execution',
    });
    return askV2ExecutedAnswer(input, {
      tier: 'certified',
      result,
      block: exact.artifact.artifact as KGNode,
    }, `The certified query completed with ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}.`);
  } catch (error) {
    const failure = v2ExecutionFailureFromError(error, 'CERTIFIED_EXECUTION_FAILED');
    observe('error', failure.reasonCode, { origin: failure.origin });
    finishAskAgentV2Turn(state, {
      version: 2,
      kind: 'execution_failure',
      reasonCode: failure.reasonCode,
      safeAction: failure.origin === 'validation' ? 'refresh_metadata_then_retry' : 'check_connection_then_retry',
      origin: failure.origin,
    });
    return askV2NoAnswer(input, 'execution_failure', failure.reasonCode, failure.origin);
  }
}

/**
 * A V2 inspection reports the host's precomputed tuple state.  It must never
 * derive completeness from a provider-visible card count; the card is only a
 * safe explanation of the already-fixed host decision.
 */
function setV2TierStateFromWorkspace(
  state: AskAgentStateV4,
  workspace: AskAgentToolWorkspaceV2 | undefined,
  tier: 'certified' | 'semantic' | 'governed_relational',
  fallback: { status: 'complete' | 'available' | 'unavailable' | 'ineligible' | 'ambiguous'; candidateIds: string[]; reasonCode: string },
): void {
  const supplied = workspace?.tierStates?.[tier];
  setAskV2TierState(state, tier, supplied
    ? {
        status: supplied.status,
        candidateIds: supplied.candidateIds,
        reasonCode: supplied.reasonCode,
        ...(supplied.safeNextTools?.length ? { safeNextTools: supplied.safeNextTools } : {}),
        ...(supplied.clarificationChoices?.length ? { clarificationChoices: supplied.clarificationChoices } : {}),
      }
    : fallback);
}

function v2ExecutionBindingFingerprint(input: {
  state: AskAgentStateV4;
  tier: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql';
  candidateIds: readonly string[];
  pathIds?: readonly string[];
  /** Redacted typed bindings, never the raw SQL/DQL source. */
  bindings?: unknown;
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    snapshotId: input.state.snapshotId ?? '',
    sourceFingerprint: input.state.sourceFingerprint ?? '',
    tier: input.tier,
    candidateIds: [...new Set(input.candidateIds)].sort(),
    pathIds: [...new Set(input.pathIds ?? [])].sort(),
    bindings: input.bindings ?? null,
  })).digest('hex')}`;
}

/**
 * Same-plan governed-DQL repair is deliberately stricter than matching opaque
 * candidate and relationship IDs. A repaired program may change parser or
 * dialect presentation only; it may not add a filter, aggregation, grouping,
 * relation, alias, or output contract. Keep every non-comment token in this
 * canonical form, including quoted literals and identifiers, so the hash is
 * an equivalently strict logical-plan proof even before a compiler is invoked.
 *
 * This is not persisted as source text. The frozen binding records only its
 * digest alongside snapshot-qualified IDs.
 */
function normalizedDqlLogicalProgram(source: string): string {
  let output = '';
  let pendingWhitespace = false;
  let quote: 'single' | 'double' | 'backtick' | undefined;
  let lineComment = false;
  let blockComment = false;
  const punctuation = new Set(['|', ',', '(', ')', '=', '<', '>', '+', '-', '*', '/', '.']);
  const append = (value: string, preserveCase = false) => {
    if (pendingWhitespace && output.length > 0
      && !punctuation.has(output.at(-1)!) && !punctuation.has(value)) output += ' ';
    pendingWhitespace = false;
    output += preserveCase ? value : value.toLowerCase();
  };
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (current === '\n' || current === '\r') {
        lineComment = false;
        pendingWhitespace = true;
      }
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        pendingWhitespace = true;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += current;
      if (current === '\\' && next !== undefined) {
        output += next;
        index += 1;
        continue;
      }
      if ((quote === 'single' && current === "'")
        || (quote === 'double' && current === '"')
        || (quote === 'backtick' && current === '`')) quote = undefined;
      continue;
    }
    if (current === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "'") {
      append(current, true);
      quote = 'single';
      continue;
    }
    if (current === '"') {
      append(current, true);
      quote = 'double';
      continue;
    }
    if (current === '`') {
      append(current, true);
      quote = 'backtick';
      continue;
    }
    if (/\s/.test(current)) {
      pendingWhitespace = true;
      continue;
    }
    append(current);
  }
  // A harmless terminal separator is parser presentation, not a second DQL
  // statement. All internal separators remain part of the strict proof.
  return output.trim().replace(/;$/, '');
}

function v2GovernedDqlLogicalPlanFingerprint(input: {
  dqlProgram: string;
  measureIds: readonly string[];
  dimensionIds: readonly string[];
  outputIds: readonly string[];
}): string {
  return runtimeFingerprint(JSON.stringify({
    // The complete canonical program retains operations, relations/columns,
    // filters, grouping, aggregation, aliases, and output expressions.
    program: normalizedDqlLogicalProgram(input.dqlProgram),
    measureIds: [...new Set(input.measureIds)].sort(),
    dimensionIds: [...new Set(input.dimensionIds)].sort(),
    outputIds: [...new Set(input.outputIds)].sort(),
  }));
}

function v2PlanFingerprint(input: {
  state: AskAgentStateV4;
  tier: 'governed_relational' | 'exploratory_sql';
  candidateIds: readonly string[];
  pathIds?: readonly string[];
  sqlOrProgram: string;
}): string {
  // Kept for host-specific proposal correlation. The V2 frozen plan uses the
  // binding fingerprint above so one syntax repair can retain its targets.
  return `sha256:${createHash('sha256').update(JSON.stringify({
    binding: v2ExecutionBindingFingerprint(input),
    sqlOrProgramFingerprint: runtimeFingerprint(input.sqlOrProgram),
  })).digest('hex')}`;
}

/**
 * Keep a V2 host rejection attributable at the tool boundary without
 * persisting the raw host message. An immutable-closure or relationship-path
 * rejection must not be flattened into a generic warehouse failure, which
 * would incorrectly suggest that retrying can widen a frozen plan.
 */
function v2ExecutionFailureFromError(
  error: unknown,
  fallback: string,
): { reasonCode: string; origin: 'execution' | 'validation' } {
  const detail = analyticalErrorDetail(error);
  const code = typeof detail?.code === 'string' && /^[a-z0-9_]+$/i.test(detail.code)
    ? `ASK_V2_${detail.code.toUpperCase()}`
    : fallback;
  return {
    reasonCode: code,
    origin: detail?.stage === 'validation' || detail?.stage === 'compile' ? 'validation' : 'execution',
  };
}

/**
 * The V2 serving controller intentionally does not call `answer()`.
 *
 * Every canonical tool consumes explicit, snapshot-qualified arguments.  The
 * model owns business interpretation; this adapter owns identifier admission,
 * priority, compiler/executor boundaries, and trusted receipts.  It never
 * searches the mutable KG or reads a V1 precomputed route/plan.
 */
function createAskV2LaneHandler(
  state: AskAgentStateV4,
  limits?: { maxToolCalls?: number; maxProviderDispatches?: number },
) {
  return async (input: AnswerLoopInput): Promise<AgentAnswer> => {
    // Reapply immutable Tier 1 tuple truth before a reloaded state creates a
    // kernel or exposes a tool policy.  A persisted lower controllerTier is
    // only a pre-freeze proposal; it cannot outrank a complete certified
    // artifact from this exact workspace unless the user explicitly named a
    // qualified semantic/DQL artifact.
    const bridgeCertifiedExecutionAvailable = (() => {
      try {
        // Older in-memory bridges predate this additive readiness hook. Their
        // actual host callback below remains the authority for those tests and
        // legacy-compatible callers; live bridges always declare readiness.
        return input.askAgentV2Workspace?.isCertifiedExecutionAvailable?.();
      } catch {
        return false;
      }
    })();
    const workspace = materializeAskV2WorkspaceTierTruth(state, input.askAgentV2Workspace, {
      question: input.question,
      certifiedExecutionAvailable: Boolean(input.executeCertifiedBlock)
        && (bridgeCertifiedExecutionAvailable === undefined || bridgeCertifiedExecutionAvailable === true),
    }) ?? v2WorkspaceForInput(input, state);
    const kernel = createAskToolKernelV2(state);
    // The runtime setting is captured before the controller starts. Keep the
    // redacted choice on live V2 state so V8 can explain semantic readiness
    // without ever making an adapter a provider-controlled argument.
    if (workspace?.semanticRuntime) state.semanticRuntime = { ...workspace.semanticRuntime };
    let completed: AskV2CompletedExecution | undefined;
    let clarification: { message: string; options: Array<{ id: string; label: string }> } | undefined;
    let finalText: string | undefined;
    let executionFailure: { reasonCode: string; origin: 'execution' | 'validation' } | undefined;
    let inspectedBusinessContextIds: string[] = [];
    // A missing time binding may be completed only once from the immutable
    // current question and one admitted compatible capability. This is a
    // mechanical normalization inside one semantic tool call, never a second
    // model-selected meaning or an unbounded recovery loop.
    // A persisted host-only completion still consumes the one permitted
    // semantic-binding correction. It does *not* consume a provider tool
    // budget (the kernel derives that separately), but a resumed request must
    // not get a fresh chance to infer another axis or grain from the same
    // immutable turn.
    let semanticArgumentCompletionCount = state.observations.some((observation) => (
      observation.tool === 'compile_and_run_semantic'
      && observation.reasonCode === 'SEMANTIC_TIME_BINDING_COMPLETED'
    )) ? 1 : 0;
    const candidateIds = () => state.candidatePlan?.candidateIds ?? state.initialCandidateIds;
    /**
     * This is evaluated at the physical provider-send boundary, not when the
     * tool loop starts. A provider may issue multiple native tool rounds from
     * one `generateWithTools` call, so only the live host state can prove that
     * the next send is the one post-execution narration control. General,
     * contextual, inspection, and execution turns deliberately remain in
     * agent-control/tool-followup accounting.
     */
    const requiredNarrationControl = (): boolean => {
      if (!completed) return false;
      const policy = kernel.toolPolicy();
      const allowed = policy.allowedToolNames ?? [];
      const terminal = policy.terminalActionToolNames ?? [];
      return allowed.length === 1
        && allowed[0] === 'finish_answer'
        && terminal.length === 1
        && terminal[0] === 'finish_answer'
        && !state.observations.some((observation) => (
          observation.tool === 'finish_answer'
          && observation.outcome === 'eligible'
          && observation.reasonCode === 'ASK_V2_RESULT_NARRATED'
        ));
    };
    const observe = (tool: AskToolNameV2, outcome: AskToolObservationV1['outcome'], reasonCode: string, extra: Partial<AskToolObservationV1> = {}) => {
      observeAskAgentV2Tool(state, {
        version: 1,
        tool,
        outcome,
        reasonCode,
        candidateIds: extra.candidateIds ?? candidateIds(),
        origin: extra.origin ?? 'tool',
        ...extra,
      });
    };
    const denied = (tool: AskToolNameV2, reasonCode: string, safeNextTools?: readonly AskToolNameV2[]) => ({
      ok: false,
      reasonCode,
      tool,
      ...(safeNextTools?.length ? { safeNextTools: [...new Set(safeNextTools)] } : {}),
    });
    /**
     * A successful execution remains an answer even when the provider cannot
     * complete its final narration/control turn.  Do not replace validated
     * rows with a provider or dispatch-budget failure: retain the result,
     * make the fallback narration from its validated result facts, and leave
     * the exact narration incident in the V2 receipt.
     */
    const preserveCompletedResult = (
      narrationFailureReason: string,
      narrationFailureOrigin: 'agent_control' | 'provider' | 'narration',
    ): AgentAnswer | undefined => {
      if (!completed) return undefined;
      const narrationDeadline = narrationFailureReason === 'RUN_SOFT_TARGET_EXCEEDED'
        || narrationFailureReason === 'RUN_DEADLINE_INSUFFICIENT';
      observe('finish_answer', 'error', narrationFailureReason, {
        origin: narrationDeadline ? 'narration' : narrationFailureOrigin,
        safeAction: 'review_validated_result',
        ...(narrationDeadline ? {
          provider: {
            phase: 'narration' as const,
            cause: 'run_deadline' as const,
            retryable: false,
            safeAction: 'review_validated_result',
          },
        } : {}),
      });
      const terminalOutcome: NonNullable<AgentAnswer['askAgentV2Outcome']> = {
        version: 2,
        kind: 'finish_answer',
        reasonCode: narrationDeadline
          ? 'ASK_V2_RESULT_PRESERVED_AFTER_NARRATION_DEADLINE'
          : 'ASK_V2_RESULT_PRESERVED_AFTER_NARRATION_FAILURE',
        origin: 'narration',
        safeAction: 'review_validated_result',
      };
      finishAskAgentV2Turn(state, terminalOutcome);
      return askV2ExecutedAnswer(
        input,
        completed,
        deterministicAskV2ResultNarration(completed),
        terminalOutcome,
      );
    };
    /**
     * Clarification choices are issued by the immutable host workspace, not
     * synthesized from provider-visible cards. Distinct opaque fingerprints
     * prove the choice would change the answer; missing or malformed choice
     * evidence fails closed into normal tool progression.
     */
    const materialClarificationChoices = () => {
      const tier = state.tierStates?.semantic;
      if (tier?.status !== 'ambiguous') return [];
      const retained = new Set(state.retainedCandidateIds);
      const tierCandidates = new Set(tier.candidateIds);
      const choices = (tier.clarificationChoices ?? []).filter((choice) => (
        choice.version === 1
        && Boolean(choice.id.trim())
        && Boolean(choice.label.trim())
        && Boolean(choice.resultFingerprint.trim())
        && choice.candidateIds.length > 0
        && choice.candidateIds.every((id) => retained.has(id) && tierCandidates.has(id))
      ));
      const ids = new Set(choices.map((choice) => choice.id));
      const results = new Set(choices.map((choice) => choice.resultFingerprint));
      return choices.length >= 2 && ids.size === choices.length && results.size === choices.length
        ? choices
        : [];
    };
    const authorizeExecution = (input: {
      tool: Extract<AskToolNameV2, 'run_certified' | 'compile_and_run_semantic' | 'compile_and_run_dql' | 'validate_and_run_sql'>;
      tier: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql';
      candidateIds: string[];
      bindingFingerprint: string;
      planId: string;
      repair: boolean;
      relationshipPathIds?: string[];
      targetFingerprint?: string;
    }): { ok: true } | { ok: false; reasonCode: string } => {
      const allowed = kernel.canCall(input.tool, {
        repair: input.repair,
        candidateIds: input.candidateIds,
        ...(input.relationshipPathIds ? { relationshipPathIds: input.relationshipPathIds } : {}),
        bindingFingerprint: input.bindingFingerprint,
      });
      if (!allowed.ok) {
        observe(input.tool, 'denied', allowed.reasonCode ?? 'ASK_V2_TOOL_DENIED', {
          tier: input.tier,
          candidateIds: input.candidateIds,
          origin: 'validation',
          ...(allowed.safeNextTools?.length ? { safeAction: `use:${allowed.safeNextTools.join(',')}` } : {}),
        });
        return { ok: false, reasonCode: allowed.reasonCode ?? 'ASK_V2_TOOL_DENIED' };
      }
      observe(input.tool, 'eligible', 'ASK_V2_EXECUTION_AUTHORIZED', {
        tier: input.tier,
        candidateIds: input.candidateIds,
        planId: input.planId,
        frozen: true,
        executionAuthorized: true,
        samePlanRepair: input.repair,
        inputFingerprint: input.bindingFingerprint,
        ...(input.relationshipPathIds?.length ? { relationshipPathIds: input.relationshipPathIds } : {}),
        ...(input.targetFingerprint ? { outputFingerprint: input.targetFingerprint } : {}),
        origin: 'freeze',
      });
      return { ok: true };
    };
    const visibleIds = () => new Set([
      ...state.initialCandidateIds,
      ...state.observations
        .filter((item) => item.tool === 'inspect_ask_context')
        .flatMap((item) => item.candidateIds),
    ]);
    const visibleCandidates = () => (workspace?.candidates ?? [])
      .filter((candidate) => visibleIds().has(v2CandidateId(candidate)));
    /**
     * The admitted semantic identifiers, grouped by the role each may play.
     *
     * This is the ONLY vocabulary `compile_and_run_semantic` accepts, so it is
     * the vocabulary inspection has to hand back. The cards describe a metric's
     * compatible dimensions by display name ("customer_name"), which reads like
     * an identifier and is not one — so a model that used what it was shown got
     * a bare "identifier not admitted" refusal and no way to do better. Naming
     * the accepted IDs is not a loosening of governance: these are exactly the
     * IDs the host had already agreed to execute.
     */
    const admittedSemanticIdentifiers = (): Record<string, string[]> | undefined => {
      const byRole: Record<string, string[]> = {};
      const add = (role: string, id: string): void => {
        const bucket = byRole[role] ?? (byRole[role] = []);
        if (bucket.length < 24 && !bucket.includes(id)) bucket.push(id);
      };
      for (const candidate of visibleCandidates()) {
        const id = v2CandidateId(candidate);
        // Roles come from the CANDIDATE, not only from a capability handle.
        // Handles are minted for executable metrics; dimensions have none, so
        // a capability-only list handed back metric IDs and an empty dimension
        // list. The model then had nothing to copy for the breakdown and fell
        // back to the card's display label ("customer"), which is refused —
        // every time, no matter how often it retried.
        for (const role of ['metric', 'dimension', 'filter_dimension', 'time_dimension'] as const) {
          if (v2SemanticCandidateMatchesRole(candidate, role === 'filter_dimension' ? 'dimension' : role)) {
            add(role === 'filter_dimension' ? 'dimension' : role, id);
          }
        }
      }
      return Object.keys(byRole).length > 0 ? byRole : undefined;
    };
    /**
     * Resolve one model-supplied identifier against the admitted workspace.
     *
     * Two forms are legal. The first is a card ID exactly as a tool returned
     * it. The second is `<relation>.<column>` — a column of an admitted
     * relation, where `<relation>` may be the relation's card ID or its plain
     * name. That second form is not a loosening of admission: the host proves
     * the column is one the immutable catalog recorded for that exact relation
     * before accepting it, and every downstream gate still receives the
     * RELATION's own admitted ID. It exists because a relation card without a
     * usable column vocabulary leaves a planner nothing to say but a guess,
     * and a guess is refused every time.
     */
    const relationColumnNames = (candidate: AgentEvidenceCandidate): Set<string> =>
      new Set((candidate.columns ?? []).map((column) => column.name.trim().toLowerCase()).filter(Boolean));
    const resolveAdmittedReference = (
      rawId: string,
    ): { candidate: AgentEvidenceCandidate; column?: string } | undefined => {
      const id = rawId.trim();
      if (!id) return undefined;
      const visible = visibleCandidates();
      const byId = new Map(visible.map((candidate) => [v2CandidateId(candidate), candidate] as const));
      const exact = byId.get(id);
      if (exact) return { candidate: exact };
      const separator = id.lastIndexOf('.');
      if (separator <= 0 || separator === id.length - 1) return undefined;
      const relationRef = id.slice(0, separator);
      const column = id.slice(separator + 1);
      const relation = byId.get(relationRef)
        ?? visible.find((candidate) => candidate.name === relationRef)
        ?? visible.find((candidate) => candidate.name.toLowerCase() === relationRef.toLowerCase());
      if (!relation) return undefined;
      // Only a relation carries columns; a metric or dimension card that
      // happens to contain a dot must not become a pseudo-relation.
      if (!relationColumnNames(relation).has(column.trim().toLowerCase())) return undefined;
      return { candidate: relation, column };
    };
    const resolveCandidates = (ids: string[], predicate?: (candidate: AgentEvidenceCandidate) => boolean): AgentEvidenceCandidate[] | undefined => {
      if (ids.length === 0 || !workspace) return undefined;
      const resolved = ids.map((id) => resolveAdmittedReference(id)?.candidate);
      if (resolved.some((candidate) => !candidate) || (predicate && resolved.some((candidate) => !predicate(candidate!)))) return undefined;
      // A column reference resolves to its relation, so several selected
      // columns of one table collapse to that single admitted candidate. The
      // execution closure is the relation either way.
      const unique: AgentEvidenceCandidate[] = [];
      for (const candidate of resolved as AgentEvidenceCandidate[]) {
        if (!unique.some((entry) => v2CandidateId(entry) === v2CandidateId(candidate))) unique.push(candidate);
      }
      return unique;
    };
    /**
     * The relation vocabulary a governed-relational or exploratory-SQL call
     * may draw from: every admitted relation, and for each the columns the
     * catalog proved it has. This is what a refusal must hand back — a bare
     * "not admitted" costs a turn and teaches nothing.
     */
    const admittedRelationVocabulary = (limit = 12): Array<Record<string, unknown>> =>
      visibleCandidates()
        .filter((candidate) => (candidate.columns?.length ?? 0) > 0)
        .slice(0, limit)
        .map((candidate) => ({
          id: v2CandidateId(candidate),
          name: candidate.name,
          ...(candidate.sourceObjects?.length ? { relation: candidate.sourceObjects[0] } : {}),
          columns: (candidate.columns ?? []).slice(0, 40).map((column) => column.name),
          ...(candidate.columnCount && candidate.columnCount > Math.min(40, candidate.columns?.length ?? 0)
            ? { columnCount: candidate.columnCount }
            : {}),
        }));
    const inspected = (tool: AskToolNameV2) => {
      if (tool === 'inspect_relational_context') {
        // The initial immutable context response includes the bounded atomic
        // relationship-path handles. They are already part of the first
        // provider package, so a separate rendering call is optional; the
        // DQL tool still validates selected IDs and path closure before
        // authorization. Requiring a repeat inspection here used an entire
        // controller dispatch without adding immutable evidence.
        return state.observations.some((observation) => (
          observation.tool === 'inspect_relational_context'
        )) || state.relationshipPathHandles.length > 0;
      }
      return state.observations.some((observation) => observation.tool === tool);
    };
    const requireInspections = (tool: AskToolNameV2, required: AskToolNameV2[]): boolean => {
      // A live V2 controller commitment is made only by the matching
      // host-backed inspector below.  Requiring it to spend later-tier
      // inspection turns before the selected compiler can run was the source
      // of semantic dispatch-budget failures.  The kernel still rejects an
      // earlier *complete* tier before authorization/freeze.
      const committedExecutionTool = state.controllerTier === 'certified'
        ? 'run_certified'
        : state.controllerTier === 'semantic'
          ? 'compile_and_run_semantic'
          : state.controllerTier === 'governed_relational'
            ? 'compile_and_run_dql'
            : state.controllerTier === 'exploratory_sql'
              ? 'validate_and_run_sql'
              : undefined;
      if (committedExecutionTool === tool) return true;
      if (required.every(inspected)) return true;
      observe(tool, 'ineligible', 'REQUIRED_TIER_INSPECTION_MISSING', { origin: 'validation' });
      return false;
    };
    const safeTool = (
      name: AskToolNameV2,
      description: string,
      inputSchema: Record<string, unknown>,
      run: (args: Record<string, unknown>) => Promise<unknown>,
    ): AgentToolDefinition => ({
      name,
      description,
      inputSchema,
      run: async (value) => {
        const args = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
        // Pass opaque relationship handles into the kernel even for a
        // pre-execution validation call. This lets an invented/stale path
        // reach the DQL validator for its exact no-execution diagnostic
        // rather than being flattened into a generic live-policy denial.
        const relationshipPathIds = v2StringArray(args.relationshipPathIds, 8);
        const semanticCandidateIds = name === 'compile_and_run_semantic'
          ? [
              ...v2StringArray(args.metricIds, 8),
              ...v2StringArray(args.dimensionIds, 16),
              ...(typeof args.timeDimensionId === 'string' ? [args.timeDimensionId.trim()] : []),
              ...(Array.isArray(args.filters)
                ? args.filters.flatMap((filter) => filter && typeof filter === 'object' && !Array.isArray(filter)
                  && typeof (filter as { dimensionId?: unknown }).dimensionId === 'string'
                  ? [(filter as { dimensionId: string }).dimensionId.trim()]
                  : [])
                : []),
            ].filter(Boolean)
          : [];
        const allowed = kernel.canCall(name, {
          repair: args.repair === true,
          expansion: args.expand === true,
          ...(semanticCandidateIds.length ? { candidateIds: semanticCandidateIds } : {}),
          ...(relationshipPathIds.length ? { relationshipPathIds } : {}),
        });
        if (!allowed.ok) {
          // NEVER-DEAD-END CONCESSION. The progression rule exists to stop a
          // model from finishing without trying the executable tiers — but a
          // model that has inspected them and TWICE chosen to finish rather
          // than write exploratory SQL it cannot ground has made an honest
          // judgment (observed live: certified empty + semantic unavailable
          // on a 3,373-model repo; sonnet declined to invent Snowflake SQL
          // and the kernel burned the whole dispatch budget re-denying).
          // Concede on the SECOND identical denial: close the turn as a
          // typed gap. No SQL runs, no prose is trusted; the reader gets an
          // honest refusal in 3 dispatches instead of a timeout in 6.
          if (name === 'finish_answer'
            && allowed.reasonCode === 'ASK_V2_TOOL_PROGRESSION_REQUIRED'
            && !completed
            && state.observations.some((observation) =>
              observation.tool === 'finish_answer'
              && observation.reasonCode === 'ASK_V2_TOOL_PROGRESSION_REQUIRED')) {
            observe('finish_answer', 'ineligible', 'ASK_V2_REMAINING_TIERS_DECLINED', {
              origin: 'agent_control',
              ...(allowed.safeNextTools?.length ? { safeAction: `use:${allowed.safeNextTools.join(',')}` } : {}),
            });
            finishAskAgentV2Turn(state, {
              version: 2,
              kind: 'gap',
              reasonCode: 'ASK_V2_REMAINING_TIERS_DECLINED',
              origin: 'agent_control',
            });
            return { finished: true, conceded: true, reasonCode: 'ASK_V2_REMAINING_TIERS_DECLINED' };
          }
          const clarificationPreFreeze = name === 'request_clarification'
            && (allowed.reasonCode === 'ASK_V2_CLARIFICATION_NOT_MATERIALLY_AMBIGUOUS'
              || allowed.reasonCode === 'ASK_V2_TOOL_PROGRESSION_REQUIRED');
          const redundantInspection = allowed.reasonCode === 'ASK_V2_REDUNDANT_INSPECTION';
          observe(name, clarificationPreFreeze || redundantInspection ? 'ineligible' : 'denied', allowed.reasonCode ?? 'ASK_V2_TOOL_DENIED', {
            origin: 'validation',
            ...(allowed.safeNextTools?.length ? { safeAction: `use:${allowed.safeNextTools.join(',')}` } : {}),
          });
          return {
            ...denied(name, allowed.reasonCode ?? 'ASK_V2_TOOL_DENIED', allowed.safeNextTools),
          };
        }
        if (!workspace) {
          observe(name, 'unavailable', 'V2_WORKSPACE_SNAPSHOT_MISMATCH', { origin: 'retrieval', candidateIds: [] });
          return denied(name, 'V2_WORKSPACE_SNAPSHOT_MISMATCH');
        }
        try {
          return await run(args);
        } catch {
          observe(name, 'error', 'ASK_V2_TOOL_BOUNDARY_ERROR', { origin: 'tool' });
          return denied(name, 'ASK_V2_TOOL_BOUNDARY_ERROR');
        }
      },
    });
    const tools: AgentToolDefinition[] = [
      safeTool('inspect_ask_context', 'Inspect safe, role-balanced cards from the immutable Ask snapshot. Use expand only when initial cards are insufficient.', {
        type: 'object', properties: { expand: { type: 'boolean' } }, additionalProperties: false,
      }, async (args) => {
        const expansion = args.expand === true;
        const offset = state.observations.filter((item) => item.tool === 'inspect_ask_context' && item.reasonCode === 'same_snapshot_extension').length * 12;
        const ids = expansion ? state.expansionCandidateIds.slice(offset, offset + 12) : state.initialCandidateIds;
        const cards = (workspace?.candidates ?? [])
          .filter((candidate) => ids.includes(v2CandidateId(candidate)))
          .map((candidate) => v2SafeCard(candidate, workspace));
        observe('inspect_ask_context', cards.length ? 'eligible' : 'unavailable', expansion ? 'same_snapshot_extension' : 'initial_snapshot_context', { candidateIds: ids, origin: 'retrieval' });
        return {
          snapshotId: state.snapshotId,
          cards,
          relationshipPathHandles: state.relationshipPathHandles.map((path) => ({
            id: path.id,
            edgeIds: path.edgeIds,
            ...(path.candidateIds?.length ? { candidateIds: path.candidateIds } : {}),
          })),
        };
      }),
      safeTool('inspect_conversation_result', 'Inspect trusted prior result bindings and selected member handles. Never infer a member from browser rows.', {
        type: 'object', properties: {}, additionalProperties: false,
      }, async () => {
        observe('inspect_conversation_result', 'eligible', 'trusted_conversation_context', { candidateIds: state.conversation.availableResultHandleIds, origin: 'retrieval' });
        return {
          selectedMemberId: state.conversation.selectedMemberId,
          selectedMemberBinding: state.conversation.selectedMemberBinding,
          availableResultHandleIds: state.conversation.availableResultHandleIds,
          // The members an ambiguous reference could have meant, so the
          // analyst can ask which one instead of guessing or giving up.
          ...(state.conversation.ambiguousMemberLabels?.length
            ? { ambiguousMemberLabels: state.conversation.ambiguousMemberLabels }
            : {}),
        };
      }),
      safeTool('inspect_business_context', 'Inspect retrieved business definitions and context without executing a warehouse query.', {
        type: 'object', properties: {}, additionalProperties: false,
      }, async () => {
        const business = workspace?.businessContext;
        const cards = business?.cards?.slice(0, 24) ?? [];
        inspectedBusinessContextIds = cards.map((card) => card.id);
        observe('inspect_business_context', business?.available ? 'eligible' : 'unavailable', business?.available ? 'business_context_inspected' : 'business_context_empty', {
          origin: 'retrieval',
          candidateIds: inspectedBusinessContextIds,
        });
        return { available: business?.available ?? false, objectCount: business?.objectCount ?? 0, cards };
      }),
      safeTool('inspect_certified_candidates', 'Inspect admitted certified blocks before a semantic, governed relational, or SQL tool.', {
        type: 'object', properties: {}, additionalProperties: false,
      }, async () => {
        const candidates = visibleCandidates().filter((candidate) => candidate.kind === 'certified_block' && candidate.trustTier === 'certified');
        const ids = candidates.map(v2CandidateId);
        // Tier 1 truth was materialized from the immutable handle + actual
        // host execution callback before this policy exposed the inspector.
        // Never overwrite it from a workspace card or stale complete-fit list:
        // that was the path that reintroduced a non-executable certified
        // block and trapped semantic fallback on reload.
        const certifiedTier = state.tierStates?.certified;
        const complete = new Set(certifiedTier?.status === 'complete' ? certifiedTier.candidateIds : []);
        const executableComplete = complete.size > 0;
        if (!state.controllerTier && executableComplete) state.controllerTier = 'certified';
        const inspectionOutcome = certifiedTier?.status === 'ineligible'
          ? 'ineligible'
          : certifiedTier?.status === 'unavailable'
            ? 'unavailable'
            : ids.length > 0
              ? 'eligible'
              : 'unavailable';
        observe(
          'inspect_certified_candidates',
          inspectionOutcome,
          certifiedTier?.reasonCode ?? (ids.length ? 'CERTIFIED_CANDIDATES_AVAILABLE' : 'CERTIFIED_CANDIDATES_EMPTY'),
          { candidateIds: ids, origin: 'retrieval' },
        );
        return {
          cards: candidates.map((candidate) => ({
            ...v2SafeCard(candidate, workspace),
            // This says only whether the snapshot-proven output contract may
            // freeze tier 1 for this turn. It does not expose raw fit text or
            // let the provider promote a context-only block.
            certifiedCompleteForRequest: complete.has(v2CandidateId(candidate)),
          })),
        };
      }),
      safeTool('run_certified', 'Run one snapshot-bound certified block with optional scalar bindings. The artifact is immutable and cannot be re-searched.', {
        type: 'object', properties: {
          candidateId: { type: 'string' },
          bindings: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
          repair: { type: 'boolean' },
        }, required: ['candidateId'], additionalProperties: false,
      }, async (args) => {
        if (!requireInspections('run_certified', ['inspect_certified_candidates'])) return denied('run_certified', 'REQUIRED_TIER_INSPECTION_MISSING');
        // Re-materialize immediately before authorizing. An artifact may have
        // gone stale after the inspector rendered it; while still pre-freeze
        // that is an unavailable observation and the cascade may continue.
        const certifiedWorkspace = materializeAskV2WorkspaceTierTruth(state, input.askAgentV2Workspace, {
          question: input.question,
          certifiedExecutionAvailable: Boolean(input.executeCertifiedBlock)
            && (bridgeCertifiedExecutionAvailable === undefined || bridgeCertifiedExecutionAvailable === true),
        }) ?? workspace;
        const candidateId = typeof args.candidateId === 'string' ? args.candidateId : '';
        const candidate = resolveCandidates([candidateId], (item) => item.kind === 'certified_block' && item.trustTier === 'certified')?.[0];
        const artifact = candidate && certifiedWorkspace?.certifiedArtifacts?.get(candidateId);
        const handle = v2CertifiedArtifactHandle(artifact);
        const block = handle?.artifact && typeof handle.artifact === 'object' && (handle.artifact as { kind?: unknown }).kind === 'block'
          ? handle.artifact as KGNode
          // Backward-compatible in-memory test adapter only. The live V2 host
          // supplies a revision-bearing handle, never this raw-node branch.
          : artifact && typeof artifact === 'object' && (artifact as { kind?: unknown }).kind === 'block'
            ? artifact as KGNode
            : undefined;
        const certifiedTier = state.tierStates?.certified;
        const certifiedComplete = certifiedTier?.status === 'complete'
          ? new Set(certifiedTier.candidateIds)
          : new Set<string>();
        if (!candidate || !certifiedComplete.has(candidateId) || !block || !input.executeCertifiedBlock || !handle || !handle.isCurrent()) {
          const reason = !candidate
            ? 'CERTIFIED_CANDIDATE_NOT_ADMITTED_TO_SNAPSHOT'
            : !certifiedComplete.has(candidateId)
              ? certifiedTier?.reasonCode ?? 'CERTIFIED_TUPLE_NOT_PROVEN_BY_SNAPSHOT'
              : !handle || !block
                ? 'CERTIFIED_ARTIFACT_NOT_BOUND_TO_SNAPSHOT'
                : !handle.isCurrent()
                ? 'CERTIFIED_ARTIFACT_STALE'
                : 'CERTIFIED_EXECUTOR_UNAVAILABLE';
          observe('run_certified', !candidate || reason === 'CERTIFIED_TUPLE_NOT_PROVEN_BY_SNAPSHOT' ? 'ineligible' : 'unavailable', reason, { candidateIds: candidateId ? [candidateId] : [], tier: 'certified', origin: 'validation' });
          // The certified tool itself just proved it cannot serve this turn.
          // If the tier claim (and with it the narrowed run_certified-only
          // policy) is still standing, holding it can only loop the model
          // into the same denial until the deadline. Release, so the policy
          // recomputes and the semantic/relational ladder becomes reachable.
          if (state.exactCertifiedCandidateId || state.tierStates?.certified?.status === 'complete') {
            releaseAskV2CertifiedTierLock(state, reason);
          }
          return {
            ...denied('run_certified', reason),
            safeNextTools: ['inspect_semantic_candidates', 'compile_and_run_semantic'],
          };
        }
        try {
          if (!handle.isCurrent()) {
            observe('run_certified', 'denied', 'CERTIFIED_ARTIFACT_STALE', { tier: 'certified', candidateIds: [candidateId], origin: 'freeze' });
            return denied('run_certified', 'CERTIFIED_ARTIFACT_STALE');
          }
          const bindings = v2ScalarBindings(args.bindings);
          const repair = args.repair === true;
          const bindingFingerprint = v2ExecutionBindingFingerprint({
            state,
            tier: 'certified',
            candidateIds: [candidateId],
            bindings: { artifactRevision: handle?.revisionFingerprint ?? candidateId, bindings: bindings ?? {} },
          });
          const authorization = authorizeExecution({
            tool: 'run_certified',
            tier: 'certified',
            candidateIds: [candidateId],
            bindingFingerprint,
            planId: `ask-v2:certified:${bindingFingerprint.slice(-24)}`,
            repair,
            ...(handle ? { targetFingerprint: handle.revisionFingerprint } : {}),
          });
          if (!authorization.ok) return denied('run_certified', authorization.reasonCode);
          const result = await input.executeCertifiedBlock(block, { question: input.question, ...(bindings ? { parameters: bindings } : {}) });
          completed = { tier: 'certified', result: { ...result, trustState: 'certified', answerTier: 'certified_block' }, block };
          observe('run_certified', 'executed', 'CERTIFIED_RESULT_VALIDATED', { tier: 'certified', candidateIds: [candidateId], origin: 'execution', planId: state.resolvedPlan?.id });
          return { executed: true, tier: 'certified', rowCount: result.rowCount };
        } catch {
          executionFailure = { reasonCode: 'CERTIFIED_EXECUTION_FAILED', origin: 'execution' };
          observe('run_certified', 'error', executionFailure.reasonCode, { tier: 'certified', candidateIds: [candidateId], origin: 'execution', planId: state.resolvedPlan?.id });
          return denied('run_certified', executionFailure.reasonCode);
        }
      }),
      safeTool('inspect_semantic_candidates', 'Inspect admitted semantic metrics, dimensions, compatibility, and time-grain definitions.', {
        type: 'object', properties: {}, additionalProperties: false,
      }, async () => {
        const candidates = visibleCandidates().filter((candidate) => Boolean(askV2ExecutableSemanticRoles(candidate)));
        const ids = candidates.map(v2CandidateId);
        // Semantic route commitment requires more than a displayed card: one
        // admitted metric must have a current, host-selected compiler target,
        // a compiler, and the generated-SQL executor. Time/dimension cards
        // remain available for context but cannot make a query executable.
        // Do this at inspection time so a provider cannot spend its final
        // controller turn on a semantic route the host cannot actually run.
        const executableMetric = candidates.some((candidate) => {
          const id = v2CandidateId(candidate);
          const handle = workspace?.semanticCapabilities?.get(id);
          return askV2ExecutableSemanticRoles(candidate)?.includes('metric') === true
            && handle?.candidateId === id
            && handle.roles.includes('metric')
            && handle.isCurrent()
            && Boolean(handle.selectedEngine ?? (handle.engines.length === 1 ? handle.engines[0] : undefined));
        });
        const hostExecutionReady = Boolean(input.semanticQueryCompiler && input.executeGeneratedSql);
        const suppliedSemanticState = workspace?.tierStates?.semantic;
        const semanticStatus = ids.length === 0
          ? 'unavailable' as const
          : !hostExecutionReady
            ? 'unavailable' as const
            : suppliedSemanticState?.status === 'ambiguous'
              ? 'ambiguous' as const
              : suppliedSemanticState?.status === 'unavailable' || suppliedSemanticState?.status === 'ineligible'
                ? suppliedSemanticState.status
            : !executableMetric
              ? 'ineligible' as const
              : suppliedSemanticState?.status === 'complete'
                ? 'complete' as const
                : 'available' as const;
        // "No metric is admitted" and "a metric is admitted but no engine can
        // run it" are different facts with different cures — one is a modeling
        // or retrieval gap, the other is a runtime configuration problem — and
        // reporting both as SEMANTIC_ENGINE_UNAVAILABLE sent every reader
        // looking for a broken MetricFlow that was never involved. On a
        // project with no dbt metrics at all, the honest answer is that this
        // snapshot admitted no metric.
        const admittedMetricCard = candidates.some((candidate) =>
          askV2ExecutableSemanticRoles(candidate)?.includes('metric') === true);
        const semanticReasonCode = ids.length === 0
          ? 'SEMANTIC_CANDIDATES_EMPTY'
          : !hostExecutionReady
            ? 'SEMANTIC_EXECUTION_UNAVAILABLE'
            : suppliedSemanticState?.status === 'ambiguous'
              ? suppliedSemanticState.reasonCode
              : suppliedSemanticState?.status === 'unavailable' || suppliedSemanticState?.status === 'ineligible'
                ? suppliedSemanticState.reasonCode
            : !executableMetric
              ? (admittedMetricCard ? 'SEMANTIC_ENGINE_UNAVAILABLE' : 'SEMANTIC_METRICS_NOT_ADMITTED')
              : suppliedSemanticState?.reasonCode ?? 'SEMANTIC_CANDIDATES_AVAILABLE';
        setAskV2TierState(state, 'semantic', {
          status: semanticStatus,
          candidateIds: ids,
          reasonCode: semanticReasonCode,
          ...(semanticStatus === 'ambiguous' && suppliedSemanticState?.clarificationChoices?.length
            ? { clarificationChoices: suppliedSemanticState.clarificationChoices }
            : {}),
          ...(semanticStatus === 'ambiguous' && suppliedSemanticState?.safeNextTools?.length
            ? { safeNextTools: suppliedSemanticState.safeNextTools }
            : {}),
        });
        // A reloaded pre-freeze semantic commitment is not authority when the
        // current host lacks its compiler/executor. Leave the next policy to
        // proceed through the same snapshot's relational/exploratory path.
        if (!hostExecutionReady || !executableMetric || semanticStatus === 'ambiguous'
          || semanticStatus === 'unavailable' || semanticStatus === 'ineligible') {
          if (!state.resolvedPlan?.frozen && state.controllerTier === 'semantic') delete state.controllerTier;
        } else if (!state.controllerTier && (semanticStatus === 'available' || semanticStatus === 'complete')) {
          state.controllerTier = 'semantic';
        }
        observe('inspect_semantic_candidates', semanticStatus === 'available' || semanticStatus === 'complete' ? 'eligible' : semanticStatus, semanticReasonCode, { candidateIds: ids, origin: 'retrieval' });
        const admitted = admittedSemanticIdentifiers();
        return {
          cards: candidates.map((candidate) => v2SafeCard(candidate, workspace)),
          ...(semanticReasonCode === 'SEMANTIC_METRICS_NOT_ADMITTED'
            ? {
              note: 'This snapshot admitted semantic dimensions but no executable metric, so the semantic tier cannot answer.'
                + ' Continue with governed relational or review-required SQL over an admitted relation.',
            }
            : {}),
          // The exact identifiers compile_and_run_semantic accepts, by role.
          // A card's `dimensions` are human labels; these are the IDs.
          ...(admitted ? { admittedIdentifiers: admitted } : {}),
          ...(admitted
            ? { usage: 'Pass metricIds/dimensionIds/timeDimensionId using admittedIdentifiers values verbatim. A card\'s "dimensions" are display labels, not identifiers.' }
            : {}),
        };
      }),
      safeTool('compile_and_run_semantic', 'Compile admitted semantic metric, dimension, time, and filter IDs through the configured MetricFlow/dbt compiler, then execute once. When the question requests day, week, month, quarter, or year, provide both the opaque admitted timeDimensionId and its declared timeGrain.', {
        type: 'object', properties: {
          metricIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
          dimensionIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
          timeDimensionId: { type: 'string', description: 'Required with timeGrain for an explicit time question; use one admitted opaque time-dimension ID.' },
          timeGrain: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'], description: 'Required with timeDimensionId when the question asks for a time grain. It must be declared by that exact admitted time dimension.' },
          filters: { type: 'array', items: { type: 'object', properties: { dimensionId: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] } }, required: ['dimensionId', 'value'], additionalProperties: false }, maxItems: 8 },
          orderBy: { type: 'array', maxItems: 2, items: { type: 'object', properties: { name: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } }, required: ['name', 'direction'], additionalProperties: false }, description: 'Sort for a ranking. Each name must be one of the selected metric/dimension IDs or their runtime names. A limit without an orderBy returns arbitrary rows.' },
          limit: { type: 'integer', minimum: 1, maximum: 10000 }, repair: { type: 'boolean' },
        }, required: ['metricIds'], additionalProperties: false,
      }, async (args) => {
        if (!requireInspections('compile_and_run_semantic', ['inspect_certified_candidates', 'inspect_semantic_candidates'])) return denied('compile_and_run_semantic', 'REQUIRED_TIER_INSPECTION_MISSING');
        const semanticCapabilities = workspace?.semanticCapabilities;
        const semanticCapabilityCollisionIds = new Set(workspace?.semanticCapabilityCollisionIds ?? []);
        const directlyRequestedCollisionIds = [
          ...v2StringArray(args.metricIds, 8),
          ...v2StringArray(args.dimensionIds, 16),
          ...(typeof args.timeDimensionId === 'string' ? [args.timeDimensionId.trim()] : []),
          ...(Array.isArray(args.filters)
            ? args.filters.flatMap((filter) => filter && typeof filter === 'object' && !Array.isArray(filter)
              && typeof (filter as { dimensionId?: unknown }).dimensionId === 'string'
              ? [(filter as { dimensionId: string }).dimensionId.trim()]
              : [])
            : []),
        ].filter((candidateId) => semanticCapabilityCollisionIds.has(candidateId));
        const directlyRequestedBindingMismatches = [
          ...v2StringArray(args.metricIds, 8).map((reference) => ({ reference, role: 'metric' as const })),
          ...v2StringArray(args.dimensionIds, 16).map((reference) => ({ reference, role: 'dimension' as const })),
          ...(typeof args.timeDimensionId === 'string'
            ? [{ reference: args.timeDimensionId.trim(), role: 'time_dimension' as const }]
            : []),
        ].flatMap(({ reference, role }) => visibleCandidates()
          .filter((candidate) => v2CandidateId(candidate) === reference && v2SemanticCandidateMatchesRole(candidate, role))
          .some((candidate) => !v2SemanticCapabilityMatchesCandidate(
            semanticCapabilities?.get(v2CandidateId(candidate)),
            candidate,
            role,
          ))
          ? [reference]
          : []);
        const canonicalSemanticIds = (
          references: readonly string[],
          role: V2SemanticCapabilityRole,
        ): string[] | undefined => {
          const canonical = references.map((reference) => resolveV2SemanticCapabilityReference({
            reference,
            role,
            candidates: visibleCandidates(),
            capabilities: semanticCapabilities,
          }));
          return canonical.every((id): id is string => Boolean(id))
            ? [...new Set(canonical)]
            : undefined;
        };
        const requestedMetricIds = v2StringArray(args.metricIds, 8);
        const requestedDimensionIds = v2StringArray(args.dimensionIds, 16);
        const metricIds = canonicalSemanticIds(requestedMetricIds, 'metric');
        const dimensionIds = canonicalSemanticIds(requestedDimensionIds, 'dimension');
        // Which references failed to resolve, so a refusal can name them.
        // "identifier not admitted" without saying WHICH one leaves the model
        // re-sending the same call, and leaves an operator reading the trace
        // with no idea what was actually wrong.
        const unresolvedReferences = [
          ...(metricIds ? [] : requestedMetricIds.filter((reference) => !resolveV2SemanticCapabilityReference({
            reference, role: 'metric', candidates: visibleCandidates(), capabilities: semanticCapabilities,
          }))),
          ...(dimensionIds ? [] : requestedDimensionIds.filter((reference) => !resolveV2SemanticCapabilityReference({
            reference, role: 'dimension', candidates: visibleCandidates(), capabilities: semanticCapabilities,
          }))),
        ].slice(0, 8);
        const metricsForTime = metricIds
          ? resolveCandidates(metricIds, (candidate) => v2SemanticCandidateMatchesRole(candidate, 'metric'))
          : undefined;
        const metricTimeCompatibility = v2MetricTimeCompatibility(metricsForTime);
        // Compare a metric's declared time-dimension identities with canonical
        // cards and their retained snapshot aliases. This accommodates a
        // migration from legacy leaf IDs without treating runtime/display names
        // as identity or picking one of several model-owned metric_time axes.
        const compatibleTimeResolution = v2MetricCompatibleTimeCandidates({
          metrics: metricsForTime,
          candidates: visibleCandidates(),
        });
        const compatibleTimeCandidates = compatibleTimeResolution.candidates;
        const compatibleTimeCandidateIds = new Set(compatibleTimeCandidates.map(v2CandidateId));
        const timeCandidates = metricTimeCompatibility.constrained
          ? compatibleTimeCandidates
          : visibleCandidates();
        const suppliedTimeReference = typeof args.timeDimensionId === 'string'
          ? args.timeDimensionId.trim()
          : '';
        const allTimeCandidates = visibleCandidates().filter((candidate) => v2SemanticCandidateMatchesRole(candidate, 'time_dimension'));
        const compatibleSemanticTimeCandidates = timeCandidates.filter((candidate) => v2SemanticCandidateMatchesRole(candidate, 'time_dimension'));
        const directTimeCandidate = suppliedTimeReference
          ? allTimeCandidates.find((candidate) => {
              const candidateId = v2CandidateId(candidate);
              return candidateId === suppliedTimeReference
                && v2SemanticCapabilityMatchesCandidate(
                  semanticCapabilities?.get(candidateId),
                  candidate,
                  'time_dimension',
                );
            })
          : undefined;
        // A provider may send a current opaque ID, a backward-compatible
        // legacy opaque alias, or the compiler runtime name. Only the first
        // is globally unique. Once a metric declares more than one compatible
        // time axis, either of the latter must produce a typed ambiguity
        // rather than an arbitrary winner or a generic invalid-ID error.
        const matchingCompatibleTimeCandidates = suppliedTimeReference && !directTimeCandidate
          ? compatibleSemanticTimeCandidates.filter((candidate) => {
              const candidateId = v2CandidateId(candidate);
              const capability = semanticCapabilities?.get(candidateId);
              return v2SemanticCapabilityMatchesCandidate(capability, candidate, 'time_dimension')
                && (
                  (candidate.aliases ?? []).some((alias) => alias === suppliedTimeReference)
                  || normalizeV2SemanticRuntimeName(capability.runtimeName) === normalizeV2SemanticRuntimeName(suppliedTimeReference)
                );
            })
          : [];
        const timeReferenceAmbiguous = new Set(matchingCompatibleTimeCandidates.map(v2CandidateId)).size > 1;
        const timeReferenceIncompatible = Boolean(
          metricTimeCompatibility.constrained
          && suppliedTimeReference
          && ((directTimeCandidate && !compatibleTimeCandidateIds.has(v2CandidateId(directTimeCandidate)))
            || (!directTimeCandidate
              && allTimeCandidates.some((candidate) => {
                const candidateId = v2CandidateId(candidate);
                const capability = semanticCapabilities?.get(candidateId);
                return v2SemanticCapabilityMatchesCandidate(capability, candidate, 'time_dimension')
                  && normalizeV2SemanticRuntimeName(capability.runtimeName) === normalizeV2SemanticRuntimeName(suppliedTimeReference);
              })
              && matchingCompatibleTimeCandidates.length === 0)),
        );
        const explicitTimeRequirement = v2ExplicitTimeRequirement(input.question);
        let timeDimensionIdForValidation: unknown = args.timeDimensionId;
        let timeGrainForValidation: unknown = args.timeGrain;
        let timeBindingCompletion:
          | {
              timeId: string;
              timeGrain: string;
              inputFingerprint: string;
              outputFingerprint: string;
            }
          | undefined;
        let timeBindingCompletionFailure:
          | { outcome: 'ineligible' | 'unavailable' | 'ambiguous'; reasonCode: string }
          | undefined;
        const fiscalCalendar = explicitTimeRequirement.requiresDeclaredFiscalCalendar
          ? workspace?.fiscalCalendar
          : undefined;
        const hasDeclaredFiscalCalendar = Boolean(
          fiscalCalendar?.id?.trim()
          && fiscalCalendar.fiscalPeriodFieldId?.trim()
          && fiscalCalendar.dateRoleId?.trim()
          && explicitTimeRequirement.fiscalPeriod,
        );
        const recordTimeBindingCompletion = (input: {
          timeId: string;
          timeGrain: string;
          reason: 'explicit_question_time_axis' | 'explicit_question_time_grain';
        }) => {
          const inputFingerprint = v2ExecutionBindingFingerprint({
            state,
            tier: 'semantic',
            candidateIds: metricIds ?? [],
            bindings: {
              metricIds: metricIds ?? [],
              dimensionIds: dimensionIds ?? [],
              timeDimensionId: typeof args.timeDimensionId === 'string' ? args.timeDimensionId.trim() : '',
              timeGrain: typeof args.timeGrain === 'string' ? args.timeGrain.trim() : '',
              reason: input.reason,
            },
          });
          const outputFingerprint = v2ExecutionBindingFingerprint({
            state,
            tier: 'semantic',
            candidateIds: [...(metricIds ?? []), input.timeId],
            bindings: {
              metricIds: metricIds ?? [],
              dimensionIds: dimensionIds ?? [],
              timeDimensionId: input.timeId,
              timeGrain: input.timeGrain,
              reason: input.reason,
            },
          });
          semanticArgumentCompletionCount += 1;
          timeDimensionIdForValidation = input.timeId;
          timeGrainForValidation = input.timeGrain;
          timeBindingCompletion = { ...input, inputFingerprint, outputFingerprint };
        };
        // The current question is the only authority for this recovery. Do
        // not repair a malformed/invented time argument, infer a fiscal
        // calendar, or fill a general dimension/entity role. A full omitted
        // axis can be selected only when every chosen metric declares the
        // same admitted compatibility closure. A provider-selected opaque
        // axis is different: its omitted grain may be mechanically supplied
        // from the immutable question, never from declaredGrains[0].
        if (explicitTimeRequirement.requiresDeclaredFiscalCalendar && !hasDeclaredFiscalCalendar) {
          timeBindingCompletionFailure = {
            outcome: 'unavailable',
            reasonCode: 'SEMANTIC_FISCAL_CALENDAR_REQUIRED',
          };
        } else if (!suppliedTimeReference && explicitTimeRequirement.grain) {
          const suppliedGrain = typeof args.timeGrain === 'string'
            ? args.timeGrain.trim().toLowerCase()
            : undefined;
          // When an immutable question explicitly says "by month", a
          // controller-supplied different grain is not a harmless default.
          // Report the conflict before considering an otherwise-unique axis.
          if (suppliedGrain && suppliedGrain !== explicitTimeRequirement.grain) {
            timeBindingCompletionFailure = {
              outcome: 'ineligible',
              reasonCode: 'SEMANTIC_TIME_GRAIN_MISMATCH',
            };
          } else if (args.timeGrain !== undefined && !suppliedGrain) {
            // Leave malformed non-string/empty values to the canonical
            // normalizer below, rather than treating them as an omitted axis.
          } else if (!compatibleTimeResolution.allMetricsDeclareTimeDimensions) {
            timeBindingCompletionFailure = {
              outcome: 'ineligible',
              reasonCode: 'SEMANTIC_TIME_DIMENSION_COMPATIBILITY_UNDECLARED',
            };
          } else {
            const candidatesById = new Map<string, AgentEvidenceCandidate>();
            for (const candidate of compatibleSemanticTimeCandidates) {
              const candidateId = v2CandidateId(candidate);
              const capability = semanticCapabilities?.get(candidateId);
              const matchingGrain = (candidate.timeGrains ?? []).find((grain) => (
                grain.trim().toLowerCase() === explicitTimeRequirement.grain
              ));
              if (matchingGrain
                && v2SemanticCapabilityMatchesCandidate(capability, candidate, 'time_dimension')) {
                candidatesById.set(candidateId, candidate);
              }
            }
            const completionCandidates = [...candidatesById.values()];
            if (completionCandidates.length === 1) {
              if (semanticArgumentCompletionCount === 0) {
                const completedTime = completionCandidates[0]!;
                const timeId = v2CandidateId(completedTime);
                const timeGrain = (completedTime.timeGrains ?? []).find((grain) => (
                  grain.trim().toLowerCase() === explicitTimeRequirement.grain
                ))!;
                recordTimeBindingCompletion({ timeId, timeGrain, reason: 'explicit_question_time_axis' });
              } else {
                timeBindingCompletionFailure = {
                  outcome: 'unavailable',
                  reasonCode: 'SEMANTIC_TIME_BINDING_COMPLETION_EXHAUSTED',
                };
              }
            } else {
              timeBindingCompletionFailure = completionCandidates.length === 0
                ? { outcome: 'unavailable', reasonCode: 'SEMANTIC_TIME_DIMENSION_UNAVAILABLE' }
                : { outcome: 'ambiguous', reasonCode: 'SEMANTIC_TIME_DIMENSION_AMBIGUOUS' };
            }
          }
        } else if (suppliedTimeReference && args.timeGrain === undefined && explicitTimeRequirement.grain) {
          const canonicalTimeId = resolveV2SemanticCapabilityReference({
            reference: suppliedTimeReference,
            role: 'time_dimension',
            candidates: timeCandidates,
            capabilities: semanticCapabilities,
          });
          const selectedTime = canonicalTimeId
            ? resolveCandidates([canonicalTimeId], (candidate) => v2SemanticCandidateMatchesRole(candidate, 'time_dimension'))?.[0]
            : undefined;
          const requiredGrain = selectedTime?.timeGrains?.find((grain) => (
            grain.trim().toLowerCase() === explicitTimeRequirement.grain
          ));
          if (!selectedTime || !requiredGrain) {
            timeBindingCompletionFailure = {
              outcome: 'ineligible',
              reasonCode: 'SEMANTIC_TIME_GRAIN_NOT_DECLARED',
            };
          } else if (semanticArgumentCompletionCount === 0) {
            recordTimeBindingCompletion({
              timeId: canonicalTimeId!,
              timeGrain: requiredGrain,
              reason: 'explicit_question_time_grain',
            });
          } else {
            timeBindingCompletionFailure = {
              outcome: 'unavailable',
              reasonCode: 'SEMANTIC_TIME_BINDING_COMPLETION_EXHAUSTED',
            };
          }
        }
        const fiscalDateRoleId = hasDeclaredFiscalCalendar && fiscalCalendar?.dateRoleId
          ? resolveV2SemanticCapabilityReference({
            reference: fiscalCalendar.dateRoleId,
            role: 'time_dimension',
            candidates: allTimeCandidates,
            capabilities: semanticCapabilities,
          })
          : undefined;
        const fiscalPeriodFieldId = hasDeclaredFiscalCalendar && fiscalCalendar?.fiscalPeriodFieldId
          ? resolveV2SemanticCapabilityReference({
            reference: fiscalCalendar.fiscalPeriodFieldId,
            role: 'filter_dimension',
            candidates: visibleCandidates(),
            capabilities: semanticCapabilities,
          })
          : undefined;
        const fiscalPeriod = explicitTimeRequirement.fiscalPeriod?.trim().toUpperCase();
        const normalizedFilters = normalizeV2SemanticFilters(args.filters);
        // Filter references cross the provider boundary in multiple safe
        // representations (current opaque ID, legacy opaque alias, and a
        // unique compiler runtime name). Resolve every reference to the
        // immutable capability identity before deciding whether it is unique.
        // Raw-string dedupe would let two spellings of the same fiscal field
        // through with contradictory values and freeze an ambiguous plan.
        const canonicalFilterResolution: (
          | { ok: true; filters: Array<{ dimensionId: string; value: string | number | boolean }> }
          | { ok: false; reasonCode: 'SEMANTIC_FILTERS_INVALID' | 'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT' }
        ) = !normalizedFilters.ok
          ? { ok: false, reasonCode: normalizedFilters.reasonCode }
          : (() => {
              const filters: Array<{ dimensionId: string; value: string | number | boolean }> = [];
              const seenCanonicalIds = new Set<string>();
              for (const filter of normalizedFilters.filters) {
                const dimensionId = resolveV2SemanticCapabilityReference({
                  reference: filter.dimensionId,
                  role: 'filter_dimension',
                  candidates: visibleCandidates(),
                  capabilities: semanticCapabilities,
                });
                if (!dimensionId) {
                  return { ok: false as const, reasonCode: 'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT' as const };
                }
                // Duplicate canonical filter bindings are never harmless:
                // their order/value is provider-controlled and the compiler
                // could interpret them differently. Reject even identical
                // values rather than selecting one at random.
                if (seenCanonicalIds.has(dimensionId)) {
                  return { ok: false as const, reasonCode: 'SEMANTIC_FILTERS_INVALID' as const };
                }
                seenCanonicalIds.add(dimensionId);
                filters.push({ ...filter, dimensionId });
              }
              return { ok: true as const, filters };
            })();
        const semanticFilters = canonicalFilterResolution.ok
          ? canonicalFilterResolution.filters
          : [];
        const filtersBound = normalizedFilters.ok && canonicalFilterResolution.ok;
        const filterIds = semanticFilters.map((filter) => filter.dimensionId);
        const normalizedTime = normalizeV2SemanticTimeBinding({
          timeDimensionId: timeDimensionIdForValidation,
          timeGrain: timeGrainForValidation,
          ...(explicitTimeRequirement.grain ? { requiredTimeGrain: explicitTimeRequirement.grain } : {}),
          resolveTimeCandidate: (id) => {
            const candidateId = resolveV2SemanticCapabilityReference({
              reference: id,
              role: 'time_dimension',
              candidates: timeCandidates,
              capabilities: semanticCapabilities,
            });
            return candidateId
              ? resolveCandidates([candidateId], (candidate) => (candidate.timeGrains?.length ?? 0) > 0)?.[0]
              : undefined;
          },
        });
        const timeId = normalizedTime.ok ? normalizedTime.timeId : undefined;
        const time = normalizedTime.ok ? normalizedTime.time : undefined;
        // Fiscal tokens are executable only when this same snapshot declared
        // the calendar, its date role, and its period field, and the selected
        // compiler filter binds that exact fiscal value. Passing a valid
        // ordinary time axis must never bypass this guard.
        const fiscalPeriodFilters = fiscalPeriodFieldId
          ? semanticFilters.filter((filter) => filter.dimensionId === fiscalPeriodFieldId)
          : [];
        const fiscalFilterBound = Boolean(
          fiscalPeriodFieldId
          && fiscalPeriod
          && fiscalPeriodFilters.length === 1
          && String(fiscalPeriodFilters[0]!.value).trim().toUpperCase() === fiscalPeriod,
        );
        const fiscalBindingCandidateIds = explicitTimeRequirement.requiresDeclaredFiscalCalendar
          ? [fiscalDateRoleId, fiscalPeriodFieldId].filter((id): id is string => Boolean(id))
          : [];
        const semanticCandidateIds = [
          ...(metricIds ?? []),
          ...(dimensionIds ?? []),
          ...(timeId ? [timeId] : []),
          ...filterIds,
          ...fiscalBindingCandidateIds,
        ];
        const semanticPreFreeze = (
          outcome: 'ineligible' | 'unavailable' | 'ambiguous',
          reasonCode: string,
          candidateIds = semanticCandidateIds,
          safeNextTools: AskToolNameV2[] = [],
        ) => {
          setAskV2TierState(state, 'semantic', {
            status: outcome,
            candidateIds: [...new Set(candidateIds)].filter((id) => state.retainedCandidateIds.includes(id)),
            reasonCode,
            ...(safeNextTools.length ? { safeNextTools } : {}),
          });
          // A same-tier correction remains a controller commitment. A true
          // unavailable/ineligible semantic capability releases the
          // pre-freeze route so the normal cascade can continue; it never
          // freezes or silently executes a lower tier.
          if (state.controllerTier === 'semantic'
            && !safeNextTools.includes('compile_and_run_semantic')
            && !safeNextTools.includes('request_clarification')) {
            state.controllerTier = undefined;
          }
          observe('compile_and_run_semantic', outcome, reasonCode, {
            tier: 'semantic',
            ...(unresolvedReferences.length ? { rejectedIdentifiers: unresolvedReferences } : {}),
            // What WAS admitted for the role that failed. An operator reading
            // a refusal needs to see the set the reference was matched
            // against, or "not admitted" is unfalsifiable.
            ...(unresolvedReferences.length
              ? { admittedDimensionIds: (admittedSemanticIdentifiers()?.dimension ?? []).slice(0, 8) }
              : {}),
            candidateIds,
            origin: 'validation',
            ...(safeNextTools.length ? { safeAction: `use:${safeNextTools.join(',')}` } : {}),
          });
          // Name the identifiers that WOULD be accepted.
          //
          // A bare "identifier not admitted" refusal is unactionable: the
          // model has just been shown metric cards whose `dimensions` are
          // display names, and is required to answer in admitted candidate
          // IDs. Told only that its choice was wrong, it cannot do better on
          // the next turn, so it burns the dispatch budget guessing or gives
          // up and reports a modeling gap that does not exist. The host knows
          // the admitted set; withholding it serves no safety purpose,
          // because these are exactly the IDs it already agreed to accept.
          const admissible = reasonCode === 'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT'
            || reasonCode === 'SEMANTIC_FILTERS_INVALID'
            || reasonCode.startsWith('SEMANTIC_TIME_')
            ? admittedSemanticIdentifiers()
            : undefined;
          return {
            ...denied('compile_and_run_semantic', reasonCode, safeNextTools),
            ...(admissible ? { admittedIdentifiers: admissible } : {}),
            // A bare "filters invalid" is equally unactionable: the model has
            // no way to know it sent the wrong SHAPE. Spell the contract out
            // once and the next call can be the corrected one instead of a
            // surrender to finish_answer.
            ...(reasonCode === 'SEMANTIC_FILTERS_INVALID' ? {
              usage: 'filters must be an array (max 8) of {"dimensionId": "<admitted dimension id>", "value": <string|number|boolean>} — one entry per dimension, no operator/values keys. Take dimensionId from admittedIdentifiers verbatim.',
            } : {}),
            // A time axis is only usable together with a grain it declares,
            // so naming the axis without its grains just moves the refusal.
            ...(admissible
              ? {
                admittedTimeDimensions: visibleCandidates()
                  .filter((candidate) => v2SemanticCandidateMatchesRole(candidate, 'time_dimension'))
                  .slice(0, 8)
                  .map((candidate) => ({
                    id: v2CandidateId(candidate),
                    timeGrains: (candidate.timeGrains ?? []).slice(0, 8),
                  })),
              }
              : {}),
            ...(admissible && unresolvedReferences.length
              ? {
                rejectedIdentifiers: unresolvedReferences,
                usage: 'Re-send compile_and_run_semantic using values from admittedIdentifiers verbatim.'
                  + ' The rejectedIdentifiers above are not identifiers this snapshot admits.',
              }
              : {}),
          };
        };
        if (directlyRequestedCollisionIds.length > 0) {
          return semanticPreFreeze('unavailable', 'SEMANTIC_CAPABILITY_ID_COLLISION', directlyRequestedCollisionIds);
        }
        if (directlyRequestedBindingMismatches.length > 0) {
          return semanticPreFreeze('ineligible', 'SEMANTIC_CAPABILITY_NOT_BOUND_OR_STALE', directlyRequestedBindingMismatches);
        }
        if (!normalizedFilters.ok) return semanticPreFreeze('ineligible', normalizedFilters.reasonCode);
        if (!canonicalFilterResolution.ok) {
          // A fiscal request has a stricter immutable binding contract. Once
          // calendar metadata is declared, a filter that fails canonical
          // admission or uniqueness is not generic missing context; it is an
          // invalid fiscal-period binding and must not reach the compiler.
          return semanticPreFreeze(
            'ineligible',
            explicitTimeRequirement.requiresDeclaredFiscalCalendar && hasDeclaredFiscalCalendar
              ? 'SEMANTIC_FISCAL_FILTER_INVALID'
              : canonicalFilterResolution.reasonCode,
            metricIds ?? [],
            ['compile_and_run_semantic'],
          );
        }
        if (explicitTimeRequirement.requiresDeclaredFiscalCalendar
          && hasDeclaredFiscalCalendar
          && !fiscalFilterBound) {
          return semanticPreFreeze(
            'ineligible',
            'SEMANTIC_FISCAL_FILTER_INVALID',
            [...new Set([...semanticCandidateIds, ...(metricIds ?? [])])],
            ['compile_and_run_semantic'],
          );
        }
        // A mis-specified identifier is a MALFORMED REQUEST, not proof that
        // this tier cannot serve the question. Closing the semantic tier here
        // meant one wrong argument permanently removed the only path that
        // could have answered — the model was handed the admitted IDs and
        // then forbidden from using them. Keep the tier open for one
        // corrected call; the identifiers themselves are still validated.
        if (!filtersBound || !metricIds || !dimensionIds) {
          return semanticPreFreeze(
            'ineligible',
            'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT',
            semanticCandidateIds,
            ['compile_and_run_semantic'],
          );
        }
        if (timeBindingCompletionFailure) {
          return semanticPreFreeze(
            timeBindingCompletionFailure.outcome,
            timeBindingCompletionFailure.reasonCode,
            metricIds ?? [],
            ['compile_and_run_semantic'],
          );
        }
        if (timeBindingCompletion) {
          // This records the host-only, one-shot binding correction in V8
          // without charging it as a second model tool call or freezing a
          // plan. The later authorization still binds the exact completed
          // opaque ID and declared grain before compiler execution.
          observe('compile_and_run_semantic', 'eligible', 'SEMANTIC_TIME_BINDING_COMPLETED', {
            tier: 'semantic',
            candidateIds: [...(metricIds ?? []), timeBindingCompletion.timeId],
            origin: 'validation',
            inputFingerprint: timeBindingCompletion.inputFingerprint,
            outputFingerprint: timeBindingCompletion.outputFingerprint,
            safeAction: 'host_completed_explicit_time_binding',
          });
        }
        if (timeReferenceAmbiguous) return semanticPreFreeze('ambiguous', 'SEMANTIC_TIME_DIMENSION_AMBIGUOUS', metricIds);
        if (timeReferenceIncompatible) return semanticPreFreeze('ineligible', 'SEMANTIC_TIME_DIMENSION_INCOMPATIBLE', metricIds);
        // A time refusal must say which time axes ARE bindable and at what
        // grain. Told only that its choice was invalid, the model re-sends a
        // different guess and the turn dies on budget with the query never
        // attempted — even though a valid axis was sitting in the snapshot.
        // For a WINDOW-ONLY requirement (no grain grouping asked), the model's
        // time args are advisory: the axis exists to carry the host's window
        // filter, and the host can complete that binding itself. Refusing on a
        // mis-spelled axis here sent every such turn into an invalid-axis
        // retry loop — the model kept "helpfully" naming time axes for a
        // question that never asked it to. Ignore the bad args, record that,
        // and let host completion pick the sole metric-declared axis below.
        const windowOnlyTimeArgsIgnored = !normalizedTime.ok
          && Boolean(explicitTimeRequirement.window)
          && !explicitTimeRequirement.grain;
        if (windowOnlyTimeArgsIgnored) {
          observe('compile_and_run_semantic', 'eligible', 'SEMANTIC_TIME_ARGS_IGNORED_FOR_WINDOW', {
            tier: 'semantic', candidateIds: semanticCandidateIds, origin: 'validation',
          });
        }
        if (!normalizedTime.ok && !windowOnlyTimeArgsIgnored) {
          // Offer a same-tier correction ONCE. The host now hands back the
          // admitted axes with their declared grains, so a first miss is
          // genuinely fixable — but a second identical failure means this
          // metric has no time axis the request can bind, and repeating the
          // call just spends the budget the lower tiers needed. After that,
          // send the analyst down the ladder.
          const alreadyFailedOnTime = state.observations.some((observation) => (
            observation.tool === 'compile_and_run_semantic'
            && typeof observation.reasonCode === 'string'
            && observation.reasonCode.startsWith('SEMANTIC_TIME_')
          ));
          return semanticPreFreeze(
            'ineligible',
            normalizedTime.reasonCode,
            semanticCandidateIds,
            alreadyFailedOnTime ? ['inspect_relational_context'] : ['compile_and_run_semantic'],
          );
        }
        if (explicitTimeRequirement.requiresDeclaredFiscalCalendar && (
          !hasDeclaredFiscalCalendar
          || !fiscalDateRoleId
          || !fiscalPeriodFieldId
          || !fiscalFilterBound
          || (timeId !== undefined && timeId !== fiscalDateRoleId)
        )) {
          return semanticPreFreeze(
            'unavailable',
            'SEMANTIC_FISCAL_CALENDAR_REQUIRED',
            [...new Set([...semanticCandidateIds, ...(metricIds ?? [])])],
            ['compile_and_run_semantic'],
          );
        }
        if (semanticCandidateIds.some((candidateId) => semanticCapabilityCollisionIds.has(candidateId))) {
          return semanticPreFreeze('unavailable', 'SEMANTIC_CAPABILITY_ID_COLLISION');
        }
        const metrics = metricsForTime;
        const dimensions = dimensionIds.length === 0 ? [] : resolveCandidates(dimensionIds, (candidate) => v2SemanticCandidateMatchesRole(candidate, 'dimension'));
        const filterCandidates = filterIds.length ? resolveCandidates(filterIds, (candidate) => v2SemanticCandidateMatchesRole(candidate, 'filter_dimension')) : [];
        if (!metrics || !dimensions || (timeId && !time) || !filterCandidates) {
          return semanticPreFreeze(
            'ineligible',
            'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT',
            semanticCandidateIds,
            ['compile_and_run_semantic'],
          );
        }
        if (!input.semanticQueryCompiler || !input.executeGeneratedSql) {
          return semanticPreFreeze('unavailable', 'SEMANTIC_EXECUTION_UNAVAILABLE');
        }
        // The provider selects opaque evidence IDs.  The real compiler must
        // never receive those IDs as authored MetricFlow/dbt field names: it
        // resolves them through the immutable capability captured with this
        // retrieval snapshot.  That keeps admission/receipts opaque while
        // letting the live compiler operate on its actual runtime names.
        const capabilities = semanticCapabilities;
        const resolveCapabilities = (
          ids: readonly string[],
          role: 'metric' | 'dimension' | 'time_dimension' | 'filter_dimension',
        ) => {
          if (!capabilities) return undefined;
          const handles = ids.map((id) => capabilities.get(id));
          const candidateFingerprints = ids.map((id) => new Set(
            visibleCandidates()
              .filter((candidate) => v2CandidateId(candidate) === id && v2SemanticCandidateMatchesRole(candidate, role))
              .map(askV2SemanticCandidateAuthorityFingerprint),
          ));
          if (handles.some((handle, index) => (
            !handle
            || handle.candidateId !== ids[index]
            || !handle.roles.includes(role)
            || !handle.isCurrent()
            || candidateFingerprints[index]!.size !== 1
            || !candidateFingerprints[index]!.has(handle.fingerprint)
          ))) return undefined;
          return handles as NonNullable<typeof handles[number]>[];
        };
        const metricCapabilities = resolveCapabilities(metricIds, 'metric');
        const dimensionCapabilities = resolveCapabilities(dimensionIds, 'dimension');
        const timeCapabilities = timeId ? resolveCapabilities([timeId], 'time_dimension') : [];
        const fiscalDateRoleCapabilities = fiscalDateRoleId
          ? resolveCapabilities([fiscalDateRoleId], 'time_dimension')
          : [];
        const filterCapabilities = resolveCapabilities(filterIds, 'filter_dimension');
        if (!metricCapabilities || !dimensionCapabilities || !timeCapabilities || !filterCapabilities
          || (explicitTimeRequirement.requiresDeclaredFiscalCalendar && !fiscalDateRoleCapabilities)) {
          return semanticPreFreeze('ineligible', 'SEMANTIC_CAPABILITY_NOT_BOUND_OR_STALE');
        }
        const fiscalDateRoleCapabilityHandles = fiscalDateRoleCapabilities ?? [];
        const resolvedEngine = selectV2SemanticEngine({ metricCapabilities });
        if (!resolvedEngine.ok) {
          return semanticPreFreeze(
            resolvedEngine.outcome,
            resolvedEngine.reasonCode,
            semanticCandidateIds,
          );
        }
        const semanticEngine = resolvedEngine.engine;
        // The native composer cannot join another model to apply a member
        // filter — and, worse, it used to DROP the filter silently and ship
        // the grand total as the member's number. Refuse BEFORE the plan
        // freezes so the exploratory tier (which can express the join)
        // remains reachable. MetricFlow handles cross-model filters itself.
        if (semanticEngine === 'native' && semanticFilters.length > 0) {
          const metricModels = new Set((resolveCandidates(metricIds ?? [], (candidate) =>
            v2SemanticCandidateMatchesRole(candidate, 'metric')) ?? [])
            .map((candidate) => (candidate.semanticModel ?? '').toLowerCase())
            .filter(Boolean));
          const crossModelFilterIds = (resolveCandidates(filterIds, (candidate) =>
            v2SemanticCandidateMatchesRole(candidate, 'filter_dimension')) ?? [])
            .filter((candidate) => {
              const model = (candidate.semanticModel ?? '').toLowerCase();
              return model && metricModels.size > 0 && !metricModels.has(model);
            })
            .map((candidate) => v2CandidateId(candidate));
          if (crossModelFilterIds.length > 0) {
            return {
              ...semanticPreFreeze('ineligible', 'SEMANTIC_FILTER_ENGINE_UNSUPPORTED', crossModelFilterIds, ['validate_and_run_sql']),
              usage: 'The native semantic engine cannot apply a filter from another model. Express this member filter through governed SQL (validate_and_run_sql) instead; the query was not compiled.',
            };
          }
        }
        // Older text/native transcripts can still send an `engine` field from
        // the pre-V2 contract. It is intentionally ignored: the immutable
        // capability above has already selected the only host-approved engine.
        // Do not turn a stale provider argument into a second semantic retry.
        state.semanticRuntime = {
          version: 1,
          preference: workspace?.semanticRuntime?.preference ?? 'auto',
          selectedEngine: semanticEngine,
          readiness: 'ready',
        };
        const selectedCandidateIds = semanticCandidateIds;
        const bindingFingerprint = v2ExecutionBindingFingerprint({
          state,
          tier: 'semantic',
          candidateIds: selectedCandidateIds,
          bindings: {
            metricIds,
            dimensionIds,
            timeDimensionId: timeId ?? '',
            timeGrain: (normalizedTime.ok ? normalizedTime.timeGrain : undefined) ?? '',
            ...(explicitTimeRequirement.requiresDeclaredFiscalCalendar ? {
              fiscalCalendar: {
                id: fiscalCalendar!.id,
                dateRoleId: fiscalDateRoleId!,
                fiscalPeriodFieldId: fiscalPeriodFieldId!,
                fiscalPeriod: fiscalPeriod!,
              },
            } : {}),
            engine: semanticEngine ?? '',
            filters: semanticFilters,
            limit: typeof args.limit === 'number' ? args.limit : null,
            capabilityFingerprints: [
              ...metricCapabilities,
              ...dimensionCapabilities,
              ...timeCapabilities,
              ...fiscalDateRoleCapabilityHandles,
              ...filterCapabilities,
            ].map((handle) => handle.fingerprint),
          },
        });
        const repair = args.repair === true;
        const authorization = authorizeExecution({
          tool: 'compile_and_run_semantic',
          tier: 'semantic',
          candidateIds: selectedCandidateIds,
          bindingFingerprint,
          planId: `ask-v2:semantic:${bindingFingerprint.slice(-24)}`,
          repair,
        });
        if (!authorization.ok) return denied('compile_and_run_semantic', authorization.reasonCode);
        // An orderBy may reference only fields this very call selected. Every
        // top-N through this tool used to be an UNORDERED LIMIT — the schema
        // had no way to express a sort, so "top customers by revenue" ran as
        // a row lottery. Resolution accepts the admitted opaque ID or the
        // capability's runtime name; anything else is a typed denial rather
        // than silently unsorted output.
        const requestedOrderBy = Array.isArray(args.orderBy) ? args.orderBy.slice(0, 2) : [];
        const selectedForOrder = [...metricCapabilities, ...dimensionCapabilities, ...timeCapabilities];
        const resolvedOrderBy: Array<{ name: string; direction: 'asc' | 'desc' }> = [];
        for (const entry of requestedOrderBy) {
          if (!entry || typeof entry !== 'object') continue;
          const rawName = typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name.trim() : '';
          const direction = (entry as { direction?: unknown }).direction === 'asc' ? 'asc' as const : 'desc' as const;
          const matched = selectedForOrder.find((handle) =>
            handle.runtimeName === rawName || handle.candidateId === rawName);
          if (!matched) {
            observe('compile_and_run_semantic', 'ineligible', 'SEMANTIC_ORDER_FIELD_NOT_SELECTED', {
              tier: 'semantic', candidateIds: selectedCandidateIds, origin: 'validation',
              safeAction: 'use:compile_and_run_semantic',
            });
            return {
              ...denied('compile_and_run_semantic', 'SEMANTIC_ORDER_FIELD_NOT_SELECTED', ['compile_and_run_semantic']),
              usage: 'orderBy names must come from the metricIds/dimensionIds selected in this same call.',
            };
          }
          resolvedOrderBy.push({ name: matched.runtimeName, direction });
        }
        // A required WINDOW needs a bound time axis, and its concrete date
        // values are computed by the HOST — the analyst binds which axis,
        // never the dates. Without this, "last two months" could compile as
        // an unfiltered all-time query and no gate would know.
        const requiredWindow = explicitTimeRequirement.window;
        const windowBounds = requiredWindow
          ? resolvePlanTimeRange(requiredWindow.expression, new Date())
          : undefined;
        // A window-only requirement needs an axis to FILTER on, not to group
        // by — and the metric itself declares its time axes. When exactly one
        // compatible axis exists, the host completes the binding: demanding
        // that the model name an axis the question never mentioned only fed
        // the grain/dimension-invalid retry loop until the budget died.
        const hostCompletedWindowAxis = requiredWindow && windowBounds
          && timeCapabilities.length === 0
          && !explicitTimeRequirement.grain
          ? (() => {
            const axes = compatibleTimeResolution.candidates;
            // One compatible axis: no decision exists. Several: the metric's
            // OWN capability contract may declare which axis is its default —
            // authored snapshot metadata, not a guess. Only when the authored
            // declarations also leave more than one does this stay a real
            // choice for the analyst.
            const declaredAxisIds = new Set((metricsForTime ?? []).flatMap((candidate) =>
              (candidate.analyticalCapability?.timeDimensions ?? [])
                .map((axis) => axis.dimensionId?.trim())
                .filter((id): id is string => Boolean(id))));
            let narrowed = axes.length === 1
              ? axes
              : axes.filter((axis) => declaredAxisIds.has(v2CandidateId(axis)));
            // A metric commonly declares BOTH its physical axis (ordered_at)
            // and MetricFlow's canonical aggregation-time alias (metric_time).
            // These are the SAME axis for a plain window filter, so preferring
            // the declared default — and failing that, metric_time itself,
            // which MetricFlow defines as "the metric's own aggregation time"
            // and accepts unqualified — is adapter semantics, not a guess.
            if (narrowed.length > 1) {
              const defaultAxisIds = new Set((metricsForTime ?? []).flatMap((candidate) =>
                (candidate.analyticalCapability?.timeDimensions ?? [])
                  .filter((axis) => (axis.defaultFor?.length ?? 0) > 0)
                  .map((axis) => axis.dimensionId?.trim())
                  .filter((id): id is string => Boolean(id))));
              const preferred = narrowed.filter((axis) => defaultAxisIds.has(v2CandidateId(axis)));
              if (preferred.length >= 1) narrowed = preferred;
            }
            if (narrowed.length > 1) {
              const metricTime = narrowed.filter((axis) => (
                ((v2CandidateId(axis).split(':').pop() ?? '').split('.').pop() ?? '') === 'metric_time'
              ));
              if (metricTime.length === 1) narrowed = metricTime;
            }
            if (narrowed.length !== 1) return undefined;
            const axisId = v2CandidateId(narrowed[0]!);
            const handle = semanticCapabilities?.get(axisId);
            return handle && handle.candidateId === axisId && handle.isCurrent() ? handle : undefined;
          })()
          : undefined;
        if (hostCompletedWindowAxis) {
          observe('compile_and_run_semantic', 'eligible', 'SEMANTIC_TIME_WINDOW_HOST_COMPLETED', {
            tier: 'semantic', candidateIds: [hostCompletedWindowAxis.candidateId], origin: 'validation',
          });
        }
        if (requiredWindow && windowBounds && timeCapabilities.length === 0 && !hostCompletedWindowAxis) {
          observe('compile_and_run_semantic', 'ineligible', 'SEMANTIC_TIME_WINDOW_UNBOUND', {
            tier: 'semantic', candidateIds: selectedCandidateIds, origin: 'validation',
            safeAction: 'use:compile_and_run_semantic',
          });
          const admitted = admittedSemanticIdentifiers();
          return {
            ...denied('compile_and_run_semantic', 'SEMANTIC_TIME_WINDOW_UNBOUND', ['compile_and_run_semantic']),
            usage: `The question restricts results to "${requiredWindow.expression}". Re-send with a timeDimensionId (and its declared timeGrain) so the host can apply that window.`,
            ...(admitted ? { admittedIdentifiers: admitted } : {}),
            admittedTimeDimensions: visibleCandidates()
              .filter((candidate) => v2SemanticCandidateMatchesRole(candidate, 'time_dimension'))
              .slice(0, 8)
              .map((candidate) => ({
                id: v2CandidateId(candidate),
                timeGrains: (candidate.timeGrains ?? []).slice(0, 8),
              })),
          };
        }
        const windowAxisRuntimeName = timeCapabilities.length > 0
          ? timeCapabilities[0]!.runtimeName
          : hostCompletedWindowAxis?.runtimeName;
        const windowFilters = requiredWindow && windowBounds && windowAxisRuntimeName
          ? [
            { dimension: windowAxisRuntimeName, operator: 'gte', values: [windowBounds.startInclusive.slice(0, 10)] },
            { dimension: windowAxisRuntimeName, operator: 'lt', values: [windowBounds.endExclusive.slice(0, 10)] },
          ]
          : [];
        const selection = {
          metrics: metricCapabilities.map((handle) => handle.runtimeName),
          ...(semanticEngine ? { engine: semanticEngine } : {}),
          ...(dimensionCapabilities.length ? { dimensions: dimensionCapabilities.map((handle) => handle.runtimeName) } : {}),
          ...(timeCapabilities.length ? {
            timeDimension: {
              name: timeCapabilities[0]!.runtimeName,
              granularity: (normalizedTime.ok ? normalizedTime.timeGrain : undefined)!,
            },
          } : {}),
          ...(filterCapabilities.length || windowFilters.length ? {
            filters: [
              ...filterCapabilities.map((handle, index) => ({
                dimension: handle.runtimeName,
                operator: '=',
                values: [String(semanticFilters[index]!.value)],
              })),
              // Host-owned window bounds; provider input cannot supply these.
              ...windowFilters,
            ],
          } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(resolvedOrderBy.length ? { orderBy: resolvedOrderBy } : {}),
        };
        try {
          const compiled = await input.semanticQueryCompiler(selection);
          // The compiler is not an authority to switch adapters. The host
          // froze `semanticEngine` from the project preference and the
          // snapshot-bound capability before compilation; executing SQL that
          // reports a different engine would silently cross that frozen
          // target. This is a terminal execution-boundary incident, not a
          // pre-freeze engine observation and not a same-plan repair.
          if (compiled.engine !== semanticEngine) {
            executionFailure = { reasonCode: 'SEMANTIC_EXECUTION_TARGET_MISMATCH', origin: 'execution' };
            observe('compile_and_run_semantic', 'error', executionFailure.reasonCode, {
              tier: 'semantic',
              candidateIds: selectedCandidateIds,
              origin: 'execution',
              planId: state.resolvedPlan?.id,
            });
            finishAskAgentV2Turn(state, {
              version: 2,
              kind: 'execution_failure',
              reasonCode: executionFailure.reasonCode,
              origin: executionFailure.origin,
              safeAction: 'inspect_execution_target',
            });
            return denied('compile_and_run_semantic', executionFailure.reasonCode);
          }
          // ── FAIL-CLOSED FILTER PROOF ─────────────────────────────────────
          // A composer that cannot express a requested filter (for example a
          // cross-model member filter on the native engine) may silently drop
          // it — and the grand total then ships labeled as one member's
          // number, the worst wrongness there is. Every requested filter
          // value (member equality and host window bounds) must appear in
          // the compiled SQL, or the query does not run. Both governed
          // engines inline literal values; if a future engine parameterizes
          // them, extend this proof rather than weakening it.
          const compiledSqlText = String(compiled.sql ?? '').toLowerCase();
          const requiredFilterLiterals = [
            ...semanticFilters.map((filter) => String(filter.value)),
            ...windowFilters.flatMap((filter) => filter.values.map(String)),
          ].filter((literal) => literal.trim().length > 0);
          const droppedFilterLiterals = requiredFilterLiterals
            .filter((literal) => !compiledSqlText.includes(literal.toLowerCase()));
          if (droppedFilterLiterals.length > 0) {
            observe('compile_and_run_semantic', 'ineligible', 'SEMANTIC_FILTER_NOT_COMPILED', {
              tier: 'semantic',
              candidateIds: selectedCandidateIds,
              origin: 'validation',
              safeAction: 'use:validate_and_run_sql',
            });
            // The plan froze at authorization, so no other tier can legally
            // run this turn. End it honestly rather than letting the loop
            // spend the budget on post-freeze denials.
            finishAskAgentV2Turn(state, {
              version: 2,
              kind: 'execution_failure',
              reasonCode: 'SEMANTIC_FILTER_NOT_COMPILED',
              origin: 'validation',
              safeAction: 'use:validate_and_run_sql',
            });
            return {
              ...denied('compile_and_run_semantic', 'SEMANTIC_FILTER_NOT_COMPILED', ['validate_and_run_sql']),
              usage: `The selected semantic engine compiled this query WITHOUT ${droppedFilterLiterals.length} required filter value(s); it was not executed, because the unfiltered total would be presented as the filtered answer. Express the filter through governed SQL instead.`,
            };
          }
          try {
            const result = await input.executeGeneratedSql(compiled.sql);
            // A zero-row adapter result loses its header row, and with it
            // the downstream contract: the deterministic fact renderer needs
            // columns to state even "zero rows", and the reader deserves the
            // shape of the answer they asked for. The host composed the
            // selection, so the projected columns are known without a single
            // returned row.
            const projectedColumns = Array.isArray(result.columns) && result.columns.length > 0
              ? result.columns
              : [
                ...(selection.dimensions ?? []),
                ...(selection.timeDimension ? [selection.timeDimension.name] : []),
                ...selection.metrics,
              ];
            completed = {
              tier: 'semantic',
              result: {
                ...result,
                columns: projectedColumns,
                trustState: 'governed',
                answerTier: 'semantic_metric',
                semanticTrace: compiled.trace,
                ...(requiredWindow && windowBounds && windowFilters.length ? {
                  appliedTimeWindow: {
                    expression: requiredWindow.expression,
                    startInclusive: windowBounds.startInclusive.slice(0, 10),
                    endExclusive: windowBounds.endExclusive.slice(0, 10),
                  },
                } : {}),
              },
            };
            observe('compile_and_run_semantic', 'executed', 'SEMANTIC_RESULT_VALIDATED', { tier: 'semantic', candidateIds: selectedCandidateIds, origin: 'execution', planId: state.resolvedPlan?.id });
            return { executed: true, tier: 'semantic', rowCount: result.rowCount, engine: compiled.engine };
          } catch {
            executionFailure = { reasonCode: 'SEMANTIC_EXECUTION_FAILED', origin: 'execution' };
            observe('compile_and_run_semantic', 'error', executionFailure.reasonCode, { tier: 'semantic', candidateIds: selectedCandidateIds, origin: 'execution', planId: state.resolvedPlan?.id });
            return denied('compile_and_run_semantic', executionFailure.reasonCode);
          }
        } catch {
          // Compilation happens after the host has frozen the exact semantic
          // capability. It is therefore a terminal same-plan failure, not a
          // pre-freeze signal to silently select a different route.
          executionFailure = { reasonCode: 'SEMANTIC_COMPILATION_FAILED', origin: 'execution' };
          observe('compile_and_run_semantic', 'error', executionFailure.reasonCode, { tier: 'semantic', candidateIds: selectedCandidateIds, origin: 'execution', planId: state.resolvedPlan?.id });
          return denied('compile_and_run_semantic', executionFailure.reasonCode);
        }
      }),
      safeTool(
        'describe_relation',
        'Describe one admitted relation: every column the catalog recorded for it, plus the relationship paths it participates in.'
        + ' Call this before writing DQL or SQL so you use real column names instead of guessing.',
        {
          type: 'object',
          properties: { candidateId: { type: 'string', minLength: 1, description: 'An admitted relation card ID, or the relation name exactly as a card reported it.' } },
          required: ['candidateId'],
          additionalProperties: false,
        },
        async (args) => {
          const requested = typeof args.candidateId === 'string' ? args.candidateId.trim() : '';
          const resolved = requested ? resolveAdmittedReference(requested) : undefined;
          const candidate = resolved?.candidate;
          // A relation is a thing with columns. Refusing anything else keeps
          // this tool from becoming a second, weaker card renderer.
          if (!candidate || (candidate.columns?.length ?? 0) === 0) {
            observe('describe_relation', 'ineligible', 'RELATION_NOT_ADMITTED', {
              candidateIds: requested ? [requested] : [], origin: 'retrieval',
            });
            return {
              ...denied('describe_relation', 'RELATION_NOT_ADMITTED'),
              admittedRelations: admittedRelationVocabulary(),
              usage: 'Pass candidateId from admittedRelations verbatim. Only a relation with catalog columns can be described.',
            };
          }
          const id = v2CandidateId(candidate);
          const columns = (candidate.columns ?? []).slice(0, 200).map((column) => ({
            name: column.name,
            ...(column.type ? { type: column.type } : {}),
            ...(column.description ? { description: column.description } : {}),
          }));
          const relatedPaths = state.relationshipPathHandles
            .filter((path) => (path.candidateIds ?? []).includes(id))
            .slice(0, 8)
            .map((path) => ({ id: path.id, edgeIds: path.edgeIds }));
          observe('describe_relation', 'eligible', 'RELATION_DESCRIBED', { candidateIds: [id], origin: 'retrieval' });
          return {
            id,
            name: candidate.name,
            ...(candidate.definition ? { definition: candidate.definition } : {}),
            ...(candidate.sourceObjects?.length ? { relation: candidate.sourceObjects[0] } : {}),
            columns,
            columnCount: candidate.columnCount ?? columns.length,
            ...(columns.length < (candidate.columnCount ?? columns.length) ? { columnsTruncated: true } : {}),
            ...(relatedPaths.length ? { relationshipPathHandles: relatedPaths } : {}),
            usage: 'Reference these columns as "' + id + '.<column>" in expectedOutputIds/measureIds/dimensionIds,'
              + ' and by their plain name inside SQL. Columns not listed here are not admitted for this relation.',
          };
        },
      ),
      safeTool(
        'describe_metric',
        'Describe one admitted semantic metric: the dimensions it can be grouped by, their queryable grains, and the dimensions that are'
        + ' NOT reachable from it and why. Use it before compile_and_run_semantic when a breakdown may not be compatible.',
        {
          type: 'object',
          properties: { candidateId: { type: 'string', minLength: 1, description: 'An admitted semantic metric candidate ID.' } },
          required: ['candidateId'],
          additionalProperties: false,
        },
        async (args) => {
          const requested = typeof args.candidateId === 'string' ? args.candidateId.trim() : '';
          const candidate = requested ? resolveAdmittedReference(requested)?.candidate : undefined;
          const isMetric = Boolean(candidate)
            && (candidate!.kind === 'semantic_metric'
              || candidate!.semanticObjectType === 'metric'
              || candidate!.semanticObjectType === 'measure');
          if (!candidate || !isMetric) {
            observe('describe_metric', 'ineligible', 'SEMANTIC_METRIC_NOT_ADMITTED', {
              candidateIds: requested ? [requested] : [], origin: 'retrieval',
            });
            return {
              ...denied('describe_metric', 'SEMANTIC_METRIC_NOT_ADMITTED'),
              ...(admittedSemanticIdentifiers() ? { admittedIdentifiers: admittedSemanticIdentifiers() } : {}),
              usage: 'Pass candidateId of an admitted semantic metric verbatim.',
            };
          }
          const id = v2CandidateId(candidate);
          const runtimeName = candidate.semanticRuntimeName ?? candidate.name;
          const layer = input.semanticLayer;
          if (!layer) {
            // The card still carries the compatibility the snapshot captured.
            observe('describe_metric', 'eligible', 'SEMANTIC_METRIC_DESCRIBED', { candidateIds: [id], origin: 'retrieval' });
            return {
              id,
              name: candidate.name,
              ...(candidate.definition ? { definition: candidate.definition } : {}),
              compatibleDimensions: (candidate.dimensions ?? []).slice(0, 60),
              ...(candidate.timeGrains?.length ? { timeGrains: candidate.timeGrains } : {}),
              usage: 'Group only by dimensions listed here, using an admitted dimension candidate ID.',
            };
          }
          // In-process compatibility over the FULL semantic layer, memoized by
          // metric set. A card can only show the dimensions retrieval happened
          // to admit; a metric with sixty reachable dimensions deserves better
          // than that accident. No subprocess and no warehouse call.
          let compatible: Array<{ name: string; qualifiedName?: string; grains?: string[] }> = [];
          let incompatible: Array<{ name: string; reason: string }> = [];
          try {
            const explained = layer.explainCompatibleDimensions([runtimeName]);
            compatible = explained.compatible.slice(0, 80).map((dimension) => ({
              name: dimension.name,
              ...(dimension.qualifiedName ? { qualifiedName: dimension.qualifiedName } : {}),
              ...((dimension as { granularities?: string[] }).granularities?.length
                ? { grains: (dimension as { granularities?: string[] }).granularities!.slice(0, 8) }
                : {}),
            }));
            incompatible = explained.incompatible.slice(0, 24).map((entry) => ({ name: entry.name, reason: entry.reason }));
          } catch {
            compatible = (candidate.dimensions ?? []).slice(0, 60).map((name) => ({ name }));
          }
          // Name the admitted candidate ID for each compatible dimension when
          // one exists: that is the only spelling compile_and_run_semantic
          // accepts, and a display label that reads like an ID is exactly what
          // used to be refused.
          const withIds = compatible.map((dimension) => {
            const dimensionId = resolveV2SemanticCapabilityReference({
              reference: dimension.qualifiedName ?? dimension.name,
              role: 'dimension',
              candidates: workspace?.candidates ?? [],
              capabilities: workspace?.semanticCapabilities,
            });
            return { ...dimension, ...(dimensionId ? { dimensionId } : {}) };
          });
          observe('describe_metric', 'eligible', 'SEMANTIC_METRIC_DESCRIBED', { candidateIds: [id], origin: 'retrieval' });
          return {
            id,
            name: candidate.name,
            ...(candidate.definition ? { definition: candidate.definition } : {}),
            ...(candidate.aggregation ? { aggregation: candidate.aggregation } : {}),
            compatibleDimensions: withIds,
            ...(incompatible.length ? { incompatibleDimensions: incompatible } : {}),
            ...(candidate.timeGrains?.length ? { timeGrains: candidate.timeGrains } : {}),
            usage: 'Pass dimensionId values to compile_and_run_semantic. A dimension listed without a dimensionId is reachable'
              + ' for this metric but not admitted in this snapshot, so it cannot be selected this turn.',
          };
        },
      ),
      safeTool('inspect_relational_context', 'Inspect admitted qualified relation/column cards and atomic relationship path handles.', {
        type: 'object', properties: {}, additionalProperties: false,
      }, async () => {
        const candidates = visibleCandidates().filter((candidate) => candidate.kind === 'dql_modeling' || candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source' || candidate.kind === 'sql_column' || candidate.kind === 'sql_table' || (candidate.relationshipEvidence?.length ?? 0) > 0);
        const paths = state.relationshipPathHandles.map((path) => ({
          id: path.id,
          edgeIds: path.edgeIds,
          ...(path.candidateIds?.length ? { candidateIds: path.candidateIds } : {}),
        }));
        // Relationship cards are evidence, not an executable governed-DQL
        // route by themselves.  Report them to the planner, but only retain
        // an `available` governed tier when this invocation has the bound
        // executor that can consume the immutable path closure. Otherwise
        // the same snapshot may advance safely to exploratory SQL.
        const hasBoundRelationalExecutor = Boolean(
          (input.authorizeAskV2DqlArtifact && input.executeAskV2DqlArtifact)
          || (!input.askAgentV2Workspace && input.executeDqlArtifact),
        );
        const hasRelationalEvidence = candidates.length > 0 || paths.length > 0;
        setV2TierStateFromWorkspace(state, workspace, 'governed_relational', {
          status: hasRelationalEvidence && hasBoundRelationalExecutor ? 'available' : 'unavailable',
          candidateIds: candidates.map(v2CandidateId),
          reasonCode: hasRelationalEvidence
            ? hasBoundRelationalExecutor
              ? 'GOVERNED_RELATIONAL_CONTEXT_AVAILABLE'
              : 'GOVERNED_RELATIONAL_EXECUTION_UNAVAILABLE'
            : 'GOVERNED_RELATIONAL_CONTEXT_EMPTY',
        });
        if (!state.controllerTier && hasRelationalEvidence && hasBoundRelationalExecutor) {
          state.controllerTier = 'governed_relational';
        }
        observe('inspect_relational_context', candidates.length || paths.length ? 'eligible' : 'unavailable', candidates.length || paths.length ? 'relationship_paths_available' : 'relationship_paths_empty', { candidateIds: candidates.map(v2CandidateId), origin: 'retrieval' });
        return {
          cards: candidates.map((candidate) => v2SafeCard(candidate, workspace)),
          relationshipPathHandles: paths,
          // `compile_and_run_dql` accepts these IDs and no others. Listing them
          // here is what lets the next call be built rather than guessed.
          admittedIdentifiers: candidates.map(v2CandidateId),
          admittedRelationshipPathIds: paths.map((path) => path.id),
          usage: 'Pass measureIds/dimensionIds/expectedOutputIds from admittedIdentifiers verbatim,'
            + ' and relationshipPathIds from admittedRelationshipPathIds. A card\'s "name" is a label, not an identifier.',
        };
      }),
      safeTool('compile_and_run_dql', 'Compile one DQL program only from admitted qualified IDs and atomic relationship path handles, then execute it as governed relational.', {
        type: 'object', properties: {
          dqlProgram: { type: 'string', minLength: 1, maxLength: 30000 },
          measureIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
          dimensionIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
          relationshipPathIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          expectedOutputIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 24 }, repair: { type: 'boolean' },
        }, required: ['dqlProgram', 'measureIds', 'expectedOutputIds'], additionalProperties: false,
      }, async (args) => {
        if (!requireInspections('compile_and_run_dql', ['inspect_certified_candidates', 'inspect_semantic_candidates', 'inspect_relational_context'])) return denied('compile_and_run_dql', 'REQUIRED_TIER_INSPECTION_MISSING');
        const program = typeof args.dqlProgram === 'string' ? args.dqlProgram.trim() : '';
        const measureIds = v2StringArray(args.measureIds, 8);
        const dimensionIds = v2StringArray(args.dimensionIds, 16);
        const outputIds = v2StringArray(args.expectedOutputIds, 24);
        const pathIds = v2StringArray(args.relationshipPathIds, 8);
        const selectedCandidateIds = [...new Set([...measureIds, ...dimensionIds, ...outputIds])];
        const selected = resolveCandidates([...measureIds, ...dimensionIds, ...outputIds]);
        const selectedPaths = state.relationshipPathHandles.filter((path) => pathIds.includes(path.id));
        const allowedPaths = new Set(state.relationshipPathHandles.map((path) => path.id));
        const pathCandidateIds = new Set(selectedPaths.flatMap((path) => path.candidateIds ?? []));
        const relationLike = (candidate: AgentEvidenceCandidate) => candidate.kind === 'dql_modeling'
          || candidate.kind === 'dbt_model'
          || candidate.kind === 'dbt_source'
          || candidate.kind === 'sql_column'
          || candidate.kind === 'sql_table';
        const unboundRelation = selected?.some((candidate) => relationLike(candidate)
          && pathIds.length > 0
          && pathCandidateIds.size > 0
          && !pathCandidateIds.has(v2CandidateId(candidate)));
        const v2DqlExecutor = input.executeAskV2DqlArtifact;
        const v2DqlAuthorizer = input.authorizeAskV2DqlArtifact;
        const legacyDqlExecutor = !input.askAgentV2Workspace ? input.executeDqlArtifact : undefined;
        const v2DqlHostAvailable = Boolean(v2DqlAuthorizer && v2DqlExecutor);
        const legacyDqlHostAvailable = Boolean(!input.askAgentV2Workspace && legacyDqlExecutor);
        if (!program || !selected || pathIds.some((id) => !allowedPaths.has(id)) || unboundRelation || (!v2DqlHostAvailable && !legacyDqlHostAvailable)) {
          const reason = !selected || pathIds.some((id) => !allowedPaths.has(id)) || unboundRelation
            ? 'GOVERNED_RELATIONAL_IDENTIFIER_OR_PATH_NOT_ADMITTED'
            : 'GOVERNED_RELATIONAL_EXECUTION_UNAVAILABLE';
          observe('compile_and_run_dql', 'ineligible', reason, { tier: 'governed_relational', candidateIds: selectedCandidateIds, origin: 'validation' });
          // A bare "not admitted" is unactionable — the model guessed wrong
          // IDs once and will guess again until the budget dies. Name the
          // admitted relational identifiers and path handles verbatim, the
          // same teaching contract the semantic tier's refusals carry.
          const admittedRelational = visibleCandidates()
            .filter(relationLike)
            .slice(0, 16)
            .map((candidate) => v2CandidateId(candidate));
          return {
            ...denied('compile_and_run_dql', reason),
            ...(reason === 'GOVERNED_RELATIONAL_IDENTIFIER_OR_PATH_NOT_ADMITTED' ? {
              admittedRelationalIds: admittedRelational,
              admittedRelations: admittedRelationVocabulary(),
              admittedRelationshipPathIds: state.relationshipPathHandles.slice(0, 8).map((path) => path.id),
              usage: 'Re-send compile_and_run_dql using measureIds/dimensionIds/expectedOutputIds that are admitted card IDs or'
                + ' "<relation>.<column>" naming a column of an admitted relation (see admittedRelations), and relationshipPathIds'
                + ' from admittedRelationshipPathIds. Use describe_relation for the full column list of one relation.',
            } : {}),
          };
        }
        // The local host mints a V2-only authorization before compiling the
        // DQL program.  This is the frozen boundary: the compiler and
        // warehouse may not cause the model to switch route afterwards. A
        // tiny in-memory adapter remains for host-neutral unit tests only;
        // the production local runtime always supplies the authorizer.
        try {
          const artifact = {
            kind: 'sql_block', source: program, name: 'V2 governed relational program',
            metrics: measureIds, dimensions: dimensionIds, trustState: 'governed',
          } as const;
          const bindingFingerprint = v2ExecutionBindingFingerprint({
            state,
            tier: 'governed_relational',
            candidateIds: selectedCandidateIds,
            pathIds,
            bindings: {
              measureIds,
              dimensionIds,
              outputIds,
              // A repair cannot change DQL semantics under the same frozen
              // candidate/path closure. This digest covers the normalized
              // complete DQL program plus the selected output binding.
              logicalPlanFingerprint: v2GovernedDqlLogicalPlanFingerprint({
                dqlProgram: program,
                measureIds,
                dimensionIds,
                outputIds,
              }),
            },
          });
          const repair = args.repair === true;
          // The host capability is the freeze boundary, but it must never be
          // minted for a request the V2 kernel has already rejected (most
          // importantly, a widened relationship closure after the first
          // governed plan freezes).  This non-mutating preflight deliberately
          // precedes host authorization; `authorizeExecution` below remains
          // the single place that records the authorization/freeze receipt.
          const preflight = kernel.canCall('compile_and_run_dql', {
            repair,
            candidateIds: selectedCandidateIds,
            relationshipPathIds: pathIds,
            bindingFingerprint,
          });
          if (!preflight.ok) {
            observe('compile_and_run_dql', 'denied', preflight.reasonCode ?? 'ASK_V2_TOOL_DENIED', {
              tier: 'governed_relational',
              candidateIds: selectedCandidateIds,
              origin: 'validation',
              ...(preflight.safeNextTools?.length ? { safeAction: `use:${preflight.safeNextTools.join(',')}` } : {}),
            });
            return denied('compile_and_run_dql', preflight.reasonCode ?? 'ASK_V2_TOOL_DENIED');
          }
          const hostAuthorization = v2DqlHostAvailable
            ? await v2DqlAuthorizer!({
                version: 2,
                candidateIds: selectedCandidateIds,
                expectedOutputIds: outputIds,
                relationshipPathIds: pathIds,
                snapshotId: state.snapshotId,
                planFingerprint: bindingFingerprint,
                repair,
              })
            : undefined;
          const authorization = authorizeExecution({
            tool: 'compile_and_run_dql',
            tier: 'governed_relational',
            candidateIds: selectedCandidateIds,
            relationshipPathIds: pathIds,
            bindingFingerprint,
            planId: hostAuthorization?.planId ?? `ask-v2:governed:${bindingFingerprint.slice(-24)}`,
            repair,
            ...(hostAuthorization?.targetFingerprint ? { targetFingerprint: hostAuthorization.targetFingerprint } : {}),
          });
          if (!authorization.ok) return denied('compile_and_run_dql', authorization.reasonCode);
          const result = v2DqlHostAvailable
            ? await v2DqlExecutor!({
                version: 2,
                artifact,
                candidateIds: selectedCandidateIds,
                expectedOutputIds: outputIds,
                relationshipPathIds: pathIds,
                snapshotId: state.snapshotId,
                planFingerprint: bindingFingerprint,
                ...(hostAuthorization ? { authorizationPlanId: hostAuthorization.planId } : {}),
                repair,
              })
            : await legacyDqlExecutor!(artifact);
          completed = { tier: 'governed_relational', result: { ...result, trustState: 'governed', answerTier: 'governed_relational' } };
          observe('compile_and_run_dql', 'executed', 'GOVERNED_RELATIONAL_RESULT_VALIDATED', { tier: 'governed_relational', candidateIds: selectedCandidateIds, relationshipPathIds: pathIds, origin: 'execution', planId: state.resolvedPlan?.id });
          return { executed: true, tier: 'governed_relational', rowCount: result.rowCount, relationshipPathIds: pathIds };
        } catch (error) {
          executionFailure = v2ExecutionFailureFromError(error, 'GOVERNED_RELATIONAL_EXECUTION_FAILED');
          observe('compile_and_run_dql', 'error', executionFailure.reasonCode, { tier: 'governed_relational', candidateIds: selectedCandidateIds, relationshipPathIds: pathIds, origin: executionFailure.origin, planId: state.resolvedPlan?.id });
          return denied('compile_and_run_dql', executionFailure.reasonCode);
        }
      }),
      safeTool('validate_and_run_sql', 'Validate one read-only SQL proposal against admitted output IDs, mint a one-use capability, and execute it as review-required.', {
        type: 'object', properties: { sql: { type: 'string', minLength: 1, maxLength: 30000 }, expectedOutputIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 24 }, repair: { type: 'boolean' } }, required: ['sql', 'expectedOutputIds'], additionalProperties: false,
      }, async (args) => {
        if (!requireInspections('validate_and_run_sql', ['inspect_certified_candidates', 'inspect_semantic_candidates', 'inspect_relational_context'])) return denied('validate_and_run_sql', 'REQUIRED_TIER_INSPECTION_MISSING');
        const sql = typeof args.sql === 'string' ? args.sql : '';
        const outputIds = v2StringArray(args.expectedOutputIds, 24);
        const outputs = resolveCandidates(outputIds);
        const validation = sql && input.contextPack ? validateSqlAgainstLocalContext(sql, input.contextPack) : { ok: false };
        const v2Prepare = input.prepareAskV2ExploratorySqlExecution;
        const legacyPrepare = !input.askAgentV2Workspace ? input.prepareExploratorySqlExecution : undefined;
        if (!outputs || !validation.ok || (!v2Prepare && !legacyPrepare) || !input.executeAgenticGeneratedSql) {
          const reason = !outputs ? 'EXPLORATORY_OUTPUT_IDENTIFIER_NOT_ADMITTED' : validation.ok ? 'EXPLORATORY_EXECUTION_CAPABILITY_UNAVAILABLE' : 'EXPLORATORY_SQL_VALIDATION_FAILED';
          observe('validate_and_run_sql', 'ineligible', reason, { tier: 'exploratory_sql', candidateIds: outputIds, origin: 'validation' });
          // Same teaching contract as the semantic/relational refusals: a
          // model told only "not admitted" guesses identifiers until the
          // budget dies. Name the admitted output IDs verbatim.
          const admittedOutputs = reason === 'EXPLORATORY_OUTPUT_IDENTIFIER_NOT_ADMITTED'
            ? visibleCandidates().slice(0, 24).map((candidate) => v2CandidateId(candidate))
            : [];
          // The validator names the exact offending relation or column. Reading
          // a field it does not have ("reason") meant every SQL-validation
          // refusal arrived bare, so the model re-sent the same query with no
          // way to know what was wrong.
          const validationDetail = !validation.ok
            ? {
              ...('error' in validation && typeof validation.error === 'string' ? { error: validation.error.slice(0, 400) } : {}),
              ...('code' in validation && typeof validation.code === 'string' ? { validationCode: validation.code } : {}),
              ...('offending' in validation && validation.offending ? { offending: validation.offending } : {}),
            }
            : {};
          return {
            ...denied('validate_and_run_sql', reason),
            ...(admittedOutputs.length ? {
              admittedOutputIds: admittedOutputs,
              admittedRelations: admittedRelationVocabulary(),
              usage: 'Every expectedOutputIds entry must be an admitted card ID, or "<relation>.<column>" naming a column of an admitted relation'
                + ' (see admittedRelations). Use describe_relation to see every column of one relation.',
            } : {}),
            ...(reason === 'EXPLORATORY_SQL_VALIDATION_FAILED' ? {
              ...validationDetail,
              usage: 'Correct the SQL to reference only relations and columns proven above, then re-send validate_and_run_sql once.',
            } : {}),
          };
        }
        try {
          const selectedCandidateIds = [...new Set(outputIds)];
          const repair = args.repair === true;
          const bindingFingerprint = v2ExecutionBindingFingerprint({
            state,
            tier: 'exploratory_sql',
            candidateIds: selectedCandidateIds,
            bindings: { outputIds },
          });
          const prepared = v2Prepare
            ? await v2Prepare({
                version: 2,
                sql,
                expectedOutputIds: outputIds,
                selectedCandidateIds,
                snapshotId: state.snapshotId,
                planFingerprint: bindingFingerprint,
                repair,
              })
            : await legacyPrepare!(sql);
          const authorization = authorizeExecution({
            tool: 'validate_and_run_sql',
            tier: 'exploratory_sql',
            candidateIds: selectedCandidateIds,
            bindingFingerprint,
            planId: prepared.freeze?.planId ?? `ask-v2:exploratory:${bindingFingerprint.slice(-24)}`,
            repair,
            ...(prepared.freeze?.targetFingerprint ? { targetFingerprint: prepared.freeze.targetFingerprint } : {}),
          });
          if (!authorization.ok) return denied('validate_and_run_sql', authorization.reasonCode);
          const result = await input.executeAgenticGeneratedSql(prepared.capability, sql);
          completed = { tier: 'exploratory_sql', result: { ...result, trustState: 'review_required', answerTier: 'exploratory_sql' } };
          observe('validate_and_run_sql', 'executed', 'EXPLORATORY_RESULT_VALIDATED', { tier: 'exploratory_sql', candidateIds: outputIds, origin: 'execution', planId: state.resolvedPlan?.id });
          return { executed: true, tier: 'exploratory_sql', rowCount: result.rowCount, reviewRequired: true };
        } catch (error) {
          executionFailure = v2ExecutionFailureFromError(error, 'EXPLORATORY_EXECUTION_FAILED');
          observe('validate_and_run_sql', 'error', executionFailure.reasonCode, { tier: 'exploratory_sql', candidateIds: outputIds, origin: executionFailure.origin, planId: state.resolvedPlan?.id });
          return denied('validate_and_run_sql', executionFailure.reasonCode);
        }
      }),
      safeTool('search_values', 'Search one host-approved value index to resolve a member. It never reads result rows.', {
        type: 'object', properties: { candidateId: { type: 'string' }, query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['candidateId', 'query'], additionalProperties: false,
      }, async (args) => {
        const candidateId = typeof args.candidateId === 'string' ? args.candidateId : '';
        const candidate = resolveCandidates([candidateId])?.[0];
        const reason = candidate ? 'VALUE_SEARCH_ADAPTER_NOT_BOUND' : 'VALUE_SEARCH_IDENTIFIER_NOT_ADMITTED';
        observe('search_values', candidate ? 'unavailable' : 'ineligible', reason, { candidateIds: candidateId ? [candidateId] : [], origin: 'retrieval' });
        return denied('search_values', reason);
      }),
      safeTool('request_clarification', 'Request one stable clarification only when multiple executable business meanings remain.', {
        type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 1000 }, options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false }, minItems: 2, maxItems: 8 } }, required: ['message', 'options'], additionalProperties: false,
      }, async (args) => {
        const message = typeof args.message === 'string' ? args.message.trim() : '';
        const options = Array.isArray(args.options) ? args.options.slice(0, 8).flatMap((option) => option && typeof option === 'object' && typeof (option as Record<string, unknown>).id === 'string' && typeof (option as Record<string, unknown>).label === 'string'
          ? [{ id: String((option as Record<string, unknown>).id), label: String((option as Record<string, unknown>).label) }]
          : []) : [];
        const issued = materialClarificationChoices();
        const issuedIds = new Set(issued.map((choice) => choice.id));
        const requestedIds = options.map((option) => option.id);
        const requestedUniqueIds = new Set(requestedIds);
        const exactIssuedSet = issued.length >= 2
          && requestedIds.length === issued.length
          && requestedUniqueIds.size === issued.length
          && requestedIds.every((id) => issuedIds.has(id));
        if (!issued.length) {
          const safeNextTools = kernel.toolPolicy().allowedToolNames.filter((tool) => tool !== 'request_clarification');
          observe('request_clarification', 'ineligible', 'ASK_V2_CLARIFICATION_NOT_MATERIALLY_AMBIGUOUS', {
            origin: 'validation',
            candidateIds: [],
            ...(safeNextTools.length ? { safeAction: `use:${safeNextTools.join(',')}` } : {}),
          });
          return denied('request_clarification', 'ASK_V2_CLARIFICATION_NOT_MATERIALLY_AMBIGUOUS', safeNextTools);
        }
        if (!message) {
          observe('request_clarification', 'ineligible', 'ASK_V2_CLARIFICATION_MESSAGE_INVALID', {
            origin: 'validation',
            candidateIds: issued.flatMap((choice) => choice.candidateIds),
            safeAction: 'use:request_clarification',
          });
          return denied('request_clarification', 'ASK_V2_CLARIFICATION_MESSAGE_INVALID', ['request_clarification']);
        }
        if (!exactIssuedSet) {
          observe('request_clarification', 'ineligible', 'ASK_V2_CLARIFICATION_OPTIONS_INVALID', {
            origin: 'validation',
            candidateIds: issued.flatMap((choice) => choice.candidateIds),
            safeAction: 'use:request_clarification',
          });
          return denied('request_clarification', 'ASK_V2_CLARIFICATION_OPTIONS_INVALID', ['request_clarification']);
        }
        // The LLM supplies only opaque IDs. Labels are re-bound to the
        // host-issued stable set, so an invented/reworded option can never
        // become a persisted conversational selection.
        const stableOptions = issued.map((choice) => ({ id: choice.id, label: choice.label }));
        clarification = { message, options: stableOptions };
        observe('request_clarification', 'needs_input', 'ASK_V2_CLARIFICATION_REQUESTED', {
          origin: 'agent_control',
          candidateIds: issued.flatMap((choice) => choice.candidateIds),
        });
        // The transport may stop only after the host has recorded this stable
        // clarification outcome.  A rejected clarification returns the normal
        // denied shape from `safeTool` and must remain a pre-freeze observation
        // so the controller can take its declared safe-next action.
        return { finished: true, clarificationId: `clarification:${state.snapshotId ?? 'snapshot'}`, options: stableOptions };
      }),
      safeTool('finish_answer', 'Finish after an execution tool completed, or finish a definition/business/general answer from retrieved context only.', {
        type: 'object', properties: {
          answer: { type: 'string', minLength: 1, maxLength: 8000 },
          /** Required only for a governed business-context answer. */
          evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 24 },
      }, required: ['answer'], additionalProperties: false,
      }, async (args) => {
        const answer = typeof args.answer === 'string' ? args.answer : undefined;
        const evidenceIds = v2StringArray(args.evidenceIds, 24);
        const contextual = state.turnClass === 'definition' || state.turnClass === 'business_context';
        const inspected = state.observations.some((observation) => observation.tool === 'inspect_business_context'
          && observation.outcome === 'eligible');
        const selectedBusinessEvidence = evidenceIds?.filter((id) => inspectedBusinessContextIds.includes(id)) ?? [];
        if (!completed && contextual && (!inspected || selectedBusinessEvidence.length === 0)) {
          observe('finish_answer', 'ineligible', 'BUSINESS_CONTEXT_EVIDENCE_REQUIRED', {
            origin: 'validation',
            candidateIds: selectedBusinessEvidence,
            safeAction: 'inspect_business_context_then_select_evidence',
          });
          return denied('finish_answer', 'BUSINESS_CONTEXT_EVIDENCE_REQUIRED');
        }
        observe('finish_answer', 'eligible', completed ? 'ASK_V2_RESULT_NARRATED' : 'ASK_V2_CONTEXTUAL_ANSWER', {
          origin: completed ? 'narration' : 'agent_control',
          candidateIds: completed ? [] : selectedBusinessEvidence,
        });
        // Do not retain narration from a rejected early finish proposal. A
        // later validated execution must either receive a new host-approved
        // finish narration or fall back to its deterministic fact narration.
        finalText = answer;
        return { finished: true, hasResult: Boolean(completed), evidenceIds: selectedBusinessEvidence };
      }),
    ];
    // `finish_answer` is an authoritative host control boundary.  Text-only
    // provider adapters normally stop in the agent loop immediately after the
    // tool returns, but keep the boundary at this higher layer as well: a
    // transport wrapper must never send another planner request after the
    // validated result and its narration have both been recorded.
    const terminalNarrationReady = () => Boolean(completed && state.observations.some((observation) => (
      observation.tool === 'finish_answer'
      && observation.outcome === 'eligible'
      && observation.reasonCode === 'ASK_V2_RESULT_NARRATED'
    )));
    const terminalAwareProvider: AgentProvider = {
      name: input.provider.name,
      available: () => input.provider.available(),
      generate: async (...args) => {
        if (terminalNarrationReady()) return finalText ?? '';
        return input.provider.generate(...args);
      },
      ...(input.provider.generateWithTools ? {
        generateWithTools: async (...args: Parameters<NonNullable<AgentProvider['generateWithTools']>>) => {
          if (terminalNarrationReady()) return finalText ?? '';
          return input.provider.generateWithTools!(...args);
        },
      } : {}),
    };
    // ── HOST-FIRST SEMANTIC EXECUTION ────────────────────────────────────
    // The evidence from 120 live runs: turns the host executed directly
    // succeeded; turns that asked the model to transcribe host-known bindings
    // into tool arguments died burning the dispatch budget on spelling —
    // wrong identifier forms, wrong grains, wrong axes — each refusal costing
    // one slow provider round trip. When the typed requirement resolves every
    // clause to exactly ONE admitted binding, there is no decision left for a
    // model to make: the host calls its own governed tools directly — same
    // admission, same freeze, same gates, zero provider calls. The analyst
    // loop below remains the path for genuine ambiguity, and any host-first
    // miss falls through to it with the inspection observations as a head
    // start.
    // When the loop found no executable path, check whether the reason is
    // simply that the user asked for a field this project has never modeled.
    // "Not enough context" for an unmodeled term reads as a system failure;
    // the truthful answer names the term and the governed alternatives.
    const requestedUnmodeledTerm = async (): Promise<{ term: string; admitted: string[] } | undefined> => {
      const plan = buildAnalysisQuestionPlan(input.question);
      const requirements = buildAnalyticalRequirementSet({ question: input.question });
      // A "dimension term" can actually be a member VALUE ("beverage
      // revenue" filters product_type, it does not group by a beverage
      // field). Values never appear in metadata names, so they must not be
      // declared unmodeled — only terms the parser did NOT also read as a
      // filter literal qualify.
      const literalish = new Set([
        ...requirements.memberTerms.map((term) => String(term).toLowerCase().trim()),
        ...(plan.requestedShape.filters ?? []).map((term) => String(term).toLowerCase().trim()),
      ]);
      const terms = [...new Set([...(plan.dimensionTerms ?? []), ...requirements.dimensions])]
        .map((term) => String(term).trim())
        .filter((term) => Boolean(term)
          && !literalish.has(term.toLowerCase())
          // A time noun is a grain served by any admitted time axis, not a
          // field of its own; "by month" must never read as unmodeled.
          && !/^(?:day|week|month|quarter|year|season|period)s?$/i.test(term)
          // Generic request nouns ("the % DOD ACM value", "the revenue info")
          // name HOW the user wants the answer, not a field to resolve.
          && !/^(?:value|info|information|detail|data|number|figure|result|stat|statistic|total|summary|breakdown)s?$/i.test(term)
          // The lexical by-phrase extractor can emit run-together noise
          // ("month_using_the_revenue_semantic_metric"). Only a clean one- or
          // two-word business noun is a claim worth refusing over.
          && /^[a-z]+(?: [a-z]+)?$/i.test(term)
          // "product revenue" asks for a revenue VARIANT, not a product
          // grouping: a term directly qualifying a measure word is measure
          // vocabulary and must not be declared unmodeled.
          && !requirements.measures.some((measure) =>
            input.question.toLowerCase().includes(`${term.toLowerCase()} ${measure.toLowerCase()}`)));
      const all = visibleCandidates();
      const roles: V2SemanticCapabilityRole[] = ['dimension', 'metric', 'time_dimension', 'filter_dimension'];
      const unresolved = terms.filter((term) => {
        const lower = term.toLowerCase();
        const snake = lower.replace(/\s+/g, '_');
        if (roles.some((role) => resolveV2SemanticCapabilityReference({
          reference: snake, role, candidates: all, capabilities: workspace?.semanticCapabilities,
        }))) return false;
        const containedInCandidates = all.some((candidate) =>
          (candidate.name ?? '').toLowerCase().includes(lower)
          || (candidate.aliases ?? []).some((alias) => alias.toLowerCase().includes(lower))
          || (candidate.sourceObjects ?? []).some((source) => source.toLowerCase().includes(lower)));
        // A term can be modeled through a JOIN rather than a retained card:
        // an admitted relationship path to the customers model proves
        // "customer" even when no customer card was retained.
        const containedInPaths = (state.relationshipPathHandles ?? []).some((handle) =>
          handle.id.toLowerCase().includes(lower)
          || (handle.edgeIds ?? []).some((edge) => edge.toLowerCase().includes(lower))
          || (handle.candidateIds ?? []).some((id) => id.toLowerCase().includes(lower)));
        return !containedInCandidates && !containedInPaths;
      });
      if (unresolved.length === 0) return undefined;
      // Retention is a ranking, not the model: a term absent from the 80
      // retained cards can still be modeled a thousand times over in a large
      // catalog. Only the HOST's whole-catalog lookup may authorize a
      // "not modeled" claim; without that proof, no refusal.
      const catalogCheck = input.catalogTermMentioned;
      if (!catalogCheck) return undefined;
      let confirmed: string | undefined;
      for (const term of unresolved) {
        try {
          if (!(await catalogCheck(term))) { confirmed = term; break; }
        } catch {
          return undefined;
        }
      }
      if (!confirmed) return undefined;
      const admitted = [...new Set(all
        .filter((candidate) => v2SemanticCandidateMatchesRole(candidate, 'dimension'))
        .map((candidate) => candidate.semanticRuntimeName ?? candidate.name))].slice(0, 6);
      return { term: confirmed, admitted };
    };
    const hostFirst = !state.exactCertifiedCandidateId
      && state.tierStates?.certified?.status !== 'complete'
      && (state.turnClass === 'analytics' || state.turnClass === 'prior_result' || state.turnClass === 'clarification_response')
      ? await deriveHostFirstSemanticArgs({
        question: input.question,
        candidates: visibleCandidates(),
        capabilities: workspace?.semanticCapabilities,
        ...(parseV2TrustedMemberSelection(state) ? { trustedMemberSelection: parseV2TrustedMemberSelection(state) } : {}),
        ...(input.probeAllowlistedLiteral ? { probeAllowlistedLiteral: input.probeAllowlistedLiteral } : {}),
      })
      : undefined;
    if (hostFirst) {
      try {
        const toolByName = (name: string) => tools.find((tool) => tool.name === name);
        await toolByName('inspect_certified_candidates')?.run({});
        await toolByName('inspect_semantic_candidates')?.run({});
        const compiled = await toolByName('compile_and_run_semantic')?.run(hostFirst) as { executed?: boolean; rowCount?: number } | undefined;
        if (compiled?.executed && completed) {
          const rowCount = typeof compiled.rowCount === 'number' ? compiled.rowCount : completed.result.rowCount;
          await toolByName('finish_answer')?.run({
            answer: `The governed semantic query executed and returned ${rowCount} row${rowCount === 1 ? '' : 's'}.`,
          });
          if (completed && state.observations.some((observation) => (
            observation.tool === 'finish_answer' && observation.reasonCode === 'ASK_V2_RESULT_NARRATED'
          ))) {
            return askV2ExecutedAnswer(input, completed, finalText ?? '');
          }
        }
        // Not executed: the observations recorded above (including any typed
        // refusal) now guide the analyst loop instead of being rediscovered.
      } catch {
        // A host-first fault must never cost the turn; the loop still runs.
      }
      // A terminal minted during the host-first attempt (for example the
      // fail-closed filter proof after the plan froze) ends the turn here:
      // every later tool call would only be denied post-freeze.
      if (state.terminalOutcome?.kind === 'execution_failure') {
        return askV2NoAnswer(
          input,
          'execution_failure',
          state.terminalOutcome.reasonCode,
          state.terminalOutcome.origin,
          state.terminalOutcome.safeAction,
        );
      }
    }
    // A grouping term that resolves to NOTHING in the snapshot — no
    // capability in any role, no candidate name or alias even containing it
    // — cannot be fixed by any number of provider dispatches. Refuse before
    // the first one, naming the term and the governed alternatives, instead
    // of letting the analyst guess identifiers until the budget dies. This
    // runs after the host-first attempt: a turn the host executed never
    // needed the term to resolve.
    if (!state.terminalOutcome
      && (state.turnClass === 'analytics' || state.turnClass === 'prior_result' || state.turnClass === 'clarification_response')) {
      const unmodeled = await requestedUnmodeledTerm();
      if (unmodeled) {
        observeAskAgentV2Tool(state, {
          version: 1,
          tool: 'finish_answer',
          outcome: 'ineligible',
          reasonCode: 'ASK_V2_REQUESTED_TERM_UNMODELED',
          candidateIds: [],
          origin: 'validation',
        });
        finishAskAgentV2Turn(state, {
          version: 2,
          kind: 'gap',
          reasonCode: 'ASK_V2_REQUESTED_TERM_UNMODELED',
          origin: 'validation',
        });
        return askV2NoAnswer(input, 'gap', 'ASK_V2_REQUESTED_TERM_UNMODELED', 'validation', undefined, unmodeled);
      }
    }
    let loop: Awaited<ReturnType<typeof runAgenticToolLoopDetailed>>;
    try {
      // THE WORKSPACE TRAVELS WITH THE QUESTION.
      //
      // The kernel's policy was written believing "the initial provider
      // package already contains the immutable role-balanced cards" — and for
      // the research lane it does. For an ordinary analytical turn it never
      // did: the first dispatch carried the system prompt and the question and
      // nothing else. A model asked to use only identifiers a tool returned,
      // holding zero identifiers, has exactly two moves — spend a dispatch on
      // an inspection, or guess. It guessed, and every tier refused the guess.
      // Sending the cards the host already selected costs nothing (they are
      // the same bytes inspect_ask_context would return) and removes a whole
      // round trip from every question.
      // WHAT THE LAST ANSWER WAS.
      //
      // A follow-up is not a new question with fewer words. "Now split that by
      // month" only means anything next to the measure, the members and the
      // shape of the answer that preceded it — all of which the host already
      // holds and, until now, never sent. The analyst received five words and
      // a fresh workspace and had to re-derive an intent it was never told.
      // These are the host's own typed conversation facts, not model memory:
      // values stay bounded and the member binding remains host-authoritative.
      const conversationBrief = ((): string | undefined => {
        const followUp = input.followUp;
        if (!followUp) return undefined;
        const brief: Record<string, unknown> = {};
        if (followUp.sourceQuestion) brief.previousQuestion = followUp.sourceQuestion;
        if (followUp.priorMeasures?.length) brief.previousMeasures = followUp.priorMeasures.slice(0, 6);
        if (followUp.dimensions?.length) brief.previousBreakdowns = followUp.dimensions.slice(0, 6);
        if (followUp.filters?.length) brief.previousFilters = followUp.filters.slice(0, 8);
        if (followUp.priorResultColumns?.length) brief.previousResultColumns = followUp.priorResultColumns.slice(0, 16);
        if (typeof followUp.priorLimit === 'number') brief.previousRowLimit = followUp.priorLimit;
        if (followUp.sourceBlockName) brief.previousCertifiedBlock = followUp.sourceBlockName;
        // Members the host has already bound are authoritative; the analyst
        // must not re-choose them, and naming them stops it from asking.
        const boundMembers = (followUp.memberBindings ?? [])
          .slice(0, 6)
          .map((binding) => ({
            dimension: binding.dimension,
            values: binding.values.slice(0, 8),
            confidence: binding.confidence,
          }));
        if (boundMembers.length) brief.boundMembers = boundMembers;
        if (followUp.deicticChoices?.values?.length) {
          brief.ambiguousReference = {
            dimension: followUp.deicticChoices.dimension,
            options: followUp.deicticChoices.values.slice(0, 8),
          };
        }
        if (followUp.priorResultSetUnavailable) brief.previousResultSetUnavailable = true;
        if (Object.keys(brief).length === 0) return undefined;
        return 'This turn continues the previous answer. Host-recorded facts about it '
          + '(authoritative — do not re-derive them from the question text):\n'
          + JSON.stringify(brief);
      })();
      const openingCards = (workspace?.candidates ?? [])
        .filter((candidate) => state.initialCandidateIds.includes(v2CandidateId(candidate)))
        .map((candidate) => v2SafeCard(candidate, workspace));
      if (openingCards.length > 0) {
        // Recorded as an inspection so the receipt, the kernel's redundancy
        // guard, and the tool-policy ladder all agree the controller has
        // already seen this package.
        observeAskAgentV2Tool(state, {
          version: 1,
          tool: 'inspect_ask_context',
          outcome: 'eligible',
          reasonCode: 'initial_snapshot_context',
          candidateIds: state.initialCandidateIds,
          origin: 'retrieval',
        });
      }
      const openingContext = openingCards.length > 0
        ? JSON.stringify({
          snapshotId: state.snapshotId,
          cards: openingCards,
          relationshipPathHandles: state.relationshipPathHandles
            .slice(0, 8)
            .map((path) => ({
              id: path.id,
              edgeIds: path.edgeIds,
              ...(path.candidateIds?.length ? { candidateIds: path.candidateIds } : {}),
            })),
        })
        : undefined;
      loop = await runAgenticToolLoopDetailed(terminalAwareProvider, [
        { role: 'system', content: buildAskV2AnalystSystemPrompt(state) },
        ...(openingContext
          ? [{
            role: 'user' as const,
            content: 'Admitted context from the immutable snapshot for this question. These are the only identifiers you may reference;'
              + ' call describe_relation for a relation\'s full column list, or inspect_ask_context with expand for more cards.\n'
              + openingContext,
          }]
          : []),
        ...(conversationBrief ? [{ role: 'user' as const, content: conversationBrief }] : []),
        { role: 'user', content: input.question },
      ], tools, {
        ...(input.signal ? { signal: input.signal } : {}),
        // The V2 tool runtime owns one initial agent-control transport and
        // then bounded follow-ups.  The text loop advances the additive
        // phase after the first send; native transports do the same at their
        // physical attempt boundary in the provider wrapper.
        dispatchPhase: 'agent_control',
        egressPurpose: 'answer_generation',
        // V2's legal responses are tool calls only. The default contract
        // invites a raw-SQL final answer, which this lane cannot accept and
        // the parser cannot even read as a tool call.
        textToolContract: buildAskV2TextToolContract,
        maxToolCalls: limits?.maxToolCalls ?? (state.turnClass === 'research' ? 24 : state.turnClass === 'analytics' || state.turnClass === 'prior_result' ? 8 : 4),
        // A compound question — a time filter, a metric and a breakdown — costs
        // an inspection per tier, at least one compile attempt, and a reserved
        // send for finish_answer. At six the narration turn was the one that
        // got cut: the query had already executed and validated, and the user
        // was shown "stopped at its own orchestration budget" instead of the
        // rows DQL was holding. Ten matches the run-level ceiling so the two
        // budgets cannot disagree about how much room the analyst really has.
        // PHYSICAL sends, not logical round trips: a wrapper provider (the
        // claude-code/codex passthrough) spends TWO physical sends per
        // logical turn, so a cap of 10 gave those providers only five turns —
        // the cold big-repo discovery ladder alone costs five, leaving zero
        // room to apply a taught refusal. Sixteen restores eight logical
        // turns for wrappers; 1:1 text providers are still bounded by the
        // tool-call ceiling and the run deadline long before this guard.
        maxProviderDispatches: limits?.maxProviderDispatches ?? (state.turnClass === 'research' ? 12 : state.turnClass === 'analytics' || state.turnClass === 'prior_result' ? 24 : 4),
        // The kernel owns current availability. Native transports evaluate it
        // before each API tool declaration; text transports receive the same
        // update after every observation. This reserves a final *LLM action*
        // when discovery has already established a compatible semantic tier.
        getCurrentToolPolicy: () => kernel.toolPolicy(),
        // Native OpenAI/Claude loops and text-protocol turns both pass through
        // the same provider wrapper. It calls this for every physical send;
        // a provider cannot label its own discovery/execution request as
        // narration because `completed` changes only after the host validates
        // an execution result above.
        resolvePhysicalDispatchPhase: () => (
          requiredNarrationControl() ? 'narration' : undefined
        ),
        providerPayloadGuard: input.providerPayloadGuard,
      });
    } catch (error) {
      // A physical provider failure that arrives after a validated result must
      // not erase that result.  Prefer the explicit host `finish_answer`, but
      // if its transport turn fails, close with deterministic result facts.
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      const reasonCode = code === 'RUN_SOFT_TARGET_EXCEEDED' || code === 'RUN_DEADLINE_INSUFFICIENT'
        ? code
        : 'ASK_V2_PROVIDER_AGENT_CONTROL_FAILED';
      const preserved = preserveCompletedResult(reasonCode, reasonCode === 'ASK_V2_PROVIDER_AGENT_CONTROL_FAILED' ? 'provider' : 'narration');
      if (preserved) return preserved;
      observe('finish_answer', 'error', reasonCode, {
        origin: reasonCode === 'ASK_V2_PROVIDER_AGENT_CONTROL_FAILED' ? 'provider' : 'narration',
        ...(reasonCode === 'ASK_V2_PROVIDER_AGENT_CONTROL_FAILED' ? {} : {
          provider: {
            phase: 'narration' as const,
            cause: 'run_deadline' as const,
            retryable: false,
            safeAction: 'retry_after_run_deadline',
          },
        }),
      });
      return askV2NoAnswer(input, 'provider_failure', reasonCode, reasonCode === 'ASK_V2_PROVIDER_AGENT_CONTROL_FAILED' ? 'provider' : 'narration');
    }
    // A native provider can report a tool-loop budget terminal after it has
    // already completed the canonical host `finish_answer` callback. The
    // callback owns the final narration and validated result; do not let a
    // transport's attempt to obtain another planner turn overwrite it with a
    // synthetic budget failure. Text transports stop at the same boundary in
    // `runTextProtocolToolLoopDetailed`.
    const completedAndNarrated = Boolean(completed && state.observations.some((observation) => (
      observation.tool === 'finish_answer'
      && observation.outcome === 'eligible'
      && observation.reasonCode === 'ASK_V2_RESULT_NARRATED'
    )));
    if (completedAndNarrated) return askV2ExecutedAnswer(input, completed!, finalText ?? loop.text);
    // A typed semantic validation observation is more useful than a generic
    // no-result when the controller has no remaining correction turn. This
    // includes a missing/ambiguous explicit time axis as well as host-owned
    // engine readiness. A frozen execution boundary still takes precedence.
    const terminalSemanticValidationReasonCodes = new Set([
      'SEMANTIC_ENGINE_UNAVAILABLE',
      'SEMANTIC_TIME_DIMENSION_INVALID',
      'SEMANTIC_TIME_GRAIN_WITHOUT_TIME_DIMENSION',
      'SEMANTIC_TIME_GRAIN_NOT_DECLARED',
      'SEMANTIC_TIME_GRAIN_MISMATCH',
      'SEMANTIC_TIME_DIMENSION_INCOMPATIBLE',
      'SEMANTIC_TIME_DIMENSION_COMPATIBILITY_UNDECLARED',
      'SEMANTIC_TIME_DIMENSION_UNAVAILABLE',
      'SEMANTIC_TIME_DIMENSION_AMBIGUOUS',
      'SEMANTIC_TIME_BINDING_COMPLETION_EXHAUSTED',
      'SEMANTIC_FISCAL_CALENDAR_REQUIRED',
      'SEMANTIC_FISCAL_FILTER_INVALID',
    ]);
    const semanticValidationObservation = [...state.observations].reverse().find((observation) => (
      observation.tool === 'compile_and_run_semantic'
      && observation.origin === 'validation'
      && terminalSemanticValidationReasonCodes.has(observation.reasonCode)
    ));
    const terminalSemanticValidationObservation = () => {
      // Once a plan has frozen, a historical pre-freeze engine selection
      // rejection is no longer the terminal truth. The compiler/connection/
      // result boundary owns the incident, and may allow only its same-plan
      // repair. Never let a stale validation observation mask it.
      if (!semanticValidationObservation || state.resolvedPlan?.frozen || executionFailure) return undefined;
      const safeAction = semanticValidationObservation.safeAction ?? 'use:compile_and_run_semantic';
      finishAskAgentV2Turn(state, {
        version: 2,
        kind: 'gap',
        reasonCode: semanticValidationObservation.reasonCode,
        origin: 'validation',
        safeAction,
      });
      return askV2NoAnswer(input, 'gap', semanticValidationObservation.reasonCode, 'validation');
    };
    if (loop.stop !== 'final') {
      const reasonCode = loop.stop === 'tool_budget_exhausted'
        ? 'ASK_TOOL_BUDGET_EXHAUSTED'
        : loop.stop === 'provider_dispatch_budget_exhausted'
          ? 'ASK_PROVIDER_DISPATCH_BUDGET_EXHAUSTED'
          : loop.stop === 'invalid_tool_response'
            ? 'ASK_V2_INVALID_TOOL_RESPONSE'
          : loop.stop === 'run_soft_target_exceeded'
            ? 'RUN_SOFT_TARGET_EXCEEDED'
            : 'RUN_DEADLINE_INSUFFICIENT';
      const narrationDeadline = loop.stop === 'run_soft_target_exceeded' || loop.stop === 'run_deadline_insufficient';
      const providerDispatchBudget = loop.stop === 'provider_dispatch_budget_exhausted';
      const invalidToolResponse = loop.stop === 'invalid_tool_response';
      const terminalOrigin = narrationDeadline
        ? 'narration' as const
        : providerDispatchBudget || invalidToolResponse
          ? 'provider' as const
          : 'agent_control' as const;
      const preserved = preserveCompletedResult(reasonCode, terminalOrigin);
      if (preserved) return preserved;
      // Execution is already frozen and has reached a physical boundary. Its
      // typed failure remains authoritative even if the provider later uses
      // its remaining dispatches without producing a finish control.
      if (executionFailure) {
        finishAskAgentV2Turn(state, {
          version: 2,
          kind: 'execution_failure',
          reasonCode: executionFailure.reasonCode,
          origin: executionFailure.origin,
          safeAction: executionFailure.reasonCode === 'SEMANTIC_EXECUTION_TARGET_MISMATCH'
            ? 'inspect_execution_target'
            : 'retry_same_frozen_plan',
        });
        return askV2NoAnswer(
          input,
          'execution_failure',
          executionFailure.reasonCode,
          executionFailure.origin,
          executionFailure.reasonCode === 'SEMANTIC_EXECUTION_TARGET_MISMATCH'
            ? 'inspect_execution_target'
            : undefined,
        );
      }
      // The engine binding itself is the highest-fidelity terminal incident.
      // Do not overwrite it with a later transport budget marker merely
      // because the controller did not correct the allowed same-tool input.
      const semanticTerminal = terminalSemanticValidationObservation();
      if (semanticTerminal) return semanticTerminal;
      observe('finish_answer', 'error', reasonCode, {
        origin: terminalOrigin,
        ...(narrationDeadline ? {
          provider: {
            phase: 'narration' as const,
            cause: 'run_deadline' as const,
            retryable: false,
            safeAction: 'retry_after_run_deadline',
          },
        } : providerDispatchBudget ? {
          provider: {
            phase: 'tool_followup' as const,
            cause: 'dispatch_budget' as const,
            retryable: false,
            safeAction: 'inspect_run',
          },
        } : invalidToolResponse ? {
          provider: {
            phase: 'tool_followup' as const,
            cause: 'unknown' as const,
            retryable: false,
            safeAction: 'retry_with_required_tool',
          },
        } : {}),
      });
      finishAskAgentV2Turn(state, {
        version: 2,
        kind: invalidToolResponse ? 'provider_failure' : 'budget_exhausted',
        reasonCode,
        origin: terminalOrigin,
        safeAction: narrationDeadline
          ? 'retry_after_run_deadline'
          : invalidToolResponse
            ? 'retry_with_required_tool'
          : loop.stop === 'tool_budget_exhausted'
          ? 'inspect_tool_progression_then_retry'
          : 'retry_within_provider_dispatch_budget',
      });
      return askV2NoAnswer(input, invalidToolResponse ? 'provider_failure' : 'budget_exhausted', reasonCode, terminalOrigin, invalidToolResponse ? 'retry_with_required_tool' : undefined);
    }
    if (clarification) return {
      kind: 'no_answer', sourceTier: 'no_answer', certification: 'analyst_review_required', reviewStatus: 'analyst_review_required',
      refusalCode: 'ambiguous', text: clarification.message, answer: clarification.message, citations: [], considered: [],
      clarificationOptions: clarification.options.map((option) => ({ id: option.id, label: option.label })),
      contextPack: input.contextPack,
      askAgentV2Outcome: { version: 2, kind: 'clarification', reasonCode: 'ASK_V2_CLARIFICATION_REQUESTED', origin: 'agent_control' },
    };
    // The dynamic tool policy requires a host-validated `finish_answer`
    // after execution. This is a defensive fallback for a legacy/custom
    // transport that incorrectly returns a final prose turn instead: retain
    // the validated result with deterministic facts rather than accepting
    // unvalidated narration or turning it into a no-answer.
    if (completed) {
      return preserveCompletedResult('ASK_V2_TERMINAL_NARRATION_REQUIRED', 'agent_control')!;
    }
    // A tool that reached a physical execution boundary owns this terminal
    // incident.  Do not convert it into a vague coverage gap or let a later
    // contextual branch hide the connection/validation failure.
    if (executionFailure) {
      finishAskAgentV2Turn(state, {
        version: 2,
        kind: 'execution_failure',
        reasonCode: executionFailure.reasonCode,
        origin: executionFailure.origin,
        safeAction: executionFailure.reasonCode === 'SEMANTIC_EXECUTION_TARGET_MISMATCH'
          ? 'inspect_execution_target'
          : 'retry_same_frozen_plan',
      });
      return askV2NoAnswer(
        input,
        'execution_failure',
        executionFailure.reasonCode,
        executionFailure.origin,
        executionFailure.reasonCode === 'SEMANTIC_EXECUTION_TARGET_MISMATCH'
          ? 'inspect_execution_target'
          : undefined,
      );
    }
    // A final no-tool response after this validation failure retains the same
    // precise semantic contract terminal rather than becoming a generic
    // no-executable-result response.
    const semanticTerminal = terminalSemanticValidationObservation();
    if (semanticTerminal) return semanticTerminal;
    if (state.turnClass === 'definition' || state.turnClass === 'business_context' || state.turnClass === 'general') {
      const text = (finalText ?? loop.text).trim() || 'I could not find enough retrieved context to answer that definition or business-context question.';
      const contextualEvidenceBound = (state.turnClass === 'definition' || state.turnClass === 'business_context')
        && state.observations.some((observation) => observation.tool === 'inspect_business_context'
          && observation.outcome === 'eligible')
        && state.observations.some((observation) => observation.tool === 'finish_answer'
          && observation.outcome === 'eligible'
          && observation.candidateIds.length > 0);
      return {
        kind: 'uncertified',
        sourceTier: 'business_context',
        certification: contextualEvidenceBound ? 'governed' : 'analyst_review_required',
        reviewStatus: contextualEvidenceBound ? 'governed' : 'analyst_review_required',
        text, answer: text, citations: [], considered: [], contextPack: input.contextPack,
        askAgentV2Outcome: { version: 2, kind: 'finish_answer', reasonCode: contextualEvidenceBound ? 'ASK_V2_CONTEXTUAL_ANSWER' : 'ASK_V2_GENERAL_UNGROUNDED_ANSWER', origin: 'narration' },
      };
    }
    if (state.terminalOutcome?.reasonCode === 'ASK_V2_REMAINING_TIERS_DECLINED') {
      return askV2NoAnswer(input, 'gap', 'ASK_V2_REMAINING_TIERS_DECLINED', 'agent_control');
    }
    const progress = kernel.toolPolicy();
    if (progress.terminalActionToolNames?.length) {
      observe('finish_answer', 'ineligible', 'ASK_V2_TOOL_PROGRESSION_REQUIRED', {
        origin: 'agent_control',
        safeAction: `use:${progress.terminalActionToolNames.join(',')}`,
      });
      return askV2NoAnswer(input, 'gap', 'ASK_V2_TOOL_PROGRESSION_REQUIRED', 'agent_control');
    }
    return askV2NoAnswer(input, 'gap', 'ASK_V2_NO_EXECUTABLE_TOOL_RESULT', 'tool', undefined, await requestedUnmodeledTerm());
  };
}

interface AskV2ResearchHypothesis {
  id: string;
  kind: 'analytical' | 'lineage';
  question: string;
  /** Optional opaque host handle for an already-frozen analytical child. */
  frozenChildId?: string;
}

/**
 * Parse only a provider-authored explicit research plan.  There is no
 * heuristic branch generation here: a malformed or too-thin plan remains a
 * limited-scope observation instead of pretending that several hypotheses
 * were investigated.
 */
function parseAskV2ResearchHypotheses(text: string): AskV2ResearchHypothesis[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  let value: unknown;
  try {
    value = JSON.parse(fenced.trim());
  } catch {
    return [];
  }
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { hypotheses?: unknown }).hypotheses
    : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 6).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const kind = record.kind === 'lineage' ? 'lineage' : record.kind === 'analytical' ? 'analytical' : undefined;
    const question = typeof record.question === 'string' ? record.question.trim() : '';
    if (!kind || !question || question.length > 1_000) return [];
    const frozenChildId = kind === 'analytical' && typeof record.frozenChildId === 'string'
      && record.frozenChildId.trim().length > 0
      ? record.frozenChildId.trim()
      : undefined;
    // Do not persist provider-controlled labels as durable receipt IDs.
    return [{ id: `research:branch:${index + 1}`, kind, question, ...(frozenChildId ? { frozenChildId } : {}) }];
  });
}

function createResearchBranchState(
  root: AskAgentStateV4,
): AskAgentStateV4 {
  return {
    ...root,
    // A child operates the ordinary V2 cascade against the exact same
    // snapshot/workspace. It has no parent observations or frozen plan to
    // inherit, which prevents an analytical result from becoming lineage
    // evidence or from silently choosing a parent route.
    turnClass: 'analytics',
    observations: [],
    tierAttempts: [],
    resolvedPlan: undefined,
    terminal: undefined,
    terminalOutcome: undefined,
  };
}

/**
 * Execute a root-frozen Research child without a provider turn. The callback
 * is a host capability captured alongside the root V2 snapshot—not a generic
 * route/plan replay—and must return a fully frozen child receipt. This keeps a
 * selected certified/semantic child from entering either the V1 controller or
 * another V2 planner loop after its business meaning is already settled.
 */
async function runAskV2FrozenResearchChild(
  input: AnswerLoopInput,
  root: AskAgentStateV4,
  workspace: AskAgentToolWorkspaceV2,
  frozenChildId: string,
): Promise<{ child: AskAgentStateV4; answer: AgentAnswer }> {
  const fallback = createResearchBranchState(root);
  const handle = workspace.frozenResearchChildren?.get(frozenChildId);
  const fail = (reasonCode: string): { child: AskAgentStateV4; answer: AgentAnswer } => {
    observeAskAgentV2Tool(fallback, {
      version: 1,
      tool: 'inspect_ask_context',
      outcome: 'denied',
      reasonCode,
      candidateIds: [],
      origin: 'validation',
    });
    return {
      child: fallback,
      answer: askV2NoAnswer(input, 'denied', reasonCode, 'validation'),
    };
  };
  const retained = new Set(root.retainedCandidateIds);
  if (!handle
    || handle.version !== 1
    || handle.snapshotId !== root.snapshotId
    || handle.sourceFingerprint !== root.sourceFingerprint
    || handle.candidateIds.length === 0
    || handle.candidateIds.some((id) => !retained.has(id))
    || handle.binding?.version !== 1
    || !handle.binding.planFingerprint
    || (handle.tier === 'certified' && (handle.binding.trustState !== 'certified' || !handle.binding.artifactRevisionFingerprint))
    || (handle.tier === 'semantic' && (handle.binding.trustState !== 'governed' || !(handle.binding.capabilityFingerprints?.length)))) {
    return fail('RESEARCH_FROZEN_CHILD_NOT_ADMITTED_TO_SNAPSHOT');
  }
  if (!handle.isCurrent()) return fail('RESEARCH_FROZEN_CHILD_CAPABILITY_STALE');
  try {
    const result = await handle.execute(root);
    const child = result?.state;
    const answer = result?.answer as AgentAnswer | undefined;
    const plan = child?.resolvedPlan;
    const exactCandidateSet = plan
      && plan.candidateIds.length === handle.candidateIds.length
      && plan.candidateIds.every((id) => handle.candidateIds.includes(id));
    if (!child
      || child.mode !== 'authoritative_v2'
      || child.snapshotId !== root.snapshotId
      || child.sourceFingerprint !== root.sourceFingerprint
      || !plan?.frozen
      || plan.tier !== handle.tier
      || !exactCandidateSet
      || plan.fingerprint !== handle.binding.planFingerprint
      || !answer) {
      return fail('RESEARCH_FROZEN_CHILD_CAPABILITY_MISMATCH');
    }
    return { child, answer };
  } catch {
    return fail('RESEARCH_FROZEN_CHILD_EXECUTION_FAILED');
  }
}

/** Dedicated, read-only lineage branch. It never reuses an analytical result. */
function runAskV2DedicatedLineageBranch(
  state: AskAgentStateV4,
  workspace: AskAgentToolWorkspaceV2,
): Promise<AskV2ResearchBranchReceiptInput> {
  const relationCandidates = workspace.candidates
    .filter((candidate) => state.retainedCandidateIds.includes(v2CandidateId(candidate)))
    .filter((candidate) => candidate.kind === 'dql_modeling'
      || candidate.kind === 'dbt_model'
      || candidate.kind === 'dbt_source'
      || candidate.kind === 'sql_column'
      || candidate.kind === 'sql_table');
  const paths = state.relationshipPathHandles;
  const evidenceHandleIds = paths.length > 0
    ? paths.map((path) => path.id)
    : relationCandidates.map(v2CandidateId).slice(0, 24);
  const hostProgram = workspace.runDedicatedLineageProgram;
  if (hostProgram) {
    // The root-frozen program only accepts one exact admitted graph target.
    // A broad relation list is context, not authority to pick a branch target
    // by lexical order; report it as limited/ambiguous rather than inventing a
    // structural path.
    const targetCandidateIds = relationCandidates.length === 1
      ? [v2CandidateId(relationCandidates[0]!)]
      : [];
    if (targetCandidateIds.length === 0) {
      observeAskAgentV2Tool(state, {
        version: 1,
        tool: 'inspect_relational_context',
        outcome: 'ambiguous',
        tier: 'governed_relational',
        reasonCode: 'RESEARCH_LINEAGE_TARGET_AMBIGUOUS',
        candidateIds: relationCandidates.map(v2CandidateId),
        origin: 'validation',
      });
      return Promise.resolve({
        id: 'pending',
        verdict: 'inconclusive',
        evidenceHandleIds: [],
        lineageProgram: 'dedicated',
      });
    }
    try {
      const lineage = hostProgram({
        snapshotId: state.snapshotId,
        targetCandidateIds,
        relationshipPathIds: paths.map((path) => path.id),
      });
      const terminallyUnavailable = lineage.status === 'missing'
        || lineage.status === 'ambiguous'
        || lineage.status === 'stale'
        || lineage.status === 'unavailable';
      observeAskAgentV2Tool(state, {
        version: 1,
        tool: 'inspect_relational_context',
        outcome: terminallyUnavailable ? 'unavailable' : 'executed',
        tier: 'governed_relational',
        reasonCode: terminallyUnavailable
          ? `RESEARCH_LINEAGE_${lineage.status.toUpperCase()}`
          : 'RESEARCH_DEDICATED_LINEAGE_EVIDENCE',
        candidateIds: targetCandidateIds,
        origin: 'tool',
      });
      return Promise.resolve({
        id: 'pending',
        // A structural graph is deliberately not a causal analytic claim. A
        // completed lineage receipt remains inconclusive even when it found
        // dependencies; its validator handles are carried for synthesis.
        verdict: 'inconclusive',
        evidenceHandleIds: lineage.evidenceHandleIds.slice(0, 24),
        ...(lineage.validatorEvidenceHandleIds?.length
          ? { validatorEvidenceHandleIds: lineage.validatorEvidenceHandleIds.slice(0, 24) }
          : {}),
        ...(lineage.counterEvidenceHandleIds?.length
          ? { counterEvidenceHandleIds: lineage.counterEvidenceHandleIds.slice(0, 24) }
          : {}),
        ...(lineage.receiptFingerprint ? { childReceiptFingerprint: lineage.receiptFingerprint } : {}),
        lineageProgram: 'dedicated',
      });
    } catch {
      observeAskAgentV2Tool(state, {
        version: 1,
        tool: 'inspect_relational_context',
        outcome: 'unavailable',
        tier: 'governed_relational',
        reasonCode: 'RESEARCH_LINEAGE_PROGRAM_UNAVAILABLE',
        candidateIds: targetCandidateIds,
        origin: 'tool',
      });
      return Promise.resolve({ id: 'pending', verdict: 'inconclusive', evidenceHandleIds: [], lineageProgram: 'dedicated' });
    }
  }
  observeAskAgentV2Tool(state, {
    version: 1,
    tool: 'inspect_relational_context',
    outcome: evidenceHandleIds.length > 0 ? 'executed' : 'unavailable',
    tier: 'governed_relational',
    reasonCode: evidenceHandleIds.length > 0 ? 'RESEARCH_DEDICATED_LINEAGE_EVIDENCE' : 'RESEARCH_LINEAGE_EVIDENCE_UNAVAILABLE',
    candidateIds: relationCandidates.map(v2CandidateId),
    origin: 'tool',
  });
  return Promise.resolve({
    id: 'pending',
    verdict: evidenceHandleIds.length > 0 ? 'inconclusive' : 'inconclusive',
    evidenceHandleIds,
    lineageProgram: 'dedicated',
  });
}

/**
 * A Research analytical branch is supported only when a host execution has a
 * complete, internally consistent receipt or an already-built deterministic
 * fact set.  A tool merely returning `executed` is not evidence: that fact
 * can exist before a result contract is persisted, and it must not turn an
 * empty/failed/cancelled branch into a research conclusion.
 */
function askV2ResearchAnalyticalBranchReceipt(
  input: {
    id: string;
    child: AskAgentStateV4;
    answer: AgentAnswer;
  },
): AskV2ResearchBranchReceiptInput {
  const { child, answer } = input;
  const result = answer.result;
  const receipt = result?.executionReceipt;
  const isFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  const resultFingerprint = isFingerprint(result?.resultFingerprint)
    ? result!.resultFingerprint!.toLowerCase()
    : isFingerprint(receipt?.resultFingerprint)
      ? receipt!.resultFingerprint.toLowerCase()
      : undefined;
  const receiptValid = Boolean(
    receipt
    && isFingerprint(receipt.sourceFingerprint)
    && isFingerprint(receipt.compiledSqlFingerprint)
    && isFingerprint(receipt.parameterFingerprint)
    && isFingerprint(receipt.resultFingerprint)
    && resultFingerprint === receipt.resultFingerprint.toLowerCase(),
  );
  const factSet = answer.analyticalFacts;
  const factsValid = Boolean(
    factSet
    && resultFingerprint
    && factSet.resultFingerprint.toLowerCase() === resultFingerprint
    && factSet.facts.every((fact) => fact.resultFingerprint.toLowerCase() === resultFingerprint),
  );
  const physicalExecution = child.observations.some((observation) => observation.outcome === 'executed' && observation.origin === 'execution');
  const validated = physicalExecution && (receiptValid || factsValid);
  const terminalFailure = answer.askAgentV2Outcome?.kind === 'provider_failure'
    || answer.askAgentV2Outcome?.kind === 'execution_failure'
    || answer.askAgentV2Outcome?.kind === 'denied';
  const candidateIds = [...new Set(child.observations.flatMap((observation) => observation.candidateIds))].slice(0, 24);
  const validatorEvidenceHandleIds = [
    ...(receiptValid && receipt ? [`receipt:${receipt.resultFingerprint.toLowerCase()}`] : []),
    ...(factsValid && factSet ? [`fact-set:${factSet.factSetId}`] : []),
  ];
  // A caveat fact is preserved as counter-evidence, but does not by itself
  // imply contradiction or causality.  We never manufacture a counter claim
  // from an executed row set.
  const counterEvidenceHandleIds = factsValid && factSet
    ? factSet.facts.filter((fact) => fact.kind === 'caveat').map((fact) => `fact:${fact.factId}`).slice(0, 24)
    : [];
  const childReceiptFingerprint = runtimeFingerprint(JSON.stringify({
    snapshotId: child.snapshotId,
    terminal: answer.askAgentV2Outcome?.kind ?? 'none',
    observations: child.observations.map((observation) => ({
      tool: observation.tool,
      outcome: observation.outcome,
      reasonCode: observation.reasonCode,
      origin: observation.origin,
    })),
    ...(resultFingerprint ? { resultFingerprint } : {}),
  }));
  return {
    id: input.id,
    verdict: validated ? 'supported' : terminalFailure ? 'failed' : 'inconclusive',
    evidenceHandleIds: [
      ...candidateIds,
      ...(validated && resultFingerprint ? [`result:${resultFingerprint}`] : []),
    ].slice(0, 24),
    ...(validatorEvidenceHandleIds.length ? { validatorEvidenceHandleIds } : {}),
    ...(counterEvidenceHandleIds.length ? { counterEvidenceHandleIds } : {}),
    childReceiptFingerprint,
    lineageProgram: 'not_run',
  };
}

/**
 * Explicit Research remains one V2 runtime: the provider first proposes real
 * hypotheses from the immutable safe cards, each analytical child runs an
 * isolated V2 cascade, and lineage receives its own snapshot program.  No
 * legacy research controller, V1 answer loop, or fabricated branch list is
 * involved.
 */
function createAskV2ResearchLaneHandler(state: AskAgentStateV4) {
  return async (input: AnswerLoopInput): Promise<AgentAnswer> => {
    const workspace = v2WorkspaceForInput(input, state);
    if (!workspace) {
      observeAskAgentV2Tool(state, {
        version: 1, tool: 'inspect_ask_context', outcome: 'unavailable',
        reasonCode: 'V2_WORKSPACE_SNAPSHOT_MISMATCH', candidateIds: [], origin: 'retrieval',
      });
      return askV2NoAnswer(input, 'gap', 'V2_WORKSPACE_SNAPSHOT_MISMATCH', 'retrieval');
    }
    const initialCards = workspace.candidates
      .filter((candidate) => state.initialCandidateIds.includes(v2CandidateId(candidate)))
      .map((candidate) => v2SafeCard(candidate, workspace));
    observeAskAgentV2Tool(state, {
      version: 1,
      tool: 'inspect_ask_context',
      outcome: initialCards.length > 0 ? 'eligible' : 'unavailable',
      reasonCode: initialCards.length > 0 ? 'RESEARCH_SNAPSHOT_CONTEXT_AVAILABLE' : 'RESEARCH_SNAPSHOT_CONTEXT_EMPTY',
      candidateIds: state.initialCandidateIds,
      origin: 'retrieval',
    });

    let planText: string;
    try {
      planText = await input.provider.generate([
        {
          role: 'system',
          content: 'Plan explicit analytics research from only the supplied immutable snapshot cards. Return JSON only: {"hypotheses":[{"kind":"analytical"|"lineage","question":"...","frozenChildId?":"opaque host handle"}]}. Produce 3 to 6 hypotheses only when the cards ground them. Include at most one lineage hypothesis. When a listed root-frozen child exactly matches an analytical hypothesis, echo its frozenChildId unchanged; otherwise omit it. Never invent identifiers, SQL, facts, or causal claims.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: input.question,
            snapshotId: state.snapshotId,
            cards: initialCards,
            relationshipPathHandles: state.relationshipPathHandles.map((path) => ({ id: path.id, edgeIds: path.edgeIds, candidateIds: path.candidateIds })),
            // These are opaque, host-authorized child capabilities. They are
            // only meaningful for an analytical hypothesis and must be echoed
            // as `frozenChildId`; the host rejects any invented/stale ID.
            frozenResearchChildren: [...(workspace.frozenResearchChildren?.values() ?? [])]
              .filter((child) => child.snapshotId === state.snapshotId && child.sourceFingerprint === state.sourceFingerprint)
              .map((child) => ({ id: child.id, tier: child.tier, candidateIds: child.candidateIds })),
          }),
        },
      ], {
        ...(input.signal ? { signal: input.signal } : {}),
        maxProviderDispatches: 1,
      });
    } catch {
      observeAskAgentV2Tool(state, {
        version: 1, tool: 'finish_answer', outcome: 'error', reasonCode: 'RESEARCH_HYPOTHESIS_PROVIDER_FAILED', candidateIds: [], origin: 'provider',
      });
      return askV2NoAnswer(input, 'provider_failure', 'RESEARCH_HYPOTHESIS_PROVIDER_FAILED', 'provider');
    }

    const hypotheses = parseAskV2ResearchHypotheses(planText);
    if (hypotheses.length === 0) {
      recordAskV2ResearchLedger(state, []);
      observeAskAgentV2Tool(state, {
        version: 1, tool: 'finish_answer', outcome: 'unavailable', reasonCode: 'RESEARCH_HYPOTHESES_NOT_GROUNDABLE', candidateIds: [], origin: 'agent_control',
      });
      return askV2NoAnswer(input, 'gap', 'RESEARCH_HYPOTHESES_NOT_GROUNDABLE', 'agent_control');
    }

    const branchReceipts: AskV2ResearchBranchReceiptInput[] = [];
    // The hypothesis proposal already consumed one of Research's twelve
    // physical provider sends. Divide the remaining budget across actual
    // analytical children before any child starts, so independently bounded
    // child loops cannot add up to an unbounded parent Research run.
    const analyticalBranchCount = hypotheses.filter((hypothesis) => hypothesis.kind === 'analytical').length;
    const perAnalyticalBranchDispatches = analyticalBranchCount > 0
      ? Math.max(1, Math.floor((ASK_V2_BUDGETS.research.providerDispatches - 1) / analyticalBranchCount))
      : 0;
    const perAnalyticalBranchTools = Math.min(6, Math.max(0, perAnalyticalBranchDispatches - 1));
    for (const hypothesis of hypotheses) {
      const child = createResearchBranchState(state);
      if (hypothesis.kind === 'lineage') {
        const lineage = await runAskV2DedicatedLineageBranch(child, workspace);
        branchReceipts.push({ ...lineage, id: hypothesis.id });
        continue;
      }
      if (hypothesis.frozenChildId) {
        // A root-frozen child is a provider-free execution capability. It
        // cannot reroute through V1 or issue a second agent-control request.
        const frozen = await runAskV2FrozenResearchChild(input, state, workspace, hypothesis.frozenChildId);
        branchReceipts.push(askV2ResearchAnalyticalBranchReceipt({
          id: hypothesis.id,
          child: frozen.child,
          answer: frozen.answer,
        }));
        continue;
      }
      const childInput: AnswerLoopInput = { ...input, question: hypothesis.question };
      const childAnswer = await createAskV2LaneHandler(child, {
        maxToolCalls: perAnalyticalBranchTools,
        maxProviderDispatches: perAnalyticalBranchDispatches,
      })(childInput);
      branchReceipts.push(askV2ResearchAnalyticalBranchReceipt({
        id: hypothesis.id,
        child,
        answer: childAnswer,
      }));
    }
    const ledger = recordAskV2ResearchLedger(state, branchReceipts)!;
    // Synthesis is deliberately receipt-backed.  It does not repeat branch
    // counts as a pretend answer and it never promotes a returned row set or
    // structural lineage edge into a causal conclusion.  The branch question
    // is a user-visible hypothesis; the supporting/limiting wording comes
    // only from its durable validator/counter-evidence receipt.
    const hypothesisById = new Map(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis] as const));
    const supportedBranches = ledger.branches.filter((branch) => branch.verdict === 'supported');
    const contradictedBranches = ledger.branches.filter((branch) => branch.verdict === 'contradicted');
    const counterEvidenceBranches = ledger.branches.filter((branch) => (branch.counterEvidenceHandleIds?.length ?? 0) > 0);
    const limitedBranches = ledger.branches.filter((branch) => branch.verdict === 'failed'
      || branch.verdict === 'inconclusive'
      || branch.verdict === 'skipped');
    const label = (branch: typeof ledger.branches[number]) => hypothesisById.get(branch.id)?.question
      ?? `research branch ${branch.id.replace(/^research:branch:/, '')}`;
    const findings = supportedBranches.length > 0
      ? supportedBranches.map((branch) => `- Validated result evidence was retained for: ${label(branch)}.`).join('\n')
      : '- No branch produced a fully validated analytical finding.';
    const counterEvidence = [...contradictedBranches, ...counterEvidenceBranches]
      .filter((branch, index, values) => values.findIndex((value) => value.id === branch.id) === index)
      .map((branch) => `- ${label(branch)} has recorded counter-evidence or a contradictory validator result.`)
      .join('\n') || '- No deterministic counter-evidence was retained; absence of counter-evidence is not proof of causality.';
    const limitations = [
      ...(ledger.limitedScope ? ['- Limited research scope: fewer than three groundable hypotheses were available from this snapshot.'] : []),
      ...limitedBranches.map((branch) => `- ${label(branch)} remained ${branch.verdict}; it is not used as a conclusion.`),
    ].join('\n') || '- Findings are limited to the validated receipts and the immutable retrieval snapshot for this run.';
    const followUps = supportedBranches.length > 0
      ? '- Open a validated branch result to inspect its data and ask a scoped follow-up on the same result binding.'
      : '- Refine the business metric, entity, or time frame, then rerun Research against a refreshed snapshot.';
    const text = `Research summary\n\nFindings\n${findings}\n\nCounter-evidence\n${counterEvidence}\n\nLimitations\n${limitations}\n\nFollow-up\n${followUps}`;
    observeAskAgentV2Tool(state, {
      version: 1, tool: 'finish_answer', outcome: 'eligible', reasonCode: 'RESEARCH_BRANCHES_COMPLETED', candidateIds: [], origin: 'narration',
    });
    finishAskAgentV2Turn(state, { version: 2, kind: 'finish_answer', reasonCode: 'RESEARCH_BRANCHES_COMPLETED', origin: 'narration' });
    return {
      kind: 'uncertified',
      sourceTier: 'business_context',
      certification: 'analyst_review_required',
      reviewStatus: 'analyst_review_required',
      text,
      answer: text,
      citations: [],
      considered: [],
      contextPack: input.contextPack,
      askAgentV2Outcome: { version: 2, kind: 'finish_answer', reasonCode: 'RESEARCH_BRANCHES_COMPLETED', origin: 'narration' },
    };
  };
}

function askV2NoAnswer(
  input: AnswerLoopInput,
  kind: NonNullable<AgentAnswer['askAgentV2Outcome']>['kind'],
  reasonCode: string,
  origin: NonNullable<AgentAnswer['askAgentV2Outcome']>['origin'],
  safeActionOverride?: string,
  modelingGap?: { term: string; admitted: string[] },
): AgentAnswer {
  const dispatchBudget = kind === 'budget_exhausted' && reasonCode === 'ASK_PROVIDER_DISPATCH_BUDGET_EXHAUSTED';
  const semanticToolContract = reasonCode === 'SEMANTIC_ENGINE_UNAVAILABLE';
  const semanticExecutionTargetMismatch = reasonCode === 'SEMANTIC_EXECUTION_TARGET_MISMATCH';
  const semanticFailure = semanticToolContract
    ? createAnalyticalFailure({
      code: 'COMPILATION_FAILED',
      phase: 'validation',
      snapshotId: input.askAgentV2Workspace?.getToolWorkspace?.()?.snapshotId
        ?? input.contextPack?.knowledgeLens?.snapshotId
        ?? 'snapshot-unavailable',
      error: { code: reasonCode, message: 'The configured semantic runtime is not ready for the snapshot-bound metric.' },
      failedBindings: [{ role: 'semantic_engine', reasonCode }],
    })
    : undefined;
  const text = semanticToolContract
    ? 'The configured semantic runtime is not ready for the selected snapshot-bound metric. Review semantic adapter readiness, then retry.'
    : semanticExecutionTargetMismatch
    ? 'DQL stopped before execution because the compiled semantic query did not match the frozen execution target. Review the execution target and trace; no query was run.'
    : dispatchBudget
    ? 'The Ask runtime reached its bounded provider-dispatch limit before it could execute a plan. No query was run. Review the trace, then retry.'
    : kind === 'provider_failure'
    ? 'The AI provider could not complete this Ask step. Check provider readiness, then retry.'
    : kind === 'execution_failure'
      ? reasonCode === 'SEMANTIC_FILTER_NOT_COMPILED'
        ? 'The governed semantic engine could not apply the required member filter, and DQL refused to run the unfiltered query in its place. Ask through a certified block or governed SQL, or enable the MetricFlow runtime for cross-model filters.'
        : 'The selected governed query did not complete on the current connection. Review the connection and trace, then retry.'
      : modelingGap
        ? `"${modelingGap.term}" is not modeled in this project's governed data, so no query can compute it.${modelingGap.admitted.length ? ` Governed groupings available: ${modelingGap.admitted.join(', ')}.` : ''} Ask with one of those instead, or model "${modelingGap.term}" and re-sync.`
        : reasonCode === 'ASK_V2_REMAINING_TIERS_DECLINED'
          ? 'No certified block or semantic metric covers this question, and the analyst declined to run unverified exploratory SQL against this snapshot. No query was executed. Use Research for a deeper investigation, certify a block for this question, or name the exact model/columns to query.'
          : 'DQL could not complete a safe analytical tool path from the current metadata snapshot.';
  return {
    kind: 'no_answer',
    sourceTier: 'no_answer',
    certification: 'analyst_review_required',
    reviewStatus: 'analyst_review_required',
    // A physical-dispatch ceiling is provider/runtime control, not missing
    // business evidence, and it is not the provider failing either. It carries
    // its own terminal code so the card can say what actually stopped the run;
    // `isTerminalFailure` admits it explicitly, so no legacy cascade turns it
    // into ANALYTICAL_COVERAGE_GAP.
    refusalCode: dispatchBudget
      ? 'orchestration_budget_exhausted'
      : kind === 'provider_failure'
        ? 'provider_error'
        : kind === 'execution_failure'
          ? 'execution_error'
          : modelingGap
            ? 'modeling_gap'
            : 'grounding_gap',
    text,
    answer: text,
    citations: [],
    considered: [],
    contextPack: input.contextPack,
    ...(semanticFailure ? { analyticalFailure: semanticFailure } : {}),
    askAgentV2Outcome: {
      version: 2,
      kind,
      reasonCode,
      origin,
      safeAction: safeActionOverride ?? (kind === 'provider_failure'
        ? 'check_provider_readiness'
        : semanticToolContract
          ? 'use:compile_and_run_semantic'
        : dispatchBudget
          ? 'retry_within_provider_dispatch_budget'
          : 'inspect_recorded_observations_then_retry'),
    },
  };
}

type AskV2CompletedExecution = {
  tier: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql';
  result: NonNullable<AgentAnswer['result']>;
  block?: KGNode;
};

/**
 * Provider narration is optional after the host has already validated the
 * execution result. This sentence is deliberately derived only from the
 * result contract (tier, row count, and column count), so it is safe to use
 * when a final provider dispatch fails, exhausts its budget, or returns no
 * host-validated `finish_answer`.
 */
function deterministicAskV2ResultNarration(completed: AskV2CompletedExecution): string {
  const rows = Math.max(0, completed.result.rowCount);
  const columns = Array.isArray(completed.result.columns) ? completed.result.columns.length : 0;
  const tier = completed.tier.replace(/_/g, ' ');
  const columnClause = columns > 0
    ? ` across ${columns} returned column${columns === 1 ? '' : 's'}`
    : '';
  return `The validated ${tier} query completed with ${rows} row${rows === 1 ? '' : 's'}${columnClause}. The validated result is retained below.`;
}

/**
 * Bind the question's typed clauses to admitted candidates, deterministically.
 *
 * Returns compile_and_run_semantic arguments ONLY when every clause resolves
 * to exactly one admitted binding — one metric per measure term, one dimension
 * per grouping term, an unambiguous ranking. Anything ambiguous, ungrounded,
 * or beyond the composer's shape (per-group top-N, explicit grain grouping,
 * literal member filters) returns undefined and the analyst loop decides.
 * The host never guesses; it only transcribes what has a single answer.
 */
async function deriveHostFirstSemanticArgs(input: {
  question: string;
  candidates: readonly AgentEvidenceCandidate[];
  capabilities: ReadonlyMap<string, AskSemanticCapabilityHandleV1> | undefined;
  /**
   * Server-trusted member selection from a prior-result clarification: the
   * user clicked a value the host itself displayed. Binding it is
   * transcription, never a guess.
   */
  trustedMemberSelection?: { dimensionReferences: string[]; value: string };
  /** Host probe over the operator's explicit column allowlist. */
  probeAllowlistedLiteral?: AnswerLoopInput['probeAllowlistedLiteral'];
}): Promise<{ metricIds: string[]; dimensionIds?: string[]; filters?: Array<{ dimensionId: string; value: string }>; orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>; limit?: number } | undefined> {
  const { question, candidates, capabilities } = input;
  if (!capabilities || capabilities.size === 0) return undefined;
  const requirements = buildAnalyticalRequirementSet({ question });
  const plan = buildAnalysisQuestionPlan(question);
  // Shapes the deterministic composer cannot express go to the analyst.
  if (plan.requestedShape.topN?.scope === 'per_group') return undefined;
  if (requirements.time?.grain) return undefined;
  if (requirements.measures.length === 0) return undefined;

  // Requirement terms are business English ("customer name"); runtime names
  // are snake_case ("customer_name"). Both spell the same field — try the
  // spellings, never different MEANINGS. Ambiguity still returns undefined.
  const resolve = (reference: string, role: V2SemanticCapabilityRole): string | undefined => {
    for (const variant of [...new Set([reference, reference.trim().replace(/\s+/g, '_')])]) {
      const resolved = resolveV2SemanticCapabilityReference({ reference: variant, role, candidates, capabilities });
      if (resolved) return resolved;
    }
    return undefined;
  };

  // ── Member/filter literals ────────────────────────────────────────────
  // A literal is bindable only through PROOF: either the user selected the
  // value from a host-displayed prior result (trusted selection), or the
  // host's allowlist probe found the exact value in exactly one approved
  // physical column that maps to exactly one admitted semantic dimension.
  // Anything else — no proof, two proofs, conflicting values — goes to the
  // analyst loop. The time window is NOT a member literal: it is handled by
  // the window pipeline inside the compile tool.
  const normalizeLiteral = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const literalTerms = [...new Set([
    ...requirements.memberTerms.map(String),
    ...(plan.requestedShape.filters ?? [])
      .map(String)
      .filter((term) => !parseAnalyticalTimeWindow(term)),
  ].map(normalizeLiteral).filter(Boolean))];
  // Terms that are the same literal in different casings collapse to one.
  const coveredLiterals = new Set<string>();
  const filters: Array<{ dimensionId: string; value: string }> = [];
  const addFilter = (dimensionId: string, value: string): boolean => {
    const existing = filters.find((filter) => filter.dimensionId === dimensionId);
    // Two different values on one '=' dimension cannot be expressed here.
    if (existing) return normalizeLiteral(existing.value) === normalizeLiteral(value);
    filters.push({ dimensionId, value });
    return true;
  };
  const trusted = input.trustedMemberSelection;
  const trustedNormalized = trusted ? normalizeLiteral(trusted.value) : undefined;
  for (const literal of literalTerms) {
    if (coveredLiterals.has(literal)) continue;
    // (a) the user's clicked prior-result selection covers this literal.
    if (trusted && trustedNormalized && (trustedNormalized === literal || trustedNormalized.includes(literal))) {
      const dimensionId = trusted.dimensionReferences
        .map((reference) => resolve(reference, 'filter_dimension'))
        .find(Boolean);
      if (!dimensionId) return undefined;
      if (!addFilter(dimensionId, trusted.value)) return undefined;
      coveredLiterals.add(literal);
      continue;
    }
    // (b) exact-existence proof from the operator's column allowlist.
    if (!input.probeAllowlistedLiteral) return undefined;
    let probe: Awaited<ReturnType<NonNullable<AnswerLoopInput['probeAllowlistedLiteral']>>>;
    try {
      probe = await input.probeAllowlistedLiteral(literal);
    } catch {
      return undefined;
    }
    if (probe.status !== 'matched' || probe.matches.length !== 1) return undefined;
    const match = probe.matches[0]!;
    const relationLeaf = (match.relation.split('.').pop() ?? match.relation).replace(/["'`]/g, '').toLowerCase();
    // The physical column proves the VALUE; the semantic snapshot must
    // still prove the FIELD: exactly one admitted dimension whose runtime
    // name and owning model match the probed column's identity.
    const owningDimensions = candidates.filter((candidate) =>
      v2SemanticCandidateMatchesRole(candidate, 'filter_dimension')
      && (candidate.semanticRuntimeName ?? candidate.name) === match.column
      && (
        (candidate.semanticModel ?? '').toLowerCase() === relationLeaf
        || (candidate.sourceObjects ?? []).some((source) => source.toLowerCase().includes(relationLeaf))
      ));
    if (owningDimensions.length !== 1) return undefined;
    const dimensionId = resolve(v2CandidateId(owningDimensions[0]!), 'filter_dimension');
    if (!dimensionId) return undefined;
    if (!addFilter(dimensionId, match.canonicalValue)) return undefined;
    coveredLiterals.add(literal);
  }

  const metricIds: string[] = [];
  for (const measure of requirements.measures.slice(0, 4)) {
    const resolved = resolve(measure, 'metric');
    if (!resolved) return undefined;
    if (!metricIds.includes(resolved)) metricIds.push(resolved);
  }
  if (metricIds.length === 0) return undefined;

  const dimensionIds: string[] = [];
  const rawGroupingTerms = [...new Set([
    ...requirements.entityDisplayTerms,
    ...requirements.dimensions,
  ])].filter((term) => !/^(?:day|week|month|quarter|year|season|period)s?$/i.test(term.trim()));
  // "customer" and "customer name" name the same grouping; the display form
  // is the executable one. Keep only the display form when both appear.
  const groupingTerms = rawGroupingTerms.filter((term) =>
    !rawGroupingTerms.some((other) => other !== term && other.startsWith(`${term} `)));
  for (const term of groupingTerms.slice(0, 6)) {
    const resolved = resolve(term, 'dimension');
    if (!resolved) return undefined;
    if (!dimensionIds.includes(resolved)) dimensionIds.push(resolved);
  }

  const topN = plan.requestedShape.topN;
  const direction = plan.requestedShape.rankingDirection === 'bottom' ? 'asc' as const : 'desc' as const;
  return {
    metricIds,
    ...(dimensionIds.length ? { dimensionIds } : {}),
    ...(filters.length ? { filters } : {}),
    ...(topN ? {
      orderBy: [{ name: metricIds[0]!, direction }],
      limit: topN.n,
    } : {}),
  };
}

/**
 * The server-trusted member selection carried by a clarified prior-result
 * turn. `selectedMemberId`/`selectedMemberBinding` come from the persisted
 * result binding; the `member:<entity>:<value>` clarification id is the
 * click itself. Neither is provider input.
 */
function parseV2TrustedMemberSelection(
  state: AskAgentStateV4,
): { dimensionReferences: string[]; value: string } | undefined {
  const conversation = state.conversation;
  if (!conversation) return undefined;
  const memberId = typeof conversation.selectedMemberId === 'string' ? conversation.selectedMemberId.trim() : '';
  const memberValue = typeof conversation.selectedMemberBinding === 'string' ? conversation.selectedMemberBinding.trim() : '';
  if (memberId && memberValue) {
    return { dimensionReferences: [memberId], value: memberValue };
  }
  const clarification = typeof conversation.clarificationId === 'string' ? conversation.clarificationId : '';
  const parsed = /^member:([^:]+):(.+)$/.exec(clarification);
  if (!parsed) return undefined;
  const entity = parsed[1]!.trim();
  const value = parsed[2]!.trim();
  if (!entity || !value) return undefined;
  return { dimensionReferences: [`${entity}_name`, entity], value };
}

function askV2ExecutedAnswer(
  input: AnswerLoopInput,
  completed: AskV2CompletedExecution,
  narration: string,
  terminalOutcome?: NonNullable<AgentAnswer['askAgentV2Outcome']>,
): AgentAnswer {
  const certified = completed.tier === 'certified';
  const exploratory = completed.tier === 'exploratory_sql';
  const text = narration.trim() || `The ${completed.tier.replace(/_/g, ' ')} query completed with ${completed.result.rowCount} row${completed.result.rowCount === 1 ? '' : 's'}.`;
  return {
    kind: certified ? 'certified' : 'uncertified',
    sourceTier: certified ? 'certified_artifact' : completed.tier === 'semantic' ? 'semantic_layer' : 'dbt_manifest',
    certification: certified ? 'certified' : exploratory ? 'analyst_review_required' : 'governed',
    reviewStatus: certified ? 'certified' : exploratory ? 'analyst_review_required' : 'governed',
    text, answer: text, result: completed.result, ...(completed.block ? { block: completed.block } : {}), citations: [], considered: [], contextPack: input.contextPack,
    askAgentV2Outcome: terminalOutcome ?? { version: 2, kind: 'finish_answer', reasonCode: 'ASK_V2_VALIDATED_RESULT', origin: 'execution' },
  };
}

function observeV2ProviderFailure(
  state: AskAgentStateV4 | undefined,
  diagnostic: ProviderFailureDiagnosticV1,
  terminal = false,
): void {
  if (!state) return;
  observeAskAgentV2Tool(state, {
    version: 1,
    tool: 'finish_answer',
    outcome: 'error',
    reasonCode: `provider_${diagnostic.cause}`,
    candidateIds: [],
    origin: 'provider',
    provider: {
      phase: diagnostic.phase === 'generation' ? 'agent_control' : diagnostic.phase,
      cause: diagnostic.cause,
      retryable: diagnostic.retryable,
      safeAction: diagnostic.safeAction,
    },
  });
  if (terminal) {
    finishAskAgentV2Turn(state, {
      version: 2,
      kind: 'provider_failure',
      reasonCode: `provider_${diagnostic.cause}`,
      safeAction: diagnostic.safeAction,
      origin: 'provider',
    });
  }
}

function createAskV2TraceToolCallback(
  observer: AskTraceObserverV1,
  state: AskAgentStateV4 | undefined,
): TraceAwareToolCallback {
  const trace = createAskTraceToolCallback(observer);
  const callback: TraceAwareToolCallback = (event) => {
    trace(event);
    observeV2ToolCall(state, event);
  };
  Object.defineProperty(callback, ASK_TRACE_TOOL_CALLBACK, {
    value: true,
    enumerable: false,
  });
  return callback;
}

function isAskTraceToolCallback(callback: ProviderToolLoopOptions['onToolCall'] | undefined): boolean {
  return Boolean((callback as TraceAwareToolCallback | undefined)?.[ASK_TRACE_TOOL_CALLBACK]);
}

function createCertifiedFitConfirmation(provider: AgentProvider, signal?: AbortSignal): CertifiedFitConfirmation {
  return async ({ question, questionPlan, block, fit }) => {
    const response = await provider.generate([
      {
        role: 'system',
        content: [
          'You are a strict governed analytics routing judge.',
          'Decide whether the certified block can directly answer the user question.',
          'Allow only when the block covers the requested metric, grain, dimensions, filters, required columns, ranking, and top-N.',
          'If the block is merely useful context, close but wrong grain, missing requested columns, or ambiguous, reject it.',
          'Return JSON only: {"allow":boolean,"confidence":"high|medium|low","reason":"short reason"}.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          requestedShape: questionPlan.requestedShape,
          candidateBlock: summarizeBlockForFitConfirmation(block),
          deterministicFit: {
            kind: fit.kind,
            confidence: fit.confidence,
            reasons: fit.reasons,
            missingOutputs: fit.missingOutputs,
            missingDimensions: fit.missingDimensions,
            unsupportedFilters: fit.unsupportedFilters,
            grainMismatch: fit.grainMismatch,
            topNAction: fit.topNAction,
            inferredContract: fit.inferredContract,
          },
        }, null, 2),
      },
    ], { maxTokens: 220, temperature: 0, signal });
    return parseCertifiedFitConfirmation(response);
  };
}

/**
 * Decide whether the answer path needs a live warehouse-schema read up front.
 * Generated SQL must verify retrieved relation columns against the selected
 * execution target: dbt/catalog metadata can legitimately be ahead of (or
 * behind) the deployed warehouse. The runtime performs a bounded point lookup,
 * not a broad warehouse scan, and falls back to the catalog if access is denied.
 */
function shouldLoadSchemaContext(
  contextPack: LocalContextPack | undefined,
  hasSemanticLayer: boolean,
): boolean {
  if (!contextPack) return true;
  const route = contextPack.routeDecision.route;
  if (route === 'certified' || route === 'clarify' || route === 'conflict') return false;
  if (contextPack.questionPlan.requestedShape.filters.length > 0) return true;

  // Relations are useful semantic context, but their physical columns still
  // need verification on the active DuckDB, Snowflake, or other target before
  // generated SQL is executed.
  if (contextPack.allowedSqlContext.relations.length > 0) return true;

  const hasSemanticCandidates = hasSemanticLayer && contextPack.objects.some((object) =>
    object.objectType === 'metric'
    || object.objectType === 'dimension'
    || object.objectType === 'measure'
    || object.objectType === 'semantic_model');
  if (hasSemanticCandidates) return false;

  return contextPack.allowedSqlContext.sourceBlockSql.length === 0;
}

function shouldSearchProjectFiles(contextPack: LocalContextPack | undefined): boolean {
  if (!contextPack) return true;
  if (contextPack.routeDecision.route === 'certified') return false;
  const meaningfulObjects = contextPack.objects.filter((object) =>
    object.objectType === 'block'
    || object.objectType === 'metric'
    || object.objectType === 'semantic_metric'
    || object.objectType === 'semantic_model'
    || object.objectType === 'dbt_model');
  return meaningfulObjects.length < 2
    || (contextPack.allowedSqlContext.relations.length === 0
      && contextPack.allowedSqlContext.sourceBlockSql.length === 0);
}

function renderProjectSourceSearch(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const matches = (value as { matches?: unknown }).matches;
  if (!Array.isArray(matches) || matches.length === 0) return undefined;
  const lines = matches.slice(0, 24).flatMap((match) => {
    if (!match || typeof match !== 'object' || Array.isArray(match)) return [];
    const record = match as { path?: unknown; line?: unknown; text?: unknown };
    if (typeof record.path !== 'string' || typeof record.text !== 'string') return [];
    return [`${record.path}${typeof record.line === 'number' ? `:${record.line}` : ''} — ${record.text}`];
  });
  return lines.length > 0
    ? `Live project source matches (bounded fallback; validate through DQL metadata before use):\n${lines.join('\n')}`
    : undefined;
}

function summarizeBlockForFitConfirmation(block: CertifiedFitConfirmationRequest['block']): Record<string, unknown> {
  const payload = block.payload ?? {};
  return {
    objectKey: block.objectKey,
    objectType: block.objectType,
    name: block.name,
    status: block.status,
    description: block.description ?? stringValue(payload.description),
    grain: stringValue(payload.grain),
    dimensions: stringArray(payload.dimensions),
    entities: stringArray(payload.entities),
    declaredOutputs: stringArray(payload.declaredOutputs),
    outputContract: payload.outputContract,
    allowedFilters: stringArray(payload.allowedFilters),
    sql: truncateForFitPrompt(stringValue(payload.sql), 1200),
    llmContext: truncateForFitPrompt(stringValue(payload.llmContext), 800),
  };
}

function parseCertifiedFitConfirmation(text: string): { allow: boolean; confidence?: 'high' | 'medium' | 'low'; reason?: string } {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { allow: false, confidence: 'low', reason: 'fit confirmation did not return JSON' };
  }
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
      ? parsed.confidence
      : undefined;
    return {
      allow: parsed.allow === true,
      ...(confidence ? { confidence } : {}),
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return { allow: false, confidence: 'low', reason: 'fit confirmation returned malformed JSON' };
  }
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced?.[1]) return fenced[1];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * A precomputed exploratory pack is an optimization/witness only. The runner
 * independently derives the pack from the immutable router-selected IDs and
 * accepts the witness only when its snapshot, source fingerprint, physical
 * relations, and metadata object set are exactly the same. This prevents a
 * caller from replacing a safe same-snapshot closure with a broader one.
 */
function exploratoryClosureMatches(
  derived: LocalContextPack | undefined,
  witness: LocalContextPack,
): boolean {
  if (!derived) return false;
  if (derived.knowledgeLens.snapshotId !== witness.knowledgeLens.snapshotId) return false;
  if (derived.freshness.fingerprint !== witness.freshness.fingerprint) return false;
  const normalize = (value: string): string => value
    .trim()
    .split('.')
    .map((part) => part.trim().replace(/^["`\[]|["`\]]$/g, '').toLowerCase())
    .filter(Boolean)
    .join('.');
  const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every((value) => rightSet.has(value));
  };
  const derivedRelations = [...new Set(derived.allowedSqlContext.relations.map((relation) => normalize(relation.relation)))].sort();
  const witnessRelations = [...new Set(witness.allowedSqlContext.relations.map((relation) => normalize(relation.relation)))].sort();
  if (!sameSet(derivedRelations, witnessRelations)) return false;
  const derivedObjects = [...new Set(derived.objects.map((object) => object.objectKey))].sort();
  const witnessObjects = [...new Set(witness.objects.map((object) => object.objectKey))].sort();
  return sameSet(derivedObjects, witnessObjects);
}

function truncateForFitPrompt(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function emitProposalFromText(text: string, emit: (turn: AgentTurn) => void): void {
  const match = text.match(/DQL_BLOCK_PROPOSAL\s*[:=]?\s*(\{[\s\S]*\})\s*$/);
  if (!match) return;
  try {
    const raw = JSON.parse(match[1]) as Partial<BlockProposal>;
    if (!raw.name || !raw.sql) return;
    emit({
      kind: 'proposal',
      proposal: {
        name: String(raw.name),
        path: typeof raw.path === 'string' && raw.path.trim() ? raw.path : undefined,
        domain: String(raw.domain ?? ''),
        owner: String(raw.owner ?? ''),
        description: String(raw.description ?? ''),
        sql: String(raw.sql),
        ...blockProposalDqlMetadata(raw),
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
        chartType: typeof raw.chartType === 'string' ? raw.chartType : undefined,
      },
      governance: { certified: false, errors: [], warnings: ['Generated by a non-tool provider; review before saving.'] },
    });
  } catch {
    // Ignore malformed proposal text. The visible assistant response still streams as text.
  }
}

/**
 * Route the runtime's own provider through an eval cassette when the host asks.
 *
 * The client-side cassette in `dql agent eval` only covers `--via loop`: with
 * `--via runtime` the SERVER owns the provider, so without this hook the one
 * driver that actually exercises routing and gates could never be made
 * deterministic — and a suite that cannot be deterministic cannot gate a PR.
 *
 * Opt-in through the environment, never through a request field: a caller must
 * not be able to redirect a production run onto recorded responses.
 */
/**
 * Read `agent.orchestrator` straight from dql.config.json.
 *
 * Deliberately NOT `loadProjectConfig` from local-runtime: that module imports
 * this one (local-runtime.ts:164), so reaching back would close an import cycle
 * through a 34k-line file. A few lines of JSON reading is the cheaper trade.
 *
 * Cached by a lightweight file fingerprint, not forever. Settings writes must
 * take effect for the next Ask without requiring a notebook-server restart.
 * A malformed file resolves to `null`, which `resolveOrchestratorPolicy` turns
 * into `legacy` — a broken config must not route real questions onto an
 * unproven path.
 */
const agentConfigCache = new Map<string, {
  fingerprint: string;
  value: Record<string, unknown> | null;
}>();

function agentConfigFingerprint(projectRoot: string): string {
  try {
    const stats = statSync(join(projectRoot, 'dql.config.json'));
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function readAgentConfig(projectRoot: string): Record<string, unknown> | null {
  const fingerprint = agentConfigFingerprint(projectRoot);
  const cached = agentConfigCache.get(projectRoot);
  if (cached && cached.fingerprint === fingerprint) return cached.value;
  let resolved: Record<string, unknown> | null = null;
  try {
    const raw = readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { agent?: unknown };
    resolved = parsed?.agent && typeof parsed.agent === 'object'
      ? parsed.agent as Record<string, unknown>
      : null;
  } catch {
    resolved = null;
  }
  agentConfigCache.set(projectRoot, { fingerprint, value: resolved });
  return resolved;
}

function readOrchestratorConfig(projectRoot: string): Record<string, unknown> | null {
  const orchestrator = readAgentConfig(projectRoot)?.orchestrator;
  return orchestrator && typeof orchestrator === 'object' ? orchestrator as Record<string, unknown> : null;
}

/**
 * Is on-demand value lookup permitted for this project?
 *
 * Mirrors `resolveAgentRuntimeValueGrounding`, read locally rather than imported
 * — local-runtime imports this module, so reaching back would close a cycle
 * through a 34k-line file. Anything other than an explicit `safe_automatic`
 * resolves to disabled: value lookup touches warehouse cell values, so a
 * malformed setting must fail closed.
 */
/**
 * Structured turn planning is OFF by default.
 *
 * It costs one provider dispatch before the loop makes any tool call, and on a
 * slow provider that dispatch can consume enough of the discovery window that
 * the loop is then refused admission and falls back to the legacy path —
 * measured on ollama, where all three agentic dispatches planned successfully
 * and then died at "soft target elapsed before this provider dispatch could
 * start". Its payoff is a legible trace, and `onStep` is not wired to SSE yet,
 * so today it buys nothing a user can see. Ordinary Ask already has a
 * candidate-ID meaning call that produces the host-owned analytical plan, so
 * it must never spend an extra provider transport on turn planning even when
 * a stale local config enables it. Research remains the only explicit lane
 * that may opt in to a separate plan stage.
 */
function turnPlanningEnabled(
  projectRoot: string,
  orchestrationMode: AgentRunRequest['orchestrationMode'] | undefined,
): boolean {
  if (orchestrationMode !== 'research') return false;
  const orchestrator = readAgentConfig(projectRoot)?.orchestrator;
  if (!orchestrator || typeof orchestrator !== 'object') return false;
  return (orchestrator as { turnPlanning?: unknown }).turnPlanning === true;
}

function valueLookupEnabled(projectRoot: string): boolean {
  const grounding = readAgentConfig(projectRoot)?.runtimeValueGrounding;
  if (!grounding || typeof grounding !== 'object') return false;
  return (grounding as { mode?: unknown }).mode === 'safe_automatic';
}

/**
 * V2 rows are local-only unless the project explicitly opts a remote provider
 * in. The setting is read server-side and cannot be supplied by a prompt or
 * browser request. Existing Research egress remains unchanged.
 */
function askV2ProviderResultEgress(projectRoot: string, providerId: SimpleProviderId) {
  const setting = readAgentConfig(projectRoot)?.providerResultEgress;
  const allowRemoteRows = Boolean(
    setting
    && typeof setting === 'object'
    && (setting as { allowRemoteRows?: unknown }).allowRemoteRows === true,
  );
  return defaultProviderResultEgressPolicyV2({
    transport: providerId === 'ollama' ? 'local' : 'remote',
    allowRemoteRows,
  });
}

/**
 * Which migration lane this turn belongs to.
 *
 * Research is identified by the server-resolved `orchestrationMode`, not by
 * `analysisDepth`. A reader can ask Ask AI to think deeply without opting into
 * the Research workflow, its wider dispatch budget, or any row-bearing tools.
 *
 * Deliberately coarse: the seam only needs to know which bucket a turn falls in
 * so a lane can be enabled independently. The fine-grained triage between
 * certified, semantic, and generated stays inside the answer path, where the
 * retrieval evidence lives.
 */
function agenticLaneForRequest(req: AgentRunRequest): AgenticLane {
  if (req.askAgentRuntimeMode === 'authoritative_v2') return req.orchestrationMode === 'research' ? 'research' : 'ask_v2';
  return req.orchestrationMode === 'research' ? 'research' : 'generated';
}

/**
 * V2 is selected by the server-side Ask runtime, not a project setting or a
 * browser request.  This is the single handoff that makes the bounded analyst
 * tool loop authoritative for a V2 free-text turn while preserving V1's
 * explicit project-config migration behaviour.
 */
function orchestratorPolicyForRequest(req: AgentRunRequest): OrchestratorPolicy {
  if (req.askAgentRuntimeMode === 'authoritative_v2') {
    return {
      mode: 'agentic',
      lanes: new Set<AgenticLane>([req.orchestrationMode === 'research' ? 'research' : 'ask_v2']),
      maxIterations: req.orchestrationMode === 'research' ? 24 : 8,
      // A V2 error is a typed terminal observation. Falling through to V1
      // would re-interpret business meaning or issue a fresh generation after
      // the bounded V2 tool runtime already stopped.
      fallbackOnError: false,
    };
  }
  return resolveOrchestratorPolicy({ config: readOrchestratorConfig(req.projectRoot) });
}

export function applyEvalCassette(provider: AgentProvider, projectRoot: string): AgentProvider {
  const dir = process.env.DQL_EVAL_CASSETTE_DIR;
  if (!dir) return provider;
  return withCassette(
    provider,
    new CassetteStore(dir),
    resolveCassetteModeFromEnv(process.env),
    evalCassetteCanonicalizationV2(projectRoot),
  );
}

/**
 * Create a replay-only provider when the runtime is launched for an offline
 * evaluation. This is intentionally unavailable outside explicit cassette
 * replay: recording and live modes still require a configured real provider.
 *
 * The cassette's recorded provider identity is part of its key. Recover it
 * from a single-provider cassette directory instead of borrowing a user's
 * active provider or guessing from an API setting. The base provider cannot
 * make a network call; replay misses remain CassetteMissError failures.
 */
export function createEvalCassetteReplayProvider(projectRoot: string): AgentProvider | undefined {
  const dir = process.env.DQL_EVAL_CASSETTE_DIR;
  if (!dir || resolveCassetteModeFromEnv(process.env) !== 'replay') return undefined;

  const store = new CassetteStore(dir);
  const providerNames = store.providerNames();
  const providerName = providerNames.length === 1 ? asAgentProviderName(providerNames[0]!) : undefined;
  if (!providerName) return undefined;

  return withCassette({
    name: providerName,
    available: async () => true,
    generate: async () => {
      throw new Error('Eval cassette replay miss: no live provider is available.');
    },
  }, store, 'replay', evalCassetteCanonicalizationV2(projectRoot));
}

function asAgentProviderName(value: string): AgentProvider['name'] | undefined {
  return value === 'claude' || value === 'openai' || value === 'gemini' || value === 'ollama'
    ? value
    : undefined;
}

/**
 * A raw text provider for planning calls that are not the answer itself.
 *
 * Research hypothesis planning needs `generate`, not the full agent runner —
 * and the runner cannot be reused for it, because the runner IS the governed
 * answer path. Cassettes apply, so a recorded run stays hermetic.
 */
export function createGovernedTextProvider(
  id: SimpleProviderId,
  projectRoot: string,
): AgentProvider | undefined {
  const spec = SPECS[id];
  if (!spec) return undefined;
  try {
    return applyEvalCassette(spec.create(projectRoot), projectRoot);
  } catch {
    return undefined;
  }
}

export function createDqlAgentProviderRunner(id: SimpleProviderId, providerOverride?: AgentProvider): AgentRunner {
  return {
    async run(req, emit, signal) {
      const spec = SPECS[id];
      const rawProvider = applyEvalCassette(providerOverride ?? spec.create(req.projectRoot), req.projectRoot);
      const askTrace = askTraceObserverForV1(req);
      const v2Authoritative = req.askAgentRuntimeMode === 'authoritative_v2';
      const v2State = v2Authoritative ? req.askAgentV2State : undefined;
      // The final answer lives inside a provider-owned lexical scope below.
      // Keep only its result identity here so the runner can mint the
      // process-local execution receipt after the resource cleanup block.
      let terminalAnswer: AgentAnswer | undefined;
      const v2Workspace = v2Authoritative && askAgentV2WorkspaceMatches(v2State, req.askAgentV2Workspace)
        ? req.askAgentV2Workspace
        : undefined;
      const v2ToolWorkspace = v2Workspace?.getToolWorkspace?.();
      // AgentRunner receives normalized messages, not the HTTP request shape;
      // derive the current user question from that authoritative envelope.
      // Reading `req.question` here made exact V2 routes crash before their
      // proof could run because AgentRunRequest deliberately has no such
      // field.
      const v2Question = v2Authoritative ? resolveEffectiveQuestion(req) : undefined;
      const v2ExactCertified = v2ExactCertifiedCandidate(
        v2State,
        v2ToolWorkspace,
        v2Question ? buildAnalysisQuestionPlan(v2Question) : undefined,
      );
      // A router-frozen exact certified block is a deterministic execution
      // lane. It may not probe provider readiness merely because it shares the
      // answer-loop adapter with provider-dependent routes. The flag is
      // server-owned and the deterministic provider below throws if a future
      // branch accidentally tries to generate text, so this cannot create a
      // silent provider fallback.
      const providerPreflightRequired = req.providerPreflightRequired !== false
        && !req.deterministicExploratoryProposal
        // The immutable V2 workspace proves this unique artifact already. A
        // readiness probe would be a provider call in disguise and violate
        // the Tier 1 zero-call contract.
        && !v2ExactCertified;
      const isResearch = req.orchestrationMode === 'research';
      const frozenExploratoryRepairRoute = frozenExploratoryRepairAuthorityForRequest(req);
      // Ordinary analytical Ask has one candidate-ID interpretation, one
      // generation, and — only for an already frozen exploratory plan — one
      // same-plan model-decline correction. The shared run ledger remains the
      // authority across calls; this per-provider ceiling keeps un-ledgered
      // direct callers in the same bounded shape.  A legacy text-tool run is
      // not an analytical repair route and retains its established three-tool
      // plus final-response wrapper cap; it cannot acquire the repair phase.
      const v2ResultEgress = v2Authoritative ? askV2ProviderResultEgress(req.projectRoot, id) : undefined;
      // The authoritative V2 analyst walks a tier ladder: inspect certified,
      // inspect semantic, attempt it, inspect relational, attempt that, and
      // only then exploratory SQL — with a finish control reserved at the end.
      // At six dispatches a single mis-specified argument anywhere in that
      // sequence ended the turn with nothing executed, which read to users as
      // "the AI could not answer" when it had simply run out of turns partway
      // down a path it was following correctly. Ten leaves room to be wrong
      // once per tier and still finish; the tool-call ceiling and the run
      // deadline remain the real bounds.
      const maxProviderDispatches = isResearch
        ? (v2Authoritative ? 12 : 8)
        : frozenExploratoryRepairRoute ? 3 : v2Authoritative ? 10 : 4;
      const researchRowsOptIn = isResearch && req.researchResultRowsOptIn === true;
      const sharedDispatchEvidence = req.providerDispatchEvidenceSink;
      let providerRoundTrips = 0;
      let sqlExecutions = 0;
      let pendingResultRowCount = 0;
      let pendingColumnCount = 0;
      let pendingCumulativeResultRowCount = 0;
      let pendingResearchPurpose: 'research_narration' | 'research_tool' = 'research_narration';
      let physicalToolAttemptIndex = 0;
      let physicalProviderAttemptIndex = 0;
      let lastFailedProviderSpanId: string | undefined;
      let physicalDispatchSequence = 0;
      let lastAdmittedPhysicalDispatch: {
        sequence: number;
        attemptIndex: number;
        phase: ProviderDispatchPhaseV1;
        purpose: ProviderEgressPurpose;
      } | undefined;
      const providerEgressReceipts: ProviderEgressReceiptV1[] = [];
      const dispatchEvidence = (fallbackReason: string) => {
        const shared = sharedDispatchEvidence?.snapshot(fallbackReason);
        return shared
          ? { ...shared, sqlExecutions, fallbackReason }
          : {
              providerEgressReceipts: [...providerEgressReceipts],
              providerRoundTrips,
              toolCalls: 0,
              sqlExecutions,
              repairs: 0,
              fallbackReason,
            };
      };
      /**
       * Count a SQL call at the physical execution boundary, not merely when
       * the answer loop asks the host to prepare one. A tagged missing
       * connection fails before the connector sees SQL, so it must remain zero
       * in the durable receipt and trace. Other rejected execution callbacks
       * retain the historical count: they may have reached the warehouse and
       * failed there.
       */
      const executeAtSqlBoundary = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          const result = await work();
          sqlExecutions += 1;
          return result;
        } catch (error) {
          if (!isPreSqlConnectionConfigurationError(error)) sqlExecutions += 1;
          throw error;
        }
      };
      signal.addEventListener('abort', () => {
        const reason = signal.reason;
        if (reason && typeof reason === 'object') {
          Object.assign(reason, { providerDispatchEvidence: dispatchEvidence('cancelled') });
        }
      }, { once: true });
      const providerAttemptPayload = (
        event: Pick<ProviderDispatchEvent, 'provider' | 'model'>,
        input: {
          admission: 'admitted' | 'denied';
          phase: ProviderDispatchPhaseV1;
          purpose: ProviderEgressPurpose;
          retryOfSpanId?: string;
          diagnostic?: ProviderFailureDiagnosticV1;
        },
      ) => {
        const diagnostic = input.diagnostic;
        const config = getEffectiveProviderConfig(req.projectRoot, id);
        let baseOrigin: string | undefined;
        if (config.baseUrl) {
          try { baseOrigin = new URL(config.baseUrl).origin; } catch { baseOrigin = config.baseUrl; }
        }
        const model = event.model ?? config.model;
        return {
          version: 1 as const,
          phase: input.phase,
          purpose: input.purpose,
          physicalAttemptIndex: ++physicalProviderAttemptIndex,
          providerFingerprint: diagnostic?.providerFingerprint ?? runtimeFingerprint(event.provider),
          ...(diagnostic?.modelFingerprint || model ? { modelFingerprint: diagnostic?.modelFingerprint ?? runtimeFingerprint(model!) } : {}),
          ...(diagnostic?.baseOriginFingerprint || baseOrigin ? { baseOriginFingerprint: diagnostic?.baseOriginFingerprint ?? runtimeFingerprint(baseOrigin!) } : {}),
          ...(input.retryOfSpanId ? { retryOfSpanId: input.retryOfSpanId } : {}),
          admission: input.admission,
          ...(diagnostic?.httpStatusClass ? { httpStatusClass: diagnostic.httpStatusClass } : {}),
          ...(diagnostic?.retryable !== undefined ? { retryable: diagnostic.retryable } : {}),
          ...(diagnostic?.safeAction ? { safeAction: diagnostic.safeAction } : {}),
          ...(diagnostic?.cause ? { cause: diagnostic.cause } : {}),
          provenance: 'live' as const,
        };
      };
      const providerDiagnosticForTrace = (
        error: unknown,
        phase: ProviderFailureDiagnosticV1['phase'],
      ): ProviderFailureDiagnosticV1 => providerBoundaryDiagnostic({
        providerId: id,
        projectRoot: req.projectRoot,
        phase,
        error,
        code: error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : undefined,
      });
      /**
       * The wrapper is the authoritative physical-dispatch boundary. Preserve
       * a Research phase that the host explicitly set, but ordinary Ask only
       * accepts the frozen-plan repair marker; every other Ask transport is
       * answer generation.
       */
      const v2NarrationPhaseForPhysicalEvent = (
        options: ProviderToolLoopOptions | undefined,
        event: Pick<ProviderDispatchEvent, 'operation' | 'attemptIndex'>,
      ): boolean => {
        if (!v2Authoritative || isResearch || options?.egressPurpose !== 'answer_generation') return false;
        const requestedPhase = options?.dispatchPhase;
        if (requestedPhase !== 'agent_control'
          && requestedPhase !== 'tool_followup'
          && requestedPhase !== 'narration') return false;
        try {
          // The resolver closes over process-local V2 state. It can return
          // narration only after a host-validated result has narrowed the
          // current policy to the one required finish_answer action.
          return options.resolvePhysicalDispatchPhase?.({
            operation: event.operation,
            attemptIndex: event.attemptIndex,
            requestedPhase,
          }) === 'narration';
        } catch {
          // A lifecycle resolver is admission authority, never best effort.
          // If it fails, retain normal discovery accounting rather than
          // minting a narration exemption.
          return false;
        }
      };
      const providerDispatchIdentity = (options?: ProviderToolLoopOptions): {
        dispatchPhase: ProviderDispatchPhaseV1;
        purpose: ProviderEgressPurpose;
        ordinaryRepairRequested: boolean;
        ordinaryRepairAuthorized: boolean;
        ordinaryPlanningRequested: boolean;
        ordinaryPlanningAuthorized: boolean;
        v2NarrationRequested: boolean;
        v2NarrationAuthorized: boolean;
        retryRequested: boolean;
        retryAuthorized: boolean;
      } => {
        const requestedPhase = options?.dispatchPhase;
        const requestedPurpose = options?.egressPurpose;
        // In an ordinary Ask, `repair` and `repair_sql` are a paired,
        // server-owned capability.  Preserve the requested repair identity in
        // a denied trace so support can see what was refused, but do not admit
        // it unless this runner captured the immutable exploratory RAP and
        // the answer loop supplied the single-send repair shape.
        const ordinaryRepairRequested = !isResearch
          && (requestedPhase === 'repair' || requestedPurpose === 'repair_sql');
        const ordinaryRepairAuthorized = ordinaryRepairRequested
          && frozenExploratoryRepairRoute
          && requestedPhase === 'repair'
          && requestedPurpose === 'repair_sql'
          && options?.maxProviderDispatches === 1
          && options?.retryOfAttemptIndex === undefined;
        // Authoritative Ask planner calls are a server-owned, bounded ingress
        // into the analytical runtime.  Preserve their physical phase so the
        // local ledger can distinguish one initial planner call from one
        // verifier-directed revision.  A bare client phase label cannot mint
        // this lane: it must carry the typed planning marker and one-send cap.
        const ordinaryPlanningRequested = !isResearch && requestedPhase === 'planning';
        const ordinaryPlanningAuthorized = ordinaryPlanningRequested
          && requestedPurpose === 'answer_generation'
          && (options?.analyticalPlanningKind === 'initial' || options?.analyticalPlanningKind === 'targeted_revision')
          && options?.maxProviderDispatches === 1
          && options?.retryOfAttemptIndex === undefined;
        // Only a server-selected authoritative V2 runtime may use these
        // additive phases.  They distinguish the first agent-control turn
        // from bounded tool-followups in the physical ledger; they do not
        // create a client-selectable route or an additional egress purpose.
        const v2AgentControlRequested = v2Authoritative
          && (requestedPhase === 'agent_control' || requestedPhase === 'tool_followup')
          && requestedPurpose === 'answer_generation';
        // A text-protocol final turn carries `narration` as its requested
        // phase. Do not accept that label by itself: the same live resolver
        // used below for each native physical attempt must prove the
        // post-execution required finish_answer state here too.
        const v2NarrationRequested = v2Authoritative
          && !isResearch
          && requestedPhase === 'narration'
          && requestedPurpose === 'answer_generation';
        const v2NarrationAuthorized = v2NarrationRequested
          && v2NarrationPhaseForPhysicalEvent(options, {
            operation: 'generate',
            attemptIndex: 1,
          });
        const researchPhase = requestedPhase === 'classification'
          || requestedPhase === 'meaning_resolution'
          || requestedPhase === 'planning'
          || requestedPhase === 'generation'
          || requestedPhase === 'narration'
          || requestedPhase === 'repair';
        const dispatchPhase: ProviderDispatchPhaseV1 = isResearch && researchPhase
          ? requestedPhase
          : v2NarrationAuthorized
            ? 'narration'
          : v2AgentControlRequested
            ? requestedPhase
          : ordinaryPlanningAuthorized
            ? 'planning'
          : ordinaryRepairRequested
            ? 'repair'
            : 'generation';
        const purpose: ProviderEgressPurpose = dispatchPhase === 'repair'
          ? 'repair_sql'
          : isResearch && (
            requestedPurpose === 'research_narration'
            || requestedPurpose === 'research_tool'
            || requestedPurpose === 'answer_generation'
          )
            ? requestedPurpose
            : isResearch
              ? pendingResearchPurpose
              : 'answer_generation';
        const retryRequested = options?.retryOfAttemptIndex !== undefined;
        const runnerRetry = (options as RunnerOwnedProviderToolLoopOptions | undefined)?.[RUNNER_OWNED_RETRY_LINEAGE];
        const retryAuthorized = retryRequested
          && Boolean(
            runnerRetry
            && runnerRetry.parentAttemptIndex === options?.retryOfAttemptIndex
            && runnerRetry.phase === dispatchPhase
            && runnerRetry.purpose === purpose,
          );
        return {
          dispatchPhase,
          purpose,
          ordinaryRepairRequested,
          ordinaryRepairAuthorized,
          ordinaryPlanningRequested,
          ordinaryPlanningAuthorized,
          v2NarrationRequested,
          v2NarrationAuthorized,
          retryRequested,
          retryAuthorized,
        };
      };
      const withPhysicalDispatchObserver = (options?: ProviderToolLoopOptions): {
        options: ProviderToolLoopOptions;
        admitInvocation(input: {
          operation: ProviderDispatchEvent['operation'];
          messages: ReadonlyArray<{ role: string; content: string }>;
        }): Record<string, unknown>;
        settle(outcome: 'ok' | 'error' | 'cancelled', error?: unknown): void;
      } => {
        // The answer loop can label exactly one frozen-plan correction as a
        // repair. Do not let arbitrary provider options mint another phase:
        // the local runner owns all other ordinary Ask dispatches as generation.
        const identity = providerDispatchIdentity(options);
        const {
          dispatchPhase,
          purpose,
          ordinaryRepairRequested,
          ordinaryRepairAuthorized,
          ordinaryPlanningRequested,
          ordinaryPlanningAuthorized,
          v2NarrationRequested,
          v2NarrationAuthorized,
          retryRequested,
          retryAuthorized,
        } = identity;
        const requestedPhysicalCap = typeof options?.maxProviderDispatches === 'number'
          && Number.isInteger(options.maxProviderDispatches)
          && options.maxProviderDispatches > 0
          ? options.maxProviderDispatches
          : maxProviderDispatches;
        // A repair response is one physical send even if a lower-level
        // provider supports protocol retries. The frozen plan's one repair
        // reservation must not turn into an unbounded transport loop.
        const physicalDispatchCap = dispatchPhase === 'repair'
          ? 1
          : Math.min(maxProviderDispatches, requestedPhysicalCap);
        // A native provider may make several sends inside one wrapper call.
        // The wrapper admits attempt 1 before entering the raw provider; its
        // first callback deduplicates that admission.  Attempts 2+ are real
        // tool-followups, not duplicate initial control calls.  Derive the
        // physical phase at the one boundary that sees the actual attempt
        // index so the shared ledger can enforce one control call plus the
        // bounded follow-up budget for native and text providers alike.
        const dispatchPhaseForEvent = (event: Pick<ProviderDispatchEvent, 'operation' | 'attemptIndex'>): ProviderDispatchPhaseV1 => {
          if (v2NarrationPhaseForPhysicalEvent(options, event)) return 'narration';
          return v2Authoritative && dispatchPhase === 'agent_control' && event.attemptIndex > 1
            ? 'tool_followup'
            : dispatchPhase;
        };
        const onToolCall = options?.onToolCall;
        const onProviderDispatch = options?.onProviderDispatch;
        const onProviderDispatchComplete = options?.onProviderDispatchComplete;
        const onProviderDispatchRejected = options?.onProviderDispatchRejected;
        type PhysicalTraceEntry = {
          spanId: string | undefined;
          attempt: ProviderAttemptTraceV1;
        };
        const pending = new Map<string, PhysicalTraceEntry[]>();
        const keyForDispatch = (event: Pick<ProviderDispatchEvent, 'provider' | 'operation' | 'attemptIndex'>) => `${event.provider}:${event.operation}:${event.attemptIndex}`;
        // An admission failure can be surfaced both by a throwing admission
        // callback and a provider's optional rejection callback. It is one
        // unsent attempt, not two trace rows.
        const admittedKeys = new Set<string>();
        const deniedKeys = new Set<string>();
        const finish = (
          entry: PhysicalTraceEntry,
          outcome: 'ok' | 'error' | 'cancelled',
          error?: unknown,
          httpStatus?: number,
        ) => {
          if (!entry.spanId) return;
          if (outcome === 'ok') {
            askTrace.finishSpan(entry.spanId, {
              outcome: 'ok',
              reasonCode: 'completed',
              payload: { kind: 'provider', attempt: entry.attempt },
            });
            return;
          }
          const diagnostic = providerDiagnosticForTrace(
            error ?? (typeof httpStatus === 'number' ? Object.assign(new Error(`HTTP ${httpStatus}`), { code: `HTTP_${httpStatus}` }) : undefined),
            entry.attempt.phase,
          );
          const failureAttempt = {
            ...entry.attempt,
            ...(diagnostic.httpStatusClass ? { httpStatusClass: diagnostic.httpStatusClass } : {}),
            retryable: diagnostic.retryable,
            safeAction: diagnostic.safeAction,
            cause: outcome === 'cancelled' ? 'cancelled' as const : diagnostic.cause,
          };
          askTrace.finishSpan(entry.spanId, {
            outcome: outcome === 'cancelled' ? 'cancelled' : 'error',
            reasonCode: outcome === 'cancelled' ? 'cancelled' : 'provider_failure',
            payload: { kind: 'provider', attempt: failureAttempt },
          });
          lastFailedProviderSpanId = entry.spanId;
        };
        /**
         * Admit one provider send at the runner boundary.  Built-in providers
         * call `onProviderDispatch` immediately before their HTTP request;
         * custom/subscription providers are allowed to be callback-silent.
         * In the latter case `invokePhysicalProvider` supplies a synthetic,
         * content-safe envelope before entering `rawProvider`, so a physical
         * provider invocation can never evade budget/egress receipts.
         *
         * The first native callback for a wrapper invocation shares the same
         * operation/attempt key and is therefore only wire-sanitized below;
         * it does not create a second receipt or consume a second budget slot.
         * Subsequent native loop sends use attempt 2+ and are independently
         * admitted, as they must be.
         */
        const admit = (event: ProviderDispatchEvent, notifySource: boolean): Record<string, unknown> => {
          try {
            const eventDispatchPhase = dispatchPhaseForEvent(event);
            // This is the last synchronous boundary before a native provider
            // serializes bytes. A caller cannot mint an ordinary Ask repair
            // merely by placing lifecycle labels in ProviderToolLoopOptions.
            if (ordinaryRepairRequested && !ordinaryRepairAuthorized) {
              throw repairAuthorityAdmissionError();
            }
            if (ordinaryPlanningRequested && !ordinaryPlanningAuthorized) {
              throw Object.assign(
                new Error('Analytical planning dispatch requires a server-owned initial or targeted-revision marker.'),
                { code: 'PROVIDER_DISPATCH_PLANNING_NOT_ALLOWED' },
              );
            }
            if (v2NarrationRequested && !v2NarrationAuthorized) {
              throw Object.assign(
                new Error('Ask V2 narration dispatch requires a host-validated result and the required finish_answer terminal policy.'),
                { code: 'PROVIDER_DISPATCH_NARRATION_NOT_ALLOWED' },
              );
            }
            if (retryRequested && !retryAuthorized) throw retryLineageAdmissionError();

            const envelope = sharedDispatchEvidence
              ? sharedDispatchEvidence.observe(event, {
                  purpose,
                  dispatchPhase: eventDispatchPhase,
                  optIn: pendingResultRowCount > 0 && researchRowsOptIn,
                  serializedResultShape: {
                    resultRowCount: pendingResultRowCount,
                    columnCount: pendingColumnCount,
                  },
                  ...(pendingCumulativeResultRowCount > 0
                    ? { cumulativeResultRowCount: pendingCumulativeResultRowCount }
                    : {}),
                  ...(options?.retryOfAttemptIndex !== undefined
                    ? { retryOfAttemptIndex: options.retryOfAttemptIndex }
                    : {}),
                  ...(eventDispatchPhase === 'planning' && options?.analyticalPlanningKind
                    ? { planningKind: options.analyticalPlanningKind }
                    : {}),
                })
              : (() => {
                  // Fallback path only (CLI/MCP-direct runs carry no shared
                  // ledger). Keep it at the same physical cap as the server
                  // ledger so callback-silent providers cannot bypass it.
                  if (!isResearch && providerRoundTrips >= physicalDispatchCap) {
                    throw Object.assign(new Error(`Provider dispatch budget exhausted after ${physicalDispatchCap} ordinary Ask attempts.`), {
                      code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED',
                    });
                  }
                  const normalized = prepareProviderWireEnvelopeForDispatch(rawProvider.name, event.envelope);
                  assertProviderPayloadAllowed(normalized, {
                    allowResultRows: false,
                    maxResultRows: 0,
                    purpose,
                  });
                  providerRoundTrips += 1;
                  providerEgressReceipts.push(createProviderDispatchEgressReceipt({
                    purpose,
                    dispatchPhase: eventDispatchPhase,
                    provider: rawProvider.name,
                    operation: event.operation,
                    attemptIndex: event.attemptIndex,
                    ...(event.model ? { model: event.model } : {}),
                    ...(options?.retryOfAttemptIndex !== undefined
                      ? { retryOfAttemptIndex: options.retryOfAttemptIndex }
                      : {}),
                    permittedCategories: pendingResultRowCount > 0
                      ? ['instructions', 'question', 'schema_metadata', 'governed_context', 'result_rows']
                      : ['instructions', 'question', 'schema_metadata', 'governed_context'],
                    optIn: pendingResultRowCount > 0 && researchRowsOptIn,
                    envelope: normalized,
                    serializedResultShape: {
                      resultRowCount: pendingResultRowCount,
                      columnCount: pendingColumnCount,
                    },
                    ...(pendingCumulativeResultRowCount > 0
                      ? { cumulativeResultRowCount: pendingCumulativeResultRowCount }
                      : {}),
                  }));
                  return normalized;
                })();

            pendingResultRowCount = 0;
            pendingColumnCount = 0;
            pendingCumulativeResultRowCount = 0;
            pendingResearchPurpose = 'research_narration';
            const attempt = providerAttemptPayload(event, {
              admission: 'admitted',
              phase: eventDispatchPhase,
              purpose,
              retryOfSpanId: lastFailedProviderSpanId,
            });
            const spanId = askTrace.startSpan({ name: 'provider.attempt', stage: 'provider', reasonCode: 'started', payload: { kind: 'provider', attempt } });
            const key = keyForDispatch(event);
            lastAdmittedPhysicalDispatch = {
              sequence: ++physicalDispatchSequence,
              attemptIndex: event.attemptIndex,
              phase: eventDispatchPhase,
              purpose,
            };
            admittedKeys.add(key);
            pending.set(key, [...(pending.get(key) ?? []), { spanId, attempt }]);
            // Source callbacks are observational/normalization hooks, never
            // receipt authority. They see actual native sends once; a
            // callback-silent provider has no fabricated raw envelope exposed.
            return notifySource ? onProviderDispatch?.(event) ?? envelope : envelope;
          } catch (error) {
            const eventDispatchPhase = dispatchPhaseForEvent(event);
            const key = keyForDispatch(event);
            if (!admittedKeys.has(key) && !deniedKeys.has(key)) {
              deniedKeys.add(key);
              const diagnostic = providerDiagnosticForTrace(error, eventDispatchPhase);
              const attempt = providerAttemptPayload(event, {
                admission: 'denied',
                phase: eventDispatchPhase,
                purpose,
                diagnostic,
                retryOfSpanId: lastFailedProviderSpanId,
              });
              const spanId = askTrace.startSpan({ name: 'provider.attempt', stage: 'provider', reasonCode: 'provider_failure', payload: { kind: 'provider', attempt } });
              askTrace.finishSpan(spanId, {
                outcome: 'denied',
                reasonCode: 'provider_failure',
                payload: { kind: 'provider', attempt },
              });
              lastFailedProviderSpanId = spanId;
            }
            try {
              onProviderDispatchRejected?.({
                provider: event.provider,
                operation: event.operation,
                attemptIndex: event.attemptIndex,
                ...(event.model ? { model: event.model } : {}),
                error,
              });
            } catch {
              // A source observer cannot turn a denied local admission into a
              // provider send or a second failure record.
            }
            throw error;
          }
        };
        const physicalOptions: ProviderToolLoopOptions = {
        ...(options ?? {}),
        // The raw provider loop has the same outer ceiling as the local Ask
        // contract. The run-scoped ledger is the authority for phase limits:
        // one planning/generation transport plus, only when the answer loop
        // presents a frozen exploratory repair marker, one repair transport.
        maxProviderDispatches: physicalDispatchCap,
        ...(sharedDispatchEvidence?.mayStartToolCall
          ? { mayStartToolCall: () => sharedDispatchEvidence.mayStartToolCall!() }
          : {}),
        onProviderDispatch: (event: ProviderDispatchEvent) => {
          const key = keyForDispatch(event);
          if (admittedKeys.has(key)) {
            // The wrapper already admitted this invocation before control
            // entered rawProvider. Preserve real-envelope validation without
            // duplicating the receipt/count/trace span.
            const envelope = prepareProviderWireEnvelopeForDispatch(rawProvider.name, event.envelope);
            assertProviderPayloadAllowed(envelope, {
              allowResultRows: false,
              maxResultRows: 0,
              purpose,
            });
            return onProviderDispatch?.(event) ?? envelope;
          }
          return admit(event, true);
        },
        onProviderDispatchComplete: (event: ProviderDispatchCompletionEvent) => {
          const key = keyForDispatch(event);
          const entries = pending.get(key) ?? [];
          const entry = entries[0];
          // A successful HTTP response or subscription child-process exit is
          // merely a physical milestone. Keep the same span open until the
          // parser/stream/result path settles; this prevents a malformed 200
          // response from being recorded as a successful provider attempt.
          if (entry && event.outcome === 'ok' && (event.settlement === 'transport' || event.settlement === 'process')) {
            entry.attempt = {
              ...entry.attempt,
              ...(event.settlement === 'transport' ? { transportOutcome: 'ok' as const } : { processOutcome: 'ok' as const }),
            };
          } else {
            const closed = entries.shift();
            if (entries.length > 0) pending.set(key, entries); else pending.delete(key);
            if (closed) finish(closed, event.outcome, event.error, event.httpStatus);
          }
          onProviderDispatchComplete?.(event);
        },
        onProviderDispatchRejected: (event) => {
          // `prepareProviderHttpDispatch` rejected this before it could send
          // bytes. Keep it as a denied admission rather than pretending an
          // HTTP attempt happened (or losing dispatch-budget evidence).
          const key = keyForDispatch(event);
          if (!admittedKeys.has(key) && !deniedKeys.has(key)) {
            deniedKeys.add(key);
            const eventDispatchPhase = dispatchPhaseForEvent(event);
            const diagnostic = providerDiagnosticForTrace(event.error, eventDispatchPhase);
            const attempt = providerAttemptPayload(event, {
              admission: 'denied',
              phase: eventDispatchPhase,
              purpose,
              diagnostic,
              retryOfSpanId: lastFailedProviderSpanId,
            });
            const spanId = askTrace.startSpan({
              name: 'provider.attempt',
              stage: 'provider',
              reasonCode: 'provider_failure',
              payload: { kind: 'provider', attempt },
            });
            askTrace.finishSpan(spanId, {
              outcome: 'denied',
              reasonCode: 'provider_failure',
              payload: { kind: 'provider', attempt },
            });
            lastFailedProviderSpanId = spanId;
          }
          try { onProviderDispatchRejected?.(event); } catch { /* observer is fail-open */ }
        },
        onToolCall: (event) => {
          // Native providers call this callback at the physical tool boundary.
          // Text-protocol loops use the trace-marked callback they received
          // directly, so this avoids recording a single tool twice.
          if (!isAskTraceToolCallback(onToolCall)) {
            recordPhysicalToolCallTrace(askTrace, event, ++physicalToolAttemptIndex);
          }
          onToolCall?.(event);
        },
        };
        return {
          options: physicalOptions,
          admitInvocation: (input: {
            operation: ProviderDispatchEvent['operation'];
            messages: ReadonlyArray<{ role: string; content: string }>;
          }) => admit({
            provider: rawProvider.name,
            operation: input.operation,
            // This is attempt one within the raw-provider method call. Native
            // callbacks for its first send use the same key and deduplicate;
            // later native sends report attempt 2+ and are admitted normally.
            attemptIndex: 1,
            ...(options?.model ? { model: options.model } : {}),
            envelope: {
              messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
            },
          }, false),
          settle: (outcome, error) => {
            for (const entries of pending.values()) {
              for (const entry of entries) finish(entry, outcome, error);
            }
            pending.clear();
          },
        };
      };
      // One retry only, on the SAME configured provider and only for failures
      // that are normally transient. The physical-dispatch observer remains in
      // the path for both attempts, so a retry cannot exceed the run-wide
      // dispatch budget or silently fail over to another provider.
      let transientRetryUsed = false;
      const mayRetrySameProvider = (
        error: unknown,
        identity: ReturnType<typeof providerDispatchIdentity>,
        parent: typeof lastAdmittedPhysicalDispatch | undefined,
      ): boolean => {
        // A frozen exploratory run deliberately reserves its third physical
        // dispatch for the same-plan SQL repair. A transient retry of meaning
        // or generation would consume that reservation, so it is forbidden.
        if (
          signal.aborted
          || transientRetryUsed
          || frozenExploratoryRepairRoute
          || identity.dispatchPhase === 'repair'
          || !parent
          || parent.phase !== identity.dispatchPhase
          || parent.purpose !== identity.purpose
        ) return false;
        const diagnostic = providerDiagnosticForTrace(error, identity.dispatchPhase);
        return diagnostic.retryable && (
          diagnostic.cause === 'rate_limited'
          || diagnostic.cause === 'gateway'
          || diagnostic.cause === 'network'
          || diagnostic.cause === 'provider_timeout'
        );
      };
      const retrySameProviderOnce = async <T>(
        sourceOptions: ProviderToolLoopOptions | undefined,
        operation: (options: ProviderToolLoopOptions | undefined) => Promise<T>,
      ): Promise<T> => {
        const identity = providerDispatchIdentity(sourceOptions);
        const dispatchSequenceBefore = physicalDispatchSequence;
        try {
          return await operation(sourceOptions);
        } catch (error) {
          const parent = lastAdmittedPhysicalDispatch?.sequence && lastAdmittedPhysicalDispatch.sequence > dispatchSequenceBefore
            ? lastAdmittedPhysicalDispatch
            : undefined;
          if (!mayRetrySameProvider(error, identity, parent)) throw error;
          transientRetryUsed = true;
          emit({ kind: 'thinking', text: 'The configured AI provider had a transient error; retrying it once within this run budget.' });
          // The retry carries immutable phase/purpose/provider lineage. The
          // ledger re-validates the parent receipt before it admits any bytes.
          const retryOptions: RunnerOwnedProviderToolLoopOptions = {
            ...(sourceOptions ?? {}),
            dispatchPhase: identity.dispatchPhase,
            egressPurpose: identity.purpose,
            retryOfAttemptIndex: parent!.attemptIndex,
          };
          Object.defineProperty(retryOptions, RUNNER_OWNED_RETRY_LINEAGE, {
            value: {
              parentAttemptIndex: parent!.attemptIndex,
              phase: identity.dispatchPhase,
              purpose: identity.purpose,
            },
            enumerable: false,
          });
          return operation(retryOptions);
        }
      };
      const invokePhysicalProvider = async <T>(
        sourceOptions: ProviderToolLoopOptions | undefined,
        operation: ProviderDispatchEvent['operation'],
        messages: ReadonlyArray<{ role: string; content: string }>,
        invoke: (options: ProviderToolLoopOptions) => Promise<T>,
      ): Promise<T> => {
        const observed = withPhysicalDispatchObserver(sourceOptions);
        try {
          // Own admission/receipt at the only wrapper boundary shared by
          // built-ins, subscription clients, and test/custom providers. A
          // callback-silent implementation cannot reach rawProvider before
          // this succeeds; built-ins deduplicate their first native callback.
          observed.admitInvocation({ operation, messages });
          const result = await invoke(observed.options);
          // Built-in HTTP providers close each span via
          // `onProviderDispatchComplete`; this only closes a custom provider
          // that exposes admission but not the optional completion callback.
          observed.settle('ok');
          return result;
        } catch (error) {
          observed.settle(signal.aborted ? 'cancelled' : 'error', error);
          throw error;
        }
      };
      const provider: AgentProvider = {
        name: rawProvider.name,
        available: () => rawProvider.available(),
        generate: (...args) => retrySameProviderOnce(
          args[1],
          (sourceOptions) => invokePhysicalProvider(sourceOptions, 'generate', args[0], (options) => rawProvider.generate(args[0], options)),
        ),
        ...(rawProvider.generateWithTools ? {
          generateWithTools: (...args: Parameters<NonNullable<AgentProvider['generateWithTools']>>) => retrySameProviderOnce(
            args[2],
            (sourceOptions) => invokePhysicalProvider(sourceOptions, 'generate_with_tools', args[0], (options) => rawProvider.generateWithTools!(args[0], args[1], options)),
          ),
        } : {}),
        ...(rawProvider.generateStream ? {
          generateStream: (...args: Parameters<NonNullable<AgentProvider['generateStream']>>) => invokePhysicalProvider(args[1], 'generate_stream', args[0], (options) => rawProvider.generateStream!(args[0], options, args[2])),
        } : {}),
      };
      if (providerPreflightRequired) {
        // Readiness is a real provider operation, not a proxy for a later
        // answer-loop invocation. Record its own outcome before a route can
        // depend on this provider, while keeping the observer wholly fail-open.
        const preflightSpan = askTrace.startSpan({
          name: 'provider.preflight',
          stage: 'provider',
          reasonCode: 'started',
          payload: {
            kind: 'provider',
            attempt: {
              version: 1,
              phase: 'preflight',
              physicalAttemptIndex: 0,
              providerFingerprint: runtimeFingerprint(rawProvider.name),
              readiness: 'unknown',
              admission: 'unknown',
              provenance: 'live',
            },
          },
        });
        let preflightError: unknown;
        let available = false;
        try {
          available = await provider.available();
        } catch (error) {
          preflightError = error;
        }
        if (!available) {
          const message = `${spec.label} is not configured or reachable. ${spec.setup}`;
          const typedReadinessError = preflightError && typeof preflightError === 'object';
          const classifiedDiagnostic = providerBoundaryDiagnostic({
            providerId: id,
            projectRoot: req.projectRoot,
            phase: 'preflight',
            error: preflightError ?? message,
            // A bare `available() === false` carries no credential, model, or
            // network evidence.  Preserve it as an unconfigured/readiness
            // observation instead of inventing authentication advice.  Typed
            // adapter errors remain authoritative and retain their exact code.
            code: typedReadinessError
              ? String((preflightError as { code?: unknown }).code ?? '')
              : 'PROVIDER_CONFIGURATION_UNAVAILABLE',
          });
          const diagnostic = typedReadinessError
            ? classifiedDiagnostic
            : {
                ...classifiedDiagnostic,
                cause: 'unknown' as const,
                retryable: false,
                safeAction: 'fix_provider_configuration' as const,
              };
          askTrace.finishSpan(preflightSpan, {
            outcome: 'unavailable',
            reasonCode: 'provider_preflight',
            payload: {
              kind: 'provider',
              attempt: {
                version: 1,
                phase: 'preflight',
                physicalAttemptIndex: 0,
                providerFingerprint: diagnostic.providerFingerprint ?? runtimeFingerprint(rawProvider.name),
                ...(diagnostic.modelFingerprint ? { modelFingerprint: diagnostic.modelFingerprint } : {}),
                ...(diagnostic.baseOriginFingerprint ? { baseOriginFingerprint: diagnostic.baseOriginFingerprint } : {}),
                readiness: 'unavailable',
                admission: 'unknown',
                retryable: diagnostic.retryable,
                safeAction: diagnostic.safeAction,
                cause: diagnostic.cause,
                provenance: 'live',
              },
            },
          });
          observeV2ProviderFailure(v2State, diagnostic, true);
          emit({
            kind: 'error',
            message,
            providerDiagnostic: diagnostic,
          });
          return;
        }
        askTrace.finishSpan(preflightSpan, {
          outcome: 'ok',
          reasonCode: 'completed',
          payload: {
            kind: 'provider',
            attempt: {
              version: 1,
              phase: 'preflight',
              physicalAttemptIndex: 0,
              providerFingerprint: runtimeFingerprint(rawProvider.name),
              readiness: 'ready',
              admission: 'unknown',
              provenance: 'live',
            },
          },
        });
      }

      try {
        const requestStartedAt = Date.now();
        emit({
          kind: 'thinking',
          text: providerPreflightRequired
            ? `Using ${spec.label} through the governed DQL agent.`
            : req.deterministicExploratoryProposal
              ? 'Executing the router-selected deterministic physical plan without an AI provider.'
              : 'Executing the router-selected certified plan without an AI provider.',
        });
        const kgPath = defaultKgPath(req.projectRoot);
        if (!existsSync(kgPath)) {
          emit({ kind: 'thinking', text: 'Building the local agent knowledge graph from terms, business views, blocks, apps, dashboards, dbt, and semantic metadata.' });
        }
        const projectStateStartedAt = Date.now();
        const projectState = await ensureAgentProjectReady(req.projectRoot, { kgPath, manifest: req.projectSnapshot?.manifest });
        const projectStateDurationMs = Date.now() - projectStateStartedAt;
        emit({ kind: 'thinking', text: projectState.cacheHit ? 'Reused the warm project index.' : 'Refreshed the project index after source changes.' });

        const rawQuestion = resolveEffectiveQuestion(req);
        if (!rawQuestion) {
          emit({ kind: 'error', message: 'No user question found.' });
          return;
        }
        // V2 may not silently acquire a second context pack if the bridge was
        // lost during request handoff.  A stale or missing bridge is a typed
        // gap, not a reason to re-run retrieval against a newer snapshot.
        if (v2Authoritative && v2State?.snapshotId && !v2Workspace) {
          finishAskAgentV2Turn(v2State, {
            version: 2,
            kind: 'gap',
            reasonCode: 'ASK_V2_SNAPSHOT_BRIDGE_UNAVAILABLE',
            safeAction: 'retry_after_metadata_refresh',
            origin: 'retrieval',
          });
          emit({
            kind: 'error',
            message: 'The retrieved Ask context is no longer available for this immutable snapshot, so DQL did not re-retrieve or execute a query. Refresh metadata and retry.',
          });
          return;
        }

        const memory = new MemoryStore(defaultMemoryPath(req.projectRoot));
        const kg = new KGStore(kgPath);
        try {
          const conversationSnapshot = conversationSnapshotFromContext(req.conversationContext);
          const rawFollowUp = followUpFromConversationContext(req, rawQuestion) ?? inferFollowUpContext(req, rawQuestion);
          const followUp = applyTopicShiftGuard(rawFollowUp, conversationSnapshot);
          // This is a server-side decision recorded by the engine/trace. It
          // never comes from client JSON or an LLM response.
          req.conversationBinding = followUp?.binding ?? 'none';
          // CTX-003: retrieval and planning operate on the user's current words.
          // Prior SQL, DQL source, owners, and result metadata stay in the typed
          // follow-up envelope rendered separately for the provider; concatenating
          // them into the question polluted filters/dimensions and changed intent.
          const question = rewriteFollowUpQuestion(rawQuestion, followUp);
          // Retrieve durable learnings only — notebook/project/user/artifact scope.
          // `thread` (per-conversation) memory is intentionally excluded: it is
          // raw-chat residue, not a governed learning, and bloats the prompt.
          const memoryContext = memory.search({
            query: question,
            scopes: ['notebook', 'project', 'user', 'artifact'],
            scopeId: req.upstream?.cellId,
            limit: 6,
          });
          const semanticLayer = loadAgentSemanticLayer(req.projectRoot);
          const semanticRuntimeActive = semanticLayer
            ? await getSemanticRuntimeStatus(req.projectRoot).then((status) => status.active).catch(() => 'native' as const)
            : 'native' as const;
          const questionPlan = buildAnalysisQuestionPlan(question, followUp);
          const contextBudget = contextRetrievalBudgetForQuestion({
            questionPlan,
            requestedDepth: req.analysisDepth,
            reasoningEffort: req.reasoningEffort,
          });
          const selectedContext = selectedContextForMetadata(req, question);
          emit({ kind: 'thinking', text: 'Searching certified blocks, semantic metrics, relevant domains, and skills.' });
          const contextStartedAt = Date.now();
          const bridgedContextPack = v2Workspace
            ? (() => {
                try { return v2Workspace.getContextPack() as LocalContextPack | undefined; } catch { return undefined; }
              })()
            : undefined;
          // In authoritative V2 the bridge is the immutable retrieval boundary.
          // Falling back to a newly built pack here would let a post-planner
          // retrieval silently change candidate identity, which is exactly the
          // double-context failure V2 is meant to remove. Legacy/shadow keeps
          // its existing prepared/local retrieval compatibility path.
          const contextPack = v2Authoritative
            ? bridgedContextPack
            : bridgedContextPack ?? req.preparedContextPack ?? await buildLocalContextPack(req.projectRoot, {
            question,
            surface: 'notebook',
            followUp,
            selectedContext,
            strictness: contextBudget.strictness,
            limit: contextBudget.limit,
            confirmCertifiedFit: createCertifiedFitConfirmation(provider, signal),
            // A cross-encoder pass over the fused candidates. Advisory: it may
            // only reorder what retrieval returned, and a failure or timeout
            // leaves retrieval's ordering untouched — so it can improve the
            // pack and cannot break it.
            rerankCandidates: (rerankQuestion, candidates) => rerankCandidates(
              provider,
              rerankQuestion,
              candidates,
              {
                ...(signal ? { signal } : {}),
                timeoutMs: Math.round(2_500 * deadlineScale()),
              },
            ),
            // Conversation-aware reuse: same-topic follow-ups seed (or, for
            // filter-only refinements, re-stamp) the prior turn's context pack.
            priorContextPackId: priorContextPackIdFromSnapshot(conversationSnapshot),
            conversationTopicRelation: conversationSnapshot?.topicRelation,
            domainContext: req.domainContext,
            preparedMetadataFingerprint: projectState.metadataFingerprint,
            })
              .catch(() => undefined);
          if (v2Authoritative && !contextPack) {
            const text = 'The immutable Ask snapshot could not supply its bound context pack. DQL did not re-retrieve or execute a query.';
            finishAskAgentV2Turn(v2State!, {
              version: 2,
              kind: 'gap',
              reasonCode: 'ASK_V2_BOUND_CONTEXT_UNAVAILABLE',
              origin: 'retrieval',
              safeAction: 'refresh_snapshot_then_retry',
            });
            emit({
              kind: 'tool_result',
              id: 'governed_answer',
              output: askV2NoAnswer({ contextPack: undefined } as AnswerLoopInput, 'gap', 'ASK_V2_BOUND_CONTEXT_UNAVAILABLE', 'retrieval'),
            });
            return;
          }
          // CTX-002/SKILL-003: the immutable context pack is the single skill
          // selection for this turn. Never re-read mutable skill files after
          // the project snapshot has been acquired.
          const skills: Skill[] = (contextPack?.skills ?? []).map((skill) => ({
            id: skill.id,
            localId: skill.id,
            qualifiedId: skill.qualifiedId,
            scope: 'project',
            domain: skill.domain,
            domains: skill.domains,
            modelAreaRefs: skill.modelAreaRefs,
            kind: skill.kind,
            status: skill.status,
            owner: skill.owner,
            triggers: skill.triggers,
            exclusions: skill.exclusions,
            description: skill.description,
            preferredMetrics: skill.preferredMetrics,
            preferredBlocks: skill.preferredBlocks,
            preferredDimensions: skill.preferredDimensions,
            requiredFilters: skill.requiredFilters,
            clarifyWhen: skill.clarifyWhen,
            examples: [],
            sourceRefs: skill.sourceRefs,
            vocabulary: skill.vocabulary,
            body: skill.guidance,
            sourcePath: skill.sourcePath ?? '',
          }));
          const contextDurationMs = Date.now() - contextStartedAt;
          const answerLoopTools = buildAnswerLoopTools(req.projectRoot, {
            researchResultRowsOptIn: researchRowsOptIn,
          });
          const sourceSearchTool = answerLoopTools.find((tool) => tool.name === 'search_project_files');
          const sourceSearchStartedAt = Date.now();
          const earlySourceSearch = sourceSearchTool && shouldSearchProjectFiles(contextPack)
            ? await (async () => {
                emit({ kind: 'thinking', text: 'Checking live project definitions for a missed metric, dimension, or join.' });
                return sourceSearchTool.run({ query: question, limit: 24 }).catch(() => undefined);
              })()
            : undefined;
          const sourceSearchDurationMs = Date.now() - sourceSearchStartedAt;
          const extraContext = [
            renderExtraContext(req, followUp),
            renderProjectSourceSearch(earlySourceSearch),
          ].filter((value): value is string => Boolean(value)).join('\n\n') || undefined;
          // Verify retrieved relation columns against the active execution
          // target before generated SQL runs. The runtime limits this to a few
          // named relations and reuses this prepared context pack.
          const schemaStartedAt = Date.now();
          if (req.getSchemaContext && shouldLoadSchemaContext(contextPack, Boolean(semanticLayer))) {
            emit({ kind: 'thinking', text: 'Inspecting the runtime schema needed to ground this answer.' });
          }
          const schemaContext = req.getSchemaContext && shouldLoadSchemaContext(contextPack, Boolean(semanticLayer))
            ? await req.getSchemaContext(question, contextPack).catch(() => [])
            : [];
          // The router's exploratory candidate IDs are server-owned execution
          // authority. Once that tier is selected, provider prompt/schema
          // context must be the candidate closure rather than the broad
          // retrieval pack. The latter remains available to the host for
          // receipts only and cannot be used to introduce another relation.
          const forcedExploratoryTier = req.selectedCascadeTier === 'exploratory_sql';
          // Re-derive the closure from the broad immutable pack and the
          // router-selected IDs. `preparedExploratoryContextPack` is only a
          // server-side consistency witness; it cannot override or widen the
          // derivation even if a future caller constructs an AgentRunner
          // request directly.
          const derivedExploratoryContextPack = forcedExploratoryTier
            ? scopeContextPackToExploratoryCandidateClosure(contextPack, req.exploratoryCandidateIds)
            : undefined;
          const closureWitnessMatches = !req.preparedExploratoryContextPack
            || exploratoryClosureMatches(
              derivedExploratoryContextPack,
              req.preparedExploratoryContextPack,
            );
          const exploratoryContextPack = closureWitnessMatches
            ? derivedExploratoryContextPack
            : undefined;
          if (forcedExploratoryTier && (!exploratoryContextPack || !req.exploratoryCandidateIds?.length)) {
            const text = 'The router-selected exploratory path no longer has a complete same-snapshot physical closure, so DQL did not send SQL generation or execute a query.';
            emit({
              kind: 'tool_result',
              id: 'governed_answer',
              output: {
                kind: 'no_answer',
                sourceTier: 'no_answer',
                certification: 'analyst_review_required',
                reviewStatus: 'none',
                confidence: 0,
                text,
                answer: text,
                refusalCode: 'grounding_gap',
                refusalDetails: {
                  code: closureWitnessMatches ? 'EXPLORATORY_CLOSURE_UNAVAILABLE' : 'EXPLORATORY_CLOSURE_MISMATCH',
                  message: text,
                },
                contextPack,
                providerUsed: provider.name,
              },
            });
            return;
          }
          const answerContextPack = forcedExploratoryTier
            ? exploratoryContextPack ?? contextPack
            : contextPack;
          const normalizeQualifiedRelation = (value: string): string => value
            .trim()
            .split('.')
            .map((part) => part.trim().replace(/^["`\[]|["`\]]$/g, '').toLowerCase())
            .filter(Boolean)
            .join('.');
          const closureRelations = new Set(
            (exploratoryContextPack?.allowedSqlContext.relations ?? [])
              .map((relation) => normalizeQualifiedRelation(relation.relation)),
          );
          const answerSchemaContext = forcedExploratoryTier && closureRelations.size > 0
            ? schemaContext.filter((table) => closureRelations.has(normalizeQualifiedRelation(table.relation)))
            : schemaContext;
          const schemaDurationMs = Date.now() - schemaStartedAt;
          const selectedBlockHints = shouldUseSelectedBlockHint(req, question, followUp)
            ? extractSelectedBlockHints(req)
            : [];
          const blockHints = Array.from(new Set([
            ...(followUp?.kind === 'generic' && followUp.sourceBlockName ? [followUp.sourceBlockName] : []),
            ...selectedBlockHints,
          ]));
          const answerStartedAt = Date.now();
          emit({ kind: 'thinking', text: 'Resolving the best governed answer path and validating the result.' });
          const manifest = req.projectSnapshot?.manifest ?? buildManifest({
            projectRoot: req.projectRoot,
            dbtManifestPath: resolveDbtManifestPath(req.projectRoot) ?? undefined,
          });
          const guardSnapshot = (): void => {
            if (req.projectSnapshot) req.assertProjectSnapshot?.(req.projectSnapshot.snapshotId);
          };
          assertProviderPayloadAllowed(prepareProviderContextForDispatch({
            question,
            ...(conversationSnapshot ? { conversationSnapshot } : {}),
            ...(memoryContext ? { memoryContext } : {}),
            schemaContext: prepareServerOwnedProviderSchemaContext(answerSchemaContext),
            ...(answerContextPack ? { contextPack: answerContextPack } : {}),
            skills,
            ...(followUp ? { followUp } : {}),
          }), {
            allowResultRows: false,
            maxResultRows: 0,
            purpose: 'answer_generation',
          });
          // The strangler seam. `answerAgentic` and `answer` are interchangeable
          // here; which runs is a per-lane config decision that defaults to
          // legacy, so this is a no-op until a lane is explicitly enabled.
          // Preserve the non-enumerable observer when the provider runner
          // projects the AgentRun request into the answer-loop input.  The
          // analyst loop receives this projected object, so dropping the
          // observer here would make actual text-protocol tool calls invisible
          // even though provider, router, and SQL evidence was recorded.
          const answerLoopInput: Parameters<typeof answer>[0] = attachAskTraceObserverV1<Parameters<typeof answer>[0]>({
            question,
            ...(v2Workspace ? { askAgentV2Workspace: v2Workspace } : {}),
            ...(req.skipCrossResultComputation
              ? { skipCrossResultComputation: true }
              : {}),
            ...(req.resolvedAnalyticalPlan
              ? { resolvedAnalyticalPlan: req.resolvedAnalyticalPlan }
              : {}),
            ...(req.selectedCascadeTier
              ? { selectedCascadeTier: req.selectedCascadeTier }
              : {}),
            ...(req.exploratoryCandidateIds?.length
              ? { exploratoryCandidateIds: [...req.exploratoryCandidateIds] }
              : {}),
            ...(req.generatedProposalTargetFingerprint
              ? { generatedProposalTargetFingerprint: req.generatedProposalTargetFingerprint }
              : {}),
            ...(req.deterministicExploratoryProposal
              ? { forcedGeneratedProposal: req.deterministicExploratoryProposal }
              : {}),
            ...(req.analyticalReferenceInstant
              ? { analyticalReferenceInstant: req.analyticalReferenceInstant }
              : {}),
            ...(req.resolveAnalyticalFreshness
              ? { resolveAnalyticalFreshness: req.resolveAnalyticalFreshness }
              : {}),
            extraContext,
            provider,
            kg,
            manifest,
            domain: req.domainContext?.activeDomain ?? undefined,
            domainContext: req.domainContext,
            skills,
            blockHints,
            followUp,
            conversationSnapshot,
            memoryContext,
            schemaContext: answerSchemaContext,
            semanticLayer,
            // Runtime-aware executability for metric SELECTION: with a full
            // semantic runtime active (dbt Cloud / MetricFlow CLI) every
            // governed metric is executable; native-only hosts demote
            // runtime-only metrics so they cannot outrank an executable
            // sibling on a lexical tie.
            ...(semanticLayer
              ? {
                  canExecuteSemanticMetric: (metricName: string) =>
                    semanticRuntimeActive !== 'native' || semanticLayer.canComposeMetric(metricName),
                }
              : {}),
            contextPack: answerContextPack,
            // The project's configured embedder (dql.config.json ai.embeddings).
            // Without it, matchSemanticMetric falls back to the offline hashed
            // provider, whose vectors can never ground a match on similarity
            // alone — so a metric named only by synonym or acronym is invisible
            // and the router dead-ends on a bare-ranking clarification.
            embeddingProvider: projectEmbeddingProvider(req.projectRoot),
            signal,
            reasoningEffort: req.reasoningEffort,
            analysisDepth: contextBudget.analysisDepth,
            allowProviderSemanticMemberSelection: req.allowProviderSemanticMemberSelection === true,
            ...(req.semanticDriver ? { semanticDriver: req.semanticDriver } : {}),
            ...(req.semanticTableMapping ? { semanticTableMapping: req.semanticTableMapping } : {}),
            ...(req.semanticQueryCompiler ? { semanticQueryCompiler: req.semanticQueryCompiler } : {}),
            ...(req.preferredEvidenceIds?.length ? { preferredEvidenceIds: req.preferredEvidenceIds } : {}),
            ...(req.preferredExecutionId ? { preferredExecutionId: req.preferredExecutionId } : {}),
            executeCertifiedBlock: req.executeCertifiedBlock
              ? async (...args) => {
                  guardSnapshot();
                  return executeAtSqlBoundary(() => req.executeCertifiedBlock!(...args));
                }
              : undefined,
            executeGeneratedSql: req.executeGeneratedSql
              ? async (...args) => {
                  guardSnapshot();
                  return executeAtSqlBoundary(() => req.executeGeneratedSql!(...args));
                }
              : undefined,
            // Host-owned allowlist literal probe: read-only, value-bounded,
            // and consumed only by the host-first binder — no snapshot or
            // SQL-boundary guard is needed because it can never execute a
            // provider-authored query.
            ...(req.probeAllowlistedLiteral ? { probeAllowlistedLiteral: req.probeAllowlistedLiteral } : {}),
            ...(req.catalogTermMentioned ? { catalogTermMentioned: req.catalogTermMentioned } : {}),
            prepareExploratorySqlExecution: req.prepareExploratorySqlExecution
              ? async (sql, ...args) => {
                  guardSnapshot();
                  // The execution host repeats this validation immediately
                  // before capability minting. Keep the same exact-qualified
                  // closure check here as well, before the provider runner can
                  // even invoke that host boundary. A provider response cannot
                  // use another same-snapshot relation merely because it was
                  // present in broad retrieval diagnostics.
                  if (forcedExploratoryTier && exploratoryContextPack) {
                    const proposalValidation = validateSqlAgainstLocalContext(sql, exploratoryContextPack, {
                      runtimeSchema: answerSchemaContext,
                    });
                    const outsideClosure = !proposalValidation.ok
                      || proposalValidation.referencedRelations.some((relation) =>
                        !closureRelations.has(normalizeQualifiedRelation(relation)),
                      );
                    if (outsideClosure) {
                      throw Object.assign(
                        new Error('The generated SQL references a relation outside the router-selected physical closure, so it was not executed.'),
                        { code: 'UNAUTHORIZED_SQL' },
                      );
                    }
                  }
                  return req.prepareExploratorySqlExecution!(sql, ...args);
                }
              : undefined,
            // Authoritative V2 deliberately bypasses the legacy routeDecision
            // authorization callback above.  These two host callbacks consume
            // only the immutable V2 workspace/state carried on this request;
            // they cannot reopen a V1 cascade or mint a second plan.
            prepareAskV2ExploratorySqlExecution: req.prepareAskV2ExploratorySqlExecution
              ? async (proposal) => {
                  guardSnapshot();
                  return req.prepareAskV2ExploratorySqlExecution!(proposal);
                }
              : undefined,
            authorizeAskV2DqlArtifact: req.authorizeAskV2DqlArtifact
              ? async (proposal) => {
                  guardSnapshot();
                  return req.authorizeAskV2DqlArtifact!(proposal);
                }
              : undefined,
            executeAgenticGeneratedSql: req.executeAgenticGeneratedSql
              ? async (capability, sql, artifact) => {
                  guardSnapshot();
                  return executeAtSqlBoundary(() => req.executeAgenticGeneratedSql!(capability, sql, artifact));
                }
              : undefined,
            agenticExecutionScope: {
              runId: req.agentRunId,
              snapshotId: req.projectSnapshot?.snapshotId,
              planId: req.resolvedAnalyticalPlan?.planId,
              targetFingerprint: req.generatedProposalTargetFingerprint,
            },
            executeDqlArtifact: req.executeDqlArtifact
              ? async (...args) => {
                  guardSnapshot();
                  return executeAtSqlBoundary(() => req.executeDqlArtifact!(...args));
                }
              : undefined,
            executeAskV2DqlArtifact: req.executeAskV2DqlArtifact
              ? async (proposal) => {
                  guardSnapshot();
                  return executeAtSqlBoundary(() => req.executeAskV2DqlArtifact!(proposal));
                }
              : undefined,
            expandGroundingContext: createGroundingContextExpander(req.projectRoot, req.probeNamedRelations),
            answerLoopTools,
            providerPayloadGuard: {
              purpose: v2Authoritative ? 'answer_generation' : 'research_tool',
              allowedResultRowTools: v2Authoritative
                ? (v2ResultEgress?.allowRows
                  ? { sample_notebook_dataset: 20, execute_local_analysis: 20, preview_query: 20 }
                  : {})
                : researchRowsOptIn
                  ? { sample_notebook_dataset: 20, execute_local_analysis: 200 }
                  : {},
              resultRowBudgetGroupByTool: {
                sample_notebook_dataset: 'research_sample',
                execute_local_analysis: 'research_local_analysis',
                ...(v2Authoritative ? { preview_query: 'ask_v2_result' } : {}),
              },
              cumulativeResultRowBudgets: {
                ...(v2Authoritative
                  ? { research_sample: 20, research_local_analysis: 20, ask_v2_result: 20 }
                  : { research_sample: 20, research_local_analysis: 200 }),
              },
              ...(v2Authoritative ? {
                maxResultColumns: v2ResultEgress?.maximumColumns,
                maxResultCells: v2ResultEgress?.maximumCells,
              } : {}),
              onPayload: ({ toolName, output, resultRowCount, columnCount, cumulativeResultRowCount }) => {
                if (v2Authoritative) {
                  if (resultRowCount === 0) return;
                  providerEgressReceipts.push(createProviderEgressReceipt({
                    purpose: 'answer_generation',
                    provider: provider.name,
                    permittedCategories: ['question', 'schema_metadata', 'result_rows'],
                    optIn: v2ResultEgress?.allowRows === true,
                    payload: { toolName, output },
                    resultRowCount,
                    columnCount,
                    cumulativeResultRowCount,
                  }));
                  return;
                }
                pendingResearchPurpose = researchDispatchPurposeForTool(toolName);
                pendingResultRowCount += resultRowCount;
                pendingColumnCount = Math.max(pendingColumnCount, columnCount);
                pendingCumulativeResultRowCount = Math.max(pendingCumulativeResultRowCount, cumulativeResultRowCount);
                if (resultRowCount === 0) return;
                providerEgressReceipts.push(createProviderEgressReceipt({
                  purpose: researchDispatchPurposeForTool(toolName),
                  provider: provider.name,
                  permittedCategories: ['question', 'schema_metadata', 'result_rows'],
                  optIn: researchRowsOptIn,
                  payload: { toolName, output },
                  resultRowCount,
                  columnCount,
                  cumulativeResultRowCount,
                }));
              },
            },
            // NOTE: no captureGeneratedDraft here — a plain answer/research question must NOT
            // auto-write a draft into the blocks space. A draft is created only when the user
            // explicitly acts (the "Create DQL draft" action → the dql_block_draft route).
          } as Parameters<typeof answer>[0], askTrace);
          let result: AgentAnswer;
          if (v2Authoritative) {
            // Tier 1 completes before provider planning.  The direct path is
            // still fully V2-owned: it uses the same immutable workspace,
            // freezes at capability minting, calls the same host executor,
            // and records the same typed tool/fact receipt.  It never calls
            // the V1 answer loop or a provider merely to rediscover an exact
            // certified artifact already proven by retrieval.
            const exactCertified = await executeAskV2ExactCertifiedFastPath(answerLoopInput, v2State);
            if (exactCertified) {
              result = exactCertified;
            } else {
            // The V2 lane is a real handler, not a post-hoc label for the
            // generated analyst loop. Its legacy function is an assertion: it
            // must never be called because the V2 policy has no fallback.
            result = await answerAgentic(answerLoopInput, {
              policy: orchestratorPolicyForRequest(req),
              lane: agenticLaneForRequest(req),
              legacy: async () => {
                throw new Error('ASK_V2_LEGACY_CONTROLLER_MUST_NOT_RUN');
              },
              // Research is an explicit V2 handler on the same snapshot and
              // tool kernel. It never falls through to the legacy research
              // controller when the provider chooses a branch/tool.
              handlers: {
                ask_v2: createAskV2LaneHandler(v2State!),
                research: createAskV2ResearchLaneHandler(v2State!),
              },
            });
            }
          } else {
          result = req.deterministicExploratoryProposal
            ? await answer(answerLoopInput)
            : await answerAgentic(answerLoopInput, {
            // V2 is an explicit host-owned runtime selection, not a project
            // config accident.  It sends the immutable retrieved workspace to
            // the bounded analyst tool loop even when an older project still
            // has the migration policy set to legacy.  Shadow never serves.
            policy: orchestratorPolicyForRequest(req),
            lane: agenticLaneForRequest(req),
            legacy: answer,
            // The generated lane runs the analyst loop: it verifies every
            // identifier against a tool observation before the SQL is executed.
            // Certified and semantic lanes are deliberately NOT registered —
            // their answers already come from a governed contract, so a
            // verification pass would add latency and no safety.
            handlers: {
              generated: createAnalystLaneHandler({
                legacy: answer,
                authoritativeV2: v2Authoritative,
                buildDeps: (loopInput) => {
                  const execute = loopInput.executeGeneratedSql;
                  const valuesEnabled = valueLookupEnabled(req.projectRoot);
                  const tools = buildAnalystLoopTools(loopInput, { valuesEnabled });
                  if (process.env.DQL_ORCHESTRATOR_TRACE) {
                    console.warn(`[dql] analyst loop deps: tools=${tools.length} preview=${Boolean(execute)} values=${valuesEnabled}`);
                  }
                  if (tools.length === 0) return undefined;
                  return {
                    tools,
                    maxIterations: resolveOrchestratorPolicy({
                      config: readOrchestratorConfig(req.projectRoot),
                    }).maxIterations,
                    // Keep the raw loop bounded by the same physical ceiling
                    // as the wrapper. The run-scoped ledger still admits only
                    // one ordinary generation/planning transport; a separate
                    // frozen-plan repair marker is required for the third send.
                    maxProviderDispatches,
                    // Scaled by the same knob as every other agent deadline, so
                    // a local model that needs seconds per call is not planned
                    // out of existence by a budget calibrated for a hosted one.
                    // V2 deliberately uses one bounded turn plan after
                    // retrieval.  V1 keeps its historical research-only
                    // planning policy so this does not broaden legacy calls.
                    ...(turnPlanningEnabled(req.projectRoot, req.orchestrationMode) || v2Authoritative ? {
                    planTurn: async (question: string, toolNames: string[]) => {
                      const plan = await planAnalystTurn(
                        loopInput.provider,
                        question,
                        toolNames,
                        {
                          timeoutMs: Math.round(2_500 * deadlineScale()),
                          ...(loopInput.signal ? { signal: loopInput.signal } : {}),
                        },
                      );
                      if (process.env.DQL_ORCHESTRATOR_TRACE) {
                        console.warn(plan
                          ? `[dql] analyst turn plan: "${plan.restatement}" establish=${plan.mustEstablish.length} opening=${plan.openingTool ?? 'unset'}`
                          : '[dql] analyst turn plan: unavailable (loop proceeds unplanned)');
                      }
                      return plan;
                    },
                    } : {}),
                    // Text-protocol tool loops execute tools outside the
                    // provider transport, so carry the same physical-boundary
                    // observer through the loop. The marker prevents the
                    // provider wrapper from duplicating native tool records.
                    onToolCall: v2Authoritative
                      ? createAskV2TraceToolCallback(askTraceObserverForV1(loopInput), v2State)
                      : createAskTraceToolCallback(askTraceObserverForV1(loopInput)),
                    // The loop's trace, on the channel the provider already uses
                    // for progress. `thinking` turns become `onProgress`, which
                    // the run engine emits as `executor.started` over SSE — so
                    // this needs no new event type, no contract change, and no
                    // UI work. Without it the loop does real work (tool calls,
                    // identifier checks, a bounded repair) behind a silent
                    // spinner, which reads as a hang rather than as an analyst
                    // establishing facts.
                    onStep: (step) => {
                      emit({
                        kind: 'thinking',
                        text: step.detail ? `${step.label} — ${step.detail}` : step.label,
                      });
                    },
                    // Reuse the legacy parser and validator rather than forking
                    // a second SQL front end that would drift from the first.
                    parseSql: (raw) => parseProposal(raw).sql,
                    extractReferences: (sql) => {
                      const validation = validateSqlAgainstLocalContext(sql, loopInput.contextPack);
                      const qualified = qualifyAuthorizationReferences(sql, {
                        relations: validation.referencedRelations ?? [],
                        columns: validation.referencedColumns ?? [],
                      });
                      return {
                        relations: validation.referencedRelations ?? [],
                        columns: qualified.filter((reference) => !validation.referencedRelations?.includes(reference)),
                      };
                    },
                    // The safety verifiers keep their logic; only what happens on
                    // failure changes. Instead of ending the turn, the specific
                    // check that fired comes back as something the model can act
                    // on — "joining those tables multiplies rows" rather than
                    // "nothing was executed".
                    verifySql: (sql) => {
                      const validation = validateSqlAgainstLocalContext(sql, loopInput.contextPack);
                      if (validation.ok) return undefined;
                      return renderContextValidationRefusalForUser(
                        validation.code,
                        validation.error,
                        loopInput.followUp?.memberBindings,
                        validation.aggregationSafetyProof?.issueCodes,
                      );
                    },
                  };
                },
              }),
            },
            onDiagnostic: (event) => {
              if (event.kind === 'fallback') {
                console.warn(`[dql] agentic orchestrator fell back on ${event.lane}: ${event.reason}`);
              } else if (process.env.DQL_ORCHESTRATOR_TRACE) {
                // Opt-in dispatch trace. A migration where the new path silently
                // never runs looks identical to one where it runs and agrees,
                // and that ambiguity costs more to debug than the log costs to
                // carry.
                console.warn(`[dql] agentic orchestrator dispatched lane=${event.lane} mode=${event.mode}`);
              }
            },
          });
          }
          if (v2Authoritative) finishV2AnswerFromResult(v2State, result);
          terminalAnswer = result;
          const answerDurationMs = Date.now() - answerStartedAt;
          // CTX-002: an answer built from one snapshot must never be published
          // after the runtime has advanced to another snapshot.
          guardSnapshot();
          result.evidence = result.evidence ?? {
            route: [], lineage: [], businessContext: [], selectedAssets: [], sourceTables: [], semanticObjects: [], citations: result.citations,
          };
          result.evidence.route.unshift({
            tool: 'prepare_project_state',
            status: 'checked',
            label: projectState.cacheHit ? 'Reused warm project index' : 'Refreshed project index',
            detail: `catalog=${projectState.metadataFingerprint.slice(0, 12)}; schema=${schemaContext.length > 0 ? 'loaded' : 'deferred'}`,
          });
          result.evidence.timings = [
            { phase: 'project_state', durationMs: projectStateDurationMs, detail: projectState.cacheHit ? 'warm index reused' : 'project index refreshed' },
            { phase: 'context_retrieval', durationMs: contextDurationMs, detail: contextPack ? `objects=${contextPack.objects.length}` : 'catalog unavailable' },
            { phase: 'source_search', durationMs: sourceSearchDurationMs, detail: earlySourceSearch ? 'bounded live fallback ran' : 'not needed' },
            { phase: 'runtime_schema', durationMs: schemaDurationMs, detail: schemaContext.length > 0 ? `tables=${schemaContext.length}` : 'deferred' },
            { phase: 'answer_resolution', durationMs: answerDurationMs, detail: result.route?.tier ?? result.kind },
            { phase: 'total', durationMs: Date.now() - requestStartedAt },
          ];
          const terminalDispatchEvidence = dispatchEvidence('none');
          result.evidence.runtimeCounters = {
            providerRoundTrips: terminalDispatchEvidence.providerRoundTrips,
            toolCalls: result.evidence.toolCalls?.length ?? 0,
            sqlExecutions,
            repairs: result.analysisPlan?.repairAttempts ?? 0,
          };
          if (isResearch && !providerEgressReceipts.some((receipt) => receipt.purpose === 'research_tool')) {
            providerEgressReceipts.push(createProviderEgressReceipt({
              purpose: 'research_tool',
              provider: provider.name,
              permittedCategories: ['instructions', 'question', 'schema_metadata', 'governed_context'],
              optIn: researchRowsOptIn,
              payload: { resultRows: 0, enabled: researchRowsOptIn },
              resultRowCount: 0,
              columnCount: 0,
            }));
          }
          result.providerEgressReceipts = sharedDispatchEvidence
            ? terminalDispatchEvidence.providerEgressReceipts
            : providerEgressReceipts;
          emit({ kind: 'tool_result', id: 'governed_answer', output: result });
          emit({ kind: 'text', text: formatAgentAnswer(result) });
          if (result.proposedSql) {
            emitDraftProposal(result, question, emit);
          } else {
            emitProposalFromText(result.text, emit);
          }
          // NOTE: we deliberately do NOT persist a per-turn chat summary into
          // memory. Raw chat is not a correctness signal; auto-capturing it
          // pollutes the store and bloats every later prompt. Durable learning
          // comes only from governed deltas (certify/correct). Conversation
          // continuity is carried per-request via conversationContext instead.
        } finally {
          kg.close();
          memory.close();
        }
        emit({ kind: 'done', stopReason: 'stop' });
        // The terminal V2 state belongs to this provider-runner invocation.
        // Return its sanitized execution receipt directly to the host instead
        // of asking a caller to observe mutation through a cloned request.
        const terminalReceipt = v2Authoritative
          ? askV2ExecutionReceiptFromTerminalState(v2State, req.askAgentV2ExecutionCapability, terminalAnswer)
          : undefined;
        return terminalReceipt ? { askAgentV2ExecutionReceipt: terminalReceipt } : undefined;
      } catch (err) {
        // A deadline/cancellation is NOT a provider failure. Rethrow it intact so
        // the engine renders its graceful bounded-deadline message instead of a
        // raw "<provider> failed: The operation was aborted due to timeout".
        if (signal.aborted) {
          const reason = signal.reason ?? err;
          if (reason && typeof reason === 'object') {
            Object.assign(reason, { providerDispatchEvidence: dispatchEvidence('cancelled') });
          }
          throw reason;
        }
        const message = err instanceof Error ? err.message : String(err);
        // Both codes are DQL's OWN budget refusing to start another dispatch.
        // Only the count-based one was recognized, so a time-based refusal was
        // reported as "<provider> failed: The 30-second soft target elapsed" —
        // blaming the user's AI subscription for DQL's timer and sending them
        // to debug the wrong system entirely.
        const budgetCode = err && typeof err === 'object'
          ? String((err as { code?: unknown }).code)
          : '';
        const orchestrationBudgetExhausted = budgetCode === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED'
          || budgetCode === 'RUN_SOFT_TARGET_EXCEEDED'
          || budgetCode === 'RUN_DEADLINE_INSUFFICIENT';
        // The project catalog was rebuilt underneath a run in flight. That is
        // DQL's own concurrency, and telling the user their AI subscription
        // failed sends them to re-authenticate a provider that worked fine.
        const snapshotDrift = budgetCode === 'PROJECT_SNAPSHOT_MISMATCH';
        const setupHint = shouldShowProviderSetupHint(message) ? ` ${spec.setup}` : '';
        const diagnostic = providerBoundaryDiagnostic({
          providerId: id,
          projectRoot: req.projectRoot,
          phase: orchestrationBudgetExhausted ? 'planning' : 'generation',
          error: err,
          code: orchestrationBudgetExhausted
            ? 'PROVIDER_DISPATCH_BUDGET'
            : snapshotDrift
              ? 'ADMISSION_DENIED'
              : budgetCode,
        });
        observeV2ProviderFailure(v2State, diagnostic, true);
        emit({
          kind: 'error',
          message: orchestrationBudgetExhausted
            ? `Ask stopped at its own bounded orchestration budget before a final answer was available — the AI provider did not fail. (${message})`
            : snapshotDrift
              ? 'The project snapshot was rebuilt while this run was in flight, so DQL discarded the in-progress plan rather than answer from a stale catalog. The AI provider did not fail — retry the question.'
              : `${spec.label} failed: ${message}.${setupHint}`,
          dispatchEvidence: dispatchEvidence(
            orchestrationBudgetExhausted ? 'orchestration_budget_exhausted'
              : snapshotDrift ? 'project_snapshot_mismatch'
              : 'provider_error',
          ),
          providerDiagnostic: diagnostic,
        });
      }
    },
  };
}

function shouldShowProviderSetupHint(message: string): boolean {
  return /api key|not configured|not reachable|connection refused|ECONNREFUSED|fetch failed|network error|model .*not found/i
    .test(message);
}

function lastUserMessage(req: AgentRunRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role === 'user' && msg.content.trim()) return msg.content.trim();
  }
  return '';
}

/** Did the assistant's previous turn ask the user a clarifying question? */
const CLARIFY_MARKER_RE =
  /one more detail|needs clarification|which (?:business object|metric|table|certified block)|what (?:grain|filter|time period)|baseline period|should define the answer|before (?:i can|it can) (?:safely )?(?:answer|generate)/i;

/**
 * When the prior assistant turn was a clarifying question and this turn is the user's
 * answer, the answer alone is too vague to route — re-classifying it just re-clarifies.
 * Fold the ORIGINAL question together with the clarification answer so the loop has
 * enough to proceed. Returns the current message unchanged when this isn't a clarify
 * follow-up.
 */
export function resolveEffectiveQuestion(req: AgentRunRequest): string {
  const msgs = req.messages;
  const current = lastUserMessage(req);
  if (!current) return current;
  // The current user turn is the last message; find the assistant turn before it.
  let assistantIdx = -1;
  for (let i = msgs.length - 2; i >= 0; i--) {
    if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
  }
  if (assistantIdx < 0) return current;
  if (!CLARIFY_MARKER_RE.test(msgs[assistantIdx].content)) return current;
  if (!isLikelyClarificationReply(current)) return current;
  // Find the original user question that prompted the clarification.
  let original = '';
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].content.trim()) { original = msgs[i].content.trim(); break; }
  }
  if (!original || original === current) return current;
  return `${original} — clarification: ${current}`;
}

export function rewriteFollowUpQuestion(question: string, followUp?: AgentFollowUpContext): string {
  void followUp;
  return question.replace(/\s+/g, ' ').trim();
}

function formatPriorResultRefForQuestion(ref: AgentPriorResultReference): string {
  const parts = [
    `Prior result ref: result:${ref.id}`,
    ref.columns.length ? `schema=[${ref.columns.slice(0, 24).join(', ')}]` : '',
    typeof ref.rowCount === 'number' ? `row_count=${ref.rowCount}` : '',
    ref.sourceSql ? `source_sql=${compactInline(ref.sourceSql, 500)}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

function formatPriorDqlArtifactForQuestion(artifact: AgentDqlArtifactReference): string {
  const parts = [
    `Prior DQL artifact: kind=${artifact.kind}`,
    artifact.name ? `name=${artifact.name}` : '',
    artifact.sourcePath ? `path=${artifact.sourcePath}` : '',
    artifact.metrics?.length ? `metrics=[${artifact.metrics.slice(0, 12).join(', ')}]` : '',
    artifact.dimensions?.length ? `dimensions=[${artifact.dimensions.slice(0, 12).join(', ')}]` : '',
    artifact.filters?.length ? `filters=[${artifact.filters.slice(0, 8).map(formatDqlArtifactFilterInline).join('; ')}]` : '',
    artifact.timeDimension ? `time=${artifact.timeDimension.name}/${artifact.timeDimension.granularity}` : '',
    artifact.orderBy?.length ? `order_by=[${artifact.orderBy.slice(0, 8).map((order) => `${order.name} ${order.direction}`).join(', ')}]` : '',
    typeof artifact.limit === 'number' ? `limit=${artifact.limit}` : '',
    artifact.source ? `source=${compactInline(artifact.source, 900)}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

function formatDqlArtifactFilterInline(filter: { dimension: string; operator: string; values: string[] }): string {
  return `${filter.dimension} ${filter.operator} ${filter.values.slice(0, 8).join(', ')}`;
}

function formatFollowUpFilters(followUp: AgentFollowUpContext): string {
  if (!followUp.filters?.length) return '';
  if (followUp.dimensions?.length === 1) {
    return `${followUp.dimensions[0]} in [${followUp.filters.join(', ')}]`;
  }
  return followUp.filters.join(', ');
}

function compactInline(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3).trimEnd()}...` : compact;
}

/** Drafts shown to the model per app; enough to be useful, bounded for prompt size. */
const APP_DRAFT_PROMPT_LIMIT = 6;

/**
 * The App copilot's own app: its pages, tiles, and review-required drafts.
 *
 * `AppContextEnvelopeV1` already travelled to the prompt inside the serialized
 * run envelope, but only as an anonymous JSON dump — and it never carried the
 * app's drafts at all, because those live in `apps/<id>/drafts/` which the
 * manifest's block scan never reads. Rendering it here gives the drafts the
 * explicit trust instruction they need; the caller drops `appContext` from the
 * JSON dump so nothing is carried twice.
 *
 * This sits in the extra-context section, which already tells the model the
 * material must not override certified artifacts — the correct standing for a
 * review-required draft.
 */
export function renderAppContextForPrompt(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as {
    app?: { name?: string; domain?: string; audience?: string; businessOutcome?: string };
    dashboards?: Array<{ title?: string; tiles?: unknown[] }>;
    drafts?: Array<{ name?: string; status?: string; description?: string; question?: string; sql?: string }>;
    focus?: { tileId?: string; blockId?: string };
  };
  const app = envelope.app;
  if (!app?.name) return undefined;
  const lines = [`This question was asked inside the App "${app.name}"${app.domain ? ` (domain: ${app.domain})` : ''}.`];
  if (app.audience) lines.push(`Audience: ${app.audience}`);
  if (app.businessOutcome) lines.push(`Business outcome: ${app.businessOutcome}`);

  const pages = (envelope.dashboards ?? []).filter((page) => page?.title);
  if (pages.length > 0) {
    lines.push(`Pages: ${pages.map((page) => `${page.title} (${page.tiles?.length ?? 0} tiles)`).join('; ')}`);
  }
  if (envelope.focus?.blockId) lines.push(`Focused block: ${envelope.focus.blockId}`);

  const drafts = (envelope.drafts ?? []).filter((draft) => draft?.name).slice(0, APP_DRAFT_PROMPT_LIMIT);
  if (drafts.length > 0) {
    lines.push(
      '',
      'Draft analyses saved in this app. They are REVIEW-REQUIRED and not certified:',
      'reuse or adapt their SQL when it answers the question, say plainly that the source is an unreviewed app draft,',
      'and never present one as a certified result.',
      ...drafts.map((draft) => [
        `- ${draft.name} (status: ${draft.status ?? 'review'})`,
        draft.question ? `  question: ${draft.question}` : '',
        draft.description ? `  description: ${draft.description}` : '',
        draft.sql ? `  sql:\n${draft.sql.split('\n').map((line) => `    ${line}`).join('\n')}` : '',
      ].filter(Boolean).join('\n')),
    );
  }
  return lines.join('\n');
}

export function renderExtraContext(req: AgentRunRequest, followUp?: AgentFollowUpContext): string | undefined {
  const parts: string[] = [];
  let upstream = req.upstream?.sql?.trim();
  if (upstream?.startsWith('{')) {
    // The run envelope carries `workspaceContext.appContext` for App copilot
    // questions. Render it as prose with its trust instruction, and strip it
    // from the JSON below rather than shipping the same content twice.
    try {
      const rawEnvelope = JSON.parse(upstream) as { workspaceContext?: Record<string, unknown> };
      const appContext = rawEnvelope.workspaceContext?.appContext;
      const rendered = renderAppContextForPrompt(appContext);
      if (rendered) {
        parts.push(rendered);
        const { appContext: _dropped, ...restWorkspace } = rawEnvelope.workspaceContext ?? {};
        const envelope = prepareProviderContextForDispatch({
          ...rawEnvelope,
          workspaceContext: restWorkspace,
        }) as { workspaceContext?: Record<string, unknown> };
        upstream = JSON.stringify(envelope, null, 2);
      } else {
        upstream = JSON.stringify(prepareProviderContextForDispatch(rawEnvelope), null, 2);
      }
    } catch {
      // Not the structured envelope — fall through and carry it verbatim.
    }
  }
  if (upstream) {
    const label = upstream.startsWith('{') || upstream.startsWith('[')
      ? 'Current app/drill context'
      : 'Current upstream SQL';
    parts.push(`${label}:\n${upstream}`);
  }
  const context = req.conversationContext;
  // Thread-scoped runs render the structured conversation snapshot in its own
  // prompt section (answer-loop) — skip this text recap to avoid double-carrying.
  const hasServerSnapshot = Boolean((context as Record<string, unknown> | undefined)?.serverSnapshot);
  if (context && !hasServerSnapshot) {
    // Bound the carried-forward "conversation memory" defensively: only the most
    // recent turn's signals, with hard caps on the summary length and list sizes
    // so prompts don't grow across a long multi-turn chat.
    const clampText = (value: string, max = 240): string =>
      value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
    const clampList = (values: string[], max = 8): string => values.slice(0, max).join(', ');
    const contextLines = [
      context.sourceCertifiedBlock ? `source certified block: ${context.sourceCertifiedBlock}` : '',
      context.sourceQuestion ? `source question: ${clampText(context.sourceQuestion, 200)}` : '',
      context.sourceAnswerSummary ? `source answer summary: ${clampText(context.sourceAnswerSummary)}` : '',
      context.contextPackId ? `context pack: ${context.contextPackId}` : '',
      context.trustLabel ? `trust label: ${context.trustLabel}` : '',
      context.reviewStatus ? `review status: ${context.reviewStatus}` : '',
      context.draftBlockPath ? `draft block: ${context.draftBlockPath}` : '',
      context.dqlArtifact ? `prior DQL artifact:\n${formatPriorDqlArtifactForQuestion(context.dqlArtifact)}` : '',
      context.requestedFilters?.length ? `remembered filters: ${clampList(context.requestedFilters)}` : '',
      context.requestedDimensions?.length ? `remembered dimensions: ${clampList(context.requestedDimensions)}` : '',
      context.outputColumns?.length ? `prior output columns: ${clampList(context.outputColumns)}` : '',
      context.resultDimensionValues ? `prior result values: ${formatResultDimensionValues(context.resultDimensionValues)}` : '',
      context.turns?.length ? `recent analytical turns:\n${formatConversationTurnsForPrompt(context.turns)}` : '',
    ].filter(Boolean);
    if (contextLines.length > 0) {
      parts.push(`Conversation memory:\n${contextLines.join('\n')}`);
    }
  }
  if (followUp?.sourceBlockName) {
    const suffix = followUp.kind === 'drilldown'
      ? 'Use it as source context, but prefer a distinct certified drilldown block or a review-required draft.'
      : followUp.kind === 'contextual'
        ? 'This is advisory prior-turn context — use it only if the question refers to it; on a new topic, ignore it.'
        : 'Reuse it for this generic follow-up.';
    const lead = followUp.kind === 'contextual'
      ? `Prior turn used certified block "${followUp.sourceBlockName}".`
      : `Follow-up context: the user is referring to certified block "${followUp.sourceBlockName}".`;
    parts.push(`${lead} ${suffix}`);
  }
  if (followUp?.filters?.length) {
    parts.push(`Requested follow-up filters: ${followUp.filters.join(', ')}`);
  }
  if (followUp?.dimensions?.length) {
    parts.push(`Requested follow-up dimensions: ${followUp.dimensions.join(', ')}`);
  }
  if (followUp?.priorResultRef) {
    parts.push(`Prior result reference:\n${formatPriorResultRefForQuestion(followUp.priorResultRef)}`);
  }
  if (followUp?.priorDqlArtifact) {
    parts.push(`Prior DQL artifact reference:\n${formatPriorDqlArtifactForQuestion(followUp.priorDqlArtifact)}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function selectedContextForMetadata(req: AgentRunRequest, question: string): unknown {
  const upstream = req.upstream?.sql?.trim();
  if (!upstream || (!upstream.startsWith('{') && !upstream.startsWith('['))) return req.upstream;
  try {
    const parsed = JSON.parse(upstream) as Record<string, unknown>;
    if (!('selectedBlock' in parsed) && !('focusBlock' in parsed)) return req.upstream;
    if (shouldUseFocusedTileForQuestion(question)) return req.upstream;
    const { selectedBlock: _selectedBlock, ...rest } = parsed;
    return {
      ...rest,
      focusBlock: rest.focusBlock ?? _selectedBlock,
      contextPolicy: {
        ...(rest.contextPolicy && typeof rest.contextPolicy === 'object' && !Array.isArray(rest.contextPolicy)
          ? rest.contextPolicy as Record<string, unknown>
          : {}),
        retrieval: 'question_first',
        focusBlockUse: 'soft_context_only',
      },
    };
  } catch {
    return req.upstream;
  }
}

function shouldUseSelectedBlockHint(
  req: AgentRunRequest,
  question: string,
  followUp?: AgentFollowUpContext,
): boolean {
  if (followUp?.kind === 'generic' && followUp.sourceBlockName) return false;
  if (followUp?.kind === 'drilldown' || isDrilldownFollowUp(question)) return false;
  return shouldUseFocusedTileForQuestion(question) && extractSelectedBlockHints(req).length > 0;
}

function shouldUseFocusedTileForQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (!/\b(this|that|it|selected\s+(?:tile|block|metric)|current\s+(?:tile|block|metric))\b/.test(lower)) return false;
  if (/\b(top|bottom|best|worst|highest|lowest|least|fewest|less|most|rank|ranking|orders?|customers?|revenue|spend|by\s+[a-z]|compare|break\s*down|drill|why|driver|list|show|give me)\b/.test(lower)) {
    return false;
  }
  return true;
}

function extractSelectedBlockHints(req: AgentRunRequest): string[] {
  const upstream = req.upstream?.sql?.trim();
  if (!upstream || (!upstream.startsWith('{') && !upstream.startsWith('['))) return [];
  try {
    const parsed = JSON.parse(upstream) as {
      selectedBlock?: { blockId?: unknown };
      focusBlock?: { blockId?: unknown };
      availableBlocks?: Array<{ blockId?: unknown }>;
    };
    const selected = typeof parsed.selectedBlock?.blockId === 'string'
      ? parsed.selectedBlock.blockId.trim()
      : typeof parsed.focusBlock?.blockId === 'string'
        ? parsed.focusBlock.blockId.trim()
      : '';
    return selected ? [selected] : [];
  } catch {
    return [];
  }
}

function inferFollowUpContext(req: AgentRunRequest, question: string): AgentFollowUpContext | undefined {
  // A browser-carried assistant message is never enough to establish prior
  // governed authority. In particular, text such as "Answered by certified
  // block **x**" cannot become source attribution, a result filter, or a
  // compiler hint unless the host has reconstructed a persisted conversation
  // snapshot for this thread. HTTP Ask ingress removes public history; this
  // guard keeps alternative/direct provider entry points from reintroducing
  // the same authority bypass.
  if (!conversationSnapshotFromContext(req.conversationContext)) return undefined;
  // Even with server-backed context, a prior assistant turn is not permission
  // to carry rows, measures, or a block into a complete new analytical
  // question. Admit it only for an explicit prior-result reference/operation;
  // otherwise this returns `undefined`.
  const kind = isGenericFollowUp(question) ? 'generic' : isDrilldownFollowUp(question) ? 'drilldown' : undefined;
  if (!kind) return undefined;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role !== 'assistant') continue;
    const sourceBlockName = extractCertifiedBlockName(msg.content);
    if (!sourceBlockName) continue;
    return {
      kind,
      binding: 'prior_result',
      sourceBlockName,
      sourceAnswer: msg.content.slice(0, 1200),
      filters: kind === 'drilldown' ? extractDrilldownFilters(question) : undefined,
      dimensions: kind === 'drilldown' ? extractDrilldownDimensions(question) : undefined,
    };
  }
  return undefined;
}

function priorContextPackIdFromSnapshot(snapshot: ConversationSnapshot | undefined): string | undefined {
  const fromState = (snapshot?.workingState as { lastContextPackId?: unknown } | undefined)?.lastContextPackId;
  if (typeof fromState === 'string' && fromState.trim()) return fromState;
  const fromTurns = snapshot?.recentTurns?.length
    ? snapshot.recentTurns[snapshot.recentTurns.length - 1]?.contextPackId
    : undefined;
  return typeof fromTurns === 'string' && fromTurns.trim() ? fromTurns : undefined;
}

/** Parse the server-attached conversation snapshot (thread-scoped runs only). */
function conversationSnapshotFromContext(
  context: AgentRunRequest['conversationContext'],
): ConversationSnapshot | undefined {
  const record = context as Record<string, unknown> | undefined;
  const raw = record?.conversationEnvelope ?? record?.serverSnapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const snapshot = raw as ConversationSnapshot;
  return typeof snapshot.threadId === 'string' && Array.isArray(snapshot.recentTurns)
    ? snapshot
    : undefined;
}

/**
 * Deterministic stale-context protection: when the persisted working state says
 * the new question is a topic SHIFT, prior-turn filters must not be forced into
 * the follow-up (a "by X" phrasing can regex-classify as drilldown even on a
 * genuinely new topic). Question-derived filters are kept; carried ones drop.
 */
function applyTopicShiftGuard(
  followUp: AgentFollowUpContext | undefined,
  snapshot: ConversationSnapshot | undefined,
): AgentFollowUpContext | undefined {
  if (!followUp || snapshot?.topicRelation !== 'shift') return followUp;
  // A server-produced compound dependency is a direct child input, not an
  // incidental thread carry. Every other result binding is dropped on a
  // topic shift so a fresh analytical request cannot receive prior rows or
  // measures merely because the thread has history.
  return followUp.binding === 'task_dependency' ? followUp : undefined;
}

/**
 * Resolve the prior-turn context a follow-up may build on.
 *
 * The topic-shift guard is applied HERE rather than by the caller. It used to
 * be invoked at the provider call site only, while the retrieval call site
 * (`buildLocalContextPack`) took the raw result — so on a detected topic shift
 * the context pack was still built with the previous question's filters and
 * dimensions, and the retrieval query text was seeded with the previous
 * question and answer. Folding the guard in makes it impossible to forget at a
 * third call site.
 */
export function resolveAgentFollowUpContext(
  rawContext: Record<string, unknown> | undefined,
  question: string,
  snapshot?: ConversationSnapshot,
): AgentFollowUpContext | undefined {
  return applyTopicShiftGuard(
    resolveAgentFollowUpContextRaw(rawContext, question),
    snapshot ?? conversationSnapshotFromContext(rawContext as AgentRunRequest['conversationContext']),
  );
}

function resolveAgentFollowUpContextRaw(
  rawContext: Record<string, unknown> | undefined,
  question: string,
): AgentFollowUpContext | undefined {
  const context = rawContext as AgentRunRequest['conversationContext'];
  if (!context) return undefined;
  const taskDependency = analyticalTaskDependencyBindingFromContext(context);
  // A compound child receives exactly one server-computed parent value plus
  // result/row proofs. Do not replay parent prose, SQL, or result rows into the
  // child; its normal governed retrieval and immutable-plan checks still run.
  if (taskDependency) {
    return {
      kind: 'drilldown',
      binding: 'task_dependency',
      sourceTurnId: `task:${taskDependency.sourceTaskId}`,
      filters: [taskDependency.value],
      dimensions: [taskDependency.canonicalColumn],
      priorResultColumns: [taskDependency.canonicalColumn],
      priorResultValues: { [taskDependency.canonicalColumn]: [taskDependency.value] },
      memberBindings: [{
        dimension: taskDependency.canonicalColumn,
        values: [taskDependency.value],
        source: 'prior_result',
        confidence: 'exact',
        sourceTurnId: `task:${taskDependency.sourceTaskId}`,
      }],
      resolvedReferences: [`${taskDependency.canonicalColumn}: ${taskDependency.value}`],
    };
  }
  const turns = conversationTurnsFromContext(context);
  const activeTurn = activeConversationTurn(context, turns, question);
  const activeResult = activeTurn?.result && typeof activeTurn.result === 'object' && !Array.isArray(activeTurn.result)
    ? activeTurn.result as Record<string, unknown>
    : undefined;
  const sourceBlockName = cleanOptionalString(activeTurn?.sourceCertifiedBlock) ?? cleanOptionalString(context.sourceCertifiedBlock);
  const priorMemberSets = cleanPriorResultMemberSets(activeResult?.memberSets)
    ?? cleanPriorResultMemberSets(context.resultMemberSets);
  // New turns persist entity/display sets with a content-free result
  // fingerprint. Legacy rows retain `dimensionValues`, so merge both forms for
  // restart compatibility. The resolver always binds the display values; an
  // optional entity key is preserved as local continuity metadata, not guessed
  // into a user-visible filter.
  const priorResultValues = mergePriorResultValues(
    memberSetValuesByDimension(priorMemberSets),
    cleanStringRecordArray(activeResult?.dimensionValues),
    cleanStringRecordArray(context.resultDimensionValues),
  );
  const pluralPriorEntity = pluralPriorResultEntity(question);
  const priorResultSetUnavailable = Boolean(
    pluralPriorEntity && valuesForPriorDimension(priorResultValues ?? {}, pluralPriorEntity).length === 0,
  );
  const priorResultColumns = mergeStrings(
    arrayValue(activeResult?.columns),
    context.resultColumns,
    context.outputColumns,
  );
  const priorResultRef = priorResultRefFromTurn(activeTurn, activeResult, priorResultColumns);
  const priorDqlArtifact = cleanDqlArtifactReference(activeTurn?.dqlArtifact) ?? cleanDqlArtifactReference(context.dqlArtifact);
  const resolvedReferences = resolveConversationReferences(question, turns, priorResultValues);
  const focusedPriorResultValues = resolvedReferences.valuesByDimension ?? priorResultValues;
  const hasFocusedReference = Boolean(resolvedReferences.valuesByDimension);
  const relativeComparison = isEntityRelativeComparisonQuestion(question);
  const hasUsefulContext = Boolean(sourceBlockName || priorResultColumns?.length || focusedPriorResultValues || priorDqlArtifact);
  if (!hasUsefulContext) {
    // "Those customers" is an explicit set reference. Do not silently turn it
    // into a global customer ranking when the retained result values are absent
    // (for example, an intentionally redacted old row). The Ask runtime turns
    // this typed continuity gap into a clarification before any compiler or
    // connection attempt.
    if (!priorResultSetUnavailable || !pluralPriorEntity) return undefined;
    return {
      kind: 'drilldown',
      binding: 'prior_result',
      dimensions: [pluralPriorEntity],
      unresolvedReferences: [`The previous result did not retain the displayed ${pluralPriorEntity} set needed for "those ${pluralPriorEntity}s".`],
      priorResultSetUnavailable: true,
    };
  }
  // Prior-result material is execution-relevant context, not a friendly
  // transcript hint. A complete new question therefore receives no carry at
  // all. The only admission routes are a resolved typed reference, an
  // explicit prior-result operation, or a deictic/generic follow-up.
  const inferredKind = resolvedReferences.memberBindings?.length
    ? 'drilldown'
    : isGenericFollowUp(question)
      ? 'generic'
      : isDrilldownFollowUp(question, priorShapeTerms(priorResultColumns, focusedPriorResultValues))
        ? 'drilldown'
        : undefined;
  if (!inferredKind) return undefined;
  const binding: AgentConversationBindingV1 = 'prior_result';
  const kind = inferredKind;
  return {
    kind,
    binding,
    sourceTurnId: cleanOptionalString(activeTurn?.id) ?? cleanOptionalString(context.sourceAnswerId),
    // A relative comparison needs the named member from history, not the prior
    // block's result contract. Carrying a beverage-ranking block into "less tax
    // than Melissa" biases retrieval toward the same technical artifact and is
    // exactly how the old loop produced a global tax KPI or all customer rows.
    sourceBlockName: relativeComparison ? undefined : sourceBlockName,
    sourceQuestion: relativeComparison
      ? undefined
      : cleanOptionalString(activeTurn?.question) ?? cleanOptionalString(context.sourceQuestion),
    sourceAnswer: relativeComparison
      ? undefined
      : cleanOptionalString(activeTurn?.answerSummary) ?? cleanOptionalString(context.sourceAnswerSummary),
    filters: kind === 'drilldown'
      ? mergeStrings(
          hasFocusedReference ? undefined : activeTurnStringArray(activeTurn, 'requestedFilters'),
          hasFocusedReference ? undefined : context.requestedFilters,
          extractDrilldownFilters(question),
          resolvedReferences.filters,
        )
      : undefined,
    dimensions: kind === 'drilldown'
      ? mergeStrings(
          hasFocusedReference ? undefined : activeTurnStringArray(activeTurn, 'requestedDimensions'),
          hasFocusedReference ? undefined : context.requestedDimensions,
          extractDrilldownDimensions(question),
          resolvedReferences.dimensions,
        )
      : undefined,
    priorResultColumns: relativeComparison ? undefined : priorResultColumns,
    priorResultValues: focusedPriorResultValues,
    priorResultRef: relativeComparison ? undefined : priorResultRef,
    priorDqlArtifact: relativeComparison ? undefined : priorDqlArtifact,
    priorLimit: relativeComparison
      ? undefined
      : activeTurnNumber(activeTurn, 'topN') ?? (typeof context.priorLimit === 'number' ? context.priorLimit : undefined),
    priorMeasures: relativeComparison
      ? undefined
      : mergeStrings(
          activeTurnStringArray(activeTurn, 'requestedMeasures'),
          priorDqlArtifact?.metrics,
          arrayValue(activeResult?.measureColumns),
          context.priorMeasures,
          inferredMeasuresFromAnswerContract(context.answerContract),
          inferredMeasureColumns(priorResultColumns),
        ),
    memberBindings: resolvedReferences.memberBindings?.map((binding) => ({
      ...binding,
      sourceTurnId: cleanOptionalString(activeTurn?.id) ?? cleanOptionalString(context.sourceAnswerId),
    })),
    resolvedReferences: resolvedReferences.labels,
    unresolvedReferences: priorResultSetUnavailable && pluralPriorEntity
      ? [`The previous result did not retain the displayed ${pluralPriorEntity} set needed for "those ${pluralPriorEntity}s".`]
      : resolvedReferences.unresolved,
    ...(priorResultSetUnavailable ? { priorResultSetUnavailable: true } : {}),
    deicticChoices: resolvedReferences.deicticChoices,
    // The prior turn's actual rows, so a follow-up can compute across the shown
    // results ("of these, the average") without a fresh query. A relative
    // comparison deliberately drops the prior contract, so skip it there too.
    priorResult: relativeComparison ? undefined : priorResultDataFromTurn(activeResult, priorResultColumns),
  };
}

function analyticalTaskDependencyBindingFromContext(context: AgentRunRequest['conversationContext']): {
  sourceTaskId: string;
  sourceResultFingerprint: string;
  canonicalColumn: string;
  value: string;
  rowFingerprint: string;
} | undefined {
  const raw = cleanRecord((context as Record<string, unknown>).analyticalTaskDependencyBinding);
  if (!raw || raw.version !== 1) return undefined;
  const sourceTaskId = cleanOptionalString(raw.sourceTaskId);
  const sourceResultFingerprint = cleanOptionalString(raw.sourceResultFingerprint)?.toLowerCase();
  const canonicalColumn = cleanOptionalString(raw.canonicalColumn);
  const value = cleanOptionalString(raw.value);
  const rowFingerprint = cleanOptionalString(raw.rowFingerprint)?.toLowerCase();
  if (!sourceTaskId || !canonicalColumn || !value
    || !/^[a-f0-9]{64}$/.test(sourceResultFingerprint ?? '')
    || !/^[a-f0-9]{64}$/.test(rowFingerprint ?? '')) return undefined;
  return { sourceTaskId, sourceResultFingerprint: sourceResultFingerprint!, canonicalColumn, value, rowFingerprint: rowFingerprint! };
}

/** Build the bounded prior-result rows (aligned to columns) for cross-result
 *  follow-up computation, from a turn's persisted result sample. */
function priorResultDataFromTurn(
  activeResult: Record<string, unknown> | undefined,
  columns: string[] | undefined,
): AgentFollowUpContext['priorResult'] {
  if (!activeResult || !columns || columns.length === 0) return undefined;
  const sample = activeResult.rowsSample;
  if (!Array.isArray(sample) || sample.length === 0) return undefined;
  const rows = sample
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => columns.map((_, index) => row[index]));
  if (rows.length === 0) return undefined;
  const measureColumns = (arrayValue(activeResult.measureColumns) ?? [])
    .filter((value): value is string => typeof value === 'string');
  const rowCountRaw = activeResult.rowCount;
  return {
    columns,
    rows,
    ...(measureColumns.length > 0 ? { measureColumns } : {}),
    ...(typeof rowCountRaw === 'number' ? { rowCount: rowCountRaw } : {}),
  };
}

function followUpFromConversationContext(req: AgentRunRequest, question: string): AgentFollowUpContext | undefined {
  return resolveAgentFollowUpContext(req.conversationContext as Record<string, unknown> | undefined, question);
}

function conversationTurnsFromContext(context: AgentRunRequest['conversationContext']): Array<Record<string, unknown>> {
  const explicit = Array.isArray(context?.turns)
    ? context.turns.map(cleanRecord).filter((turn): turn is Record<string, unknown> => Boolean(turn))
    : [];
  const snapshot = conversationSnapshotFromContext(context);
  const snapshotTurns = [
    ...(snapshot?.recalledTurns ?? []).map((turn) => snapshotTurnToConversationRecord(turn, 'recalled')),
    ...(snapshot?.recentTurns ?? []).map((turn) => snapshotTurnToConversationRecord(turn, 'recent')),
  ].filter((turn): turn is Record<string, unknown> => Boolean(turn));
  const merged = mergeConversationTurnRecords([...snapshotTurns, ...explicit]);
  if (merged.length > 0) return merged.slice(-12);
  const legacy = cleanRecord({
    id: context?.sourceAnswerId,
    question: context?.sourceQuestion,
    answerSummary: context?.sourceAnswerSummary,
    sourceCertifiedBlock: context?.sourceCertifiedBlock,
    requestedFilters: context?.requestedFilters,
    requestedDimensions: context?.requestedDimensions,
    requestedMeasures: context?.priorMeasures,
    topN: context?.priorLimit,
    result: {
      columns: context?.resultColumns ?? context?.outputColumns,
      rowsSample: context?.resultRowsSample,
      dimensionValues: context?.resultDimensionValues,
      memberSets: context?.resultMemberSets,
      measureColumns: context?.priorMeasures,
    },
    route: context?.route,
    trustLabel: context?.trustLabel,
    reviewStatus: context?.reviewStatus,
    certification: context?.certification,
    contextPackId: context?.contextPackId,
    sourceSql: (context as Record<string, unknown> | undefined)?.sourceSql,
    dqlArtifact: context?.dqlArtifact,
    cascade: context?.cascade,
  });
  return legacy ? [legacy] : [];
}

function snapshotTurnToConversationRecord(
  turn: ConversationSnapshot['recentTurns'][number],
  snapshotSource: 'recent' | 'recalled',
): Record<string, unknown> | undefined {
  return compactConversationRecord({
    id: turn.id,
    question: turn.question,
    answerSummary: turn.answerSummary,
    sourceCertifiedBlock: turn.sourceCertifiedBlock,
    route: turn.route,
    trustLabel: turn.trustLabel,
    runStatus: turn.runStatus,
    stopReason: turn.stopReason,
    contextPackId: turn.contextPackId,
    sourceSql: turn.sourceSql,
    dqlArtifact: turn.dqlArtifact,
    cascade: turn.cascade,
    snapshotSource,
    result: compactConversationRecord({
      columns: turn.resultColumns,
      dimensionValues: turn.resultDimensionValues,
      memberSets: turn.resultMemberSets,
      rowCount: turn.resultRowCount,
    }),
  });
}

function mergeConversationTurnRecords(turns: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const anonymous: Array<Record<string, unknown>> = [];
  for (const turn of turns) {
    const id = cleanOptionalString(turn.id);
    if (!id) {
      anonymous.push(turn);
      continue;
    }
    const current = byId.get(id);
    byId.set(id, current ? { ...current, ...turn } : turn);
  }
  return [...anonymous, ...byId.values()];
}

function activeConversationTurn(
  context: AgentRunRequest['conversationContext'],
  turns: Array<Record<string, unknown>>,
  question: string,
): Record<string, unknown> | undefined {
  if (turns.length === 0) return undefined;
  const activeId = cleanOptionalString(context?.activeTurnId);
  const activeMatch = activeId
    ? turns.find((turn) => cleanOptionalString(turn.id) === activeId)
    : undefined;
  const recalled = turns.filter((turn) =>
    cleanOptionalString(turn.snapshotSource) === 'recalled'
    && !turnIsUntrustedContext(turn)
    && turnHasUsefulResult(turn));
  if (recalled.length > 0) {
    const bestRecalled = recalled
      .map((turn) => ({ turn, score: scoreTurnForQuestion(turn, question) }))
      .sort((a, b) => b.score - a.score)[0];
    const activeScore = activeMatch ? scoreTurnForQuestion(activeMatch, question) : 0;
    if (bestRecalled && shouldPreferRecalledPriorResult(question, bestRecalled.score, activeScore)) {
      return bestRecalled.turn;
    }
  }
  if (activeId) {
    // An active chat-only recap is presentation context, not an analytical
    // result boundary. Fall through to the last trusted result-bearing turn so
    // plural deictic references retain their bounded member set after reload.
    if (activeMatch && !turnIsUntrustedContext(activeMatch) && turnHasUsefulResult(activeMatch)) return activeMatch;
  }
  // When nothing in the thread is trustworthy there is NO anchor. Falling back
  // to the last turn regardless meant a thread whose turns had all failed kept
  // anchoring each new question to the most recent failure.
  return [...turns].reverse().find((turn) => {
    return !turnIsUntrustedContext(turn) && turnHasUsefulResult(turn);
  }) ?? [...turns].reverse().find((turn) => !turnIsUntrustedContext(turn));
}

/**
 * A turn the next question may build on. This used to exclude only `blocked`,
 * so a refused turn ("I couldn't find the answer") stayed eligible as the
 * follow-up anchor and handed its broken DQL artifact and failing SQL to the
 * next question as authoritative prior context.
 */
function turnIsUntrustedContext(turn: Record<string, unknown>): boolean {
  return !isTrustedConversationTurn(turn as Parameters<typeof isTrustedConversationTurn>[0]);
}

function turnHasUsefulResult(turn: Record<string, unknown>): boolean {
  const result = cleanRecord(turn.result);
  const columns = arrayValue(result?.columns);
  const rows = arrayValue(result?.rowsSample);
  const values = cleanStringRecordArray(result?.dimensionValues);
  const memberSets = cleanPriorResultMemberSets(result?.memberSets);
  // New persisted turns can retain a typed entity/display set even when an
  // older compacted record no longer carries the preview rows. Treat that set
  // as result-bearing continuity evidence; otherwise a later chat-only turn
  // can displace the only safe anchor after restart.
  return Boolean(columns?.length || rows?.length || values || memberSets?.length);
}

function scoreTurnForQuestion(turn: Record<string, unknown>, question: string): number {
  const queryTokens = tokenSet(question);
  if (queryTokens.size === 0) return 0;
  const result = cleanRecord(turn.result);
  const values = cleanStringRecordArray(result?.dimensionValues);
  const text = [
    cleanOptionalString(turn.question),
    cleanOptionalString(turn.answerSummary),
    ...(arrayValue(result?.columns) ?? []).map((value) => cleanOptionalString(value)).filter((value): value is string => Boolean(value)),
    ...Object.entries(values ?? {}).flatMap(([key, list]) => [key, ...list.slice(0, 8)]),
  ].filter(Boolean).join(' ');
  let score = 0;
  const turnTokens = tokenSet(text);
  for (const token of queryTokens) {
    if (turnTokens.has(token)) score += 1;
  }
  return score;
}

function shouldPreferRecalledPriorResult(question: string, recalledScore: number, activeScore: number): boolean {
  if (recalledScore >= Math.max(activeScore + 2, 2)) return true;
  if (!wantsPriorResultReference(question)) return false;
  return recalledScore > 0 && recalledScore > activeScore;
}

function wantsPriorResultReference(question: string): boolean {
  return /\b(?:previous|prior|earlier|above)\s+(?:results?|outputs?|rows?|turns?)\b/i.test(question)
    || /\b(?:with|from|using|include)\s+(?:the\s+)?(?:previous|prior|earlier|above)\b/i.test(question);
}

function tokenSet(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .match(/[a-z0-9_]+/g) ?? [];
  return new Set(tokens
    .map((token) => token.replace(/s$/, ''))
    .filter((token) => token.length > 2 && !GENERIC_FOLLOW_UP_WORDS.has(token)));
}

function priorResultRefFromTurn(
  activeTurn: Record<string, unknown> | undefined,
  activeResult: Record<string, unknown> | undefined,
  priorResultColumns: string[] | undefined,
): AgentPriorResultReference | undefined {
  const columns = priorResultColumns?.slice(0, 32) ?? [];
  if (columns.length === 0) return undefined;
  const id = cleanOptionalString(activeTurn?.id) ?? 'previous';
  const rowCount = typeof activeResult?.rowCount === 'number' && Number.isFinite(activeResult.rowCount)
    ? activeResult.rowCount
    : Array.isArray(activeResult?.rowsSample)
      ? activeResult.rowsSample.length
      : undefined;
  const sourceSql = cleanOptionalString(activeTurn?.sourceSql);
  return {
    id,
    question: cleanOptionalString(activeTurn?.question),
    columns,
    rowCount,
    sourceSql: sourceSql ? sourceSql.slice(0, 1200) : undefined,
  };
}

function resolveConversationReferences(
  question: string,
  turns: Array<Record<string, unknown>>,
  activeValues: Record<string, string[]> | undefined,
): {
  filters?: string[];
  dimensions?: string[];
  labels?: string[];
  unresolved?: string[];
  valuesByDimension?: Record<string, string[]>;
  memberBindings?: AgentMemberBinding[];
  /**
   * Candidates a singular reference ("this customer") could mean when the prior
   * result offered more than one. Carried instead of guessed so the run can ask.
   */
  deicticChoices?: { dimension: string; values: string[] };
} {
  const namedValues = resolveNamedConversationValues(question, turns, activeValues);
  const dimensions = [
    ...(resolveDeicticDimensions(question, activeValues) ?? []),
    ...Object.keys(namedValues ?? {}).map(normalizePriorValueDimension),
  ];
  let filters = resolveDeicticFilters(question, activeValues) ?? [];
  const labels: string[] = [];
  // An ambiguous singular reference is the single most common follow-up shape
  // ("what region does this customer belong to?" after a ranked list). Keep the
  // candidates so the run can offer them instead of dead-ending.
  const ambiguousSingular = !namedValues
    ? resolveSingularDeicticCandidates(question, activeValues)
    : undefined;
  const deicticChoices = ambiguousSingular && ambiguousSingular.values.length > 1
    ? ambiguousSingular
    : undefined;
  // Do NOT backfill an ambiguous singular from history: filtering on all of the
  // candidates answers a different question than the one that was asked.
  if (!namedValues && !deicticChoices && dimensions.length > 0 && filters.length === 0) {
    for (const turn of [...turns].reverse()) {
      const values = cleanStringRecordArray(cleanRecord(turn.result)?.dimensionValues);
      if (!values) continue;
      filters = dimensions.flatMap((dimension) => valuesForPriorDimension(values, dimension));
      if (filters.length > 0) break;
    }
  }
  for (const dimension of dimensions) {
    const values = (namedValues
      ? valuesForPriorDimension(namedValues, dimension)
      : activeValues
        ? valuesForPriorDimension(activeValues, dimension)
        : []).slice(0, 5);
    labels.push(values.length ? `${dimension}: ${values.join(', ')}` : `${dimension}: unresolved`);
  }
  if (namedValues) filters.push(...Object.values(namedValues).flat());
  const questionText = normalizeConversationValueText(question);
  const memberBindings: AgentMemberBinding[] = namedValues
    ? Object.entries(namedValues).map(([dimension, values]) => ({
        dimension: normalizePriorValueDimension(dimension),
        values,
        source: 'prior_result',
        confidence: values.every((value) => (` ${questionText} `).includes(` ${normalizeConversationValueText(value)} `))
          ? 'exact'
          : 'unique_partial',
      }))
    : dimensions.length === 1 && filters.length > 0
      ? [{
          dimension: dimensions[0]!,
          values: Array.from(new Set(filters)).slice(0, 24),
          source: 'prior_result',
          confidence: 'deictic',
        }]
      : [];
  const unresolved = referencesNeedValues(question) && filters.length === 0
    ? [deicticChoices
        ? `"${deicticChoices.dimension}" was referenced in the singular, but the previous result had ${deicticChoices.values.length} of them.`
        : 'Could not resolve the referenced prior result values from conversation state.']
    : undefined;
  return {
    filters: filters.length > 0 ? Array.from(new Set(filters)).slice(0, 24) : undefined,
    dimensions: dimensions.length > 0 ? Array.from(new Set(dimensions)) : undefined,
    labels: labels.length > 0 ? Array.from(new Set(labels)) : undefined,
    unresolved,
    valuesByDimension: namedValues,
    memberBindings: memberBindings.length > 0 ? memberBindings : undefined,
    deicticChoices,
  };
}

/**
 * Resolve explicit mentions against bounded values from recent result sets. Full
 * phrases win; otherwise a unique member token may resolve a shortened name
 * ("Melissa" → "Melissa Lopez"). Ambiguous partials are deliberately left for
 * clarification instead of guessing between two real warehouse members.
 */
function resolveNamedConversationValues(
  question: string,
  turns: Array<Record<string, unknown>>,
  activeValues: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  const questionText = normalizeConversationValueText(question);
  const questionTokens = new Set(questionText.split(' ').filter((token) =>
    token.length >= 3 && !GENERIC_FOLLOW_UP_WORDS.has(token)
  ));
  if (!questionText || questionTokens.size === 0) return undefined;

  const candidates = new Map<string, { dimension: string; value: string; exact: boolean }>();
  const addValues = (values: Record<string, string[]> | undefined) => {
    for (const [dimension, members] of Object.entries(values ?? {})) {
      for (const value of members) {
        const normalized = normalizeConversationValueText(value);
        if (!normalized) continue;
        const exact = (` ${questionText} `).includes(` ${normalized} `);
        const memberTokens = normalized.split(' ').filter((token) =>
          token.length >= 3 && !GENERIC_FOLLOW_UP_WORDS.has(token)
        );
        const partial = memberTokens.some((token) => questionTokens.has(token));
        if (!exact && !partial) continue;
        candidates.set(`${dimension}\u0000${normalized}`, { dimension, value, exact });
      }
    }
  };
  addValues(activeValues);
  for (const turn of [...turns].reverse()) {
    addValues(cleanStringRecordArray(cleanRecord(turn.result)?.dimensionValues));
  }

  const all = [...candidates.values()];
  const exact = all.filter((candidate) => candidate.exact);
  const selected = exact.length > 0 ? exact : all;
  const distinctValues = new Set(selected.map((candidate) => normalizeConversationValueText(candidate.value)));
  if (distinctValues.size !== 1) return undefined;

  const out: Record<string, string[]> = {};
  for (const candidate of selected) {
    out[candidate.dimension] = Array.from(new Set([...(out[candidate.dimension] ?? []), candidate.value])).slice(0, 4);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeConversationValueText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@._'-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isEntityRelativeComparisonQuestion(question: string): boolean {
  return /\b(?:less|lower|fewer|more|higher|greater)\b[^?.!]{0,80}\bthan\b\s+[a-z0-9@._'-]+/i.test(question)
    || /\b(?:below|under|above|over)\b\s+that\s+of\s+[a-z0-9@._'-]+/i.test(question)
    || /\b(?:below|under|above|over)\b\s+[A-Z][A-Za-z0-9@._'-]+/.test(question);
}

function cleanRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactConversationRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined && value !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function cleanDqlArtifactReference(value: unknown): AgentDqlArtifactReference | undefined {
  const artifact = normalizeDqlArtifactReference(value);
  if (!artifact) return undefined;
  return {
    ...artifact,
    source: artifact.source.slice(0, 3000),
    metrics: uniqueStringList(artifact.metrics),
    dimensions: uniqueStringList(artifact.dimensions),
    filters: artifact.filters
      ?.filter((filter) => filter.values.length > 0)
      .slice(0, 12)
      .map((filter) => ({ ...filter, values: uniqueStringList(filter.values)?.slice(0, 12) ?? [] })),
    orderBy: artifact.orderBy?.slice(0, 12),
  };
}

function uniqueStringList(value: string[] | undefined): string[] | undefined {
  if (!value?.length) return undefined;
  const unique = Array.from(new Set(value)).slice(0, 24);
  return unique.length > 0 ? unique : undefined;
}

function activeTurnStringArray(turn: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  return arrayValue(turn?.[key]);
}

function activeTurnNumber(turn: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = turn?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function referencesNeedValues(question: string): boolean {
  return /\b(?:it|its|they|their|them|he|she|him|his|her|hers|this|that|these|those|same|above|previous|prior)\b/i.test(question);
}

function extractCertifiedBlockName(content: string): string | undefined {
  const fromAnswer = content.match(/Answered by certified block \*\*([^*]+)\*\*/i)?.[1];
  const fromRoute = content.match(/Answered from certified block\s+([A-Za-z0-9_.-]+)/i)?.[1];
  const fromCitation = content.match(/^- block:\s*([A-Za-z0-9_.-]+)/im)?.[1];
  // The name pattern admits dots, so a sentence period lands in the match
  // ("... block food_vs_drink_revenue.") — strip trailing punctuation.
  return (fromAnswer ?? fromRoute ?? fromCitation)?.trim().replace(/[.,;:]+$/, '') || undefined;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mergeStrings(...groups: Array<unknown[] | undefined>): string[] | undefined {
  const values = groups
    .flatMap((group) => group ?? [])
    .map((value) => cleanOptionalString(value))
    .filter((value): value is string => Boolean(value));
  const unique = Array.from(new Set(values)).slice(0, 24);
  return unique.length > 0 ? unique : undefined;
}

function inferredMeasuresFromAnswerContract(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const requestedShape = record.requestedShape && typeof record.requestedShape === 'object' && !Array.isArray(record.requestedShape)
    ? record.requestedShape as Record<string, unknown>
    : undefined;
  return mergeStrings(arrayValue(record.measures), arrayValue(requestedShape?.measures));
}

function inferredMeasureColumns(columns: string[] | undefined): string[] | undefined {
  if (!columns?.length) return undefined;
  const measures = columns.filter((column) =>
    /\b(revenue|sales|amount|total|count|average|avg|sum|spend|cost|margin|profit|value|points?|score|quantity|rate|volume)\b/i.test(
      column.replace(/_/g, ' '),
    )
  );
  return measures.length > 0 ? measures : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function cleanStringRecordArray(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const values = Array.isArray(raw)
      ? raw.map(cleanOptionalString).filter((item): item is string => Boolean(item)).slice(0, 24)
      : [];
    if (key.trim() && values.length > 0) out[key.trim()] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Values a singular deictic reference ("this customer") could be pointing at.
 *
 * This used to `.slice(0, 1)` — silently picking the FIRST row of the previous
 * answer and binding it as a required filter. After a ten-row ranking, "this
 * customer" would quietly become "Melissa Lopez" because she happened to sort
 * first, and the user was never told. An ambiguous reference must stay
 * ambiguous so the caller can ask which one was meant.
 */
function resolveSingularDeicticCandidates(
  question: string,
  priorValues: Record<string, string[]> | undefined,
): { dimension: string; values: string[] } | undefined {
  if (!priorValues) return undefined;
  const singular = resolveSingularDeicticDimension(question, priorValues);
  if (!singular) return undefined;
  const values = Array.from(new Set(valuesForPriorDimension(priorValues, singular))).slice(0, 24);
  return values.length > 0 ? { dimension: singular, values } : undefined;
}

function resolveDeicticFilters(question: string, priorValues: Record<string, string[]> | undefined): string[] | undefined {
  if (!priorValues) return undefined;
  const hasExplicitPluralReference = /\b(?:these|those|same)\s+(?:customers?|products?|cat(?:egor|agor|ogor)(?:y|ies)|segments?|regions?)\b/i.test(question);
  if (!hasExplicitPluralReference) {
    const singular = resolveSingularDeicticCandidates(question, priorValues);
    if (singular) {
      // Exactly one candidate is unambiguous and can be bound as a filter.
      // Several candidates are a question for the user, not a coin flip.
      return singular.values.length === 1 ? singular.values : undefined;
    }
  }
  const dims = resolveDeicticDimensions(question, priorValues) ?? [];
  const values = dims.flatMap((dim) => valuesForPriorDimension(priorValues, dim));
  return values.length > 0 ? Array.from(new Set(values)).slice(0, 24) : undefined;
}

function resolveDeicticDimensions(question: string, priorValues: Record<string, string[]> | undefined): string[] | undefined {
  if (!priorValues) return undefined;
  const lower = question.toLowerCase();
  const dims: string[] = [];
  // A definite article names the current population ("the customers", "the
  // regions"); it does not point at rows from the previous answer. Treating
  // "the" like "these/those" silently turned ordinary new analyses into
  // required member filters from conversation history. Carry prior members only
  // for explicit demonstratives or other unambiguous prior-result references.
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:these|those|same|previous|prior|above)\s+cat(?:egor|agor|ogor)(?:y|ies)\b/, 'category'],
    [/\b(?:this|that|these|those|same|previous|prior|above)\s+products?\b/, 'product'],
    [/\b(?:this|that|these|those|same|previous|prior|above)\s+customers?\b/, 'customer'],
    [/\b(?:above|previous|prior)\s+(?:orders?|results?|rows?)\b/, 'customer'],
    [/\b(?:this|that|these|those|same|previous|prior|above)\s+segments?\b/, 'segment'],
    [/\b(?:this|that|these|those|same|previous|prior|above)\s+regions?\b/, 'region'],
  ];
  for (const [pattern, dim] of candidates) {
    if (!pattern.test(lower)) continue;
    if (dim === 'product' && /\b(?:this|that|these|those|same|previous|prior|above)\s+product\s+cat(?:egor|agor|ogor)(?:y|ies)\b/.test(lower)) continue;
    if (valuesForPriorDimension(priorValues, dim).length) dims.push(dim);
  }
  // Subject/object pronouns usually refer to people/accounts when paired with
  // purchasing verbs. Resolve that entity before broad object retrieval so a
  // prior customer row does not become a fresh catalog search for "they".
  if (
    dims.length === 0
    && /\b(?:they|their|them)\b[^.?!]{0,48}\b(?:buy|bought|purchase|purchased|order|ordered|spend|spent|use|used)\b/.test(lower)
  ) {
    if (valuesForPriorDimension(priorValues, 'customer').length > 0) dims.push('customer');
    else {
      const nameColumn = personNameFallbackDimension(priorValues);
      if (nameColumn) dims.push(nameColumn);
    }
  }
  // Singular people pronouns are common in conversational analytical follow-ups
  // ("what region does he belong to?", "what is her segment?"). Resolve them
  // against the prior result's typed customer values, preserving the same
  // ambiguity guard used by "this customer". This is intentionally limited to
  // a person-like prior dimension; a pronoun must never make us guess a product
  // or metric member from the first row.
  if (dims.length === 0 && /\b(?:he|she|him|his|her|hers)\b/.test(lower)) {
    if (valuesForPriorDimension(priorValues, 'customer').length > 0) dims.push('customer');
    else {
      const nameColumn = personNameFallbackDimension(priorValues);
      if (nameColumn) dims.push(nameColumn);
    }
  }
  // Singular people pronouns are deliberately EXCLUDED from this broad
  // fallback. `singlePriorValueDimension` returns a whole dimension, and
  // `resolveDeicticFilters` then binds every value in it — so "what region he
  // belongs to" over a ten-row answer silently filtered on all ten people at
  // once, with no clarification and no sign anything had been assumed. A
  // singular reference resolves above or becomes an ambiguity for the user to
  // settle; it must never widen into the entire prior population.
  if (dims.length === 0 && /\b(?:it|its|they|their|them|this|these|those|that|same|above|previous|prior)\b/.test(lower)) {
    const single = singlePriorValueDimension(priorValues);
    if (single) dims.push(single);
  }
  return dims.length > 0 ? Array.from(new Set(dims)) : undefined;
}

function resolveSingularDeicticDimension(question: string, priorValues: Record<string, string[]>): string | undefined {
  const lower = question.toLowerCase();
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:this|that|same|previous|prior|above)\s+product\b/, 'product'],
    [/\b(?:this|that|same|previous|prior|above)\s+customer\b/, 'customer'],
    [/\b(?:he|she|him|his|her|hers)\b/, 'customer'],
    [/\b(?:this|that|same|previous|prior|above)\s+category\b/, 'category'],
    [/\b(?:this|that|same|previous|prior|above)\s+segment\b/, 'segment'],
    [/\b(?:this|that|same|previous|prior|above)\s+region\b/, 'region'],
  ];
  for (const [pattern, dim] of candidates) {
    if (pattern.test(lower) && valuesForPriorDimension(priorValues, dim).length) return dim;
  }
  // A person pronoun over a result whose only people column is a bare `name`.
  // Returning the column here keeps the ambiguity guard intact: the caller
  // still collects every candidate and asks which one was meant.
  if (/\b(?:he|she|him|his|her|hers)\b/.test(lower)) return personNameFallbackDimension(priorValues);
  return undefined;
}

function valuesForPriorDimension(values: Record<string, string[]>, dim: string): string[] {
  const aliases = [dim, `${dim}_name`];
  if (dim === 'product') aliases.push('sku');
  if (dim === 'category') aliases.push('product_type', 'category_name');
  const exact = aliases.flatMap((alias) => values[alias] ?? []);
  // Exact alias matching alone is too literal for real result sets: keys here
  // are raw result column names, so `customer_display_name` and `top_customer`
  // both identify customers while matching none of the aliases above. Fold
  // every key that normalizes to the same business dimension AND actually
  // names members of it.
  const normalized = Object.entries(values)
    .filter(([key]) => normalizePriorValueDimension(key) === dim && namesMembersOf(key, dim))
    .flatMap(([, dimensionValues]) => dimensionValues);
  return Array.from(new Set([...exact, ...normalized])).filter(Boolean);
}

/**
 * Words that mark a column as describing an attribute OF an entity rather than
 * listing the entity's members.
 */
const NON_IDENTITY_COLUMN_WORDS = new Set([
  'id', 'ids', 'key', 'keys', 'code', 'type', 'types', 'status', 'tier', 'segment',
  'category', 'group', 'class', 'level', 'flag', 'count', 'total', 'sum', 'avg',
  'revenue', 'spend', 'amount', 'value', 'score', 'rank', 'date', 'at', 'ts',
]);

/**
 * Does this column list MEMBERS of `dim`, rather than an attribute of them?
 *
 * `customer_type` normalizes to the customer dimension but holds "returning" —
 * a segment label, not a person. Binding it as a member filter is precisely
 * the silent wrong answer this resolver exists to prevent, so a column whose
 * remaining words describe an attribute is not a source of member identities.
 * Ids are excluded for the same reason the persistence layer excludes them:
 * they are not a display surface a user can recognise or choose between.
 */
function namesMembersOf(key: string, dim: string): boolean {
  const words = key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const residual = words.filter((word) => word !== dim && word !== `${dim}s`);
  return !residual.some((word) => NON_IDENTITY_COLUMN_WORDS.has(word));
}

/**
 * The display column of a prior result that plainly holds person names, for
 * use only when no business-entity key resolved.
 *
 * A certified block that outputs a bare `name` column defeats both alias and
 * normalized matching: `name` describes no entity on its own. That is the
 * exact shape behind the reported failure — ten named customers on screen,
 * and "what region he belongs to" resolving to nothing. Restricted to a
 * singular person reference and to a single unambiguous name-like column, so
 * a pronoun can still never conjure a product or metric member.
 */
function personNameFallbackDimension(priorValues: Record<string, string[]>): string | undefined {
  for (const entity of ['customer', 'account', 'user'] as const) {
    if (valuesForPriorDimension(priorValues, entity).length > 0) return undefined;
  }
  const nameColumns = Object.keys(priorValues)
    .filter((key) => /(^|[_\s-])(full[_\s-]?)?name$/i.test(key.trim()))
    .filter((key) => (priorValues[key] ?? []).length > 0);
  return nameColumns.length === 1 ? nameColumns[0] : undefined;
}

function pluralPriorResultEntity(question: string): 'customer' | 'account' | 'product' | 'user' | undefined {
  const lower = question.toLowerCase();
  if (/\b(?:these|those|same|previous|prior)\s+customers?\b|\bof\s+(?:these|those)\s+customers?\b/.test(lower)) return 'customer';
  if (/\b(?:these|those|same|previous|prior)\s+accounts?\b|\bof\s+(?:these|those)\s+accounts?\b/.test(lower)) return 'account';
  if (/\b(?:these|those|same|previous|prior)\s+products?\b|\bof\s+(?:these|those)\s+products?\b/.test(lower)) return 'product';
  if (/\b(?:these|those|same|previous|prior)\s+users?\b|\bof\s+(?:these|those)\s+users?\b/.test(lower)) return 'user';
  return undefined;
}

function cleanPriorResultMemberSets(value: unknown): ConversationResultMemberSetV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowedEntities = new Set<ConversationResultMemberSetV1['entity']>([
    'customer', 'account', 'product', 'user', 'other',
  ]);
  const sets = value.flatMap((raw): ConversationResultMemberSetV1[] => {
    const record = cleanRecord(raw);
    if (!record || record.version !== 1) return [];
    const entity = cleanOptionalString(record.entity) as ConversationResultMemberSetV1['entity'] | undefined;
    const displayColumn = cleanOptionalString(record.displayColumn);
    const displayValues = arrayValue(record.displayValues)
      ?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .filter((item, index, values) => values.indexOf(item) === index)
      .slice(0, 24);
    if (!entity || !allowedEntities.has(entity) || !displayColumn || !displayValues?.length) return [];
    const keyColumn = cleanOptionalString(record.keyColumn);
    const keyValues = arrayValue(record.keyValues)
      ?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .filter((item, index, values) => values.indexOf(item) === index)
      .slice(0, 24);
    const resultFingerprint = cleanOptionalString(record.resultFingerprint);
    return [{
      version: 1,
      entity,
      displayColumn,
      displayValues,
      ...(keyColumn && keyValues?.length ? { keyColumn, keyValues } : {}),
      ...(resultFingerprint && /^[a-f0-9]{64}$/i.test(resultFingerprint)
        ? { resultFingerprint: resultFingerprint.toLowerCase() }
        : {}),
    }];
  });
  return sets.length > 0 ? sets.slice(0, 8) : undefined;
}

function memberSetValuesByDimension(
  sets: ConversationResultMemberSetV1[] | undefined,
): Record<string, string[]> | undefined {
  if (!sets?.length) return undefined;
  // Key each set under BOTH its display column and its business entity.
  //
  // The entity was already resolved when the turn was persisted (a `name`
  // column on a customer result is recorded as entity `customer`). Keying only
  // by `displayColumn` threw that away, so a resolver asking for the values of
  // dimension `customer` found nothing whenever the result happened to display
  // `name` rather than `customer_name` — no pronoun binding, and worse, no
  // ambiguity candidates either, so the "which one did you mean?" question
  // could never be asked. Merge rather than overwrite: two sets can share an
  // entity.
  return mergePriorResultValues(
    ...sets.map((set) => ({ [set.displayColumn]: set.displayValues })),
    ...sets.map((set) => ({ [set.entity]: set.displayValues })),
  );
}

function mergePriorResultValues(
  ...records: Array<Record<string, string[]> | undefined>
): Record<string, string[]> | undefined {
  const merged: Record<string, string[]> = {};
  for (const record of records) {
    for (const [dimension, values] of Object.entries(record ?? {})) {
      const existing = merged[dimension] ?? [];
      const next = Array.from(new Set([...existing, ...values]))
        .filter(Boolean)
        .slice(0, 24);
      if (next.length > 0) merged[dimension] = next;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function formatResultDimensionValues(value: Record<string, string[]>): string {
  return Object.entries(value)
    .slice(0, 8)
    .map(([key, values]) => `${key}=[${values.slice(0, 8).join(', ')}]`)
    .join('; ');
}

function formatConversationTurnsForPrompt(turns: unknown[]): string {
  return turns
    .map(cleanRecord)
    .filter((turn): turn is Record<string, unknown> => Boolean(turn))
    .slice(-4)
    .map((turn, index) => {
      const result = cleanRecord(turn.result);
      const columns = arrayValue(result?.columns)?.map(cleanOptionalString).filter(Boolean).slice(0, 6) ?? [];
      const values = cleanStringRecordArray(result?.dimensionValues);
      const valueText = values ? formatResultDimensionValues(values) : '';
      const cascade = cleanRecord(turn.cascade);
      const cascadeText = [
        cleanOptionalString(cascade?.terminalLane),
        cleanOptionalString(cascade?.routeTier),
      ].filter(Boolean).join('/');
      return [
        `${index + 1}. ${cleanOptionalString(turn.question) ?? 'prior turn'}`,
        cascadeText ? `cascade=${cascadeText}` : '',
        cleanOptionalString(turn.answerSummary) ? `summary=${cleanOptionalString(turn.answerSummary)}` : '',
        columns.length ? `columns=${columns.join(', ')}` : '',
        valueText ? `values=${valueText}` : '',
      ].filter(Boolean).join(' | ');
    })
    .join('\n');
}

function singlePriorValueDimension(priorValues: Record<string, string[]>): string | undefined {
  const dims = Array.from(new Set(Object.keys(priorValues).map(normalizePriorValueDimension).filter(Boolean)));
  return dims.length === 1 ? dims[0] : undefined;
}

function normalizePriorValueDimension(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes('category')) return 'category';
  if (lower.includes('product')) return 'product';
  if (lower.includes('customer')) return 'customer';
  if (lower.includes('account')) return 'account';
  if (lower.includes('user')) return 'user';
  if (lower.includes('region')) return 'region';
  if (lower.includes('segment')) return 'segment';
  if (lower.includes('channel')) return 'channel';
  return lower.replace(/[_\s-]+name$/, '').replace(/[^a-z0-9_ -]+/g, '').trim();
}

export const __test__ = {
  agenticLaneForRequest,
  resolveV2SemanticCapabilityReference,
  orchestratorPolicyForRequest,
  applyTopicShiftGuard,
  isDrilldownFollowUp,
  buildAnswerLoopTools,
  createCertifiedFitConfirmation,
  followUpFromConversationContext,
  inferFollowUpContext,
  formatCascadeOutcome,
  parseCertifiedFitConfirmation,
  rewriteFollowUpQuestion,
  shouldLoadSchemaContext,
  shouldSearchProjectFiles,
  renderProjectSourceSearch,
  researchDispatchPurposeForTool,
  readAgentConfig,
  providerBoundaryDiagnostic,
  createAskV2LaneHandler,
  createAskV2ResearchLaneHandler,
  parseAskV2ResearchHypotheses,
  askV2ResearchAnalyticalBranchReceipt,
};

function researchDispatchPurposeForTool(toolName: string): 'research_narration' | 'research_tool' {
  return toolName === 'execute_local_analysis' ? 'research_tool' : 'research_narration';
}

const GENERIC_FOLLOW_UP_WORDS = new Set([
  'a', 'about', 'again', 'all', 'also', 'and', 'are', 'as', 'be', 'block', 'can', 'could', 'data', 'did', 'do', 'does',
  'execute', 'for', 'from', 'get', 'give', 'import', 'it', 'its', 'let', 'lets', 'me', 'metrics',
  'more', 'now', 'of', 'output', 'please', 'result', 'results', 'run', 'show', 'solution', 'summary',
  'that', 'the', 'them', 'this', 'to', 'use', 'was', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'with', 'you',
]);

function isGenericFollowUp(question: string): boolean {
  const lower = question.toLowerCase();
  if (/\b(?:what|how)\s+about\s+(?:the\s+)?(?:other|remaining|rest(?:\s+of\s+the)?)\s+(?:metrics?|measures?)\b/.test(lower)) {
    return true;
  }
  if (/\b(?:combine|merge|join|final|summari[sz]e)\b/.test(lower) && /\b(?:previous|prior|above|these|those|results?|outputs?|turns?)\b/.test(lower)) {
    return true;
  }
  if (!/\b(block|data|execute|import|it|result|results|run|solution|that|this)\b/.test(lower)) return false;
  const tokens = lower.match(/[a-z0-9_]+/g) ?? [];
  const meaningful = tokens.filter((token) => token.length > 1 && !GENERIC_FOLLOW_UP_WORDS.has(token));
  return meaningful.length === 0;
}

/**
 * A drilldown INHERITS the previous turn's filters and dimensions, so the bar
 * for classifying one has to be a reference to that previous turn.
 *
 * This used to fire on a bare `by`, `for`, `only`, `where`, `compare` or a noun
 * like `regions`, which is present in almost every analytical question. "Show
 * revenue by region" on a brand-new topic was therefore treated as a drilldown
 * of whatever came before and silently inherited its filters — the reported
 * "when I ask a different question it's not giving the right solution".
 *
 * Now it needs either a deictic reference to the prior result, or an explicit
 * drill verb that only makes sense relative to something already on screen.
 */
function isDrilldownFollowUp(question: string, _priorTerms: string[] = []): boolean {
  const lower = question.toLowerCase();
  const deicticDrilldown = /\b(?:this|that|these|those|same|above|previous|prior)\s+(?:amount|value|orders?|results?|rows?|customers?|products?|cat(?:egor|agor|ogor)(?:y|ies)|segments?|regions?)\b/.test(lower)
    || /\b(?:they|their|them|he|she|him|his|her|hers)\b/.test(lower);
  // `break ... down` is split by its object more often than not ("break that
  // down", "break the revenue down"), so the verb and particle are matched with
  // a short gap between them rather than adjacently.
  const explicitDrillVerb = /\b(drills?|breakdowns?|slices?|segments?|splits?|why|drivers?|root cause|variance)\b/.test(lower)
    || /\bbreak\b.{0,16}\bdown\b/.test(lower);
  const hasDeicticReference = /\b(?:this|that|these|those|same|above|previous|prior|they|their|them|he|she|him|his|her|hers)\b/.test(lower);
  const resultStateReference = /\b(?:decline|drop|change|increase|decrease|variance)\b/.test(lower);
  // A shared word such as customer, revenue, or region is not a prior-result
  // reference. It appears in many unrelated analytical questions and used to
  // make a fresh request inherit the prior answer's filters and measures.
  const explicitPriorResultOperation = /\b(?:top|bottom)\s+\d+\s+of\s+(?:these|those|them|the\s+(?:prior|previous)?\s*results?)\b/.test(lower)
    || /\b(?:average|sum|total|compare)\s+(?:of|across)\s+(?:these|those|them|the\s+(?:prior|previous)?\s*results?)\b/.test(lower);
  // An additive projection is explicitly anchored to the result on screen.
  // It still has no authority without a completed host-persisted result; the
  // local runtime checks that boundary before it can preserve prior shape.
  const explicitResultProjectionAugmentation = /\b(?:add|include|also\s+(?:show|include))\s+(?:the\s+)?[a-z][a-z0-9_ -]{0,48}\s+(?:here|there|too|as\s+well)\b/.test(lower);
  // A drill verb with NO NEW SUBJECT is a shape continuation of the answer
  // on screen: "can you split by month" names no measure and no entity of its
  // own, so there is nothing else it could be about. Requiring a deictic word
  // here dropped the entire conversation — the certified `monthly_revenue`
  // block then claimed the turn against an EMPTY plan (its fit vacuously
  // exact), answering a different question than the one being refined. A
  // question that brings its own measure or entity keeps today's strictness.
  const plan = buildAnalysisQuestionPlan(question);
  const bringsOwnSubject = plan.metricTerms.length > 0 || plan.entities.length > 0;
  // The verb must also have NO explicit object: "split by month" refines what
  // is on screen, while "split shipments by warehouse" names its own subject
  // even when that noun is outside the parser's vocabulary.
  const objectlessDrill = /\b(?:splits?|slices?|group)\s*(?:it|this|that|them|these|those)?\s*by\b/.test(lower)
    || /\bbreak\s*(?:it|this|that|them)?\s*down\s+by\b/.test(lower);
  const shapeContinuation = objectlessDrill && !bringsOwnSubject;
  if (!deicticDrilldown && !explicitPriorResultOperation && !explicitResultProjectionAugmentation
    && !shapeContinuation
    && !(explicitDrillVerb && (hasDeicticReference || resultStateReference))) return false;
  // Bare definitions should not inherit a prior result merely because they
  // contain a pronoun. An explicit result operation remains authoritative.
  return explicitPriorResultOperation || explicitResultProjectionAugmentation || !/\b(what is|what are|define|definition|meaning of)\b/.test(lower);
}

/**
 * Lower-cased words from the prior result's columns and dimension keys, used to
 * detect that a follow-up is about that result.
 */
function priorShapeTerms(
  columns: string[] | undefined,
  dimensionValues: Record<string, string[]> | undefined,
): string[] {
  const names = [...(columns ?? []), ...Object.keys(dimensionValues ?? {})];
  const terms = new Set<string>();
  for (const name of names) {
    for (const part of name.toLowerCase().split(/[^a-z0-9]+/)) {
      // Skip short and generic tokens that would match almost any question.
      if (part.length >= 4 && !['name', 'total', 'count', 'value', 'date', 'time'].includes(part)) {
        terms.add(part);
      }
    }
  }
  return [...terms];
}

function extractDrilldownFilters(question: string): string[] {
  const filters: string[] = [];
  const quoted = [...question.matchAll(/["']([^"']+)["']/g)].map((match) => match[1].trim()).filter(Boolean);
  filters.push(...quoted);
  for (const pattern of [
    /\benterprise\b/i,
    /\bsmall business\b/i,
    /\bmid[- ]market\b/i,
    /\blast week\b/i,
    /\bthis week\b/i,
    /\blast month\b/i,
    /\bthis month\b/i,
    /\blast quarter\b/i,
    /\bthis quarter\b/i,
  ]) {
    const match = question.match(pattern);
    if (match) filters.push(match[0]);
  }
  return Array.from(new Set(filters));
}

function extractDrilldownDimensions(question: string): string[] {
  const dims: string[] = [];
  for (const match of question.matchAll(/\bby\s+([a-z][a-z0-9_ -]{1,40})/gi)) {
    const value = match[1].replace(/\b(last|this|where|for|only|and|with)\b.*$/i, '').trim();
    if (value) dims.push(value);
  }
  for (const dim of ['segment', 'region', 'customer', 'channel', 'product', 'category', 'week', 'month']) {
    if (new RegExp(`\\b${dim}\\b`, 'i').test(question)) dims.push(dim);
  }
  return Array.from(new Set(dims));
}

function formatAgentAnswer(result: AgentAnswer): string {
  const badge = result.certification === 'certified'
    ? 'Certified'
    : result.sourceTier === 'semantic_layer'
      ? 'AI generated from semantic layer - analyst review required'
      : result.kind === 'no_answer'
        ? 'No answer'
        : 'AI generated from dbt manifest - analyst review required';
  const citations = result.citations.length > 0
    ? '\n\nCitations:\n' + result.citations.map((c) => `- ${c.kind}: ${c.name}${c.provenance ? ` (${c.provenance})` : ''}`).join('\n')
    : '';
  const cascade = formatCascadeOutcome(result.cascade);
  const cascadeLine = cascade ? `\nCascade: ${cascade}` : '';
  const resultPreview = formatResultPreview(result.result);
  const dql = result.dqlArtifact?.source?.trim()
    ? `\n\nDQL Artifact (${result.dqlArtifact.kind}):\n\`\`\`dql\n${result.dqlArtifact.source.trim()}\n\`\`\``
    : '';
  const sql = result.proposedSql ? `\n\nCompiled SQL preview:\n\`\`\`sql\n${result.proposedSql}\n\`\`\`` : '';
  return `[${badge}]${cascadeLine}\n\n${result.text}${resultPreview}${citations}${dql}${sql}`;
}

function formatCascadeOutcome(cascade: AgentAnswer['cascade']): string | undefined {
  if (!cascade?.terminalLane && !cascade?.routeTier) return undefined;
  const lane = formatCascadeLane(cascade.terminalLane);
  const tier = formatCascadeTier(cascade.routeTier);
  return [lane, tier].filter(Boolean).join(' · ') || undefined;
}

function formatCascadeLane(value?: string): string | undefined {
  switch (value) {
    case 'certified':
      return 'Lane 1 certified';
    case 'semantic':
      return 'Lane 2 semantic';
    case 'generated':
      return 'Lane 3 generated';
    case 'refusal':
      return 'Lane 4 refusal';
    default:
      return value ? formatLabel(value) : undefined;
  }
}

function formatCascadeTier(value?: string): string | undefined {
  switch (value) {
    case 'certified_block':
      return 'Certified block';
    case 'semantic_metric':
      return 'Semantic metric';
    case 'generated_sql':
      return 'Generated SQL';
    case 'business_context':
      return 'Business context';
    case 'no_answer':
      return 'No answer';
    default:
      return value ? formatLabel(value) : undefined;
  }
}

function formatLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatResultPreview(result?: AgentResultPayload): string {
  if (!result) return '';
  const columns = normalizeColumns(result.columns).slice(0, 8);
  const rows = Array.isArray(result.rows) ? result.rows.slice(0, 8) : [];
  const shown = rows.length;
  const timing = typeof result.executionTime === 'number' && result.executionTime > 0
    ? ` in ${Math.round(result.executionTime)} ms`
    : '';
  if (columns.length === 0 || rows.length === 0) {
    return `\n\nResults: ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${timing}.`;
  }
  const tableRows = rows.map((row) => {
    const record = row && typeof row === 'object' ? row as Record<string, unknown> : {};
    return `| ${columns.map((col) => formatCell(record[col])).join(' | ')} |`;
  });
  const omittedRows = result.rowCount > shown ? ` Showing first ${shown} rows.` : '';
  return [
    `\n\nResults: ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${timing}.${omittedRows}`,
    `| ${columns.map(escapeMarkdownTable).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...tableRows,
  ].join('\n');
}

function normalizeColumns(columns: unknown[]): string[] {
  return columns.map((column) => {
    if (typeof column === 'string') return column;
    if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
      return (column as { name: string }).name;
    }
    return String(column);
  });
}

function formatCell(value: unknown): string {
  if (value === null || typeof value === 'undefined') return '';
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return escapeMarkdownTable(raw.length > 80 ? `${raw.slice(0, 77)}...` : raw);
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function emitDraftProposal(result: AgentAnswer, question: string, emit: (turn: AgentTurn) => void): void {
  const isDrilldown = result.evidence?.route.some((step) => step.tool === 'propose_drilldown' && step.status === 'checked') ?? false;
  const dqlArtifact = result.dqlArtifact;
  const semanticArtifact = dqlArtifact?.kind === 'semantic_block' ? dqlArtifact : undefined;
  const proposal: BlockProposal = {
    name: slugify(question).slice(0, 56) || 'ai_generated_analysis',
    domain: inferProposalDomain(result) ?? '',
    owner: `${process.env.USER ?? 'analyst'}@local`,
    description: result.text.slice(0, 240),
    sql: result.proposedSql!,
    blockType: semanticArtifact ? 'semantic' : 'custom',
    ...(dqlArtifact
      ? {
          dqlSource: dqlArtifact.source,
        }
      : {}),
    ...(semanticArtifact
      ? {
          metrics: semanticArtifact.metrics,
          dimensions: semanticArtifact.dimensions,
          ...(semanticArtifact.filters ? { filters: semanticArtifact.filters } : {}),
          ...(semanticArtifact.timeDimension ? { timeDimension: semanticArtifact.timeDimension } : {}),
        }
      : {}),
    tags: [
      'ai-generated',
      'needs-review',
      semanticArtifact ? 'semantic' : result.sourceTier ?? 'dbt_manifest',
      ...(isDrilldown ? ['drilldown'] : []),
    ],
    chartType: result.suggestedViz,
  };
  emit({
    kind: 'proposal',
    proposal,
    governance: {
      certified: false,
      errors: [],
      warnings: [
        isDrilldown
          ? 'AI generated drilldown. Validate filters, joins, and grain before certifying.'
          : 'AI generated. Analyst review and certification are required before reuse as governed content.',
      ],
    },
  });
}

function inferProposalDomain(result: AgentAnswer): string | undefined {
  const evidence = result.evidence;
  const candidates = [
    ...(evidence?.selectedAssets ?? []),
    ...(evidence?.semanticObjects ?? []),
    ...(evidence?.sourceTables ?? []),
  ];
  return candidates.find((asset) => typeof asset.domain === 'string' && asset.domain.trim())?.domain?.trim();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}
