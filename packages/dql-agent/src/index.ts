/**
 * Public surface for `@duckcodeailabs/dql-agent`.
 *
 * Consumers (CLI, MCP server, notebook UI) typically import:
 *   - `reindexProject(root)` to rebuild the KG
 *   - `KGStore` for direct queries
 *   - `answer({ ... })` for the block-first answer loop
 *   - the providers (Claude/OpenAI/Gemini/Ollama)
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { DQLManifest } from "@duckcodeailabs/dql-core";
import {
  buildManifest,
  loadProjectConfig,
  resolveDbtManifestPath,
  resolveSemanticLayerWithDiagnostics,
} from "@duckcodeailabs/dql-core";
import { KGStore } from "./kg/sqlite-fts.js";
import { buildKGFromManifest, buildKGFromSemanticLayer } from "./kg/build.js";
import { loadSkills } from "./skills/loader.js";
import type { Skill } from "./skills/loader.js";
import type { KGEdge, KGNode } from "./kg/types.js";
import { ensureMetadataCatalogFresh } from "./metadata/catalog.js";
import { reindexHints, listHintsFromGit } from "./hints/git-store.js";
import { findStaleApprovedHints, type StaleHintFinding } from "./hints/staleness.js";

export { KGStore } from "./kg/sqlite-fts.js";
export type {
  KGNode,
  KGEdge,
  KGNodeKind,
  KGSearchHit,
  KGFeedbackRow,
  KGSearchOptions,
} from "./kg/types.js";
export { buildKGFromManifest, buildKGFromSemanticLayer } from "./kg/build.js";
export {
  activeSkills,
  buildSkillBlockHints,
  loadSkills,
  parseSkill,
  renderSkill,
  buildSkillsPrompt,
  selectRelevantSkills,
  writeSkill,
  upsertSkill,
  deleteSkill,
  skillsDir,
  skillPath,
} from "./skills/loader.js";
export type {
  Skill,
  SkillLoadResult,
  WriteSkillInput,
  SelectRelevantSkillsOptions,
} from "./skills/loader.js";
export { seedDefaultSkills } from "./skills/defaults.js";
export { seedDomainSkills, buildDomainReferenceSkills } from "./skills/domain-skills.js";
export type {
  SeedDefaultSkillsOptions,
  SeedDefaultSkillsResult,
} from "./skills/defaults.js";
export { answer, parseProposal } from "./answer-loop.js";
export {
  stampTrustLabel,
  trustLabelIdForAnswer,
  type TrustStampableAnswer,
} from "./trust/stamp.js";
export {
  decideAgentAction,
  classifyConversationalTurn,
  looksLikeComposeApp,
  looksLikeFollowUp,
  type AgentAction,
  type ConversationalKind,
  type IntentDecision,
  type IntentDecisionInput,
  type IntentSignals,
} from "./intent-controller.js";
export {
  AgentRunEngine,
  AGENT_RUN_ESCALATION_MAP,
  createDeterministicAgentRunPlanner,
  defaultSuccessCriteria,
  FileAgentRunStore,
  InMemoryAgentRunStore,
  defaultAgentRunStorePath,
  selectRoute,
  routeReasoningEffort,
} from "./agent-run-engine.js";
export type { FileAgentRunStoreOptions } from "./agent-run-engine.js";
export type {
  AgentRouteExecutionContext,
  AgentRouteExecutor,
  AgentRouteExecutorResult,
  AgentRouter,
  AgentRun,
  AgentRunAnswerKind,
  AgentRunArtifact,
  AgentRunArtifactKind,
  AgentRunAudience,
  AgentRunEngineOptions,
  AgentRunEvaluation,
  AgentRunEvaluationSeverity,
  AgentRunEvent,
  AgentRunExecutors,
  AgentRunGate,
  AgentRunGateContext,
  AgentRunGates,
  AgentRunNextAction,
  AgentRunPlan,
  AgentRunPlanInput,
  AgentRunPlanner,
  AgentRunPlanSource,
  AgentRunPlannedStep,
  AgentRunReplanDecision,
  AgentRunReplanInput,
  AgentRunRepairAction,
  AgentRunRequest,
  AgentRunRequestedMode,
  AgentRunRoute,
  AgentRunSelectedObject,
  AgentRunStatus,
  AgentRunStep,
  AgentRunStepStatus,
  AgentRunStopReason,
  AgentRunStore,
  AgentRunTrustState,
} from "./agent-run-engine.js";
export { defaultAgentRunGates } from "./agent-run-gates.js";
export {
  narrateResult,
  type NarrateInput,
  type NarrateItem,
  type NarrateResult,
  type NarrateResultData,
  type NarrateCompletion,
  type NarrateOptions,
} from "./narrate.js";
export {
  createLlmAgentRunPlanner,
  type AgentRunPlannerCompletion,
  type LlmAgentRunPlannerOptions,
} from "./agent-run-planner.js";
export {
  createHybridRouter,
  type RouterClassification,
  type RouterCompletion,
  type HybridRouterOptions,
} from "./router.js";
export {
  synthesizeAnswer,
  inferFormat,
  computeResultStats,
  type SynthesizeInput,
  type SynthesizeOptions,
  type SynthesizeResult,
  type SynthesizeCompletion,
  type SynthesisFormat,
  type SynthesizeResultPreview,
  type SynthesizeColumnStat,
} from "./synthesize.js";
export {
  planApp,
  type AppPlan as AgentAppPlan,
  type AppPlanSection,
  type AppPlanFilter as AgentAppPlanFilter,
  type PlanBlock,
} from "./app-planner.js";
export {
  planResearch,
  type ResearchPlan,
  type ResearchStep,
  type ResearchFollowUp,
} from "./research-loop.js";
export { loadSemanticMetrics } from "./propose/build-from-prompt.js";
export type {
  AgentAnalysisPlan,
  AgentAnswer,
  AgentCitation,
  AgentDqlArtifactReference,
  AgentEvidence,
  AgentEvidenceAsset,
  AgentEvidenceContextItem,
  AgentEvidenceLineageNode,
  AgentEvidenceLineageRole,
  AgentEvidenceOutcome,
  AgentEvidenceRouteStatus,
  AgentEvidenceRouteStep,
  AgentEvidenceToolCall,
  AgentFollowUpContext,
  AgentJoinPath,
  AgentIntent,
  AgentPriorResultReference,
  AgentResultPayload,
  AgentSchemaColumn,
  AgentSchemaTable,
  AnalysisDepth,
  AnswerKind,
  AnswerLoopInput,
  AiRoute,
  AiRouteTier,
} from "./answer-loop.js";
export { matchSemanticMetric } from "./metadata/metric-match.js";
export {
  composeSemanticQueryForQuestion,
  renderSemanticDqlArtifact,
  semanticDqlArtifactName,
  type ComposeSemanticQueryInput,
  type SemanticBridgeFilter,
  type SemanticBridgeOrderBy,
  type SemanticBridgeQueryResult,
  type SemanticDqlArtifactInput,
} from "./semantic-bridge/compose.js";
export {
  DQL_TOOL_REGISTRY,
  dqlMcpToolNamesForSurface,
  dqlToolDefinitionsForSurface,
  dqlToolNamesForSurface,
  getDqlToolDefinition,
} from "./tools/registry.js";
export type {
  DqlToolDefinition,
  DqlToolName,
  DqlToolSurface,
  JsonSchema,
} from "./tools/registry.js";
export {
  cascadeTraceToEvidenceRouteSteps,
  createCascadeAnswerResult,
  createCascadeTrace,
  terminalLaneForRouteTier,
  type CascadeAnswerResult,
  type CascadeAnswerResultInput,
  type CascadeAnswerTier,
  type CascadeCertifiedOutcome,
  type CascadeEvidenceRouteStep,
  type CascadeGeneratedOutcome,
  type CascadeLane,
  type CascadeLaneOutcome,
  type CascadeLaneStatus,
  type CascadeLaneTrace,
  type CascadeLaneTraceInput,
  type CascadeRefusalOutcome,
  type CascadeSemanticOutcome,
  type CascadeTraceInput,
} from "./cascade/cascade.js";
export {
  shouldClarifyBeforeGeneration,
  type CascadeClarifyInput,
  type CascadeMissingContext,
  type CascadeRouteDecisionLike,
} from "./cascade/triage.js";
export {
  routeForCascadeAnswerTier,
  selectCascadeRunRoute,
  type CascadeAction,
  type CascadeAnswerRouteTier,
  type CascadeRequestedMode,
  type CascadeRouteDecision,
  type CascadeRouteRequest,
  type CascadeRunRoute,
} from "./cascade/route-policy.js";
export {
  DEFAULT_CASCADE_BUDGET_MODEL,
  canUseEngineEscalation,
  canUseLaneRepair,
  contextRetrievalBudgetForQuestion,
  analysisDepthForQuestion,
  cascadeBudgetTrace,
  cascadeBudgetUsage,
  createCascadeBudgetState,
  mcpTier2RegroundRepairBudget,
  mergeCascadeBudgetModel,
  promptContextBudgetForQuestion,
  proposalToolBudgetForQuestion,
  recordEngineEscalation,
  recordLaneRepair,
  type CascadeAnalysisDepth,
  type CascadeBudgetModel,
  type CascadeBudgetState,
  type CascadeBudgetTrace,
  type CascadeBudgetUsage,
  type CascadeLaneBudgetLimits,
  type CascadeLaneRepairKind,
  type ContextRetrievalBudget,
  type ContextRetrievalStrictness,
  type McpTier2RepairBudget,
  type PartialCascadeBudgetModel,
  type PromptContextBudget,
  type ProposalToolBudget,
  type ProposalToolBudgetClass,
  type ProposalToolBudgetOptions,
} from "./cascade/budgets.js";
export type { MetricMatch, MatchSemanticMetricOptions } from "./metadata/metric-match.js";
export {
  APP_BUILDER_SKILLS,
  planAppFromPrompt,
  validateAppPlan,
  generateAppFromPlan,
} from "./app-builder.js";
export type {
  AppBuilderSkill,
  AppBuilderSkillId,
  AppPlan,
  AppPlanAnalysisIntent,
  AppPlanFilter,
  AppPlanFollowUpAction,
  AppPlanPage,
  AppPlanTile,
  AppPlanTileKind,
  AppPlanTileRole,
  AppPlanTrustState,
  AppPlanValidationIssue,
  AppPlanValidationResult,
  GeneratedAppPackage,
  GenerateAppFromPlanOptions,
  PlanAppFromPromptInput,
} from "./app-builder.js";
export {
  MemoryStore,
  defaultMemoryPath,
  ensureDefaultMemoryFiles,
} from "./memory/sqlite-memory.js";
export type {
  AgentMemory,
  AgentMemoryInput,
  AgentMemoryScope,
  MemorySearchOptions,
} from "./memory/sqlite-memory.js";
export {
  ConversationStore,
  defaultConversationPath,
} from "./conversation/session-store.js";
export type {
  ConversationThread,
  ConversationTurn,
  ConversationTurnInput,
  ConversationTurnResult,
  ConversationTurnSearchOptions,
} from "./conversation/session-store.js";
export {
  emptyWorkingState,
  parseWorkingState,
  reduceWorkingState,
} from "./conversation/working-state.js";
export type {
  ConversationTopicFrame,
  ConversationWorkingState,
  TopicRelation,
} from "./conversation/working-state.js";
export { updateRollingSummary } from "./conversation/rolling-summary.js";
export {
  advanceThreadState,
  buildConversationSnapshot,
  recallRelevantTurns,
} from "./conversation/snapshot.js";
export type {
  ConversationSnapshot,
  ConversationSnapshotTurn,
} from "./conversation/snapshot.js";
export {
  MetadataCatalog,
  buildLocalContextPack,
  buildMetadataSnapshot,
  defaultMetadataPath,
  ensureMetadataCatalogFresh,
  metadataObjectToAllowedSqlRelation,
  openMetadataCatalog,
  planAgentAnswer,
  recordRuntimeSchemaSnapshot,
  latestRuntimeSchemaSnapshotForProject,
  recordQueryRun,
  upsertMetadataSnapshot,
} from "./metadata/catalog.js";
export {
  buildBlockBusinessFingerprint,
  buildBlockSqlFingerprints,
  fingerprintSql,
  normalizeBusinessFingerprintToken,
  normalizeSqlForFingerprint,
} from "./metadata/block-fingerprints.js";
export type {
  BlockBusinessFingerprint,
  BlockSqlFingerprints,
  BuildBlockBusinessFingerprintInput,
} from "./metadata/block-fingerprints.js";
export {
  buildAnalysisQuestionPlan,
  certifiedApplicabilityForObject,
  scoreAllowedSqlRelationWithAnalysisPlan,
  scoreMetadataObjectWithAnalysisPlan,
  sortAllowedSqlContextForAnalysisPlan,
} from "./metadata/analysis-planner.js";
export type {
  AnalysisEntityMention,
  AnalysisQuestionMode,
  AnalysisQuestionPlan,
  AllowedSqlRelationScore,
  CertifiedApplicabilityKind,
  CertifiedBlockApplicability,
} from "./metadata/analysis-planner.js";
export {
  grainMatches,
  requestedGrainFromPlan,
} from "./metadata/grain-gate.js";
export type {
  GrainGateKind,
  GrainGateResult,
  RequestedGrain,
} from "./metadata/grain-gate.js";
export {
  validateSqlAgainstLocalContext,
} from "./metadata/sql-context-validation.js";
export {
  applyGroundingExpansion,
  expandGroundingFromCatalog,
} from "./grounding/regrounding.js";
export {
  ContextLedger,
  createContextLedger,
} from "./grounding/context-ledger.js";
export type {
  GroundingContextExpander,
  GroundingExpansionRequest,
  GroundingExpansionResult,
  MergedGroundingContext,
} from "./grounding/regrounding.js";
export type {
  ContextLedgerExpansionResult,
  ContextLedgerInput,
  ContextLedgerSqlValidationOptions,
} from "./grounding/context-ledger.js";
export {
  buildSchemaGrounding,
  buildGroundingFromRuntimeRelations,
  renderGroundingForPrompt,
  resolveRelationsInSql,
  validateSqlAgainstGrounding,
  relationKeys,
} from "./metadata/sql-grounding.js";
export type {
  SchemaGrounding,
  GroundedTable,
  GroundedColumn,
  GroundedJoinKey,
  BuildSchemaGroundingOptions,
  RuntimeRelationInput,
  RelationResolution,
  GroundingValidationCode,
  GroundingValidationResult,
} from "./metadata/sql-grounding.js";
export { selectRelevantModels } from "./metadata/sql-retrieval.js";
export type { SelectRelevantModelsOptions } from "./metadata/sql-retrieval.js";
export {
  deriveGeneratedDraftSlug,
  deriveSemanticDraftName,
  renderGeneratedSqlDqlArtifact,
  upsertGeneratedDqlArtifactDraft,
  upsertGeneratedDraft,
} from "./metadata/drafts.js";
export type { GeneratedDqlArtifactDraftRecord, SemanticDraftNameInput } from "./metadata/drafts.js";
export {
  persistOwner,
  readPersistedOwner,
  resolveLocalOwner,
} from "./metadata/identity.js";
export type { ResolveOwnerOptions } from "./metadata/identity.js";
export {
  propose,
  proposePlan,
  buildProposePreview,
  buildFromPrompt,
  loadDbtArtifacts,
  upsertProposedDraft,
  renderProposedDraft,
  blockSlug,
  resolveProposeConfig,
  DEFAULT_PROPOSE_CONFIG,
  classifyModel,
  resolveDomain,
  enrichProposal,
  enrichProposals,
} from "./propose/index.js";
export type {
  ProposeOptions,
  ProposeSummary,
  ProposalResult,
  ProposalInference,
  ProposalRanking,
  ProposedPattern,
  ProposePlan,
  ProposePlanOptions,
  ProposePlanDomain,
  ProposePlanCandidate,
  ProposePreviewOptions,
  BuildFromPromptOptions,
  BuildFromPromptContext,
  BuildFromPromptResult,
  BuildCellResult,
  BuildBlockResult,
  BuildMode,
  BuildRoute,
  CertifierVerdict,
  ProposeConfig,
  ProposeConfigInput,
  Classification,
  ClassificationResult,
  ProposedDraftRecord,
  WrittenDraft,
  DbtArtifacts,
  DbtModelNode,
  DbtSourceNode,
  DbtColumn,
  EnrichFacts,
  EnrichedContent,
  EnrichOptions,
  ReflectableDraft,
  ExecutionProbe,
  BlockReflection,
  ReflectionFix,
} from "./propose/index.js";
export { reflectAndReviseBlock } from "./propose/index.js";
export { mineJoinPatterns, type JoinPatternCandidate } from "./propose/join-mining.js";
export {
  analyzeFailureClusters,
  improvementProposalsFromKg,
  type FailureSignal,
  type ImprovementProposal,
} from "./propose/failure-analysis.js";
export type {
  BuildLocalContextPackRequest,
  CertifiedFitConfirmation,
  CertifiedFitConfirmationRequest,
  CertifiedFitConfirmationResult,
  EnsureMetadataCatalogOptions,
  EnsureMetadataCatalogResult,
  DqlContextPack,
  LocalContextPack,
  MetadataCandidateConflict,
  MetadataDiagnostic,
  MetadataEdge,
  MetadataAgentIntent,
  MetadataAllowedSqlContext,
  MetadataAnswerRoute,
  MetadataEvidenceRole,
  MetadataFollowUpContext,
  MetadataMissingContext,
  MetadataObject,
  MetadataRouteDecision,
  GrainGateRouteInfo,
  MetadataDomainShard,
  MetadataSourceFingerprint,
  MetadataSnapshot,
  MetadataTrustLabel,
  PlanAgentAnswerResult,
  QueryRunSummary,
  RuntimeSchemaSnapshot,
  RuntimeSchemaTable,
  RuntimeSchemaColumn,
} from "./metadata/catalog.js";
export type {
  SqlContextValidationCode,
  SqlContextValidationOffending,
  SqlContextValidationOptions,
  SqlContextValidationResult,
} from "./metadata/sql-context-validation.js";
export type {
  GeneratedDraftBlock,
  GeneratedDraftRecord,
} from "./metadata/drafts.js";
// --- Scoped correction memory (hints) ---
export {
  HintStore,
} from "./hints/store.js";
export type {
  SearchApprovedHintsOptions,
} from "./hints/store.js";
export {
  recordCorrectionTrace,
  reviewHint,
  reindexHints,
  listHintsFromGit,
  getHintFromGit,
  writeHintFile,
  readHintFile,
  hintsDir,
  tracesDir,
  reviewsDir,
  defaultHintIndexPath,
} from "./hints/git-store.js";
export {
  buildCorrectionEvalCase,
  emitCorrectionEvalCase,
  appendCorrectionEvalCase,
  CORRECTIONS_EVAL_RELATIVE_PATH,
  type CorrectionEvalCase,
} from "./hints/correction-eval.js";
export {
  findStaleHints,
  findStaleApprovedHints,
  type StaleHintFinding,
  type HintScopeTargetKind,
} from "./hints/staleness.js";
export type {
  RecordCorrectionTraceInput,
  RecordCorrectionTraceResult,
  ReviewHintInput,
  ReviewHintResult,
} from "./hints/git-store.js";
export {
  retrieveScopedHints,
} from "./hints/retrieval.js";
export type {
  AppliedHint,
  HintRetrievalResult,
  RetrieveScopedHintsOptions,
} from "./hints/retrieval.js";
export {
  hintAppliesToScope,
  hintsConflict,
} from "./hints/types.js";
export type {
  CorrectionTrace,
  Hint,
  HintReview,
  HintScope,
  HintStatus,
  QuestionScope,
  ScopedHintMatch,
} from "./hints/types.js";
// --- Pluggable semantic retrieval (embeddings) ---
export {
  HashedTokenEmbeddingProvider,
  defaultEmbeddingProvider,
  cosineSimilarity,
  hybridRank,
} from "./embeddings/provider.js";
export type {
  EmbeddingProvider,
  HybridRankItem,
  HybridRankOptions,
  HybridRanked,
} from "./embeddings/provider.js";
export type {
  AppliedContextHint,
  RuntimeValueMatch,
} from "./metadata/catalog.js";
export {
  buildRuntimeValueIndex,
  normalizeValueIndexText,
} from "./grounding/value-index.js";
export type {
  RuntimeValueIndexEntry,
  ValueIndexSnapshot,
} from "./grounding/value-index.js";
export {
  ClaudeProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  pickProvider,
  buildProvider,
  streamOrGenerate,
  normalizeAnthropicBaseUrl,
  normalizeGeminiBaseUrl,
  REASONING_EFFORTS,
  isReasoningEffort,
  coerceReasoningEffort,
  clampReasoningEffort,
  bumpReasoningEffort,
  supportsReasoningEffort,
  geminiReasoningStyle,
  effortToThinkingBudget,
  THINKING_MODES,
  isThinkingMode,
  coerceThinkingMode,
  resolveThinkingMode,
} from "./providers/index.js";
export type {
  AgentProvider,
  AgentMessage,
  AgentToolDefinition,
  ProviderName,
  ProviderRunOptions,
  ProviderToolLoopOptions,
  ReasoningEffort,
  GeminiReasoningStyle,
  ThinkingMode,
} from "./providers/index.js";

/**
 * Default location for the agent's SQLite KG file.
 * Mirrors the manifest cache layout under `.dql/cache/`.
 */
