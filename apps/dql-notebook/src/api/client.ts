import type { DiffReport } from '@duckcodeailabs/dql-core/format';
import { normalizeDqlArtifactReference } from '@duckcodeailabs/dql-core/artifacts';
import type { Business360ResultV2 } from '@duckcodeailabs/dql-core/lineage';
import type {
  ManifestDbtFirstModeling,
  ManifestDbtProvenance,
  ManifestDiagnostic,
  ManifestLineage,
  ModelingAuthoringChange,
  ModelingChangePreview,
  DbtNodeAuthoringDetail,
  RelationshipAuthoringInput,
  ManifestRelationshipValidationEvidence,
} from '@duckcodeailabs/dql-core';
import type { AgentAnswerCascade, AgentConversationContext, AgentConversationDqlArtifact } from '../llm/types';
import type {
  Cell,
  NotebookFile,
  QueryResult,
  RunSnapshot,
  SchemaTable,
  SchemaColumn,
  SemanticLayerState,
  SemanticDimension,
  SemanticEntity,
  SemanticMeasure,
  SemanticMetric,
  SemanticModel,
  SemanticSavedQuery,
  SemanticHierarchy,
  SemanticTreeNode,
  SemanticObjectDetail,
  BlockStudioCatalog,
  BlockStudioOpenPayload,
  BlockStudioPreview,
  BlockStudioValidation,
  BlockStudioImportSession,
  BlockStudioImportSessionSummary,
  BlockStudioImportCandidate,
  DqlGenerationSession,
  DqlGenerationCandidate,
  BlockSimilarityMatch,
  DqlCandidateRecommendedAction,
  BlockStudioDbtStatus,
  SemanticLayerDiagnostics,
  AppSummary,
  ActivePersona,
  ProposeReadiness,
  ProposeGenerateResult,
  ProposePlanCandidate,
  AiBuildResult,
  AiBuildTarget,
  AiBuildMode,
  Skill,
  Domain,
} from '../store/types';

const EMPTY_PLAN = {
  totals: { modelsScanned: 0, businessModels: 0, plumbingExcluded: 0, metricsFound: 0 },
  willGenerate: 0,
  willSkip: 0,
  domains: [],
  config: {
    businessLayers: [],
    excludeLayers: [],
    maxPerDomain: 0,
    minScore: 0,
    aiEnrichment: 'auto' as const,
  },
};

export interface GitGovernedContextGroup {
  total: number;
  tracked: number;
  changed: number;
  untracked: number;
  ignored: number;
  paths: Array<{ path: string; state: 'tracked' | 'changed' | 'untracked' | 'ignored' }>;
}

function emptyGitGovernedContextGroup(): GitGovernedContextGroup {
  return { total: 0, tracked: 0, changed: 0, untracked: 0, ignored: 0, paths: [] };
}

// ── Apps API types ───────────────────────────────────────────────────────

export interface AppDocumentSummary {
  app: {
    id: string;
    name: string;
    description?: string;
    domain: string;
    subdomain?: string;
    groups?: string[];
    visibility?: 'shared' | 'private' | 'template';
    audience?: string;
    lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
    owners: string[];
    tags?: string[];
    notebooks?: Array<{
      path: string;
      title?: string;
      role: 'source' | 'analysis' | 'supporting';
      visibility: 'shared' | 'private' | 'template';
    }>;
    members: Array<{
      userId: string;
      displayName?: string;
      roles: string[];
      attributes?: Record<string, string | number | boolean>;
    }>;
    roles: Array<{ id: string; displayName?: string; description?: string }>;
    policies: Array<{
      id: string;
      domain: string;
      minClassification: 'public' | 'internal' | 'confidential' | 'restricted';
      allowedRoles: string[];
      allowedUsers?: string[];
      accessLevel: 'read' | 'write' | 'execute' | 'admin';
      enabled?: boolean;
    }>;
    rlsBindings?: Array<{ role: string; variable: string; from: string }>;
    schedules?: Array<{
      id: string;
      cron: string;
      dashboard: string;
      deliver: Array<
        | { kind: 'slack'; channel: string }
        | { kind: 'email'; to: string[] }
        | { kind: 'webhook'; url: string }
      >;
      enabled?: boolean;
    }>;
    homepage?: { type: 'dashboard'; id: string } | { type: 'notebook'; path: string };
  };
  dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }>;
  notebooks?: Array<{ path: string; title?: string; role: 'source' | 'analysis' | 'supporting'; visibility: 'shared' | 'private' | 'template' }>;
  drafts?: Array<{ path: string; name: string; reviewStatus?: string }>;
  aiPins?: LocalAiPin[];
  investigations?: LocalAppInvestigation[];
}

export type DashboardDisplayMetadata = {
  mode: 'manual' | 'ai_generated' | 'block_hint';
  component:
    | 'BusinessBrief'
    | 'KpiMetric'
    | 'TrendPanel'
    | 'RankingPanel'
    | 'EvidenceTable'
    | 'PivotTable'
    | 'TrustCallout'
    | 'NarrativePanel'
    | 'ResearchActions';
  defaultVisualization: string;
  allowedVisualizations: string[];
  fieldHints?: Record<string, string>;
  layoutIntent: 'auto' | 'compact' | 'standard' | 'wide' | 'tall' | 'full';
  rationale: string;
  trustState: 'certified' | 'review_required' | 'draft_ready';
  reviewStatus: 'certified' | 'draft_ready' | 'review_required';
};

export interface DbtFirstModelingResponse {
  manifestVersion: 3;
  dbtProvenance: ManifestDbtProvenance;
  modeling: ManifestDbtFirstModeling;
  lineage: ManifestLineage;
  diagnostics: ManifestDiagnostic[];
}

export interface ModelingApplyResponse {
  applied: ModelingChangePreview;
  modeling: ManifestDbtFirstModeling;
  diagnostics: ManifestDiagnostic[];
}

export type DashboardTileFilterBinding = {
  filter: string;
  binding?: string;
  mode?: 'parameter' | 'predicate';
  paramNames?: string[];
  required?: boolean;
  unsupportedReason?: string;
};

export type DashboardTileParameterBinding = {
  param: string;
  source: 'dashboard_filter' | 'constant' | 'persona' | 'variable';
  filter?: string;
  field?: string;
  value?: unknown;
};

export type DashboardTileSourceEvidence = {
  source: string;
  reason: string;
  kind?: string;
  nodeId?: string;
  path?: string;
  trustState?: DashboardDisplayMetadata['trustState'];
};

export type VisualizationRecommendationResponse =
  | {
      ok: true;
      display: DashboardDisplayMetadata;
      evidence: Array<{ source: string; reason: string }>;
      warnings: string[];
    }
  | { ok: false; error: string };

export type NotebookResearchIntent =
  | 'ad_hoc_analysis'
  | 'diagnose_change'
  | 'driver_breakdown'
  | 'segment_compare'
  | 'entity_drilldown'
  | 'anomaly_investigation'
  | 'trust_gap_review';

export type NotebookResearchStatus = 'draft' | 'running' | 'ready' | 'error';
export type NotebookResearchReviewStatus = 'needs_review' | 'draft_created' | 'completed' | 'certified' | 'rejected';
export type NotebookResearchDqlPromotionAction = 'reuse_existing' | 'extend_existing' | 'create_replacement' | 'create_new' | 'review_required';
export type NotebookResearchReadinessFilter = 'draft_ready' | 'certification_ready' | 'blocked';
export type NotebookResearchAgeFilter = 'stale_open' | 'expired_open';
export type NotebookResearchSort = 'priority' | 'updated_desc';
export interface NotebookResearchSourceCellPayload {
  id?: string;
  sourceCellId?: string;
  cellId?: string;
  name?: string;
  sourceCellName?: string;
  title?: string;
  fingerprint?: string;
  sourceCellFingerprint?: string;
  sqlFingerprint?: string;
  type?: string;
  sql?: string;
  content?: string;
  source?: string;
}
export type NotebookResearchNextActionFilter =
  | 'fix_blockers'
  | 'review_sql'
  | 'review_context'
  | 'run_preview'
  | 'reuse_existing'
  | 'create_dql_draft'
  | 'open_certification'
  | 'complete_review'
  | 'continue_review';

export interface NotebookResearchDqlPromotionCandidate {
  id: string;
  name: string;
  domain?: string;
  draftPath?: string;
  savedPath?: string;
  reviewStatus?: string;
  recommendedAction?: DqlCandidateRecommendedAction | string;
  similarityMatches: BlockSimilarityMatch[];
  parameterPolicy: Array<{ name: string; policy: string }>;
  allowedFilters: string[];
  warnings: string[];
}

export interface NotebookResearchDqlPromotion {
  importId: string;
  candidateIds: string[];
  draftBlockPath?: string;
  recommendedAction?: DqlCandidateRecommendedAction | string;
  similarityMatches: BlockSimilarityMatch[];
  candidates: NotebookResearchDqlPromotionCandidate[];
  createdAt: string;
}

export interface NotebookResearchReuseCheckResponse {
  run: NotebookResearchRun;
  promotion: NotebookResearchDqlPromotion;
  match: {
    parameterDecisions: DqlGenerationCandidate['parameterDecisions'];
    parameterPolicy: DqlGenerationCandidate['parameterPolicy'];
    filterBindings: DqlGenerationCandidate['filterBindings'];
    allowedFilters: string[];
    parameterizedSql: string;
    similarityMatches: DqlGenerationCandidate['similarityMatches'];
    recommendedAction: DqlGenerationCandidate['recommendedAction'];
  };
}

export interface NotebookResearchReviewChecklist {
  readyForDqlDraft: boolean;
  readyForCertificationReview: boolean;
  blockers: string[];
  warnings: string[];
  items: Array<{
    id: string;
    label: string;
    status: 'passed' | 'pending' | 'warning' | 'blocked';
    detail: string;
  }>;
}

export interface NotebookResearchPlan {
  sqlState: 'missing' | 'generated' | 'reviewed';
  grain?: string;
  parameterPolicy: Array<{ name: string; policy: string }>;
  allowedFilters: string[];
  evidence: {
    trustLabel?: string;
    contextPackId?: string;
    evidenceCount: number;
    relationCount: number;
    missingContextCount: number;
  };
  preview: {
    status: 'not_run' | 'ready' | 'error';
    rowCount?: number;
  };
  promotion: {
    path: 'needs_sql' | 'review_context' | 'run_preview' | 'reuse_existing' | 'create_dql_draft' | 'open_certification' | 'complete_review';
    duplicateDecision?: string;
  };
  reviewFocus: string[];
  generatedAt: string;
}

