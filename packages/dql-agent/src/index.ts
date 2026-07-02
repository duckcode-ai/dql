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
import { reindexHints } from "./hints/git-store.js";

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
export type {
  SeedDefaultSkillsOptions,
  SeedDefaultSkillsResult,
} from "./skills/defaults.js";
export { answer, parseProposal } from "./answer-loop.js";
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
  type SynthesizeInput,
  type SynthesizeOptions,
  type SynthesizeResult,
  type SynthesizeCompletion,
  type SynthesisFormat,
  type SynthesizeResultPreview,
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
  AgentFollowUpContext,
  AgentJoinPath,
  AgentIntent,
  AgentResultPayload,
  AgentSchemaColumn,
  AgentSchemaTable,
  AnswerKind,
  AnswerLoopInput,
  AiRoute,
  AiRouteTier,
} from "./answer-loop.js";
export { matchSemanticMetric } from "./metadata/metric-match.js";
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
  MetadataCatalog,
  buildLocalContextPack,
  buildMetadataSnapshot,
  defaultMetadataPath,
  ensureMetadataCatalogFresh,
  openMetadataCatalog,
  planAgentAnswer,
  recordRuntimeSchemaSnapshot,
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
  upsertGeneratedDraft,
} from "./metadata/drafts.js";
export type { SemanticDraftNameInput } from "./metadata/drafts.js";
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
export type {
  BuildLocalContextPackRequest,
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
} from "./metadata/catalog.js";
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
} from "./providers/index.js";
export type {
  AgentProvider,
  AgentMessage,
  ProviderName,
  ProviderRunOptions,
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
}

/**
 * Rebuild the KG from the project's manifest. Safe to call on every save —
 * incremental indexing can land later; the wholesale rebuild is fast on the
 * scale dql projects realistically reach (thousands of nodes).
 */
export async function reindexProject(
  projectRoot: string,
  opts: ReindexOptions = {},
): Promise<{ nodes: number; edges: number; skills: number }> {
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

  const kg = new KGStore(opts.kgPath ?? defaultKgPath(projectRoot));
  try {
    kg.rebuild(nodes, edges);
  } finally {
    kg.close();
  }
  await ensureMetadataCatalogFresh(projectRoot, {
    manifest,
    semanticLayer,
    force: true,
  });
  // Rebuild the approved-hint index (Git authoritative; SQLite is a view). Safe
  // when no hints exist — yields an empty index.
  try {
    reindexHints(projectRoot, opts.kgPath ?? defaultKgPath(projectRoot));
  } catch {
    // Hint indexing is advisory; never fail a reindex over it.
  }
  return { nodes: nodes.length, edges: edges.length, skills: skills.length };
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

function loadAgentSemanticLayer(projectRoot: string) {
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
  if (configured) return configured;

  if (config.dbt?.projectDir) {
    return resolveSemanticLayerWithDiagnostics(
      {
        provider: "dbt",
        projectPath: config.dbt.projectDir,
      },
      projectRoot,
    ).layer;
  }
  return undefined;
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