export function defaultKgPath(projectRoot: string): string {
  return join(projectRoot, ".dql", "cache", "agent-kg.sqlite");
}

export interface ReindexOptions {
  manifest?: DQLManifest;
  /** Path to the KG sqlite file. Defaults to `.dql/cache/agent-kg.sqlite`. */
  kgPath?: string;
  /** Set to false to skip re-loading Skills. */
  loadSkills?: boolean;
  /** Force the KG rebuild even when its graph fingerprint is unchanged. */
  forceKgIndex?: boolean;
  /** Force the metadata catalog rebuild even when its fingerprint is unchanged. */
  forceMetadataCatalog?: boolean;
}

export interface ReindexProjectResult {
  nodes: number;
  edges: number;
  skills: number;
  kgRebuilt: boolean;
  metadataRefreshed: boolean;
  kgFingerprint: string;
  metadataFingerprint: string;
  /** Approved hints whose scope targets no longer exist (W4.6); empty when none. */
  staleHints: StaleHintFinding[];
}

/**
 * Rebuild the KG from the project's manifest. Safe to call on every save —
 * incremental indexing can land later; the wholesale rebuild is fast on the
 * scale dql projects realistically reach (thousands of nodes).
 */
export async function reindexProject(
  projectRoot: string,
  opts: ReindexOptions = {},
): Promise<ReindexProjectResult> {
  const manifest = opts.manifest ?? loadManifest(projectRoot);
  const manifestGraph = buildKGFromManifest(manifest);
  const semanticLayer = loadAgentSemanticLayer(projectRoot);
  const semanticGraph = buildKGFromSemanticLayer(semanticLayer);
  let nodes = [...manifestGraph.nodes, ...semanticGraph.nodes];
  let edges = [...manifestGraph.edges, ...semanticGraph.edges];

  // Skills become KG nodes too so the agent can retrieve them.
  let skills: Skill[] = [];
  if (opts.loadSkills !== false) {
    const result = loadSkills(projectRoot);
    skills = result.skills;
    for (const s of skills) {
      nodes.push({
        nodeId: `skill:${s.id}`,
        kind: "skill",
        name: s.id,
        description: s.description,
        llmContext: s.body,
        sourcePath: s.sourcePath,
      });
    }
  }

  ({ nodes, edges } = dedupeGraph(nodes, edges));
  const kgFingerprint = fingerprintKgGraph(nodes, edges);

  const kg = new KGStore(opts.kgPath ?? defaultKgPath(projectRoot));
  let kgRebuilt = false;
  try {
    if (opts.forceKgIndex || kg.meta("fingerprint") !== kgFingerprint) {
      kg.rebuild(nodes, edges, { fingerprint: kgFingerprint });
      kgRebuilt = true;
    }
  } finally {
    kg.close();
  }
  const metadataRefresh = await ensureMetadataCatalogFresh(projectRoot, {
    manifest,
    semanticLayer,
    force: opts.forceMetadataCatalog,
  });
  // Rebuild the approved-hint index (Git authoritative; SQLite is a view). Safe
  // when no hints exist — yields an empty index.
  try {
    reindexHints(projectRoot, opts.kgPath ?? defaultKgPath(projectRoot));
  } catch {
    // Hint indexing is advisory; never fail a reindex over it.
  }
  // W4.6 — after reindexing, flag approved hints whose scope targets vanished (e.g.
  // a renamed dbt model) so they can be retired/re-scoped instead of silently firing
  // stale guidance. Advisory; never fails a reindex.
  let staleHints: StaleHintFinding[] = [];
  try {
    const approved = listHintsFromGit(projectRoot).filter((hint) => hint.status === 'approved');
    if (approved.length > 0) {
      const kgForStale = new KGStore(opts.kgPath ?? defaultKgPath(projectRoot));
      try {
        staleHints = findStaleApprovedHints(approved, kgForStale);
      } finally {
        kgForStale.close();
      }
    }
  } catch {
    // Staleness detection is advisory.
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    skills: skills.length,
    kgRebuilt,
    metadataRefreshed: metadataRefresh.refreshed,
    kgFingerprint,
    metadataFingerprint: metadataRefresh.fingerprint,
    staleHints,
  };
}