export interface NotebookResearchRun {
  id: string;
  notebookPath: string;
  domain?: string;
  owner?: string;
  sourceCellId?: string;
  sourceCellName?: string;
  sourceCellFingerprint?: string;
  title: string;
  question: string;
  intent: NotebookResearchIntent;
  context?: unknown;
  status: NotebookResearchStatus;
  summary?: string;
  recommendation?: string;
  resultPreview?: QueryResult;
  evidence?: unknown;
  researchPlan?: NotebookResearchPlan;
  generatedSql?: string;
  reviewedSql?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  display?: DashboardDisplayMetadata;
  contextPackId?: string;
  routeDecision?: unknown;
  warnings: string[];
  reviewStatus: NotebookResearchReviewStatus;
  error?: string;
  draftBlockPath?: string;
  dqlImportId?: string;
  dqlCandidateIds: string[];
  dqlPromotionAction?: NotebookResearchDqlPromotionAction;
  dqlPromotion?: NotebookResearchDqlPromotion;
  reviewChecklist?: NotebookResearchReviewChecklist;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface NotebookResearchListResponse {
  runs: NotebookResearchRun[];
  total: number;
  domains: Array<{
    domain: string;
    total: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    nextAction?: NotebookResearchNextActionFilter;
    nextActionCount?: number;
  }>;
  owners: Array<{
    owner: string;
    total: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    nextAction?: NotebookResearchNextActionFilter;
    nextActionCount?: number;
  }>;
  intents: Array<{
    intent: NotebookResearchIntent;
    total: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    nextAction?: NotebookResearchNextActionFilter;
    nextActionCount?: number;
  }>;
  notebooks: Array<{
    path: string;
    title: string;
    total: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    nextAction?: NotebookResearchNextActionFilter;
    nextActionCount?: number;
  }>;
  counts: {
    total: number;
    ready: number;
    needsReview: number;
    dqlDrafts: number;
    errors: number;
    reuseExisting: number;
    extendExisting: number;
    replacements: number;
    createNew: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    sourceLinked: number;
    nextActions: Record<NotebookResearchNextActionFilter, number>;
  };
  groupCounts: {
    domains: number;
    owners: number;
    intents: number;
    notebooks: number;
  };
  reviewMetrics: {
    totalReviewCount: number;
    openReviewCount: number;
    terminalReviewCount: number;
    draftCreatedCount: number;
    certifiedCount: number;
    completedCount: number;
    rejectedCount: number;
    draftCreationRate: number | null;
    certifyConversionRate: number | null;
    medianOpenReviewAgeMs: number | null;
    medianTimeToDraftMs: number | null;
    medianTimeToCertificationMs: number | null;
    medianTimeToTerminalMs: number | null;
  };
  limit?: number;
  offset: number;
}

export type AgentRunRequestedMode = 'auto' | 'ask' | 'research' | 'sql' | 'block' | 'app';
export type AgentRunRoute =
  | 'conversation'
  | 'certified_answer'
  | 'semantic_answer'
  | 'generated_answer'
  | 'research'
  | 'sql_cell'
  | 'dql_block_draft'
  | 'app_build'
  | 'clarify'
  | 'blocked';
export type AgentRunAnswerKind = 'governed' | 'conversational' | 'general_knowledge';
export type AgentRunStatus = 'completed' | 'needs_review' | 'needs_clarification' | 'blocked';
export type AgentRunTrustState = 'certified' | 'governed' | 'grounded' | 'review_required' | 'blocked' | 'not_applicable';
export type AgentRunStopReason =
  | 'conversational_reply'
  | 'certified_answer_found'
  | 'governed_semantic_answer'
  | 'generated_review_required'
  | 'artifact_created'
  | 'needs_clarification'
  | 'human_review_required'
  | 'blocked';
export type AgentRunArtifactKind = 'answer' | 'research_run' | 'sql_cell' | 'dql_block_draft' | 'app_draft' | 'app_proposal';

export interface MixedSourceNotebookPlan {
  datasetId?: string;
  datasetName?: string;
  localDataset: string;
  localAlias: string;
  localKey: string;
  warehouseKey: string;
  warehouseExpression: string;
  warehouseSql: string;
  warehouseRelations?: string[];
}
export type AgentRunEvaluationSeverity = 'info' | 'warning' | 'blocking';

export interface AgentRunSelectedObject {
  kind: 'notebook' | 'cell' | 'block' | 'app' | 'dashboard' | 'research' | 'workspace';
  id?: string;
  title?: string;
  path?: string;
}

export interface AgentRunRepairAction {
  kind: 'retry' | 'escalate';
  route?: AgentRunRoute;
  hint?: string;
}

export interface AgentRunEvaluation {
  id: string;
  label: string;
  passed: boolean;
  severity: AgentRunEvaluationSeverity;
  message: string;
  evidence?: unknown;
  suggestedRepair?: string;
  repairAction?: AgentRunRepairAction;
}

export type AgentRunStepStatus =
  | 'passed'
  | 'repaired'
  | 'needs_review'
  | 'escalated'
  | 'clarify'
  | 'blocked';

export interface AgentRunPlannedStep {
  id: string;
  route: AgentRunRoute;
  goal: string;
  successCriteria: string[];
}

export interface AgentRunPlan {
  source: 'llm' | 'deterministic';
  rationale: string;
  steps: AgentRunPlannedStep[];
}

export interface AgentRunStep {
  id: string;
  index: number;
  route: AgentRunRoute;
  goal: string;
  successCriteria: string[];
  status: AgentRunStepStatus;
  attempts: number;
  summary?: string;
  evaluations: AgentRunEvaluation[];
  artifacts: AgentRunArtifact[];
}

export interface AgentRunArtifact {
  id: string;
  kind: AgentRunArtifactKind;
  title: string;
  trustState: AgentRunTrustState;
  ref?: string;
  payload?: unknown;
}

export interface AgentRunNextAction {
  id: string;
  label: string;
  route?: AgentRunRoute;
  artifactKind?: AgentRunArtifactKind;
}

export interface AgentRunEvent {
  id: string;
  runId: string;
  type:
    | 'run.started'
    | 'plan.created'
    | 'step.started'
    | 'route.decided'
    | 'executor.started'
    | 'evaluation.recorded'
    | 'replan.decided'
    | 'repair.attempted'
    | 'escalated'
    | 'artifact.created'
    | 'step.completed'
    | 'run.completed'
    | 'run.failed';
  at: string;
  message: string;
  route?: AgentRunRoute;
  status?: AgentRunStatus;
  trustState?: AgentRunTrustState;
  payload?: unknown;
}

export interface AgentRun {
  id: string;
  question: string;
  requestedMode: AgentRunRequestedMode;
  route: AgentRunRoute;
  status: AgentRunStatus;
  trustState: AgentRunTrustState;
  stopReason: AgentRunStopReason;
  startedAt: string;
  completedAt: string;
  selectedObject?: AgentRunSelectedObject;
  routeDecision?: unknown;
  plan?: AgentRunPlan;
  steps: AgentRunStep[];
  summary: string;
  answer?: string;
  answerKind?: AgentRunAnswerKind;
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  events: AgentRunEvent[];
  nextActions: AgentRunNextAction[];
  repairAttempts: number;
}

export type AgentRunAudience = 'stakeholder' | 'analyst';

/**
 * The chat-composer "thinking" selection. `auto` (default) lets the engine adapt
 * effort + verification depth to the question shape; the manual modes trade speed
 * against rigor for the whole thread. Sent per run as `thinkingMode`.
 */
export type AgentThinkingMode = 'auto' | 'low' | 'medium' | 'high';

export interface CreateAgentRunInput {
  question: string;
  requestedMode?: AgentRunRequestedMode;
  mode?: AgentRunRequestedMode;
  audience?: AgentRunAudience;
  intent?: string;
  signals?: Record<string, unknown>;
  selectedObject?: AgentRunSelectedObject;
  workspaceContext?: Record<string, unknown>;
  conversationContext?: AgentConversationContext;
  context?: Record<string, unknown>;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /**
   * Server-side conversation thread. When present the server injects prior turns
   * into the conversation context and persists this run as a new turn — the
   * client-built conversationContext stays the no-threadId fallback.
   */
  threadId?: string;
  runId?: string;
  /** The composer's thinking selection for this run (auto/low/medium/high). */
  thinkingMode?: AgentThinkingMode;
}

export interface RequestCertificationInput {
  question: string;
  generatedSql?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  notebookPath?: string;
  domain?: string;
  owner?: string;
  context?: Record<string, unknown>;
}

export interface RequestCertificationResult {
  ok: boolean;
  researchRunId?: string;
  notebookPath?: string;
  error?: string;
}

export interface AgentRunListResponse {
  runs: AgentRun[];
  total: number;
  limit: number;
}

export type AgentRunStreamMessage =
  | { kind: 'event'; event: AgentRunEvent }
  | { kind: 'answer-delta'; delta: string }
  | { kind: 'complete'; run: AgentRun };

// ── Conversation threads (server-side session persistence) ──────────────

export interface AgentConversationThread {
  id: string;
  surface: string;
  title?: string;
  notebookPath?: string;
  rollingSummary?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentConversationTurnResult {
  columns?: string[];
  rowsSample?: unknown[][];
  dimensionValues?: Record<string, string[]>;
  measureColumns?: string[];
  rowCount?: number;
}

/** One persisted question/answer pair in a conversation thread (seq-ordered). */
export interface AgentConversationTurn {
  id: string;
  threadId: string;
  seq: number;
  question: string;
  answerSummary?: string;
  answerText?: string;
  route?: string;
  trustLabel?: string;
  certification?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  sql?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  cascade?: AgentAnswerCascade;
  result?: AgentConversationTurnResult;
  contract?: Record<string, unknown>;
  createdAt: string;
}

export interface NotebookResearchDiagnostics {
  counts: {
    totalRuns: number;
    activeRuns: number;
    closedRuns: number;
    notebooks: number;
    domains: number;
    owners: number;
    sourceLinkedRuns: number;
  };
  health: {
    staleOpenRuns: number;
    expiredOpenRuns: number;
    staleThresholdDays: number;
    expiredThresholdDays: number;
    oldestOpenUpdatedAt?: string;
    newestOpenUpdatedAt?: string;
  };
  search: {
    indexed: boolean;
    indexRows: number;
    indexVersion?: string;
    stale: boolean;
  };
  updatedAt: {
    oldest?: string;
    newest?: string;
  };
  limits: {
    pageSize: number;
    maxPageSize: number;
    sourceCoverageLimit: number;
    seedCellLimit: number;
  };
  warnings: string[];
}

export interface NotebookResearchSeedCellsResponse {
  created: NotebookResearchRun[];
  createdCount: number;
  skippedCount: number;
  limitApplied?: boolean;
}

export interface NotebookResearchSourceCoverageResponse {
  runs: NotebookResearchRun[];
  requestedCount: number;
  matchedCount: number;
  limitApplied?: boolean;
}

export interface NotebookResearchContextPreview {
  contextPackId: string;
  trustLabel?: string;
  routeDecision?: {
    route?: string;
    intent?: string;
    reason?: string;
  };
  evidence: Array<{
    objectKey?: string;
    objectType?: string;
    name: string;
    role?: string;
    reason: string;
  }>;
  summaries: Array<{
    title: string;
    detail: string;
    objectType?: string;
    reason?: string;
  }>;
  relations: Array<{
    relation: string;
    name: string;
    source: string;
    columns: string[];
  }>;
  missingContext: Array<{
    kind: string;
    message: string;
    severity: string;
  }>;
  warnings: string[];
  topRejected: Array<{
    name: string;
    objectType?: string;
    reason: string;
    score?: number;
  }>;
  counts: {
    objects: number;
    evidence: number;
    relations: number;
    warnings: number;
  };
}

export type NotebookResearchUpdateInput =
  Partial<Pick<
    NotebookResearchRun,
    'domain' | 'owner' | 'title' | 'question' | 'intent' | 'context' | 'evidence' | 'contextPackId' | 'routeDecision' | 'generatedSql' | 'reviewedSql' | 'dqlArtifact' | 'warnings' | 'reviewStatus' | 'recommendation' | 'dqlPromotionAction'
  >> & {
    sourceCell?: NotebookResearchSourceCellPayload;
    sourceCellId?: string | null;
    sourceCellName?: string | null;
    sourceCellFingerprint?: string | null;
  };

export interface NotebookExecutionContext {
  notebookPath?: string;
  cellId?: string;
  cellName?: string;
  researchRunId?: string;
  source?: string;
}

export interface DashboardDocumentResponse {
  app: AppDocumentSummary['app'];
  dashboard: {
    version: 1;
    id: string;
    metadata: {
      title: string;
      description?: string;
      domain?: string;
      subdomain?: string;
      groups?: string[];
      audience?: string;
      visibility?: 'shared' | 'private' | 'template';
      lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
      tags?: string[];
      businessOutcome?: string;
      businessOwner?: string;
      decisionUse?: string;
      reviewCadence?: string;
      businessRules?: string[];
      caveats?: string[];
    };
    params?: Array<{ id: string; type: string; default?: unknown; description?: string }>;
    filters?: Array<{ id: string; type: string; default?: unknown; options?: string[]; bindsTo?: string }>;
    /** Story layout sections (optional) — narrated flow for AI-built apps. */
    sections?: Array<{
      id: string;
      title: string;
      kind: 'exec_summary' | 'kpi_band' | 'insight' | 'appendix';
      narrative?: string;
      order: number;
    }>;
    layout: {
      kind: 'grid';
      cols: number;
      rowHeight: number;
      items: Array<{
        i: string;
        x: number; y: number; w: number; h: number;
        block?: { blockId?: string; ref?: string; version?: string };
        text?: { markdown: string };
        aiPin?: { id: string };
        viz: { type: string; options?: Record<string, unknown> };
        display?: DashboardDisplayMetadata;
        filterBindings?: DashboardTileFilterBinding[];
        parameterBindings?: DashboardTileParameterBinding[];
        sourceEvidence?: DashboardTileSourceEvidence[];
        trustState?: DashboardDisplayMetadata['trustState'];
        reviewStatus?: DashboardDisplayMetadata['reviewStatus'];
        title?: string;
        /** Story layout: section membership (optional). */
        sectionId?: string;
      }>;
    };
  };
}

export interface DashboardRunResponse {
  appId: string;
  dashboardId: string;
  persona: unknown;
  tiles: Array<{
    tileId: string;
    status: 'ok' | 'unauthorized' | 'error' | 'unresolved';
    tileType?: 'block' | 'text' | 'aiPin';
    blockId?: string;
    blockPath?: string;
    certificationStatus?: string | null;
    title?: string;
    viz?: { type: string; options?: Record<string, unknown> };
    chartConfig?: Record<string, unknown>;
    result?: QueryResult;
    text?: { markdown: string };
    aiPin?: LocalAiPin;
    filters?: {
      applied: Array<{ filter: string; binding?: string; mode: 'parameter' | 'predicate'; paramNames: string[] }>;
      skipped: Array<{ filter: string; reason: string }>;
    };
    invocation?: {
      resolvedParameters: Array<{
        name: string;
        value: unknown;
        source: 'policy' | 'explicit' | 'question' | 'surface' | 'default';
      }>;
      unresolvedParameters: string[];
      auditId: string;
    };
    citation?: { kind: string; name: string; path?: string };
    error?: string;
  }>;
}

export interface AppBlockRecommendation {
  id: string;
  name: string;
  domain: string;
  status: string;
  owner: string | null;
  tags: string[];
  path: string;
  lastModified: string;
  description: string;
  llmContext?: string | null;
  chartType?: string;
  score: number;
  reasons: string[];
}

export interface CreateAppRequest {
  name: string;
  domain: string;
  dashboardTitle?: string;
  subdomain?: string;
  groups?: string[];
  purpose?: string;
  audience?: string;
  visibility?: 'shared' | 'private' | 'template';
  lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
  tags: string[];
  owners: string[];
  selectedBlockIds: string[];
}

export interface CreateAppResponse {
  ok: true;
  app: AppSummary;
  paths: string[];
  dashboardId: string;
}

export interface GenerateAppRequest {
  prompt: string;
  domain?: string;
  owner?: string;
  force?: boolean;
  selectedBlockIds?: string[];
  plannerMode?: 'deterministic' | 'ai_assisted';
}

export interface GeneratedAppPlan {
  version: 1;
  appId: string;
  name: string;
  prompt: string;
  planning?: {
    plannerMode: 'deterministic' | 'ai_assisted';
    normalizedGoal: string;
    analysisIntent: string;
    audience: string;
    domain: string;
    certifiedContext: Array<{ nodeId: string; name: string; kind: string; reason: string }>;
    missingEvidence: string[];
    scopedReports?: GeneratedAppScopedReport[];
    displayStrategy: string;
    layoutRationale: string;
    handoffPlan: string[];
  };
  skills: Array<{ id: string; title: string; description: string }>;
  domain: string;
  audience: string;
  businessGoal: string;
  stakeholderSummary?: string;
  owner: string;
  lifecycle: 'draft' | 'review';
  tags: string[];
  appSections?: Array<{ id: string; title: string; purpose: string; reviewStatus: 'certified' | 'draft_ready' | 'review_required' }>;
  globalFilters?: Array<{ id: string; label: string; type: string; default?: unknown; bindsTo?: string }>;
  selectedEvidence?: Array<{ source: string; reason: string; kind?: string; nodeId?: string; trustState: string }>;
  missingEvidence?: string[];
  scopedReports?: GeneratedAppScopedReport[];
  /** Plan-preview coverage: how much of the app is certified vs. left as gaps. */
  coverage?: { certifiedTiles: number; gaps: number; ratio: number };
  pages: Array<{
    id: string;
    title: string;
    description?: string;
    filters: Array<{ id: string; label: string; type: string; default?: unknown; bindsTo?: string }>;
    tiles: Array<{
      id: string;
      title: string;
      kind: 'certified_block' | 'draft_placeholder' | 'narrative';
      description?: string;
      blockId?: string;
      sourceNodeId?: string;
      viz: string;
      certification: 'certified' | 'uncertified';
      reviewStatus: 'certified' | 'draft_ready' | 'review_required';
      trustState?: 'certified' | 'draft_ready' | 'review_required';
      filterBindings?: DashboardTileFilterBinding[];
      parameterBindings?: DashboardTileParameterBinding[];
      sourceEvidence?: DashboardTileSourceEvidence[];
      rationale?: string;
      caveats?: string[];
      reviewTasks?: string[];
      display?: {
        role: string;
        recommendedDisplayType: string;
        layoutPriority: number;
        expectedGrain?: string;
        trustState: string;
        followUpActions: string[];
        rationale: string;
        genUi?: {
          version: 1;
          component: string;
          role: string;
          layoutIntent: string;
          defaultVisualization: string;
          allowedVisualizations: string[];
          fieldHints?: Record<string, string>;
          insightTitle: string;
          trustState: string;
          reviewStatus: string;
          sourceNodeId?: string;
          followUpActions: string[];
          rationale: string;
        };
      };
    }>;
  }>;
  caveats: string[];
  reviewTasks: string[];
}

export interface GeneratedAppScopedReport {
  id: string;
  title: string;
  question: string;
  description: string;
  intent: string;
  reviewStatus: 'draft_ready' | 'review_required';
  source: string;
  evidenceNeeded: string[];
  suggestedActions: string[];
}

export interface GenerateAppResponse {
  ok: true;
  plan: GeneratedAppPlan;
  validation: {
    ok: boolean;
    issues: Array<{ level: 'error' | 'warning'; path: string; message: string }>;
    certifiedTiles: number;
    draftTiles: number;
  };
  generated: { paths: string[] };
  app: AppSummary | null;
  dashboardId: string | null;
}

/** One confirmable entry in the pre-create app proposal list. */
export interface AppBuildProposalTile {
  id: string;
  source: 'certified_block' | 'ai_generated';
  title: string;
  description?: string;
  blockId?: string;
  question?: string;
  sql?: string;
  answer?: string;
  viz: string;
  certification: 'certified' | 'ai_generated';
  preview?: { columns: string[]; rows: Array<Record<string, unknown>>; rowCount?: number };
  error?: string;
  selectedByDefault: boolean;
  followUps?: string[];
}

export interface AppBuildProposalGap {
  id: string;
  question: string;
  reason: string;
}

export interface AppBuildProposal {
  tiles: AppBuildProposalTile[];
  gaps: AppBuildProposalGap[];
  followUps: string[];
  coverage: { certifiedTiles: number; generatedTiles: number; gaps: number };
}

export interface AppAiBuildSession {
  id: string;
  /** 'proposed' = plan + proposal saved, no app files yet (awaiting confirm). */
  status: 'proposed' | 'ready' | 'error';
  createdAt: string;
  updatedAt: string;
  prompt: string;
  appId?: string;
  dashboardId?: string | null;
  generatedPaths: string[];
  plan?: GeneratedAppPlan;
  validation?: GenerateAppResponse['validation'];
  proposal?: AppBuildProposal;
  committedTileIds?: string[];
  warnings: string[];
  reviewTasks: string[];
  inputs: {
    domain?: string;
    owner?: string;
    audience?: string;
    notebookPath?: string;
    existingAppId?: string;
    selectedBlockIds: string[];
  };
  error?: string;
}

export type AppAskResponse =
  | {
      ok: true;
      route: 'certified_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer';
      answer: string;
      trustState: DashboardDisplayMetadata['trustState'];
      reviewStatus: DashboardDisplayMetadata['reviewStatus'];
      citations: Array<{ kind: string; name: string; path?: string }>;
      followUps: string[];
      decision: {
        mode: 'answer' | 'analysis' | 'app_change' | 'metadata';
        reason: string;
        nextAction: string;
        requiresContext: boolean;
        usesCertifiedResult: boolean;
        confidence: number;
      };
      investigation?: LocalAppInvestigation;
      proposal?: unknown;
      /** Grounded ReAct research plan (P4): the decision, steps, and follow-up options. */
      researchPlan?: {
        decision: 'answer' | 'clarify' | 'investigate' | 'compose_app';
        confidence: number;
        rationale: string;
        steps: Array<{ thought: string; action: { kind: string; target: string }; expectation: string }>;
        followUp?: { question: string; options: string[] };
        sources: string[];
        done: boolean;
      };
    }
  | { ok: false; error: string };

export interface AppEditorCatalogResponse {
  appId: string;
  defaultDomain: string;
  domains: string[];
  blocks: AppBlockRecommendation[];
}

export interface LocalAiPin {
  id: string;
  appId: string;
  dashboardId: string;
  tileId?: string;
  title: string;
  answer: string;
  question?: string;
  sql?: string;
  sourceTier?: string;
  certification: 'certified' | 'ai_generated';
  reviewStatus: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  refreshCadence: 'none' | 'daily';
  chartConfig?: Record<string, unknown>;
  result?: QueryResult;
  citations?: unknown[];
  analysisPlan?: unknown;
  evidence?: unknown;
  followUps?: string[];
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt?: string;
  lastRefreshError?: string;
  promotedBlockPath?: string;
}

export interface LocalAppInvestigation {
  id: string;
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title: string;
  question: string;
  intent: 'diagnose_change' | 'driver_breakdown' | 'segment_compare' | 'entity_drilldown' | 'anomaly_investigation' | 'trust_gap_review';
  context?: unknown;
  status: 'draft' | 'running' | 'ready' | 'error';
  summary?: string;
  recommendation?: string;
  metrics?: unknown;
  driverCards?: unknown[];
  resultPreviews?: unknown[];
  evidence?: unknown;
  reportSections?: Array<{
    id: string;
    kind: 'executive_answer' | 'business_interpretation' | 'key_numbers' | 'recommended_next_step' | 'review_boundary' | 'validation' | 'reusable_logic' | 'custom';
    title: string;
    body: string;
    tone?: 'answer' | 'insight' | 'warning' | 'review' | 'neutral';
    bullets?: string[];
    evidenceRefs?: string[];
  }>;
  generatedSql?: string;
  reviewStatus: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  error?: string;
  pinnedAiPinId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface AppNotebookCandidate {
  path: string;
  title: string;
  attached: boolean;
  role?: 'source' | 'analysis' | 'supporting';
  visibility?: 'shared' | 'private' | 'template';
  lastModified?: string;
}

export interface AppNotebookPreviewCell {
  id: string;
  type: string;
  name?: string;
  content: string;
  upstream?: string;
  chartConfig?: Record<string, unknown>;
  tableConfig?: Record<string, unknown>;
  singleValueConfig?: Record<string, unknown>;
  pivotConfig?: Record<string, unknown>;
  status?: string;
  result?: QueryResult;
  error?: string;
  executionCount?: number;
  executedAt?: string;
}

export interface AppNotebookPreview {
  path: string;
  title: string;
  metadata?: Record<string, unknown>;
  cells: AppNotebookPreviewCell[];
  snapshotFound?: boolean;
  capturedAt?: string;
}

export interface AppConversationMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  events?: unknown[];
  createdAt?: string;
}

export interface AppConversation {
  id: string;
  appId: string;
  dashboardId?: string;
  notebookPath?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: string;
  context?: AgentConversationContext;
  messages?: AppConversationMessage[];
}

export interface SettingsEnvVar {
  key: string;
  label: string;
  present: boolean;
  optional: boolean;
  description: string;
}

export interface SettingsEnvGroup {
  id: string;
  title: string;
  description: string;
  vars: SettingsEnvVar[];
}

export type ProviderSettingsId = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom-openai' | 'claude-code' | 'codex';
export type ProviderAuthMode = 'api_key' | 'local' | 'subscription_cli';

/** Reasoning-effort ceiling. `'auto'` = agent picks per task up to high; a level caps it. */
export type ReasoningEffortSetting = 'auto' | 'low' | 'medium' | 'high';

export interface ProviderSettings {
  id: ProviderSettingsId;
  label: string;
  enabled: boolean;
  active: boolean;
  hasApiKey: boolean;
  apiKeyPreview?: string;
  baseUrl?: string;
  model?: string;
  source: 'local' | 'env' | 'none';
  envVars: string[];
  /** How the provider authenticates (drives the settings card). */
  authMode?: ProviderAuthMode;
  /** For subscription_cli providers: the CLI binary to install + log into. */
  command?: string;
  /** Reasoning-effort ceiling (`'auto'` when unset). */
  reasoningEffort?: ReasoningEffortSetting;
  /** Whether the configured model exposes a reasoning surface (drives showing the control). */
  supportsReasoningEffort?: boolean;
}

/** Subscription providers that support browser OAuth sign-in. */
export type OAuthProviderId = 'claude' | 'codex';

/** Connection state for a subscription OAuth provider (Claude Pro/Max, ChatGPT Plus/Pro). */
export interface OAuthStatus {
  provider: OAuthProviderId;
  connected: boolean;
  email: string | null;
  models: string[];
  defaultModel: string;
  pending: boolean;
}

/** Live detection for a subscription-CLI provider. */
export interface ProviderCliStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  detail?: string;
}

export interface RemoteMcpEntry {
  kind: 'server' | 'connector';
  name: string;
  url?: string;
  connectorId?: string;
  description?: string;
  authorizationTokenEnv?: string;
  authorizationToken?: string;
  allowedTools?: string[];
  enabled: boolean;
  trusted: boolean;
  deferLoading?: boolean;
  providers?: Array<'openai' | 'anthropic'>;
  hasAuthorizationToken?: boolean;
  authorizationTokenPreview?: string;
}

export interface RemoteMcpSettings {
  path: string;
  entries: RemoteMcpEntry[];
  warnings: string[];
}

export interface AgentMemory {
  id: string;
  scope: 'thread' | 'notebook' | 'project' | 'user' | 'artifact';
  scopeId?: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  importance: number;
  validFrom?: string;
  validTo?: string;
  supersedes?: string;
  lastUsed?: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
}

const BASE = window.location.origin;

function formatRequestError(res: Response, text: string): string {
  const fallback = text.trim() || res.statusText || `HTTP ${res.status}`;
  if (!text.trim()) return fallback;
  try {
    const payload = JSON.parse(text);
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
    if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  } catch {
    // Keep the original response text when the server did not return JSON.
  }
  return fallback;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
    throw new Error(`Unable to reach the local DQL notebook server. Check that it is still running, then retry.${detail}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(formatRequestError(res, text));
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function streamAgentRunResponse(
  res: Response,
  onMessage: (message: AgentRunStreamMessage) => void,
): Promise<AgentRun> {
  if (!res.body) throw new Error('Agent run stream is not available in this browser.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: AgentRun | undefined;

  const consumeBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const payload = JSON.parse(dataLines.join('\n'));
    if (eventName === 'agent-run-event') {
      onMessage({ kind: 'event', event: payload as AgentRunEvent });
    } else if (eventName === 'agent-run-answer-delta') {
      const delta = typeof payload?.delta === 'string' ? payload.delta : '';
      if (delta) onMessage({ kind: 'answer-delta', delta });
    } else if (eventName === 'agent-run-complete') {
      completed = payload as AgentRun;
      onMessage({ kind: 'complete', run: completed });
    } else if (eventName === 'agent-run-error') {
      throw new Error(typeof payload?.error === 'string' ? payload.error : 'Agent run failed.');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(buffer[separator] === '\r' ? separator + 4 : separator + 2);
        consumeBlock(block);
        separator = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (!completed) throw new Error('Agent run stream ended before completion.');
  return completed;
}

function normalizeQueryResultPayload(raw: any): QueryResult {
  const columns: string[] = Array.isArray(raw?.columns)
    ? raw.columns.map((c: unknown) =>
        typeof c === 'string' ? c : typeof (c as any)?.name === 'string' ? (c as any).name : String(c)
      )
    : [];
  const semanticRefs = raw?.semanticRefs && typeof raw.semanticRefs === 'object'
    ? {
        metrics: Array.isArray(raw.semanticRefs.metrics) ? raw.semanticRefs.metrics.map(String) : [],
        dimensions: Array.isArray(raw.semanticRefs.dimensions) ? raw.semanticRefs.dimensions.map(String) : [],
      }
    : undefined;
  return {
    columns,
    rows: Array.isArray(raw?.rows) ? raw.rows : [],
    rowCount: raw?.rowCount ?? raw?.rows?.length ?? 0,
    executionTime: raw?.executionTime ?? raw?.executionTimeMs ?? 0,
    ...(semanticRefs ? { semanticRefs } : {}),
  };
}

function normalizeNotebookResearchRun(raw: NotebookResearchRun): NotebookResearchRun {
  const resultPreview = raw?.resultPreview && typeof raw.resultPreview === 'object'
    ? normalizeQueryResultPayload(raw.resultPreview)
    : undefined;
  return {
    ...raw,
    domain: typeof raw?.domain === 'string' && raw.domain.trim() ? raw.domain : undefined,
    owner: typeof raw?.owner === 'string' && raw.owner.trim() ? raw.owner : undefined,
    warnings: Array.isArray(raw?.warnings) ? raw.warnings : [],
    dqlCandidateIds: Array.isArray(raw?.dqlCandidateIds) ? raw.dqlCandidateIds : [],
    dqlArtifact: normalizeDqlArtifactReference(raw?.dqlArtifact),
    dqlPromotionAction: normalizeNotebookPromotionAction(raw?.dqlPromotionAction ?? raw?.dqlPromotion?.recommendedAction),
    dqlPromotion: normalizeNotebookDqlPromotion(raw?.dqlPromotion),
    researchPlan: normalizeNotebookResearchPlan(raw?.researchPlan),
    reviewChecklist: normalizeNotebookResearchChecklist(raw?.reviewChecklist, raw),
    ...(resultPreview ? { resultPreview } : { resultPreview: undefined }),
  };
}

function normalizeNotebookResearchPlan(raw: unknown): NotebookResearchPlan | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const evidence = record.evidence && typeof record.evidence === 'object' && !Array.isArray(record.evidence)
    ? record.evidence as Record<string, unknown>
    : {};
  const preview = record.preview && typeof record.preview === 'object' && !Array.isArray(record.preview)
    ? record.preview as Record<string, unknown>
    : {};
  const promotion = record.promotion && typeof record.promotion === 'object' && !Array.isArray(record.promotion)
    ? record.promotion as Record<string, unknown>
    : {};
  const sqlState = record.sqlState === 'generated' || record.sqlState === 'reviewed' ? record.sqlState : 'missing';
  const previewStatus = preview.status === 'ready' || preview.status === 'error' ? preview.status : 'not_run';
  const promotionPath = promotion.path === 'review_context'
    || promotion.path === 'run_preview'
    || promotion.path === 'reuse_existing'
    || promotion.path === 'create_dql_draft'
    || promotion.path === 'open_certification'
    || promotion.path === 'complete_review'
    ? promotion.path
    : 'needs_sql';
  const rowCount = typeof preview.rowCount === 'number' && Number.isFinite(preview.rowCount) ? preview.rowCount : undefined;
  return {
    sqlState,
    grain: typeof record.grain === 'string' && record.grain.trim() ? record.grain : undefined,
    parameterPolicy: normalizeParameterPolicy(record.parameterPolicy),
    allowedFilters: Array.isArray(record.allowedFilters) ? record.allowedFilters.map(String).filter(Boolean) : [],
    evidence: {
      trustLabel: typeof evidence.trustLabel === 'string' && evidence.trustLabel.trim() ? evidence.trustLabel : undefined,
      contextPackId: typeof evidence.contextPackId === 'string' && evidence.contextPackId.trim() ? evidence.contextPackId : undefined,
      evidenceCount: finiteCount(evidence.evidenceCount),
      relationCount: finiteCount(evidence.relationCount),
      missingContextCount: finiteCount(evidence.missingContextCount),
    },
    preview: {
      status: previewStatus,
      ...(rowCount === undefined ? {} : { rowCount }),
    },
    promotion: {
      path: promotionPath,
      duplicateDecision: typeof promotion.duplicateDecision === 'string' && promotion.duplicateDecision.trim() ? promotion.duplicateDecision : undefined,
    },
    reviewFocus: Array.isArray(record.reviewFocus) ? record.reviewFocus.map(String).filter(Boolean) : [],
    generatedAt: typeof record.generatedAt === 'string' && record.generatedAt.trim() ? record.generatedAt : new Date(0).toISOString(),
  };
}

function normalizeParameterPolicy(value: unknown): Array<{ name: string; policy: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Array<{ name: string; policy: string }> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name : undefined;
    const policy = typeof record.policy === 'string' && record.policy.trim() ? record.policy : undefined;
    return name && policy ? [{ name, policy }] : [];
  });
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeNotebookResearchReviewMetrics(value: unknown): NotebookResearchListResponse['reviewMetrics'] {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    totalReviewCount: finiteCount(raw.totalReviewCount),
    openReviewCount: finiteCount(raw.openReviewCount),
    terminalReviewCount: finiteCount(raw.terminalReviewCount),
    draftCreatedCount: finiteCount(raw.draftCreatedCount),
    certifiedCount: finiteCount(raw.certifiedCount),
    completedCount: finiteCount(raw.completedCount),
    rejectedCount: finiteCount(raw.rejectedCount),
    draftCreationRate: nullableFiniteNumber(raw.draftCreationRate),
    certifyConversionRate: nullableFiniteNumber(raw.certifyConversionRate),
    medianOpenReviewAgeMs: nullableFiniteNumber(raw.medianOpenReviewAgeMs),
    medianTimeToDraftMs: nullableFiniteNumber(raw.medianTimeToDraftMs),
    medianTimeToCertificationMs: nullableFiniteNumber(raw.medianTimeToCertificationMs),
    medianTimeToTerminalMs: nullableFiniteNumber(raw.medianTimeToTerminalMs),
  };
}

function normalizeNotebookResearchDiagnostics(raw: NotebookResearchDiagnostics): NotebookResearchDiagnostics {
  const record = raw && typeof raw === 'object' ? raw : {} as NotebookResearchDiagnostics;
  const counts = record.counts && typeof record.counts === 'object' ? record.counts : {} as NotebookResearchDiagnostics['counts'];
  const health = record.health && typeof record.health === 'object' ? record.health as Record<string, unknown> : {};
  const search = record.search && typeof record.search === 'object' ? record.search : {} as NotebookResearchDiagnostics['search'];
  const updatedAt = record.updatedAt && typeof record.updatedAt === 'object' ? record.updatedAt as Record<string, unknown> : {};
  const limits = record.limits && typeof record.limits === 'object' ? record.limits : {} as NotebookResearchDiagnostics['limits'];
  return {
    counts: {
      totalRuns: finiteCount(counts.totalRuns),
      activeRuns: finiteCount(counts.activeRuns),
      closedRuns: finiteCount(counts.closedRuns),
      notebooks: finiteCount(counts.notebooks),
      domains: finiteCount(counts.domains),
      owners: finiteCount(counts.owners),
      sourceLinkedRuns: finiteCount(counts.sourceLinkedRuns),
    },
    health: {
      staleOpenRuns: finiteCount(health.staleOpenRuns),
      expiredOpenRuns: finiteCount(health.expiredOpenRuns),
      staleThresholdDays: finiteCount(health.staleThresholdDays) || 7,
      expiredThresholdDays: finiteCount(health.expiredThresholdDays) || 30,
      oldestOpenUpdatedAt: typeof health.oldestOpenUpdatedAt === 'string' && health.oldestOpenUpdatedAt.trim() ? health.oldestOpenUpdatedAt : undefined,
      newestOpenUpdatedAt: typeof health.newestOpenUpdatedAt === 'string' && health.newestOpenUpdatedAt.trim() ? health.newestOpenUpdatedAt : undefined,
    },
    search: {
      indexed: search.indexed === true,
      indexRows: finiteCount(search.indexRows),
      indexVersion: typeof search.indexVersion === 'string' && search.indexVersion.trim() ? search.indexVersion : undefined,
      stale: search.stale === true,
    },
    updatedAt: {
      oldest: typeof updatedAt.oldest === 'string' && updatedAt.oldest.trim() ? updatedAt.oldest : undefined,
      newest: typeof updatedAt.newest === 'string' && updatedAt.newest.trim() ? updatedAt.newest : undefined,
    },
    limits: {
      pageSize: finiteCount(limits.pageSize) || 25,
      maxPageSize: finiteCount(limits.maxPageSize) || 500,
      sourceCoverageLimit: finiteCount(limits.sourceCoverageLimit) || 10_000,
      seedCellLimit: finiteCount(limits.seedCellLimit) || 1_000,
    },
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : [],
  };
}

function normalizeNotebookResearchIntent(value: unknown): NotebookResearchIntent {
  return value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
    ? value
    : 'ad_hoc_analysis';
}

function notebookTitleFromPath(value: unknown): string {
  const path = typeof value === 'string' ? value : '';
  const file = path.split(/[\\/]/).pop() ?? path;
  return file
    .replace(/\.dqlnb$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    || 'Untitled notebook';
}

function normalizeNotebookResearchNextActionCounts(value: unknown): Record<NotebookResearchNextActionFilter, number> {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const read = (key: NotebookResearchNextActionFilter) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] as number : 0;
  return {
    fix_blockers: read('fix_blockers'),
    review_sql: read('review_sql'),
    review_context: read('review_context'),
    run_preview: read('run_preview'),
    reuse_existing: read('reuse_existing'),
    create_dql_draft: read('create_dql_draft'),
    open_certification: read('open_certification'),
    complete_review: read('complete_review'),
    continue_review: read('continue_review'),
  };
}

function normalizeNotebookResearchNextAction(value: unknown): NotebookResearchNextActionFilter | undefined {
  return value === 'fix_blockers'
    || value === 'review_sql'
    || value === 'review_context'
    || value === 'run_preview'
    || value === 'reuse_existing'
    || value === 'create_dql_draft'
    || value === 'open_certification'
    || value === 'complete_review'
    || value === 'continue_review'
    ? value
    : undefined;
}

function normalizeNotebookResearchChecklist(raw: NotebookResearchReviewChecklist | undefined, run: NotebookResearchRun): NotebookResearchReviewChecklist {
  if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
    return {
      readyForDqlDraft: raw.readyForDqlDraft === true,
      readyForCertificationReview: raw.readyForCertificationReview === true,
      blockers: Array.isArray(raw.blockers) ? raw.blockers.filter((item): item is string => typeof item === 'string') : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((item): item is string => typeof item === 'string') : [],
      items: raw.items.map((item) => ({
        id: typeof item.id === 'string' ? item.id : 'item',
        label: typeof item.label === 'string' ? item.label : 'Review item',
        status: item.status === 'passed' || item.status === 'pending' || item.status === 'warning' || item.status === 'blocked' ? item.status : 'pending',
        detail: typeof item.detail === 'string' ? item.detail : '',
      })),
    };
  }
  const hasReviewedSql = Boolean(run.reviewedSql);
  const hasSql = hasReviewedSql || Boolean(run.generatedSql);
  const previewRowCount = run.resultPreview?.rowCount ?? run.resultPreview?.rows.length ?? 0;
  const hasPreview = Boolean(run.resultPreview && (run.resultPreview.columns.length > 0 || previewRowCount > 0));
  const hasDraft = Boolean(run.draftBlockPath);
  const hasEvidence = Boolean(run.contextPackId || run.evidence);
  const reuseExisting = run.dqlPromotionAction === 'reuse_existing';
  return {
    readyForDqlDraft: Boolean(!reuseExisting && run.question && hasReviewedSql && hasEvidence && run.status !== 'error'),
    readyForCertificationReview: Boolean(!reuseExisting && run.question && hasReviewedSql && hasEvidence && hasPreview && hasDraft),
    blockers: run.status === 'error' ? [run.error ?? 'Preview failed.'] : [],
    warnings: hasPreview || reuseExisting ? [] : ['Run a bounded preview before certification review.'],
    items: [
      { id: 'question', label: 'Question', status: run.question ? 'passed' : 'blocked', detail: run.question ? 'Business question is captured.' : 'Add a business question.' },
      {
        id: 'sql',
        label: 'Reviewed SQL',
        status: hasSql || reuseExisting ? 'passed' : 'blocked',
        detail: reuseExisting && !hasSql ? 'Existing DQL should be reused; no new SQL is required.' : hasSql ? 'SQL is available.' : 'Add SQL before promotion.',
      },
      {
        id: 'evidence',
        label: 'Evidence',
        status: hasEvidence || reuseExisting ? 'passed' : 'warning',
        detail: hasEvidence ? 'Context evidence is saved.' : reuseExisting ? 'Reuse evidence is captured in the recommendation.' : 'Preview and save metadata context.',
      },
      {
        id: 'preview',
        label: 'Preview',
        status: hasPreview || reuseExisting ? 'passed' : 'pending',
        detail: hasPreview ? 'Preview result is available.' : reuseExisting ? 'Certified block reuse does not require a new raw SQL preview.' : 'Run a bounded preview.',
      },
      {
        id: 'dql_draft',
        label: 'DQL draft',
        status: hasDraft || reuseExisting ? 'passed' : 'pending',
        detail: hasDraft ? `Draft saved at ${run.draftBlockPath}.` : reuseExisting ? 'No new DQL draft is required.' : 'Create a DQL draft after review.',
      },
    ],
  };
}

function normalizeNotebookResearchContextPreview(raw: NotebookResearchContextPreview): NotebookResearchContextPreview {
  const record = raw && typeof raw === 'object' ? raw : {} as NotebookResearchContextPreview;
  const routeDecision = record.routeDecision && typeof record.routeDecision === 'object'
    ? {
        route: typeof record.routeDecision.route === 'string' ? record.routeDecision.route : undefined,
        intent: typeof record.routeDecision.intent === 'string' ? record.routeDecision.intent : undefined,
        reason: typeof record.routeDecision.reason === 'string' ? record.routeDecision.reason : undefined,
      }
    : undefined;
  return {
    contextPackId: typeof record.contextPackId === 'string' ? record.contextPackId : '',
    trustLabel: typeof record.trustLabel === 'string' ? record.trustLabel : undefined,
    routeDecision,
    evidence: Array.isArray(record.evidence)
      ? record.evidence.map((item) => ({
          objectKey: typeof item.objectKey === 'string' ? item.objectKey : undefined,
          objectType: typeof item.objectType === 'string' ? item.objectType : undefined,
          name: typeof item.name === 'string' ? item.name : 'Evidence',
          role: typeof item.role === 'string' ? item.role : undefined,
          reason: typeof item.reason === 'string' ? item.reason : '',
        }))
      : [],
    summaries: Array.isArray(record.summaries)
      ? record.summaries.map((item) => ({
          title: typeof item.title === 'string' ? item.title : 'Context',
          detail: typeof item.detail === 'string' ? item.detail : '',
          objectType: typeof item.objectType === 'string' ? item.objectType : undefined,
          reason: typeof item.reason === 'string' ? item.reason : undefined,
        }))
      : [],
    relations: Array.isArray(record.relations)
      ? record.relations.map((item) => ({
          relation: typeof item.relation === 'string' ? item.relation : '',
          name: typeof item.name === 'string' ? item.name : 'Relation',
          source: typeof item.source === 'string' ? item.source : '',
          columns: Array.isArray(item.columns) ? item.columns.map(String) : [],
        })).filter((item) => item.relation || item.name)
      : [],
    missingContext: Array.isArray(record.missingContext)
      ? record.missingContext.map((item) => ({
          kind: typeof item.kind === 'string' ? item.kind : 'metadata',
          message: typeof item.message === 'string' ? item.message : '',
          severity: typeof item.severity === 'string' ? item.severity : 'warning',
        })).filter((item) => item.message)
      : [],
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : [],
    topRejected: Array.isArray(record.topRejected)
      ? record.topRejected.map((item) => ({
          name: typeof item.name === 'string' ? item.name : 'Rejected context',
          objectType: typeof item.objectType === 'string' ? item.objectType : undefined,
          reason: typeof item.reason === 'string' ? item.reason : '',
          score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : undefined,
        })).filter((item) => item.reason)
      : [],
    counts: {
      objects: typeof record.counts?.objects === 'number' ? record.counts.objects : 0,
      evidence: typeof record.counts?.evidence === 'number' ? record.counts.evidence : 0,
      relations: typeof record.counts?.relations === 'number' ? record.counts.relations : 0,
      warnings: typeof record.counts?.warnings === 'number' ? record.counts.warnings : 0,
    },
  };
}

function normalizeNotebookPromotionAction(value: unknown): NotebookResearchDqlPromotionAction | undefined {
  return value === 'reuse_existing'
    || value === 'extend_existing'
    || value === 'create_replacement'
    || value === 'create_new'
    || value === 'review_required'
    ? value
    : undefined;
}

function normalizeNotebookDqlPromotion(raw: NotebookResearchDqlPromotion | undefined): NotebookResearchDqlPromotion | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    importId: typeof raw.importId === 'string' ? raw.importId : '',
    candidateIds: Array.isArray(raw.candidateIds) ? raw.candidateIds.filter((item): item is string => typeof item === 'string') : [],
    draftBlockPath: typeof raw.draftBlockPath === 'string' ? raw.draftBlockPath : undefined,
    recommendedAction: typeof raw.recommendedAction === 'string' ? raw.recommendedAction : undefined,
    similarityMatches: Array.isArray(raw.similarityMatches) ? raw.similarityMatches : [],
    candidates: Array.isArray(raw.candidates)
      ? raw.candidates.map((candidate) => ({
          ...candidate,
          similarityMatches: Array.isArray(candidate.similarityMatches) ? candidate.similarityMatches : [],
          parameterPolicy: Array.isArray(candidate.parameterPolicy) ? candidate.parameterPolicy : [],
          allowedFilters: Array.isArray(candidate.allowedFilters) ? candidate.allowedFilters : [],
          warnings: Array.isArray(candidate.warnings) ? candidate.warnings : [],
        }))
      : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

export interface NotebookCellExecutionResponse {
  cellType: string;
  title?: string;
  blockName?: string;
  blockPath?: string;
  chartConfig?: Record<string, unknown>;
  tests?: Array<{ field: string; operator: string; expected: unknown }>;
  result: QueryResult | null;
}

export interface DatasetColumn {
  name: string;
  type: string;
  nullable?: boolean;
  nullCount?: number;
  distinctCount?: number;
  sampleValues?: unknown[];
  flags?: string[];
}

export interface DatasetSource {
  id: string;
  name: string;
  alias: string;
  description?: string;
  owner?: string;
  tags: string[];
  sourcePath: string;
  storageMode: "local" | "project" | "staged";
  format: "csv" | "parquet" | "json";
  fileFingerprint: string;
  sizeBytes: number;
  modifiedAt: string;
  importedAt: string;
  refreshedAt: string;
  trustState:
    | "local_ad_hoc"
    | "project_controlled"
    | "governed_snapshot"
    | "review_required";
  profile: {
    rowCount: number;
    sampledRows: number;
    columns: DatasetColumn[];
    warnings: string[];
    preview: Array<Record<string, unknown>>;
  };
  linked?: boolean;
  pinned?: boolean;
  expiresAt?: string;
  lineage?: Record<string, unknown>;
  schemaDrift?: {
    detectedAt: string;
    added: string[];
    removed: string[];
    changed: Array<{ column: string; before: string; after: string }>;
  };
  schemaOverrides?: Record<string, string>;
}

export const api = {
  /** Read the compiled dbt-first overlay. dbt-owned details stay in dbt artifacts. */
  async getDbtFirstModeling(): Promise<DbtFirstModelingResponse | null> {
    try {
      return await request<DbtFirstModelingResponse>('/api/modeling/dbt-first');
    } catch {
      return null;
    }
  },

  async getDbtModelingNode(uniqueId: string): Promise<DbtNodeAuthoringDetail> {
    return request<DbtNodeAuthoringDetail>(`/api/modeling/dbt-first/nodes/${encodeURIComponent(uniqueId)}`);
  },

  async previewModelingChange(change: ModelingAuthoringChange): Promise<ModelingChangePreview> {
    return request<ModelingChangePreview>('/api/modeling/dbt-first/preview', {
      method: 'POST', body: JSON.stringify({ change }),
    });
  },

  async applyModelingChange(change: ModelingAuthoringChange, fingerprint: string): Promise<ModelingApplyResponse> {
    return request<ModelingApplyResponse>('/api/modeling/dbt-first/apply', {
      method: 'POST', body: JSON.stringify({ change, fingerprint }),
    });
  },

  async validateModelingRelationship(relationship: RelationshipAuthoringInput): Promise<ManifestRelationshipValidationEvidence> {
    const result = await request<{ evidence: ManifestRelationshipValidationEvidence }>('/api/modeling/dbt-first/relationships/validate', {
      method: 'POST', body: JSON.stringify({ relationship }),
    });
    return result.evidence;
  },

  async getSettingsEnvStatus(): Promise<{ groups: SettingsEnvGroup[] }> {
    try {
      return await request<{ groups: SettingsEnvGroup[] }>('/api/settings/env-status');
    } catch {
      return { groups: [] };
    }
  },

  /**
   * Fetch the readiness summary + ranked DRAFT proposals from the propose
   * engine. Read-only preview: the server does not write or certify anything.
   */
  async getProposeReadiness(input?: { owner?: string; limit?: number }): Promise<ProposeReadiness> {
    try {
      return await request<ProposeReadiness>('/api/propose', {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      });
    } catch {
      return {
        ready: false,
        reason: 'Unable to reach the propose engine. Is the local DQL server running?',
        summary: {
          modelsScanned: 0,
          businessModels: 0,
          plumbingExcluded: 0,
          metricsFound: 0,
          proposalsRanked: 0,
          draftsExisting: 0,
          readyForReview: 0,
          blockingTotal: 0,
          warningTotal: 0,
        },
        plan: EMPTY_PLAN,
        proposals: [],
      };
    }
  },

  /**
   * Materialize DRAFT blocks for an APPROVED scope (selected slugs / domains).
   * The only propose call that writes — and only for the business-only selection
   * the human approved. Nothing is ever certified.
   */
  async generateProposeDrafts(input: {
    slugs?: string[];
    domains?: string[];
    owner?: string;
  }): Promise<ProposeGenerateResult> {
    try {
      return await request<ProposeGenerateResult>('/api/propose/generate', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : 'Unable to reach the propose engine.',
        draftsWritten: 0,
        draftsSkipped: 0,
        proposals: [],
      };
    }
  },

  /**
   * Spec 14 (part A) — lazily fetch the transparent preview for a single
   * planned proposal slug: the SQL the draft would run, declared outputs,
   * example questions, and a plain-language Certifier verdict. Read-only;
   * generates/writes nothing. Used by the expandable Get Started rows.
   */
  async proposePreview(slug: string): Promise<{ candidate: ProposePlanCandidate }> {
    return request<{ candidate: ProposePlanCandidate }>(
      `/api/propose/preview?slug=${encodeURIComponent(slug)}`,
    );
  },

  /**
   * Spec 14 (part B) — unified AI Build. Generates SQL/DQL for the user's
   * prompt and returns a clean ARTIFACT, never the Q&A answer loop's internals.
   * The result is discriminated on `target`: a notebook CELL (SQL) or a draft
   * BLOCK (saved at `path`, with metadata + Certifier verdict). Nothing is
   * certified — drafts await a human.
   */
  async aiBuild(input: {
    prompt: string;
    context?: { cellSql?: string; selection?: string };
    target: AiBuildTarget;
    owner?: string;
    // Spec 17 (part A) — 'edit' rewrites an existing block at `blockPath`
    // (so the result can show a before/after diff); 'create' (default) makes a
    // new one. `domain` scopes the build to a first-class domain (part B).
    mode?: AiBuildMode;
    blockPath?: string;
    domain?: string;
  }): Promise<AiBuildResult> {
    return request<AiBuildResult>('/api/ai/build', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
    const raw = await request<{ run: AgentRun }>('/api/agent-runs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return raw.run;
  },

  async createAgentRunStream(
    input: CreateAgentRunInput,
    onMessage: (message: AgentRunStreamMessage) => void,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/agent-runs?stream=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
      throw new Error(`Unable to reach the local DQL notebook server. Check that it is still running, then retry.${detail}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(formatRequestError(res, text));
    }
    return streamAgentRunResponse(res, onMessage);
  },

  async listAgentRuns(input?: { limit?: number }): Promise<AgentRunListResponse> {
    const params = new URLSearchParams();
    if (typeof input?.limit === 'number' && Number.isFinite(input.limit)) {
      params.set('limit', String(input.limit));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<AgentRunListResponse>(`/api/agent-runs${suffix}`);
  },

  async getAgentRun(id: string): Promise<AgentRun> {
    const raw = await request<{ run: AgentRun }>(`/api/agent-runs/${encodeURIComponent(id)}`);
    return raw.run;
  },

  async cancelAgentRun(id: string): Promise<{ ok: boolean; id?: string }> {
    return request<{ ok: boolean; id?: string }>(`/api/agent-runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
  },

  async listAgentThreads(input?: { limit?: number; archived?: boolean }): Promise<{ threads: AgentConversationThread[] }> {
    const params = new URLSearchParams();
    if (typeof input?.limit === 'number' && Number.isFinite(input.limit)) {
      params.set('limit', String(input.limit));
    }
    if (input?.archived) params.set('archived', '1');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<{ threads: AgentConversationThread[] }>(`/api/agent/threads${suffix}`);
  },

  async createAgentThread(input: { surface?: string; title?: string; notebookPath?: string } = {}): Promise<AgentConversationThread> {
    const raw = await request<{ thread: AgentConversationThread }>('/api/agent/threads', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return raw.thread;
  },

  async getAgentThread(id: string): Promise<{
    thread: AgentConversationThread;
    turns: AgentConversationTurn[];
  }> {
    return request<{
      thread: AgentConversationThread;
      turns: AgentConversationTurn[];
    }>(`/api/agent/threads/${encodeURIComponent(id)}`);
  },

  async archiveAgentThread(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/agent/threads/${encodeURIComponent(id)}/archive`, { method: 'POST' });
  },

  /**
   * Stakeholder → analyst handoff: drop a review-required output into the analyst
   * notebook queue as a draft research run for them to build/certify.
   */
  async requestCertification(input: RequestCertificationInput): Promise<RequestCertificationResult> {
    return request<RequestCertificationResult>('/api/agent-runs/request-certification', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /**
   * Spec 14 (part D) — who is drafting. Best-effort identity used to show
   * "drafting as <owner>" where drafts are created. Callers should not block
   * on it (fall back to nothing on failure).
   */
  async getIdentity(): Promise<{ owner: string }> {
    return request<{ owner: string }>('/api/identity');
  },

  async getProviderSettings(): Promise<{ providers: ProviderSettings[] }> {
    try {
      return await request<{ providers: ProviderSettings[] }>('/api/settings/providers');
    } catch {
      return { providers: [] };
    }
  },

  /** Live install/login detection for subscription-CLI providers (Claude Code / Codex). */
  async getProviderCliStatus(): Promise<{ status: Partial<Record<ProviderSettingsId, ProviderCliStatus>> }> {
    try {
      return await request<{ status: Partial<Record<ProviderSettingsId, ProviderCliStatus>> }>('/api/settings/providers/cli-status');
    } catch {
      return { status: {} };
    }
  },

  async saveProviderSettings(input: {
    id: ProviderSettingsId;
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    reasoningEffort?: ReasoningEffortSetting;
  }): Promise<{ ok: boolean; providers: ProviderSettings[] }> {
    return request('/api/settings/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStatus & { url: string }> {
    return request(`/api/auth/${provider}/start`, { method: 'POST' });
  },

  async getOAuthStatus(provider: OAuthProviderId): Promise<OAuthStatus> {
    return request(`/api/auth/${provider}/status`);
  },

  async signOutOAuth(provider: OAuthProviderId): Promise<OAuthStatus> {
    return request(`/api/auth/${provider}/signout`, { method: 'POST' });
  },

  async testProviderSettings(
    id: ProviderSettingsId,
    overrides?: { apiKey?: string; baseUrl?: string; model?: string },
  ): Promise<{ ok: boolean; message: string }> {
    // Never throw: a failed test is a normal result the UI shows inline.
    try {
      return await request<{ ok: boolean; message: string }>('/api/settings/providers/test', {
        method: 'POST',
        body: JSON.stringify({ id, ...overrides }),
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  async getRemoteMcpSettings(): Promise<{ settings: RemoteMcpSettings }> {
    try {
      return await request<{ settings: RemoteMcpSettings }>('/api/settings/mcp');
    } catch {
      return { settings: { path: '', entries: [], warnings: [] } };
    }
  },

  async saveRemoteMcpSettings(entries: RemoteMcpEntry[]): Promise<{ ok: boolean; settings: RemoteMcpSettings }> {
    return request('/api/settings/mcp', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    });
  },

  async listAgentMemory(scope?: AgentMemory['scope']): Promise<{ memories: AgentMemory[] }> {
    const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    try {
      return await request<{ memories: AgentMemory[] }>(`/api/agent/memory${suffix}`);
    } catch {
      return { memories: [] };
    }
  },

  async saveAgentMemory(input: Partial<AgentMemory> & Pick<AgentMemory, 'scope' | 'title' | 'content'>): Promise<{ ok: boolean; memory: AgentMemory }> {
    return request('/api/agent/memory', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async deleteAgentMemory(id: string): Promise<{ ok: boolean }> {
    return request(`/api/agent/memory?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async ensureAgentMemoryFiles(): Promise<{ ok: boolean; files: string[] }> {
    return request('/api/agent/memory/default-files', { method: 'POST' });
  },

  async listNotebooks(): Promise<NotebookFile[]> {
    try {
      return await request<NotebookFile[]>('/api/notebooks');
    } catch {
      // Return empty list gracefully when server is not running
      return [];
    }
  },

  async readNotebook(path: string): Promise<{ content: string }> {
    return request<{ content: string }>(
      `/api/notebook-content?path=${encodeURIComponent(path)}`
    );
  },

  async createNotebook(
    name: string,
    template: string
  ): Promise<{ path: string; content: string }> {
    return request<{ path: string; content: string }>('/api/notebooks', {
      method: 'POST',
      body: JSON.stringify({ name, template }),
    });
  },

  async createBlock(
    name: string,
    options?: {
      blockType?: 'custom' | 'semantic';
      domain?: string;
      description?: string;
      owner?: string;
      tags?: string[];
    },
  ): Promise<{ path: string; content: string }> {
    return request<{ path: string; content: string }>('/api/blocks', {
      method: 'POST',
      body: JSON.stringify({ name, ...options }),
    });
  },

  async getBlockLibrary(): Promise<{
    blocks: Array<{
      name: string; domain: string; status: string;
      owner: string | null; tags: string[]; path: string;
      lastModified: string; description: string;
      llmContext?: string | null;
    }>;
  }> {
    try {
      return await request('/api/blocks/library');
    } catch {
      return { blocks: [] };
    }
  },

  async getApps(): Promise<{
    apps: Array<{
      path: string;
      manifest: {
        name: string;
        domain: string;
        owner?: string;
        description?: string;
        cadence?: string;
        consumers?: string[];
        entryPoints?: string[];
      };
      notebooks: string[];
      dashboards: string[];
      hasDigest: boolean;
    }>;
  }> {
    try {
      return await request('/api/apps');
    } catch {
      return { apps: [] };
    }
  },

  async updateBlockStatus(path: string, newStatus: string): Promise<{ ok: boolean; status?: string; error?: string }> {
    return request('/api/blocks/status', {
      method: 'POST',
      body: JSON.stringify({ path, newStatus }),
    });
  },

  async getBlockHistory(path: string): Promise<{
    entries: Array<{ hash: string; date: string; author: string; message: string }>;
  }> {
    try {
      return await request(`/api/blocks/history?path=${encodeURIComponent(path)}`);
    } catch {
      return { entries: [] };
    }
  },

  async runBlockTests(source: string, path: string | null): Promise<{
    assertions: Array<{ field: string; operator: string; expected: string; passed: boolean; actual?: string }>;
    passed: number;
    failed: number;
    duration: number;
  }> {
    return request('/api/blocks/run-tests', {
      method: 'POST',
      body: JSON.stringify({ source, path }),
    });
  },

  async getBlockStudioCatalog(): Promise<BlockStudioCatalog> {
    return request<BlockStudioCatalog>('/api/block-studio/catalog');
  },

  async getBlockStudioDbtStatus(): Promise<BlockStudioDbtStatus> {
    return request<BlockStudioDbtStatus>('/api/block-studio/dbt-status');
  },

  async openBlockStudio(path: string): Promise<BlockStudioOpenPayload> {
    return request<BlockStudioOpenPayload>(`/api/block-studio/open?path=${encodeURIComponent(path)}`);
  },

  async getBlockBody(path: string): Promise<{ path: string; body: string; commitSha: string | null }> {
    return request<{ path: string; body: string; commitSha: string | null }>(
      `/api/blocks/body?path=${encodeURIComponent(path)}`,
    );
  },

  async validateBlockStudio(source: string, path?: string | null): Promise<BlockStudioValidation> {
    return request<BlockStudioValidation>('/api/block-studio/validate', {
      method: 'POST',
      body: JSON.stringify({ source, path }),
    });
  },

  async runBlockStudio(source: string, path?: string | null, parameters?: Record<string, unknown>): Promise<BlockStudioPreview> {
    return request<BlockStudioPreview>('/api/block-studio/run', {
      method: 'POST',
      body: JSON.stringify({ source, path, parameters }),
    });
  },

  async saveBlockStudio(payload: {
    path?: string | null;
    source: string;
    metadata: {
      name: string;
      domain: string;
      description: string;
      owner: string;
      tags: string[];
      sourceKind?: string;
      sourcePath?: string;
      importId?: string;
      candidateId?: string;
      lineage?: string[];
    };
  }): Promise<BlockStudioOpenPayload> {
    return request<BlockStudioOpenPayload>('/api/block-studio/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewBlockStudioImport(payload: {
    path: string;
    sourceKind?: 'raw-sql' | BlockStudioImportCandidate['sourceKind'];
    inputMode?: 'path' | 'paste' | 'upload';
    sources?: Array<{ path: string; content: string }>;
    domain?: string;
    owner?: string;
    tags?: string[];
  }): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>('/api/block-studio/import/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async listBlockStudioImports(): Promise<{ sessions: BlockStudioImportSessionSummary[] }> {
    return request<{ sessions: BlockStudioImportSessionSummary[] }>('/api/block-studio/imports');
  },

    async createBlockStudioImport(payload: {
      path?: string;
      sourceKind?: 'raw-sql' | BlockStudioImportCandidate['sourceKind'];
    inputMode?: 'path' | 'paste' | 'upload';
    sources?: Array<{ path: string; content: string }>;
    domain?: string;
    owner?: string;
    tags?: string[];
  }): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>('/api/block-studio/imports', {
      method: 'POST',
      body: JSON.stringify(payload),
      });
    },

    async createDqlGenerationSession(payload: {
      path?: string;
      sourceKind?: 'raw-sql' | BlockStudioImportCandidate['sourceKind'];
      inputMode?: 'path' | 'paste' | 'upload';
      sources?: Array<{ path: string; content: string }>;
      domain?: string;
      owner?: string;
      tags?: string[];
      provider?: string;
      async?: boolean;
      persistence?: 'session-only' | 'draft-files';
    }): Promise<DqlGenerationSession> {
      return request<DqlGenerationSession>('/api/block-studio/ai-imports', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    async getDqlGenerationSession(importId: string): Promise<DqlGenerationSession> {
      return request<DqlGenerationSession>(`/api/block-studio/ai-imports/${encodeURIComponent(importId)}`);
    },

  async getBlockStudioImport(importId: string): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>(`/api/block-studio/imports/${encodeURIComponent(importId)}`);
  },

  async deleteBlockStudioImport(importId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}`,
      { method: 'DELETE' },
    );
  },

  async clearBlockStudioImports(): Promise<{ ok: boolean; removed: number }> {
    return request<{ ok: boolean; removed: number }>('/api/block-studio/imports', { method: 'DELETE' });
  },

    async updateBlockStudioImportCandidate(
      importId: string,
      candidateId: string,
      patch: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'terms' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'dimensions' | 'allowedFilters' | 'parameterPolicy' | 'filterBindings' | 'sourceSystems' | 'replacementFor' | 'reviewCadence' | 'sql' | 'reviewStatus' | 'llmContext'>>,
    ): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    },

    async updateDqlGenerationCandidate(
      importId: string,
      candidateId: string,
      patch: Partial<Pick<DqlGenerationCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'terms' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'dimensions' | 'allowedFilters' | 'parameterPolicy' | 'filterBindings' | 'sourceSystems' | 'replacementFor' | 'reviewCadence' | 'sql' | 'llmContext'>>,
    ): Promise<DqlGenerationCandidate> {
      return request<DqlGenerationCandidate>(
        `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
    },

    async matchSqlForBlockReuse(sql: string, options?: { sourcePath?: string; name?: string; domain?: string; owner?: string }): Promise<{
      parameterDecisions: DqlGenerationCandidate['parameterDecisions'];
      parameterPolicy: DqlGenerationCandidate['parameterPolicy'];
      filterBindings: DqlGenerationCandidate['filterBindings'];
      allowedFilters: string[];
      parameterizedSql: string;
      similarityMatches: DqlGenerationCandidate['similarityMatches'];
      recommendedAction: DqlGenerationCandidate['recommendedAction'];
    }> {
      return request('/api/block-studio/match-sql', {
        method: 'POST',
        body: JSON.stringify({ sql, ...(options ?? {}) }),
      });
    },

    async previewDqlGenerationCandidate(importId: string, candidateId: string): Promise<DqlGenerationCandidate> {
      return request<DqlGenerationCandidate>(
        `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/preview`,
        { method: 'POST' },
      );
    },

    async certifyDqlGenerationCandidate(importId: string, candidateId: string): Promise<{ candidate: DqlGenerationCandidate; block: BlockStudioOpenPayload }> {
      return request<{ candidate: DqlGenerationCandidate; block: BlockStudioOpenPayload }>(
        `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/certify`,
        { method: 'POST' },
      );
    },

    async saveSelectedDqlGenerationCandidates(
      importId: string,
      payload: { candidateIds: string[]; owner: string },
    ): Promise<{
      ok: boolean;
      session: DqlGenerationSession;
      results: Array<{
        candidateId: string;
        path?: string;
        status: 'certified' | 'draft' | 'error';
        blockers: string[];
        candidate?: DqlGenerationCandidate;
        block?: BlockStudioOpenPayload;
        error?: string;
      }>;
    }> {
      return request(
        `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/save-selected`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
    },

  async runBlockStudioImportCandidate(importId: string, candidateId: string): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/run`,
      { method: 'POST' },
    );
  },

  async saveBlockStudioImportCandidate(importId: string, candidateId: string): Promise<{ candidate: BlockStudioImportCandidate; block: BlockStudioOpenPayload }> {
    return request<{ candidate: BlockStudioImportCandidate; block: BlockStudioOpenPayload }>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/save`,
      { method: 'POST' },
    );
  },

  async saveAllBlockStudioImportCandidates(importId: string): Promise<{
    ok: boolean;
    session: BlockStudioImportSession;
    saved: Array<{ candidateId: string; path: string }>;
    errors: Array<{ candidateId: string; error: string }>;
  }> {
    return request(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/save-all`,
      { method: 'POST' },
    );
  },

    async assistBlockStudioImportCandidate(importId: string, candidateId: string, action: string): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/ai-assist`,
      { method: 'POST', body: JSON.stringify({ action }) },
    );
    },

    async getSemanticLayerDiagnostics(): Promise<SemanticLayerDiagnostics> {
      return request<SemanticLayerDiagnostics>('/api/semantic-layer/diagnostics');
    },

    async reloadSemanticLayer(): Promise<{ ok: boolean; available: boolean; provider: string | null; errors: string[]; lastSyncTime?: string | null; dbt: BlockStudioDbtStatus }> {
      return request('/api/semantic-layer/reload', { method: 'POST' });
    },

  async certifyBlockStudio(payload: { source: string; path?: string | null }): Promise<{
    ok: boolean;
    status?: string;
    path?: string | null;
    source?: string;
    metadata?: BlockStudioOpenPayload['metadata'];
    companionPath?: string | null;
    validation?: BlockStudioValidation;
    certification: {
      certified: boolean;
      errors: Array<{ rule: string; message: string }>;
      warnings: Array<{ rule: string; message: string }>;
    };
    checklist: {
      metadata: boolean;
      validation: boolean;
      run: boolean;
      tests: boolean;
      chart: boolean;
      lineage: boolean;
      aiReviewed: boolean;
      blockers: string[];
      checkedAt?: string;
    };
    blockers?: string[];
  }> {
    const res = await fetch(`${BASE}/api/block-studio/certify`, {
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({ ok: false, error: res.statusText }));
    if (!res.ok && res.status !== 422) {
      throw new Error(JSON.stringify(body));
    }
    return body;
  },

  async saveAsBlock(payload: {
    cellId: string;
    notebookPath?: string | null;
    name: string;
    domain?: string;
    owner?: string;
    content: string;
    description?: string;
    tags?: string[];
    metricRefs?: string[];
    template?: string;
    llmContext?: string;
    examples?: Array<{ question: string; sql?: string }>;
    invariants?: string[];
    reviewRequired?: boolean;
    datasetRefs?: Cell["datasetRefs"];
    lineage?: Record<string, unknown>;
  }): Promise<{
    path: string;
    content: string;
    status: 'certified' | 'draft';
    blockers: string[];
    certification?: { certified: boolean; errors: unknown[]; warnings: unknown[] };
  }> {
    return request<{
      path: string;
      content: string;
      status: 'certified' | 'draft';
      blockers: string[];
      certification?: { certified: boolean; errors: unknown[]; warnings: unknown[] };
    }>('/api/blocks/save-from-cell', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getBlockTemplates(): Promise<Array<{ id: string; name: string; description: string; content: string }>> {
    try {
      const response = await request<{ templates: Array<{ id: string; name: string; description: string; content: string }> }>(
        '/api/blocks/templates',
      );
      return response.templates;
    } catch {
      return [];
    }
  },

  async listBlocks(domain?: string): Promise<NotebookFile[]> {
    try {
      const files = await request<NotebookFile[]>('/api/notebooks');
      return files.filter((file) => file.type === 'block' && (!domain || file.path.startsWith(`blocks/${domain}/`)));
    } catch {
      return [];
    }
  },

  async saveNotebook(path: string, content: string): Promise<void> {
    return request<void>('/api/notebook-content', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    });
  },

  async executeQuery(
    sql: string,
    signal?: AbortSignal,
    executionContext?: NotebookExecutionContext,
    executionTarget?: Cell["executionTarget"],
  ): Promise<QueryResult> {
    const raw = await request<any>("/api/query", {
      method: "POST",
      body: JSON.stringify({ sql, executionContext, executionTarget }),
      signal,
    });
    return normalizeQueryResultPayload(raw);
  },

  async previewGeneratedSql(sql: string, signal?: AbortSignal): Promise<{ ok: true; result: QueryResult } | { ok: false; error: string }> {
    try {
      const raw = await request<any>('/api/ai/sql-draft/preview', {
        method: 'POST',
        body: JSON.stringify({ sql }),
        signal,
      });
      return { ok: true, result: normalizeQueryResultPayload(raw.result) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async executeNotebookCell(cell: Cell, signal?: AbortSignal, executionContext?: NotebookExecutionContext): Promise<NotebookCellExecutionResponse> {
    const raw = await request<any>('/api/notebook/execute', {
      method: 'POST',
      body: JSON.stringify({
        cell: {
          id: cell.id,
          type: cell.type,
          source: cell.content,
          title: cell.name,
          config: cell.chartConfig,
        },
        executionTarget: cell.executionTarget,
        parameters: cell.blockBinding?.parameterValues,
        executionContext,
      }),
      signal,
    });
    return {
      cellType: String(raw?.cellType ?? cell.type),
      title: typeof raw?.title === 'string' ? raw.title : undefined,
      blockName: typeof raw?.blockName === 'string' ? raw.blockName : undefined,
      blockPath: typeof raw?.blockPath === 'string' ? raw.blockPath : undefined,
      chartConfig: raw?.chartConfig && typeof raw.chartConfig === 'object' ? raw.chartConfig : undefined,
      tests: Array.isArray(raw?.tests) ? raw.tests : undefined,
      result: raw?.result ? normalizeQueryResultPayload(raw.result) : null,
    };
  },

  async getDatasets(): Promise<{
    datasets: DatasetSource[];
    workspace?: { target: "local"; databasePath: string };
  }> {
    return request("/api/datasets");
  },

  async importDataset(input: {
    filename?: string;
    sourcePath?: string;
    contentBase64?: string;
    file?: File;
    storageMode?: "local" | "project";
    link?: boolean;
    name?: string;
    alias?: string;
    description?: string;
    owner?: string;
    tags?: string[];
  }): Promise<{ dataset: DatasetSource; duplicate: boolean }> {
    if (input.file) {
      const form = new FormData();
      form.set("file", input.file, input.file.name);
      for (const [key, value] of Object.entries(input)) {
        if (key === "file" || value === undefined) continue;
        form.set(key, Array.isArray(value) ? value.join(",") : String(value));
      }
      const response = await fetch(`${BASE}/api/datasets/import`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(formatRequestError(response, text));
      }
      return response.json() as Promise<{
        dataset: DatasetSource;
        duplicate: boolean;
      }>;
    }
    return request("/api/datasets/import", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async refreshDataset(id: string): Promise<{ dataset: DatasetSource }> {
    return request(`/api/datasets/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
    });
  },

  async updateDatasetSchema(
    id: string,
    overrides: Record<string, string>,
  ): Promise<{ dataset: DatasetSource }> {
    return request(`/api/datasets/${encodeURIComponent(id)}/schema`, {
      method: "POST",
      body: JSON.stringify({ overrides }),
    });
  },

  async renameDataset(
    id: string,
    name: string,
    alias?: string,
  ): Promise<{ dataset: DatasetSource }> {
    return request(`/api/datasets/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name, alias }),
    });
  },

  async pinDataset(
    id: string,
    pinned = true,
  ): Promise<{ dataset: DatasetSource }> {
    return request(`/api/datasets/${encodeURIComponent(id)}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned }),
    });
  },

  async removeDataset(id: string): Promise<void> {
    await request(`/api/datasets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async stageDataset(input: {
    sql: string;
    connectionName?: string;
    name?: string;
    confirmed: boolean;
    blockPath?: string;
    filters?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  }): Promise<{
    dataset: DatasetSource;
    trustLabel: "review_required";
    limits: Record<string, number>;
  }> {
    return request("/api/datasets/stage", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async listNotebookResearch(
    input?:
      | string
      | {
          path?: string;
          sourceCellId?: string;
          domain?: string;
          owner?: string;
          intent?: NotebookResearchIntent;
          search?: string;
          status?: NotebookResearchStatus;
          reviewStatus?: NotebookResearchReviewStatus;
          promotionAction?: NotebookResearchDqlPromotionAction;
          readiness?: NotebookResearchReadinessFilter;
          age?: NotebookResearchAgeFilter;
          nextAction?: NotebookResearchNextActionFilter;
          activeOnly?: boolean;
          sort?: NotebookResearchSort;
          limit?: number;
          offset?: number;
        },
  ): Promise<NotebookResearchListResponse> {
    const params = new URLSearchParams();
    if (typeof input === 'string') {
      if (input) params.set('path', input);
    } else if (input) {
      if (input.path) params.set('path', input.path);
      if (input.sourceCellId) params.set('sourceCellId', input.sourceCellId);
      if (input.domain) params.set('domain', input.domain);
      if (input.owner) params.set('owner', input.owner);
      if (input.intent) params.set('intent', input.intent);
      if (input.search) params.set('q', input.search);
      if (input.status) params.set('status', input.status);
      if (input.reviewStatus) params.set('reviewStatus', input.reviewStatus);
      if (input.promotionAction) params.set('promotionAction', input.promotionAction);
      if (input.readiness) params.set('readiness', input.readiness);
      if (input.age) params.set('age', input.age);
      if (input.nextAction) params.set('nextAction', input.nextAction);
      if (input.activeOnly) params.set('activeOnly', 'true');
      if (input.sort) params.set('sort', input.sort);
      if (typeof input.limit === 'number') params.set('limit', String(input.limit));
      if (typeof input.offset === 'number') params.set('offset', String(input.offset));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const raw = await request<NotebookResearchListResponse>(`/api/notebook/research${suffix}`);
    return {
      runs: raw.runs.map(normalizeNotebookResearchRun),
      total: typeof raw.total === 'number' ? raw.total : raw.runs.length,
      domains: Array.isArray(raw.domains)
        ? raw.domains.map((item) => ({
            domain: typeof item.domain === 'string' && item.domain.trim() ? item.domain : 'uncategorized',
            total: typeof item.total === 'number' ? item.total : 0,
            draftReady: typeof item.draftReady === 'number' ? item.draftReady : 0,
            certificationReady: typeof item.certificationReady === 'number' ? item.certificationReady : 0,
            blocked: typeof item.blocked === 'number' ? item.blocked : 0,
            staleOpen: typeof item.staleOpen === 'number' ? item.staleOpen : 0,
            expiredOpen: typeof item.expiredOpen === 'number' ? item.expiredOpen : 0,
            nextAction: normalizeNotebookResearchNextAction(item.nextAction),
            nextActionCount: typeof item.nextActionCount === 'number' && Number.isFinite(item.nextActionCount)
              ? Math.max(0, Math.floor(item.nextActionCount))
              : undefined,
          }))
        : [],
      owners: Array.isArray(raw.owners)
        ? raw.owners.map((item) => ({
            owner: typeof item.owner === 'string' && item.owner.trim() ? item.owner : 'unassigned',
            total: typeof item.total === 'number' ? item.total : 0,
            draftReady: typeof item.draftReady === 'number' ? item.draftReady : 0,
            certificationReady: typeof item.certificationReady === 'number' ? item.certificationReady : 0,
            blocked: typeof item.blocked === 'number' ? item.blocked : 0,
            staleOpen: typeof item.staleOpen === 'number' ? item.staleOpen : 0,
            expiredOpen: typeof item.expiredOpen === 'number' ? item.expiredOpen : 0,
            nextAction: normalizeNotebookResearchNextAction(item.nextAction),
            nextActionCount: typeof item.nextActionCount === 'number' && Number.isFinite(item.nextActionCount)
              ? Math.max(0, Math.floor(item.nextActionCount))
              : undefined,
          }))
        : [],
      intents: Array.isArray(raw.intents)
        ? raw.intents.map((item) => ({
            intent: normalizeNotebookResearchIntent(item.intent),
            total: typeof item.total === 'number' ? item.total : 0,
            draftReady: typeof item.draftReady === 'number' ? item.draftReady : 0,
            certificationReady: typeof item.certificationReady === 'number' ? item.certificationReady : 0,
            blocked: typeof item.blocked === 'number' ? item.blocked : 0,
            staleOpen: typeof item.staleOpen === 'number' ? item.staleOpen : 0,
            expiredOpen: typeof item.expiredOpen === 'number' ? item.expiredOpen : 0,
            nextAction: normalizeNotebookResearchNextAction(item.nextAction),
            nextActionCount: typeof item.nextActionCount === 'number' && Number.isFinite(item.nextActionCount)
              ? Math.max(0, Math.floor(item.nextActionCount))
              : undefined,
          }))
        : [],
      notebooks: Array.isArray(raw.notebooks)
        ? raw.notebooks.map((item) => ({
            path: typeof item.path === 'string' && item.path.trim() ? item.path : 'notebooks/untitled.dqlnb',
            title: typeof item.title === 'string' && item.title.trim() ? item.title : notebookTitleFromPath(item.path),
            total: typeof item.total === 'number' ? item.total : 0,
            draftReady: typeof item.draftReady === 'number' ? item.draftReady : 0,
            certificationReady: typeof item.certificationReady === 'number' ? item.certificationReady : 0,
            blocked: typeof item.blocked === 'number' ? item.blocked : 0,
            staleOpen: typeof item.staleOpen === 'number' ? item.staleOpen : 0,
            expiredOpen: typeof item.expiredOpen === 'number' ? item.expiredOpen : 0,
            nextAction: normalizeNotebookResearchNextAction(item.nextAction),
            nextActionCount: typeof item.nextActionCount === 'number' && Number.isFinite(item.nextActionCount)
              ? Math.max(0, Math.floor(item.nextActionCount))
              : undefined,
          }))
        : [],
      counts: {
        total: typeof raw.counts?.total === 'number' ? raw.counts.total : raw.runs.length,
        ready: typeof raw.counts?.ready === 'number' ? raw.counts.ready : 0,
        needsReview: typeof raw.counts?.needsReview === 'number' ? raw.counts.needsReview : 0,
        dqlDrafts: typeof raw.counts?.dqlDrafts === 'number' ? raw.counts.dqlDrafts : 0,
        errors: typeof raw.counts?.errors === 'number' ? raw.counts.errors : 0,
        reuseExisting: typeof raw.counts?.reuseExisting === 'number' ? raw.counts.reuseExisting : 0,
        extendExisting: typeof raw.counts?.extendExisting === 'number' ? raw.counts.extendExisting : 0,
        replacements: typeof raw.counts?.replacements === 'number' ? raw.counts.replacements : 0,
        createNew: typeof raw.counts?.createNew === 'number' ? raw.counts.createNew : 0,
        draftReady: typeof raw.counts?.draftReady === 'number' ? raw.counts.draftReady : 0,
        certificationReady: typeof raw.counts?.certificationReady === 'number' ? raw.counts.certificationReady : 0,
        blocked: typeof raw.counts?.blocked === 'number' ? raw.counts.blocked : 0,
        staleOpen: typeof raw.counts?.staleOpen === 'number' ? raw.counts.staleOpen : 0,
        expiredOpen: typeof raw.counts?.expiredOpen === 'number' ? raw.counts.expiredOpen : 0,
        sourceLinked: typeof raw.counts?.sourceLinked === 'number' ? raw.counts.sourceLinked : 0,
        nextActions: normalizeNotebookResearchNextActionCounts(raw.counts?.nextActions),
      },
      groupCounts: {
        domains: typeof raw.groupCounts?.domains === 'number' && Number.isFinite(raw.groupCounts.domains)
          ? Math.max(0, Math.floor(raw.groupCounts.domains))
          : (Array.isArray(raw.domains) ? raw.domains.length : 0),
        owners: typeof raw.groupCounts?.owners === 'number' && Number.isFinite(raw.groupCounts.owners)
          ? Math.max(0, Math.floor(raw.groupCounts.owners))
          : (Array.isArray(raw.owners) ? raw.owners.length : 0),
        intents: typeof raw.groupCounts?.intents === 'number' && Number.isFinite(raw.groupCounts.intents)
          ? Math.max(0, Math.floor(raw.groupCounts.intents))
          : (Array.isArray(raw.intents) ? raw.intents.length : 0),
        notebooks: typeof raw.groupCounts?.notebooks === 'number' && Number.isFinite(raw.groupCounts.notebooks)
          ? Math.max(0, Math.floor(raw.groupCounts.notebooks))
          : (Array.isArray(raw.notebooks) ? raw.notebooks.length : 0),
      },
      reviewMetrics: normalizeNotebookResearchReviewMetrics(raw.reviewMetrics),
      limit: raw.limit,
      offset: typeof raw.offset === 'number' ? raw.offset : 0,
    };
  },

  async getNotebookResearchDiagnostics(): Promise<NotebookResearchDiagnostics> {
    const raw = await request<NotebookResearchDiagnostics>('/api/notebook/research/diagnostics');
    return normalizeNotebookResearchDiagnostics(raw);
  },

  async createNotebookResearch(input: {
    notebookPath: string;
    domain?: string;
    owner?: string;
    sourceCell?: NotebookResearchSourceCellPayload;
    sourceCellId?: string;
    sourceCellName?: string;
    sourceCellFingerprint?: string;
    title?: string;
    question: string;
    intent?: NotebookResearchIntent;
    context?: unknown;
    generatedSql?: string;
    reviewedSql?: string;
    dqlArtifact?: AgentConversationDqlArtifact;
    run?: boolean;
  }): Promise<NotebookResearchRun> {
    const raw = await request<{ run: NotebookResearchRun }>('/api/notebook/research', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return normalizeNotebookResearchRun(raw.run);
  },

  async seedNotebookResearchFromCells(input: {
    notebookPath: string;
    domain?: string;
    owner?: string;
    notebookTitle?: string;
	    cells: Array<{
	      sourceCell?: NotebookResearchSourceCellPayload;
	      id?: string;
	      sourceCellId?: string;
	      name?: string;
	      sourceCellName?: string;
	      type?: string;
	      sql?: string;
	      content?: string;
	      source?: string;
	      sourceCellFingerprint?: string;
      question?: string;
      intent?: NotebookResearchIntent;
    }>;
  }): Promise<NotebookResearchSeedCellsResponse> {
    const raw = await request<NotebookResearchSeedCellsResponse>('/api/notebook/research/seed-cells', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      created: Array.isArray(raw.created) ? raw.created.map(normalizeNotebookResearchRun) : [],
      createdCount: typeof raw.createdCount === 'number' ? raw.createdCount : Array.isArray(raw.created) ? raw.created.length : 0,
      skippedCount: typeof raw.skippedCount === 'number' ? raw.skippedCount : 0,
      limitApplied: raw.limitApplied === true,
    };
  },

  async listNotebookResearchSourceCoverage(input: {
    path: string;
    sourceCellIds: string[];
    sourceCells?: NotebookResearchSourceCellPayload[];
    limit?: number;
  }): Promise<NotebookResearchSourceCoverageResponse> {
    const raw = await request<NotebookResearchSourceCoverageResponse>('/api/notebook/research/source-coverage', {
      method: 'POST',
      body: JSON.stringify({
        path: input.path,
        sourceCellIds: input.sourceCellIds,
        sourceCells: input.sourceCells,
        limit: input.limit,
      }),
    });
    return {
      runs: Array.isArray(raw.runs) ? raw.runs.map(normalizeNotebookResearchRun) : [],
      requestedCount: typeof raw.requestedCount === 'number' ? raw.requestedCount : input.sourceCellIds.length,
      matchedCount: typeof raw.matchedCount === 'number' ? raw.matchedCount : Array.isArray(raw.runs) ? raw.runs.length : 0,
      limitApplied: raw.limitApplied === true,
    };
  },

  async previewNotebookResearchContext(input: {
    notebookPath: string;
    domain?: string;
    sourceCell?: NotebookResearchSourceCellPayload;
    sourceCellId?: string;
    sourceCellName?: string;
    question: string;
    intent?: NotebookResearchIntent;
    context?: unknown;
  }): Promise<NotebookResearchContextPreview> {
    const raw = await request<NotebookResearchContextPreview>('/api/notebook/research/context-preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return normalizeNotebookResearchContextPreview(raw);
  },

  async getNotebookResearch(id: string): Promise<NotebookResearchRun> {
    const raw = await request<{ run: NotebookResearchRun }>(`/api/notebook/research/${encodeURIComponent(id)}`);
    return normalizeNotebookResearchRun(raw.run);
  },

  async updateNotebookResearch(id: string, input: NotebookResearchUpdateInput): Promise<NotebookResearchRun> {
    const raw = await request<{ run: NotebookResearchRun }>(`/api/notebook/research/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    return normalizeNotebookResearchRun(raw.run);
  },

  async runNotebookResearch(id: string, input?: Partial<Pick<
    NotebookResearchRun,
    'domain' | 'owner' | 'sourceCellFingerprint' | 'question' | 'intent' | 'context' | 'generatedSql' | 'reviewedSql' | 'dqlArtifact'
  >>): Promise<NotebookResearchRun> {
    const raw = await request<{ run: NotebookResearchRun }>(`/api/notebook/research/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    });
    return normalizeNotebookResearchRun(raw.run);
  },

  async checkNotebookResearchReuse(id: string, input?: { domain?: string; owner?: string }): Promise<NotebookResearchReuseCheckResponse> {
    const raw = await request<NotebookResearchReuseCheckResponse>(
      `/api/notebook/research/${encodeURIComponent(id)}/reuse-check`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
    return {
      ...raw,
      run: normalizeNotebookResearchRun(raw.run),
      promotion: normalizeNotebookDqlPromotion(raw.promotion) ?? raw.promotion,
    };
  },

  async promoteNotebookResearchToDql(id: string, input?: { domain?: string; owner?: string; tags?: string[]; provider?: string }): Promise<{
    run: NotebookResearchRun;
    session: DqlGenerationSession;
  }> {
    const raw = await request<{ run: NotebookResearchRun; session: DqlGenerationSession }>(
      `/api/notebook/research/${encodeURIComponent(id)}/promote-dql`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
    return { ...raw, run: normalizeNotebookResearchRun(raw.run) };
  },

  async getSchema(): Promise<SchemaTable[]> {
    try {
      const res = await fetch(`${BASE}/api/schema`);
      if (res.ok) {
        return (await res.json()) as SchemaTable[];
      }
      // Server returns 500 with { error, fallback } when introspection fails.
      const body = (await res.json().catch(() => null)) as
        | { error?: string; fallback?: SchemaTable[] }
        | null;
      if (body?.error) {
        console.warn(`[dql] schema introspection failed: ${body.error}`);
      }
      return body?.fallback ?? [];
    } catch (err) {
      console.warn('[dql] getSchema request failed', err);
      return [];
    }
  },

  async getConnections(): Promise<{
    default: string;
    connections: Record<string, unknown>;
    connectorStatus?: Array<{
      driver: 'duckdb' | 'snowflake' | 'databricks';
      label: string;
      packageName?: string;
      packageSpec?: string;
      installed: boolean;
      builtIn: boolean;
      installPath: string;
      installCommand?: string;
    }>;
    dbtProfiles?: Array<{
      id: string;
      profileName: string;
      targetName: string;
      adapter: string;
      path: string;
      connection: Record<string, unknown>;
      missingFields: string[];
      warnings: string[];
    }>;
  }> {
    try {
      return await request<{
        default: string;
        connections: Record<string, unknown>;
        connectorStatus?: Array<{
          driver: 'duckdb' | 'snowflake' | 'databricks';
          label: string;
          packageName?: string;
          packageSpec?: string;
          installed: boolean;
          builtIn: boolean;
          installPath: string;
          installCommand?: string;
        }>;
        dbtProfiles?: Array<{
          id: string;
          profileName: string;
          targetName: string;
          adapter: string;
          path: string;
          connection: Record<string, unknown>;
          missingFields: string[];
          warnings: string[];
        }>;
      }>('/api/connections');
    } catch {
      return { default: 'unknown', connections: {} };
    }
  },

  async saveConnections(
    connections: Record<string, unknown>,
    defaultConnectionName?: string,
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/connections', {
      method: 'PUT',
      body: JSON.stringify({ connections, defaultConnectionName }),
    });
  },

  async installConnector(driver: string): Promise<{
    ok: boolean;
    status?: {
      driver: 'duckdb' | 'snowflake' | 'databricks';
      label: string;
      packageName?: string;
      packageSpec?: string;
      installed: boolean;
      builtIn: boolean;
      installPath: string;
      installCommand?: string;
    };
    connectorStatus?: Array<{
      driver: 'duckdb' | 'snowflake' | 'databricks';
      label: string;
      packageName?: string;
      packageSpec?: string;
      installed: boolean;
      builtIn: boolean;
      installPath: string;
      installCommand?: string;
    }>;
    error?: string;
  }> {
    return request('/api/connectors/install', {
      method: 'POST',
      body: JSON.stringify({ driver }),
    });
  },

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      return await request<{ ok: boolean; message: string }>('/api/test-connection', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    } catch (e: any) {
      return { ok: false, message: e.message ?? 'Connection failed' };
    }
  },

  async getSemanticLayer(): Promise<Omit<SemanticLayerState, 'loading'>> {
    try {
      return await request<Omit<SemanticLayerState, 'loading'>>('/api/semantic-layer');
    } catch {
      return {
        available: false,
        provider: null,
        metrics: [],
        measures: [],
        dimensions: [],
        timeDimensions: [],
        entities: [],
        hierarchies: [],
        semanticModels: [],
        savedQueries: [],
        domains: [],
        tags: [],
        favorites: [],
        recentlyUsed: [],
        lastSyncTime: null,
      };
    }
  },

  async getSemanticTree(): Promise<SemanticTreeNode> {
    const result = await request<{ tree: SemanticTreeNode }>('/api/semantic-layer/tree');
    return result.tree;
  },

  async getSemanticObject(id: string): Promise<SemanticObjectDetail> {
    return request<SemanticObjectDetail>(`/api/semantic-layer/object/${encodeURIComponent(id)}`);
  },

  async importSemanticLayer(payload: {
    provider: 'dbt' | 'cubejs' | 'snowflake';
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
  }): Promise<any> {
    return request<any>('/api/semantic-layer/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async syncSemanticLayer(): Promise<any> {
    return request<any>('/api/semantic-layer/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async previewSemanticImport(payload: {
    provider: 'dbt' | 'cubejs' | 'snowflake';
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
  }): Promise<{
    provider: string;
    counts: Record<string, number>;
    domains: string[];
    warnings: string[];
    objects: Array<{ kind: string; name: string; label: string; domain: string }>;
  }> {
    return request('/api/semantic-layer/import-preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewSyncDiff(): Promise<{
    added: Array<{ kind: string; name: string; label: string; domain: string }>;
    removed: Array<{ kind: string; name: string; label: string; domain: string }>;
    changed: Array<{ kind: string; name: string; label: string; domain: string }>;
    unchanged: number;
  }> {
    return request('/api/semantic-layer/sync-preview', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async searchSemanticLayer(params: {
    query?: string;
    domain?: string;
    tag?: string;
    type?: 'metric' | 'measure' | 'dimension' | 'time_dimension' | 'entity' | 'hierarchy' | 'semantic_model' | 'saved_query';
  }): Promise<{
    metrics: SemanticMetric[];
    measures: SemanticMeasure[];
    dimensions: SemanticDimension[];
    timeDimensions: SemanticDimension[];
    entities: SemanticEntity[];
    hierarchies: SemanticHierarchy[];
    semanticModels: SemanticModel[];
    savedQueries: SemanticSavedQuery[];
  }> {
    const search = new URLSearchParams();
    if (params.query) search.set('q', params.query);
    if (params.domain) search.set('domain', params.domain);
    if (params.tag) search.set('tag', params.tag);
    if (params.type) search.set('type', params.type);
    try {
      return await request<{
        metrics: SemanticMetric[];
        measures: SemanticMeasure[];
        dimensions: SemanticDimension[];
        timeDimensions: SemanticDimension[];
        entities: SemanticEntity[];
        hierarchies: SemanticHierarchy[];
        semanticModels: SemanticModel[];
        savedQueries: SemanticSavedQuery[];
      }>(
        `/api/semantic-layer/search?${search.toString()}`,
      );
    } catch {
      return { metrics: [], measures: [], dimensions: [], timeDimensions: [], entities: [], hierarchies: [], semanticModels: [], savedQueries: [] };
    }
  },

  async getFavorites(): Promise<string[]> {
    try {
      const result = await request<{ favorites: string[] }>('/api/user-prefs/favorites');
      return result.favorites;
    } catch {
      return [];
    }
  },

  async toggleFavorite(name: string): Promise<string[]> {
    const result = await request<{ favorites: string[] }>('/api/user-prefs/favorites', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return result.favorites;
  },

  async getRecentlyUsed(): Promise<string[]> {
    try {
      const result = await request<{ recentlyUsed: string[] }>('/api/user-prefs/recent');
      return result.recentlyUsed;
    } catch {
      return [];
    }
  },

  async trackUsage(name: string): Promise<string[]> {
    try {
      const result = await request<{ recentlyUsed: string[] }>('/api/user-prefs/recent', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return result.recentlyUsed;
    } catch {
      return [];
    }
  },

  async getCompatibleDimensions(metrics: string[]): Promise<SemanticDimension[]> {
    const search = new URLSearchParams();
    if (metrics.length > 0) search.set('metrics', metrics.join(','));
    try {
      const result = await request<{ dimensions: SemanticDimension[] }>(
        `/api/semantic-layer/compatible-dims?${search.toString()}`,
      );
      return result.dimensions;
    } catch {
      return [];
    }
  },

  async composeQuery(
    metrics: string[],
    dimensions: string[],
    timeDimension?: { name: string; granularity: string },
  ): Promise<{ sql: string } | { error: string }> {
    try {
      return await request<{ sql: string }>('/api/semantic-query', {
        method: 'POST',
        body: JSON.stringify({ metrics, dimensions, timeDimension }),
      });
    } catch (e: any) {
      return { error: e.message ?? 'Failed to compose query' };
    }
  },

  async previewSemanticBuilder(payload: {
    metrics: string[];
    dimensions: string[];
    filters?: Array<{ dimension: string; operator: string; values: string[] }>;
    timeDimension?: { name: string; granularity: string };
    orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
    limit?: number;
  }): Promise<{ sql: string; joins: string[]; tables: string[]; result: QueryResult } | { error: string }> {
    try {
      return await request<{ sql: string; joins: string[]; tables: string[]; result: QueryResult }>('/api/semantic-builder/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (e: any) {
      return { error: e.message ?? 'Failed to preview semantic block' };
    }
  },

  async saveSemanticBuilder(payload: {
    name: string;
    domain?: string;
    description?: string;
    owner?: string;
    tags?: string[];
    metrics: string[];
    dimensions: string[];
    filters?: Array<{ dimension: string; operator: string; values: string[] }>;
    timeDimension?: { name: string; granularity: string };
    chart?: string;
    blockType?: 'semantic' | 'custom';
  }): Promise<{ path: string; content: string; companionPath: string }> {
    return request<{ path: string; content: string; companionPath: string }>('/api/semantic-builder/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async createMetric(metric: {
    name: string;
    label: string;
    description: string;
    domain: string;
    sql: string;
    type: string;
    table: string;
    tags?: string[];
  }): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      return await request<{ ok: boolean; path: string }>('/api/semantic-layer/metric', {
        method: 'POST',
        body: JSON.stringify(metric),
      });
    } catch (e: any) {
      return { ok: false, error: e.message ?? 'Failed to create metric' };
    }
  },

  async describeTable(tablePath: string): Promise<SchemaColumn[]> {
    // Extract schema from qualified path (e.g. "public.orders" → schema=public, table=orders)
    const parts = tablePath.split('.');
    const table = parts.length > 1 ? parts[parts.length - 1] : tablePath;
    const schema = parts.length > 1 ? parts.slice(0, -1).join('.') : '';
    const params = new URLSearchParams({ table });
    if (schema) params.set('schema', schema);
    try {
      return await request<SchemaColumn[]>(`/api/describe-table?${params.toString()}`);
    } catch {
      return [];
    }
  },

  async fetchLineage(): Promise<{ nodes: any[]; edges: any[] }> {
    try {
      return await request<{ nodes: any[]; edges: any[] }>('/api/lineage');
    } catch {
      return { nodes: [], edges: [] };
    }
  },

  async searchLineage(query: string): Promise<{ matches: Array<{ node: any; score: number }> }> {
    try {
      return await request<{ matches: Array<{ node: any; score: number }> }>(
        `/api/lineage/search?q=${encodeURIComponent(query)}`,
      );
    } catch {
      return { matches: [] };
    }
  },

  async queryLineage(params: {
    focus?: string;
    search?: string;
    types?: string[];
    domain?: string;
    upstreamDepth?: number;
    downstreamDepth?: number;
  }): Promise<{ graph: { nodes: any[]; edges: any[] }; focalNode?: any; matches?: Array<{ node: any; score: number }> }> {
    const searchParams = new URLSearchParams();
    if (params.focus) searchParams.set('focus', params.focus);
    if (params.search) searchParams.set('search', params.search);
    if (params.types?.length) searchParams.set('types', params.types.join(','));
    if (params.domain) searchParams.set('domain', params.domain);
    if (params.upstreamDepth !== undefined) searchParams.set('upstreamDepth', String(params.upstreamDepth));
    if (params.downstreamDepth !== undefined) searchParams.set('downstreamDepth', String(params.downstreamDepth));
    try {
      return await request<{ graph: { nodes: any[]; edges: any[] }; focalNode?: any; matches?: Array<{ node: any; score: number }> }>(
        `/api/lineage/query?${searchParams.toString()}`,
      );
    } catch {
      return { graph: { nodes: [], edges: [] }, matches: [] };
    }
  },

  async fetchLineageNode(nodeId: string): Promise<{ node: any; incoming: any[]; outgoing: any[] } | null> {
    try {
      return await request<{ node: any; incoming: any[]; outgoing: any[] }>(
        `/api/lineage/node/${encodeURIComponent(nodeId)}`,
      );
    } catch {
      return null;
    }
  },

  async fetchBusiness360(nodeId: string): Promise<Business360ResultV2 | null> {
    try {
      return await request<Business360ResultV2>(
        `/api/lineage/business-360/${encodeURIComponent(nodeId)}`,
      );
    } catch {
      return null;
    }
  },

  async fetchBlockLineage(blockName: string): Promise<{ node: any; ancestors: any[]; descendants: any[] } | null> {
    try {
      return await request<{ node: any; ancestors: any[]; descendants: any[] }>(
        `/api/lineage/block/${encodeURIComponent(blockName)}`,
      );
    } catch {
      return null;
    }
  },

  async fetchImpactAnalysis(blockName: string): Promise<any> {
    try {
      return await request<any>(`/api/lineage/impact/${encodeURIComponent(blockName)}`);
    } catch {
      return null;
    }
  },

  async fetchLineagePaths(
    nodeId: string,
    options?: { maxDepth?: number; maxPaths?: number },
  ): Promise<{
    focalNode: any;
    upstreamPaths: Array<{ nodes: any[]; edges: any[]; layers: string[] }>;
    downstreamPaths: Array<{ nodes: any[]; edges: any[]; layers: string[] }>;
    layerSummary: Record<string, number>;
  } | null> {
    try {
      const params = new URLSearchParams();
      if (options?.maxDepth) params.set('maxDepth', String(options.maxDepth));
      if (options?.maxPaths) params.set('maxPaths', String(options.maxPaths));
      const qs = params.toString();
      const url = `/api/lineage/paths/${encodeURIComponent(nodeId)}${qs ? `?${qs}` : ''}`;
      return await request<any>(url);
    } catch {
      return null;
    }
  },

  async fetchGitStatus(): Promise<{
    inRepo: boolean;
    branch: string | null;
    ahead: number;
    behind: number;
    changes: Array<{ path: string; status: string }>;
  }> {
    try {
      return await request<any>('/api/git/status');
    } catch {
      return { inRepo: false, branch: null, ahead: 0, behind: 0, changes: [] };
    }
  },

  async fetchGitLog(limit = 20): Promise<{
    inRepo: boolean;
    commits: Array<{ hash: string; author: string; date: string; subject: string }>;
  }> {
    try {
      return await request<any>(`/api/git/log?limit=${limit}`);
    } catch {
      return { inRepo: false, commits: [] };
    }
  },

  async fetchRunSnapshot(path: string): Promise<{ found: boolean; snapshot: RunSnapshot | null }> {
    try {
      return await request<any>(`/api/run-snapshot?path=${encodeURIComponent(path)}`);
    } catch {
      return { found: false, snapshot: null };
    }
  },

  async saveRunSnapshot(path: string, snapshot: RunSnapshot): Promise<void> {
    await request<void>('/api/run-snapshot', {
      method: 'PUT',
      body: JSON.stringify({ path, snapshot }),
    });
  },

  async fetchGitDiff(path?: string, staged?: boolean): Promise<{
    inRepo: boolean;
    diff: string;
    before: string | null;
    after: string | null;
    diffReport: DiffReport | null;
  }> {
    try {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      if (staged) params.set('staged', 'true');
      const qs = params.toString();
      return await request<any>(`/api/git/diff${qs ? `?${qs}` : ''}`);
    } catch {
      return { inRepo: false, diff: '', before: null, after: null, diffReport: null };
    }
  },

  async fetchGitBranches(): Promise<{ inRepo: boolean; current: string | null; branches: string[] }> {
    try {
      return await request<any>('/api/git/branches');
    } catch {
      return { inRepo: false, current: null, branches: [] };
    }
  },

  async fetchGitRemote(): Promise<{ inRepo: boolean; url: string | null; name: string | null }> {
    try {
      return await request<any>('/api/git/remote');
    } catch {
      return { inRepo: false, url: null, name: null };
    }
  },

  async fetchGitGovernedContext(): Promise<{
    inRepo: boolean;
    trackingReady: boolean;
    domains: GitGovernedContextGroup;
    skills: GitGovernedContextGroup;
  }> {
    try {
      return await request('/api/git/governed-context');
    } catch {
      return { inRepo: false, trackingReady: false, domains: emptyGitGovernedContextGroup(), skills: emptyGitGovernedContextGroup() };
    }
  },

  async enableGitGovernedContextTracking(): Promise<{ ok: boolean; changed?: boolean; error?: string }> {
    try {
      return await request('/api/git/governed-context/enable', { method: 'POST', body: '{}' });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitStage(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/stage', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitUnstage(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/unstage', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitDiscard(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/discard', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitCommit(message: string, stageAll = false): Promise<{ ok: boolean; error?: string; hash?: string }> {
    try {
      return await request<any>('/api/git/commit', {
        method: 'POST',
        body: JSON.stringify({ message, stageAll }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitPush(): Promise<{ ok: boolean; error?: string; output?: string }> {
    try {
      return await request<any>('/api/git/push', { method: 'POST', body: '{}' });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitPull(): Promise<{ ok: boolean; error?: string; output?: string }> {
    try {
      return await request<any>('/api/git/pull', { method: 'POST', body: '{}' });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitCreateBranch(name: string, checkout = true): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/branch', {
        method: 'POST',
        body: JSON.stringify({ name, checkout }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Create a review branch, commit only the selected files, push it, and open a PR. Never merges. */
  async gitCreateReview(payload: { paths: string[]; title: string; body?: string; base?: string }): Promise<{
    ok: boolean; error?: string; branch?: string; hash?: string; prUrl?: string; warning?: string;
  }> {
    try {
      return await request<any>('/api/git/review', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitCheckout(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/checkout', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // ── Apps & Dashboards ───────────────────────────────────────────────────

  async listApps(): Promise<AppSummary[]> {
    try {
      const { apps } = await request<{ apps: AppSummary[] }>('/api/apps');
      return apps;
    } catch {
      return [];
    }
  },

  /** Like listApps but throws on failure, so callers can tell "no apps" from "load failed". */
  async listAppsStrict(): Promise<AppSummary[]> {
    const { apps } = await request<{ apps: AppSummary[] }>('/api/apps');
    return apps;
  },

  async recommendAppBlocks(input: {
    domain?: string;
    tags?: string[];
    purpose?: string;
    audience?: string;
    certifiedOnly?: boolean;
  }): Promise<AppBlockRecommendation[]> {
    try {
      const { blocks } = await request<{ blocks: AppBlockRecommendation[] }>('/api/apps/recommend-blocks', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return blocks;
    } catch {
      return [];
    }
  },

  async createApp(input: CreateAppRequest): Promise<CreateAppResponse> {
    return request<CreateAppResponse>('/api/apps', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async generateApp(input: GenerateAppRequest): Promise<GenerateAppResponse | { ok: false; error: string }> {
    try {
      return await request<GenerateAppResponse>('/api/apps/generate', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async createAppAiBuild(input: GenerateAppRequest): Promise<{ ok: true; session: AppAiBuildSession } | { ok: false; error: string; session?: AppAiBuildSession }> {
    try {
      return await request(
        '/api/apps/ai-builds',
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getAppAiBuild(id: string): Promise<AppAiBuildSession | null> {
    try {
      const { session } = await request<{ ok: true; session: AppAiBuildSession }>(
        `/api/apps/ai-builds/${encodeURIComponent(id)}`,
      );
      return session;
    } catch {
      return null;
    }
  },

  /** Two-phase build, step 1: plan + confirmable content list. Writes no app files. */
  async proposeAppAiBuild(input: GenerateAppRequest): Promise<{ ok: true; session: AppAiBuildSession } | { ok: false; error: string; session?: AppAiBuildSession }> {
    try {
      return await request(
        '/api/apps/ai-builds/propose',
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Two-phase build, step 2: the user confirmed — create the app from the selection. */
  async commitAppAiBuild(sessionId: string, input: { selectedTileIds?: string[]; force?: boolean } = {}): Promise<
    { ok: true; session: AppAiBuildSession; app: AppSummary | null; dashboardId: string | null } | { ok: false; error: string }
  > {
    try {
      return await request(
        `/api/apps/ai-builds/${encodeURIComponent(sessionId)}/commit`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getApp(id: string): Promise<AppDocumentSummary | null> {
    try {
      return await request<AppDocumentSummary>(`/api/apps/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
  },

  async attachAppNotebook(appId: string, input: {
    path: string;
    title?: string;
    role?: 'source' | 'analysis' | 'supporting';
    visibility?: 'shared' | 'private' | 'template';
  }): Promise<AppDocumentSummary | { ok: false; error: string }> {
    try {
      return await request<AppDocumentSummary>(
        `/api/apps/${encodeURIComponent(appId)}/notebooks`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppNotebookCandidates(appId: string): Promise<AppNotebookCandidate[]> {
    try {
      const { notebooks } = await request<{ notebooks: AppNotebookCandidate[] }>(
        `/api/apps/${encodeURIComponent(appId)}/notebook-candidates`,
      );
      return notebooks;
    } catch {
      return [];
    }
  },

  async createAppNotebook(appId: string, input: {
    name: string;
    title?: string;
    role?: 'source' | 'analysis' | 'supporting';
    visibility?: 'shared' | 'private' | 'template';
    template?: string;
  }): Promise<{ ok: true; path: string; app: AppDocumentSummary; preview?: AppNotebookPreview } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/create`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async previewAppNotebook(appId: string, path: string): Promise<AppNotebookPreview | null> {
    try {
      return await request<AppNotebookPreview>(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/preview?path=${encodeURIComponent(path)}`,
      );
    } catch {
      return null;
    }
  },

  async runAppNotebook(appId: string, path: string): Promise<{ ok: true; preview: AppNotebookPreview } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/run`,
        { method: 'POST', body: JSON.stringify({ path }) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppConversations(appId: string): Promise<AppConversation[]> {
    try {
      const { conversations } = await request<{ conversations: AppConversation[] }>(
        `/api/apps/${encodeURIComponent(appId)}/conversations`,
      );
      return conversations;
    } catch {
      return [];
    }
  },

  async createAppConversation(appId: string, input: {
    title?: string;
    dashboardId?: string;
    notebookPath?: string;
    context?: AgentConversationContext;
    messages?: AppConversationMessage[];
  }): Promise<{ ok: true; conversation: AppConversation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getAppConversation(appId: string, conversationId: string): Promise<AppConversation | null> {
    try {
      const { conversation } = await request<{ conversation: AppConversation }>(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
      );
      return conversation;
    } catch {
      return null;
    }
  },

  async updateAppConversation(appId: string, conversationId: string, input: {
    title?: string;
    dashboardId?: string;
    notebookPath?: string;
    context?: AgentConversationContext | null;
    messages?: AppConversationMessage[];
  }): Promise<{ ok: true; conversation: AppConversation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async deleteAppConversation(appId: string, conversationId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppInvestigations(appId: string, dashboardId?: string): Promise<LocalAppInvestigation[]> {
    try {
      const search = new URLSearchParams();
      if (dashboardId) search.set('dashboardId', dashboardId);
      const qs = search.toString();
      const { investigations } = await request<{ investigations: LocalAppInvestigation[] }>(
        `/api/apps/${encodeURIComponent(appId)}/investigations${qs ? `?${qs}` : ''}`,
      );
      return investigations;
    } catch {
      return [];
    }
  },

  async createAppInvestigation(appId: string, input: {
    dashboardId?: string;
    sourceTileId?: string;
    sourceBlockId?: string;
    title?: string;
    question: string;
    intent?: LocalAppInvestigation['intent'];
    context?: unknown;
    generatedSql?: string;
    run?: boolean;
  }): Promise<{ ok: true; investigation: LocalAppInvestigation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getAppInvestigation(appId: string, investigationId: string): Promise<LocalAppInvestigation | null> {
    try {
      const { investigation } = await request<{ investigation: LocalAppInvestigation }>(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}`,
      );
      return investigation;
    } catch {
      return null;
    }
  },