/**
 * Promotion suggester — surface uncertified answers that have accumulated
 * positive feedback so an analyst can certify them as proper blocks.
 */
export function getPromotionCandidates(
  projectRoot: string,
  minUps = 5,
): Array<{
  blockId: string;
  question: string;
  ups: number;
}> {
  const kg = new KGStore(defaultKgPath(projectRoot));
  try {
    return kg.promotionCandidates(minUps);
  } finally {
    kg.close();
  }
}

function loadManifest(projectRoot: string): DQLManifest {
  // Prefer the on-disk compiled manifest, fall back to a fresh build.
  const compiled = join(projectRoot, "dql-manifest.json");
  if (existsSync(compiled)) {
    try {
      return JSON.parse(readFileSync(compiled, "utf-8")) as DQLManifest;
    } catch {
      // fall through
    }
  }
  return buildManifest({
    projectRoot,
    dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined,
  });
}

export function loadAgentSemanticLayer(projectRoot: string) {
  const config = loadProjectConfig(projectRoot);
  const semanticConfig = config.semanticLayer?.provider
    ? (config.semanticLayer as Parameters<
        typeof resolveSemanticLayerWithDiagnostics
      >[0])
    : config.semanticLayer?.path
      ? { provider: "dql" as const, path: config.semanticLayer.path }
      : undefined;
  const configured = resolveSemanticLayerWithDiagnostics(
    semanticConfig,
    projectRoot,
  ).layer;
  // An empty configured layer (scaffold default `provider: 'dql'` with no
  // definitions) must not shadow a real dbt MetricFlow layer — that would strip
  // every metric/dimension/measure node from the KG and disable the governed
  // metric answer tier. Substance wins over configuration.
  if (configured && semanticLayerHasContent(configured)) return configured;

  if (config.dbt?.projectDir) {
    const dbtLayer = resolveSemanticLayerWithDiagnostics(
      {
        provider: "dbt",
        projectPath: config.dbt.projectDir,
      },
      projectRoot,
    ).layer;
    if (dbtLayer && semanticLayerHasContent(dbtLayer)) return dbtLayer;
  }
  return configured ?? undefined;
}