  async runAppInvestigation(appId: string, investigationId: string, input?: {
    question?: string;
    intent?: LocalAppInvestigation['intent'];
    context?: unknown;
    generatedSql?: string;
    repairMode?: 'rebuild_from_certified';
  }): Promise<{ ok: true; investigation: LocalAppInvestigation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}/run`,
        { method: 'POST', body: JSON.stringify(input ?? {}) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async pinAppInvestigation(appId: string, investigationId: string, input?: {
    dashboardId?: string;
    title?: string;
    refreshCadence?: 'none' | 'daily';
  }): Promise<{ ok: true; investigation: LocalAppInvestigation; pin: LocalAiPin; dashboard?: DashboardDocumentResponse['dashboard']; tile?: DashboardDocumentResponse['dashboard']['layout']['items'][number] } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}/pin`,
        { method: 'POST', body: JSON.stringify(input ?? {}) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getDashboard(appId: string, dashboardId: string): Promise<DashboardDocumentResponse | null> {
    try {
      return await request<DashboardDocumentResponse>(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}`,
      );
    } catch {
      return null;
    }
  },

  /** Distinct values for a block column → categorical dashboard-filter dropdowns. */
  async dashboardFilterOptions(block: string, column: string): Promise<{ options: string[]; truncated: boolean } | null> {
    try {
      const search = new URLSearchParams({ block, column });
      return await request<{ options: string[]; truncated: boolean }>(`/api/dashboard/filter-options?${search.toString()}`);
    } catch {
      return null;
    }
  },

  async getAppEditorCatalog(appId: string, params?: { domain?: string; certifiedOnly?: boolean }): Promise<AppEditorCatalogResponse | null> {
    try {
      const search = new URLSearchParams();
      if (params?.domain) search.set('domain', params.domain);
      if (params?.certifiedOnly === false) search.set('certifiedOnly', 'false');
      const qs = search.toString();
      return await request<AppEditorCatalogResponse>(
        `/api/apps/${encodeURIComponent(appId)}/editor/catalog${qs ? `?${qs}` : ''}`,
      );
    } catch {
      return null;
    }
  },

  async createAppDashboard(appId: string, input: { id?: string; title: string; description?: string }): Promise<{ ok: true; dashboard: DashboardDocumentResponse['dashboard']; path: string } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async patchDashboardLayout(
    appId: string,
    dashboardId: string,
    layout: DashboardDocumentResponse['dashboard']['layout'],
  ): Promise<{ ok: true; dashboard: DashboardDocumentResponse['dashboard']; path: string } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/layout`,
        { method: 'PATCH', body: JSON.stringify({ layout }) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async askApp(appId: string, input: {
    question: string;
    dashboardId?: string;
    tileId?: string;
    blockId?: string;
    variables?: Record<string, unknown>;
    context?: unknown;
    runInvestigation?: boolean;
  }): Promise<AppAskResponse> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ask`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async promoteApp(appId: string, input?: { lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated' }): Promise<{ ok: true; app: AppDocumentSummary['app']; paths: string[]; removedLocalTiles: number } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/promote`,
        { method: 'POST', body: JSON.stringify(input ?? {}) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async recommendVisualization(input: {
    blockRef?: string;
    resultSchema?: unknown;
    rowSample?: Array<Record<string, unknown>>;
    appAudience?: string;
    prompt?: string;
    allowedVisualizations?: string[];
    component?: DashboardDisplayMetadata['component'];
    defaultVisualization?: string;
  }): Promise<VisualizationRecommendationResponse> {
    try {
      return await request(
        '/api/visualizations/recommend',
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async recommendDashboardTile(appId: string, dashboardId: string, input: {
    tileId?: string;
    blockRef?: string;
    resultSchema?: unknown;
    rowSample?: Array<Record<string, unknown>>;
    appAudience?: string;
    prompt?: string;
    allowedVisualizations?: string[];
    component?: DashboardDisplayMetadata['component'];
    defaultVisualization?: string;
  }): Promise<VisualizationRecommendationResponse | {
    ok: true;
    display: DashboardDisplayMetadata;
    filterBindings?: DashboardTileFilterBinding[];
    parameterBindings?: DashboardTileParameterBinding[];
    sourceEvidence?: DashboardTileSourceEvidence[];
    trustState: DashboardDisplayMetadata['trustState'];
    reviewStatus: DashboardDisplayMetadata['reviewStatus'];
    evidence: Array<{ source: string; reason: string }>;
    warnings: string[];
  }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles/recommend`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

 async createAiPin(appId: string, input: {
    dashboardId: string;
    title: string;
    answer: string;
    question?: string;
    sql?: string;
    sourceTier?: string;
    certification?: 'certified' | 'ai_generated';
    reviewStatus?: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
    refreshCadence?: 'none' | 'daily';
    chartConfig?: Record<string, unknown>;
    result?: QueryResult;
    citations?: unknown[];
    analysisPlan?: unknown;
    evidence?: unknown;
    followUps?: string[];
  }): Promise<{ ok: true; pin: LocalAiPin; dashboard?: DashboardDocumentResponse['dashboard']; tile?: DashboardDocumentResponse['dashboard']['layout']['items'][number] } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAiPins(appId: string, dashboardId?: string): Promise<LocalAiPin[]> {
    try {
      const search = new URLSearchParams();
      if (dashboardId) search.set('dashboardId', dashboardId);
      const qs = search.toString();
      const { pins } = await request<{ pins: LocalAiPin[] }>(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins${qs ? `?${qs}` : ''}`,
      );
      return pins;
    } catch {
      return [];
    }
  },

  async refreshAiPin(appId: string, pinId: string): Promise<{ ok: boolean; pin?: LocalAiPin; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins/${encodeURIComponent(pinId)}/refresh`,
        { method: 'POST' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async promoteAiPin(appId: string, pinId: string): Promise<{ ok: boolean; pin?: LocalAiPin; blockPath?: string; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins/${encodeURIComponent(pinId)}/promote`,
        { method: 'POST' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async fetchScopedLineage(params: { domain?: string; appId?: string; dashboardId?: string; blockId?: string }): Promise<any | null> {
    try {
      const search = new URLSearchParams();
      if (params.domain) search.set('domain', params.domain);
      if (params.appId) search.set('appId', params.appId);
      if (params.dashboardId) search.set('dashboardId', params.dashboardId);
      if (params.blockId) search.set('blockId', params.blockId);
      return await request<any>(`/api/lineage/scope?${search.toString()}`);
    } catch {
      return null;
    }
  },

  async runDashboard(appId: string, dashboardId: string, variables?: Record<string, unknown>): Promise<DashboardRunResponse | null> {
    try {
      return await request<DashboardRunResponse>(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/run`,
        { method: 'POST', body: JSON.stringify({ variables: variables ?? {} }) },
      );
    } catch {
      return null;
    }
  },

  async saveDashboard(
    appId: string,
    dashboardId: string,
    body: DashboardDocumentResponse['dashboard'],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await request<{ ok: true; path: string }>(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
      return { ok: !!result.ok };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // ── Persona ─────────────────────────────────────────────────────────────

  async getPersona(): Promise<ActivePersona | null> {
    try {
      const { persona } = await request<{ persona: ActivePersona | null }>('/api/persona');
      return persona;
    } catch {
      return null;
    }
  },

  async setPersona(userId: string, appId?: string): Promise<ActivePersona | null> {
    try {
      const { persona } = await request<{ persona: ActivePersona | null }>('/api/persona', {
        method: 'POST',
        body: JSON.stringify({ userId, appId }),
      });
      return persona;
    } catch {
      return null;
    }
  },

  async clearPersona(): Promise<void> {
    try {
      await request('/api/persona', { method: 'DELETE' });
    } catch {
      // best-effort; UI restores owner default on next refresh
    }
  },

  // ── Spec 16 — Skills authoring & management ───────────────────────────────
  // Business-context "skills" the agent applies per question. Project skills are
  // shared; personal skills are bound to one user. These methods are coded to
  // the shared contract — the backend implements the same endpoints. Errors
  // surface to the page (which renders graceful empty/error states), so we do
  // NOT swallow them here.

  /** List all skills (project + personal). → GET /api/skills */
  async getSkills(): Promise<{ skills: Skill[] }> {
    return request<{ skills: Skill[] }>('/api/skills');
  },

  /** Multi-select options for the preferred metrics/blocks fields. → GET /api/skills/options */
  async getSkillOptions(query = ''): Promise<{ metrics: string[]; blocks: string[] }> {
    const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    return request<{ metrics: string[]; blocks: string[] }>(`/api/skills/options${suffix}`);
  },

  /** Create a new skill. → POST /api/skills  body { skill } */
  async createSkill(skill: Skill): Promise<{ skill: Skill }> {
    return request<{ skill: Skill }>('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ skill }),
    });
  },

  /** Update an existing skill. → PUT /api/skills/:id  body { skill } */
  async updateSkill(id: string, skill: Skill): Promise<{ skill: Skill }> {
    return request<{ skill: Skill }>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ skill }),
    });
  },

  /** Delete a skill. → DELETE /api/skills/:id */
  async deleteSkill(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // ── Spec 17 (part B) — Domains CRUD ────────────────────────────────────────
  // A domain is the top of the domain→term→block hierarchy. These are coded to
  // the shared contract — the backend implements the same endpoints. Errors
  // surface to the page (which renders graceful empty/error states), so we do
  // NOT swallow them on create/update/delete. The list call is best-effort so
  // pickers that read it never block their host form.

  /** List all domains with rollup counts. → GET /api/domains */
  async getDomains(): Promise<{ domains: Domain[] }> {
    try {
      return await request<{ domains: Domain[] }>('/api/domains');
    } catch {
      return { domains: [] };
    }
  },

  /** Create a new domain. → POST /api/domains  body { domain } */
  async createDomain(domain: Domain): Promise<{ domain: Domain }> {
    return request<{ domain: Domain }>('/api/domains', {
      method: 'POST',
      body: JSON.stringify({ domain }),
    });
  },

  /** Update an existing domain. → PUT /api/domains/:id  body { domain } */
  async updateDomain(id: string, domain: Domain): Promise<{ domain: Domain }> {
    return request<{ domain: Domain }>(`/api/domains/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ domain }),
    });
  },

  /** Delete a domain. → DELETE /api/domains/:id */
  async deleteDomain(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/domains/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async startContextBootstrap(options: { ai?: boolean } = {}): Promise<ContextBootstrapSession> {
    return request<ContextBootstrapSession>('/api/context-bootstrap', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },

  async getContextBootstrap(id: string): Promise<ContextBootstrapSession> {
    return request<ContextBootstrapSession>(`/api/context-bootstrap/${encodeURIComponent(id)}`);
  },

  async getLatestContextBootstrap(): Promise<ContextBootstrapSession | null> {
    const result = await request<{ session: ContextBootstrapSession | null }>('/api/context-bootstrap/latest');
    return result.session ?? null;
  },

  async saveContextBootstrapSelected(id: string, candidateIds: string[]): Promise<{ id: string; saved: Array<{ id: string; path?: string; status: 'saved' | 'skipped' | 'blocked'; blockers?: string[] }> }> {
    return request(`/api/context-bootstrap/${encodeURIComponent(id)}/save-selected`, {
      method: 'POST',
      body: JSON.stringify({ candidateIds }),
    });
  },
};

export interface ContextBootstrapCandidate {
  id: string;
  kind: 'domain' | 'skill';
  action: 'create' | 'update' | 'unchanged' | 'needs_attention';
  confidence: number;
  evidence: string[];
  notes?: string[];
  domain?: Partial<Domain>;
  skill?: Partial<Skill>;
}

export interface ContextBootstrapSession {
  id: string;
  createdAt: string;
  persistence: 'session-only';
  candidates: ContextBootstrapCandidate[];
  status: 'queued' | 'inventory' | 'grounding' | 'generating' | 'validating' | 'ready' | 'needs_attention';
  ai: { requested: boolean; mode: 'pending' | 'provider' | 'evidence_only'; provider?: string };
  progress: {
    percent: number;
    message: string;
    domains: { total: number; ready: number };
    skills: { total: number; ready: number };
    events: string[];
  };
  warnings?: string[];
}