/** True when the layer defines ANY semantics — metrics, dimensions, or measures. */
function semanticLayerHasContent(layer: NonNullable<ReturnType<typeof resolveSemanticLayerWithDiagnostics>["layer"]>): boolean {
  return layer.listMetrics().length > 0
    || layer.listDimensions().length > 0
    || layer.listMeasures().length > 0;
}

function dedupeGraph(
  nodes: KGNode[],
  edges: KGEdge[],
): { nodes: KGNode[]; edges: KGEdge[] } {
  const byId = new Map<string, KGNode>();
  for (const node of nodes) {
    const existing = byId.get(node.nodeId);
    byId.set(node.nodeId, existing ? mergeNode(existing, node) : node);
  }
  const edgeKeys = new Set<string>();
  const uniqueEdges: KGEdge[] = [];
  for (const edge of edges) {
    if (!byId.has(edge.src) || !byId.has(edge.dst)) continue;
    const key = `${edge.src}\u0000${edge.dst}\u0000${edge.kind}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    uniqueEdges.push(edge);
  }
  return { nodes: Array.from(byId.values()), edges: uniqueEdges };
}

function mergeNode(a: KGNode, b: KGNode): KGNode {
  return {
    ...a,
    ...b,
    description: b.description || a.description,
    llmContext:
      [a.llmContext, b.llmContext].filter(Boolean).join("\n\n") || undefined,
    tags: Array.from(new Set([...(a.tags ?? []), ...(b.tags ?? [])])),
    examples: [...(a.examples ?? []), ...(b.examples ?? [])],
    sourcePath: b.sourcePath ?? a.sourcePath,
    gitSha: b.gitSha ?? a.gitSha,
  };
}

function fingerprintKgGraph(nodes: KGNode[], edges: KGEdge[]): string {
  const stableNodes = nodes
    .map((node) => stripUndefinedDeep(node) as Record<string, unknown>)
    .sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
  const stableEdges = edges
    .map((edge) => stripUndefinedDeep(edge) as Record<string, unknown>)
    .sort((a, b) => [
      String(a.src).localeCompare(String(b.src)),
      String(a.dst).localeCompare(String(b.dst)),
      String(a.kind).localeCompare(String(b.kind)),
    ].find((cmp) => cmp !== 0) ?? 0);
  return createHash("sha256")
    .update(stableStringify({ nodes: stableNodes, edges: stableEdges }))
    .digest("hex");
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return "\"[Circular]\"";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    seen.delete(value);
    return out;
  }
  const record = value as Record<string, unknown>;
  const out = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return out;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    out[key] = stripUndefinedDeep(raw);
  }
  return out;
}
