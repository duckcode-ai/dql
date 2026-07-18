/**
 * Dynamic-first governed answer loop.
 *
 * Stages:
 *  1) Route intent explicitly. Exact saved-block and KPI definition asks can
 *     use certified artifacts; ad hoc analysis and drillthroughs generate SQL.
 *  2) Gather ranked context (blocks, terms, business views, models, runtime
 *     schema, memories, Skills) and ask the LLM to propose SQL when needed.
 *  3) Execute read-only generated SQL with one repair attempt, then mark the
 *     answer review-required until it is promoted and certified.
 *  4) Always cite the artifacts and context used.
 *
 * The loop is *deterministic* — provider invocation is the only stochastic
 * step. Tests can mock the provider with a canned response and exercise the
 * full pipeline.
 */

import {
  describeDialectForPrompt,
  type SemanticLayer,
  type ResolvedTrustLabel,
  type TrustLabelId,
  type DqlArtifactReference,
  type DQLManifest,
} from '@duckcodeailabs/dql-core';
import type { KGStore } from './kg/sqlite-fts.js';
import type { KGNode, KGNodeKind, KGSearchHit } from './kg/types.js';
import type { AgentProvider, AgentMessage, AgentToolDefinition } from './providers/types.js';
import type { ReasoningEffort } from './providers/reasoning-effort.js';
import type { Skill } from './skills/loader.js';
import { buildSkillBlockHints, buildSkillMetricHints, buildSkillsPrompt, expandQuestionWithSkillVocabulary, selectRelevantSkills } from './skills/loader.js';
import type { AgentMemory } from './memory/sqlite-memory.js';
import type { ConversationSnapshot } from './conversation/snapshot.js';
import type { LocalContextPack, MetadataAgentIntent, MetadataRouteDecision } from './metadata/catalog.js';
import { domainContextSearchDomains, type DomainContextEnvelope } from './domain-context.js';
import type { GeneratedDraftBlock, GeneratedDraftSourceDqlArtifact } from './metadata/drafts.js';
import { deriveGeneratedDraftSlug, renderGeneratedSqlDqlArtifact } from './metadata/drafts.js';
import { buildAnalysisQuestionPlan, type AnalysisQuestionPlan } from './metadata/analysis-planner.js';
import { certifiedFitAllowsTier1, evaluateCertifiedBlockFit } from './metadata/block-fit.js';
import { buildGovernedMetricFirstSql, matchSemanticMetric, metricToGovernedSql, resolveGovernedMetricDefinition, resolveGovernedMetricSql, type MetricMatch } from './metadata/metric-match.js';
import { decideAgentAction, type IntentDecision } from './intent-controller.js';
import type {
  SqlContextValidationCode,
  SqlContextValidationOffending,
} from './metadata/sql-context-validation.js';
import type { GroundingContextExpander } from './grounding/regrounding.js';
import { createContextLedger, type ContextLedger } from './grounding/context-ledger.js';
import { validateAnswerResultShape } from './answer-shape.js';
import { fanoutWarningsForSql } from './metadata/grain-ledger.js';
import { evaluateDbtFirstGeneratedSql } from './metadata/dbt-first-safety.js';
import { planAnalyticalPath, type AnalyticalPathPlan, type AnalyticalPolicyCode } from './metadata/analytical-policy.js';
import { planCertifiedAdaptation, type CertifiedAdaptation } from './metadata/block-adapt.js';
import {
  compactSqlSnippet,
  extractSimpleSelectShape,
  selectExpressionOutputName,
} from './metadata/sql-shape.js';
import {
  composeSemanticQueryForQuestion,
  composeSemanticQueryFromMembers,
  type SemanticBridgeQueryResult,
  type SemanticFilterValueBinding,
} from './semantic-bridge/compose.js';
import { runAgenticToolLoop } from './agentic/tool-loop.js';
import { buildSemanticStageTools } from './agentic/toolset.js';
import { deriveAgenticTrust, type CompiledSemanticRecord } from './agentic/answer-contract.js';
import { selectSemanticMembersViaLlm } from './semantic-bridge/member-select.js';
import { normalizeValueIndexText } from './grounding/value-index.js';
import { questionTypeFromText } from './meaning-resolution.js';
import {
  cascadeTraceToEvidenceRouteSteps,
  createCascadeAnswerResult,
  createCascadeTrace,
  type CascadeAnswerResult,
  type CascadeLane,
} from './cascade/cascade.js';
import { shouldClarifyBeforeGeneration } from './cascade/triage.js';
import { stampTrustLabel } from './trust/stamp.js';
import {
  QUICK_PROMPT_CONTEXT_BUDGET,
  canUseLaneRepair,
  cascadeBudgetTrace,
  createCascadeBudgetState,
  deepAlternativeCountForQuestion,
  promptContextBudgetForQuestion,
  proposalToolBudgetForQuestion,
  recordLaneRepair,
  type CascadeAnalysisDepth,
  type CascadeBudgetTrace,
  type PartialCascadeBudgetModel,
  type PromptContextBudget,
} from './cascade/budgets.js';

export type AnswerKind = 'certified' | 'uncertified' | 'no_answer';
export type AnswerSourceTier = 'certified_artifact' | 'business_context' | 'semantic_layer' | 'dbt_manifest' | 'no_answer';
/**
 * The coarse, host-facing disposition. `policy_blocked` is deliberately distinct
 * from `ambiguous`: an attribution/export/proof policy is a metadata decision,
 * not a request for the analyst to rewrite an otherwise clear question.
 */
export type AnswerRefusalCode = 'grounding_gap' | 'ambiguous' | 'model_declined' | 'provider_error' | 'policy_blocked';
export type AnalysisDepth = CascadeAnalysisDepth;

/**
 * A generated query that was grounded in dbt metadata but cannot be executed as
 * governed SQL because its final v3 relationship check found missing modeling
 * coverage. Hosts may hand this to their bounded exploratory executor; the
 * answer loop deliberately never executes it on this route.
 */
export interface ExploratorySqlCandidate {
  kind: 'dbt_grounded_exploration';
  /** Only absence-of-modeling outcomes are eligible — never an unsafe policy. */
  reason: 'unbound_relation' | 'unplanned_join' | 'relationship_not_certified';
  sql: string;
  message: string;
  /** Bound entity ids, if any, that the v3 guard resolved before it stopped. */
  modeledEntityIds: string[];
  /** Relationships the guard considered; empty means no certified route exists. */
  relationshipIds: string[];
  /** The SQL was NOT executed by the governed generated-SQL lane. */
  executionStatus: 'not_executed';
}

export interface AgentRefusalDetails {
  /**
   * Validator or provider-specific code behind a no-answer outcome. For
   * grounding gaps, this preserves the exact validation code so repair loops can
   * re-ground the named identifier instead of parsing prose.
   */
  code?: AnswerRefusalCode | SqlContextValidationCode | AnalyticalPolicyCode;
  message: string;
  offending?: SqlContextValidationOffending;
}

/**
 * The chosen route, surfaced on EVERY AI result (spec 17, part C) so the UI can
 * show "where the answer came from". `tier` is the coarse route bucket; `ref`
 * names the governed artifact/metric used (e.g. `cumulative_revenue`); `label`
 * is a ready-to-render sentence.
 */
export type AiRouteTier =
  | 'certified_block'
  | 'semantic_metric'
  | 'generated_sql'
  | 'business_context'
  | 'no_answer';

export interface AiRoute {
  tier: AiRouteTier;
  label: string;
  ref?: string;
}
export type AnswerCertification = 'certified' | 'governed' | 'ai_generated' | 'analyst_review_required';
export type AnswerReviewStatus = 'none' | 'governed' | 'draft_ready' | 'analyst_review_required' | 'certified';
export type AgentIntent = MetadataAgentIntent | 'ad_hoc_analysis' | 'drillthrough';

export interface AgentCitation {
  nodeId: string;
  kind: KGNode['kind'] | 'memory' | 'runtime_schema';
  name: string;
  /** Frozen-in-time SHA at the moment of indexing. */
  gitSha?: string;
  sourceTier?: AnswerSourceTier | 'memory';
  provenance?: string;
}

export type AgentEvidenceRouteStatus = 'selected' | 'checked' | 'skipped' | 'failed';
export type AgentEvidenceLineageRole =
  | 'question'
  | 'selected_asset'
  | 'business_context'
  | 'semantic_object'
  | 'source_table'
  | 'consumer'
  | 'memory';

export interface AgentEvidenceRouteStep {
  tool: string;
  status: AgentEvidenceRouteStatus;
  label: string;
  detail?: string;
}

export interface AgentEvidenceAsset {
  nodeId: string;
  kind: KGNode['kind'] | 'memory' | 'question' | 'runtime_schema';
  name: string;
  description?: string;
  sourceTier?: AnswerSourceTier | 'memory' | 'project';
  certification?: TrustLabelId | AnswerCertification | 'uncertified' | 'analyst_review_required';
  provenance?: string;
  sourcePath?: string;
  owner?: string;
  domain?: string;
  status?: string;
}

export interface AgentEvidenceLineageNode extends AgentEvidenceAsset {
  role: AgentEvidenceLineageRole;
}

export interface AgentEvidenceContextItem {
  label: string;
  value: string;
  source?: string;
}

export interface AgentEvidenceToolCall {
  name: string;
  status: Extract<AgentEvidenceRouteStatus, 'checked' | 'failed'>;
  inputSummary?: string;
  outputSummary?: string;
  order: number;
  /** Wall-clock time this tool call took, in ms — surfaces where a slow run spent its time. */
  durationMs?: number;
}

/** Coarse wall-clock spans for the request path, used to diagnose latency regressions. */
export interface AgentEvidenceTiming {
  phase: 'project_state' | 'context_retrieval' | 'source_search' | 'runtime_schema' | 'answer_resolution' | 'total';
  durationMs: number;
  detail?: string;
}

export interface AgentEvidenceOutcome {
  name?: string;
  owner?: string;
  decisionUse?: string;
  reviewCadence?: string;
  caveats?: string[];
}

export interface AgentSchemaColumn {
  name: string;
  type?: string;
  description?: string;
  /** Bounded runtime values that matched the user's question, used only as SQL-generation hints. */
  sampleValues?: string[];
}

/**
 * Physical column names whose sampled runtime values include `value`. Used by the
 * semantic bridge to bind a filter literal to the dimension that actually carries
 * it — a generic, project-agnostic replacement for hard-coded value→dimension maps.
 */
function resolveFilterValueColumns(value: string, schemaContext: AgentSchemaTable[]): string[] {
  return resolveAgentFilterValueBindings(value, schemaContext).map((binding) => binding.column);
}

/**
 * Resolve a user-provided member phrase only against bounded values that were
 * retrieved for eligible schema fields. This is deliberately separate from
 * metadata/object search: the provider never chooses the canonical row value.
 */
export function resolveAgentFilterValueBindings(
  value: string,
  schemaContext: AgentSchemaTable[],
): SemanticFilterValueBinding[] {
  const needle = normalizeValueIndexText(value);
  if (!needle) return [];
  const candidates: Array<SemanticFilterValueBinding & { distance: number }> = [];
  for (const table of schemaContext) {
    for (const column of table.columns) {
      for (const sample of column.sampleValues ?? []) {
        const normalizedSample = normalizeValueIndexText(sample);
        if (!normalizedSample) continue;
        if (normalizedSample === needle) {
          candidates.push({
            column: column.name,
            canonicalValue: sample,
            match: sample === value ? 'exact' : 'normalized',
            confidence: 1,
            distance: 0,
          });
          continue;
        }
        const needleTokens = needle.split(' ').filter(Boolean);
        const sampleTokens = normalizedSample.split(' ').filter(Boolean);
        // A stakeholder often refers to a result member by its distinctive first
        // token ("Melissa") while the warehouse stores the display value as
        // "Melissa Lopez". Treat a strict token subset as a high-confidence fuzzy
        // candidate, but let the runner-up ambiguity guard below reject it when
        // more than one sampled value shares that token.
        if (needleTokens.length < sampleTokens.length
          && needleTokens.every((token) => token.length >= 3 && sampleTokens.includes(token))) {
          candidates.push({
            column: column.name,
            canonicalValue: sample,
            match: 'fuzzy',
            confidence: 0.97,
            distance: sampleTokens.length - needleTokens.length,
          });
          continue;
        }
        if (needleTokens.length !== sampleTokens.length) continue;
        const distance = damerauLevenshteinDistance(needle, normalizedSample);
        const similarity = 1 - (distance / Math.max(needle.length, normalizedSample.length, 1));
        const singleToken = needleTokens.length === 1;
        const threshold = singleToken ? 0.94 : 0.92;
        const maxDistance = singleToken ? 1 : 2;
        const hasExactToken = needleTokens.some((token) => sampleTokens.includes(token));
        if (similarity < threshold || distance > maxDistance || (!singleToken && !hasExactToken)) continue;
        candidates.push({
          column: column.name,
          canonicalValue: sample,
          match: 'fuzzy',
          confidence: Number(similarity.toFixed(4)),
          distance,
        });
      }
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence || a.distance - b.distance || a.column.localeCompare(b.column));
  const best = candidates[0];
  if (!best) return [];
  const runnerUp = candidates.find((candidate) => (
    candidate.column !== best.column
    || normalizeValueIndexText(candidate.canonicalValue) !== normalizeValueIndexText(best.canonicalValue)
  ));
  if (best.match === 'fuzzy' && runnerUp && best.confidence - runnerUp.confidence < 0.08) return [];
  return candidates
    .filter((candidate) => candidate.confidence === best.confidence
      && normalizeValueIndexText(candidate.canonicalValue) === normalizeValueIndexText(best.canonicalValue))
    .map(({ distance: _distance, ...binding }) => binding);
}

function damerauLevenshteinDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost,
      );
      if (row > 1 && column > 1
        && left[row - 1] === right[column - 2]
        && left[row - 2] === right[column - 1]) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + cost);
      }
    }
  }
  return matrix[left.length][right.length];
}

export interface AgentSchemaTable {
  relation: string;
  schema?: string;
  name: string;
  description?: string;
  columns: AgentSchemaColumn[];
  source?: string;
  /** Optional metadata-context rank; lower is better. Used to preserve catalog relation ordering. */
  selectionRank?: number;
  selectionScore?: number;
  selectionReason?: string;
}

export interface AgentAnalysisPlan {
  question: string;
  intent: AgentIntent;
  routeReason: string;
  grain?: string;
  measures: string[];
  dimensions: string[];
  candidateTables: Array<{
    relation: string;
    columns: string[];
    reason?: string;
  }>;
  candidateJoins: AgentJoinPath[];
  trustedContext: Array<{
    kind: KGNode['kind'] | 'memory';
    name: string;
    certification?: TrustLabelId | AnswerCertification | 'uncertified' | 'analyst_review_required';
    sourceTier?: AnswerSourceTier | 'memory' | 'project';
  }>;
  assumptions: string[];
  sql?: string;
  suggestedViz?: string;
  followUps: string[];
  repairAttempts?: number;
}

export interface AgentJoinPath {
  leftRelation: string;
  leftColumn: string;
  rightRelation: string;
  rightColumn: string;
  reason?: string;
}

export interface AgentPriorResultReference {
  id: string;
  question?: string;
  columns: string[];
  rowCount?: number;
  sourceSql?: string;
}

export type AgentDqlArtifactReference = DqlArtifactReference;

export interface AgentFollowUpContext {
  /**
   * 'generic'/'drilldown' — regex-classified follow-ups with routing force.
   * 'contextual' — always-on advisory carry for any question in an ongoing
   * conversation; never excludes artifacts, forces filters, or shifts intent.
   */
  kind: 'generic' | 'drilldown' | 'contextual';
  sourceTurnId?: string;
  sourceBlockName?: string;
  sourceQuestion?: string;
  sourceAnswer?: string;
  filters?: string[];
  dimensions?: string[];
  priorResultColumns?: string[];
  priorResultValues?: Record<string, string[]>;
  priorResultRef?: AgentPriorResultReference;
  priorDqlArtifact?: AgentDqlArtifactReference;
  priorLimit?: number;
  priorMeasures?: string[];
  resolvedReferences?: string[];
  unresolvedReferences?: string[];
}

export interface AgentEvidence {
  route: AgentEvidenceRouteStep[];
  lineage: AgentEvidenceLineageNode[];
  businessContext: AgentEvidenceContextItem[];
  outcome?: AgentEvidenceOutcome;
  selectedAssets: AgentEvidenceAsset[];
  sourceTables: AgentEvidenceAsset[];
  semanticObjects: AgentEvidenceAsset[];
  /** Real provider-visible tool observations, distinct from deterministic route breadcrumbs. */
  toolCalls?: AgentEvidenceToolCall[];
  timings?: AgentEvidenceTiming[];
  validation?: {
    status: 'passed' | 'warning' | 'failed' | 'not_run';
    message: string;
  };
  execution?: {
    status: 'executed' | 'failed' | 'not_requested' | 'not_applicable';
    message: string;
    rowCount?: number;
    executionTime?: number;
  };
  citations: AgentCitation[];
  analysisPlan?: AgentAnalysisPlan;
}

export interface AgentAnswer {
  kind: AnswerKind;
  sourceTier?: AnswerSourceTier;
  certification?: AnswerCertification;
  reviewStatus?: AnswerReviewStatus;
  /** Certification of the governed metric behind a Lane-2 answer (drives 'reviewed' trust). */
  semanticMetricCertification?: string;
  confidence?: number;
  /**
   * P0 intent controller — the high-level action the agent decided this turn
   * deserves (answer / clarify / investigate / compose_app) with a rationale.
   * Advisory: callers route on it (compose_app → app build, investigate → research).
   */
  intentDecision?: IntentDecision;
  /** Final answer text (NL summary). */
  text: string;
  /**
   * Machine-readable reason for no-answer outcomes. This keeps grounding gaps
   * distinct from genuine ambiguity so callers can retry wider instead of asking
   * the user for clarification.
   */
  refusalCode?: AnswerRefusalCode;
  refusalDetails?: AgentRefusalDetails;
  /** Alias for UI envelopes. */
  answer?: string;
  /** Certified path: the matched block. */
  block?: KGNode;
  /** Certified path execution result, when a governed executor is supplied. */
  result?: AgentResultPayload;
  /** Certified path execution failure, if the block matched but execution failed. */
  executionError?: string;
  /** Uncertified path: the LLM-proposed SQL the analyst should review. */
  proposedSql?: string;
  /**
   * A host-executable candidate for bounded, review-required exploration after
   * governed SQL was correctly rejected for missing relationship modeling.
   * Presence is the forward-compatible signal for runtimes; `refusalCode`
   * remains `grounding_gap` for older hosts until they adopt this field.
   */
  exploratoryCandidate?: ExploratorySqlCandidate;
  /** Alias for the structured answer envelope. */
  sql?: string;
  /** Suggested viz type for the proposed SQL (line/bar/single_value/...). */
  suggestedViz?: string;
  /** DQL-first artifact source assembled deterministically for the answer, when available. */
  dqlArtifact?: AgentDqlArtifactReference;
  /** Draft block id/path once a host persists the proposal. */
  draftBlockId?: string;
  draftBlock?: GeneratedDraftBlock;
  promoteCommand?: string;
  /** Legacy free-form trust label string, retained for backward compatibility. */
  trustLabel?: string;
  /**
   * Canonical trust label (base + optional qualifier) drawn from the one shared
   * vocabulary in dql-core, derived from this answer's source tier and review
   * state. Lets every surface render the same label set as the MCP answer
   * contract and the UI badge.
   */
  trustLabelInfo?: ResolvedTrustLabel;
  /**
   * One-line provenance footer (Anthropic pattern): where the answer came from
   * (source tier), how much to trust it, who owns the source, and whether the
   * data is current. Rendered by every surface so a stakeholder can judge an
   * answer at a glance. Undefined for no-answer outcomes.
   */
  provenanceFooter?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  /** Server-resolved domain/purpose scope used before retrieval. */
  domainContext?: DomainContextEnvelope;
  validationWarnings?: string[];
  selectedEvidence?: LocalContextPack['evidenceRoles'];
  citations: AgentCitation[];
  /** Relevant local memory supplied as advisory context. */
  memoryContext?: AgentMemory[];
  /** Approved Hint-Graph corrections that were applied to this answer (for transparency). */
  appliedHints?: LocalContextPack['appliedHints'];
  /** Evidence path connecting the question to metadata, SQL/block execution, and review state. */
  evidence?: AgentEvidence;
  /** Business-facing plan the agent used to answer the question. */
  analysisPlan?: AgentAnalysisPlan;
  /** Provider name used (for telemetry / UI badge). */
  providerUsed?: string;
  /** Local SQLite metadata context pack used to ground retrieval, when supplied by the host. */
  contextPack?: LocalContextPack;
  /** Top KG hits the loop considered, useful for the UI's "we considered" panel. */
  considered: KGSearchHit[];
  /** The Skills that shaped this answer (selected, not all), for transparency. */
  appliedSkills?: Array<{ id: string; description?: string }>;
  /**
   * The chosen route (spec 17, part C). Surfaced on every result so the UI can
   * show which tier answered (certified block, governed semantic metric,
   * generated SQL, business context, or an honest refusal). Computed once at the
   * single exit point in `answer()`.
   */
  route?: AiRoute;
  /** Structured terminal lane chosen by the governed answer cascade. */
  cascade?: CascadeAnswerResult;
  /**
   * Internal: the governed metric the semantic tier matched (spec 17, part C).
   * Used only to build `route` at the `answer()` exit point; not part of the
   * stable public payload.
   */
  _semanticMetricMatch?: MetricMatch;
}

export interface AgentResultPayload {
  columns: unknown[];
  rows: unknown[];
  rowCount: number;
  executionTime?: number;
  chartConfig?: unknown;
  sql?: string;
  blockName?: string;
  blockPath?: string;
  parameters?: Array<{
    name: string;
    value: unknown;
    source: 'policy' | 'explicit' | 'question' | 'surface' | 'default';
  }>;
  auditId?: string;
}

export interface CertifiedBlockInvocationInput {
  question?: string;
  parameters?: Record<string, unknown>;
}

export interface AnswerLoopInput {
  question: string;
  /**
   * Current notebook/app context, such as upstream SQL or selected filters.
   * This is prompt context only. It is intentionally excluded from KG and
   * memory retrieval so transient SQL cannot change governed routing.
   */
  extraContext?: string;
  /** Active user — used for Skills filtering and the "asked by" record. */
  userId?: string;
  /** Domain to scope the search. Optional. */
  domain?: string;
  /** Server-resolved governed scope. Prefer this over the v2 `domain` alias. */
  domainContext?: DomainContextEnvelope;
  /** Caller-supplied provider; the answer-loop never picks one itself. */
  provider: AgentProvider;
  /** Live KG store. */
  kg: KGStore;
  /**
   * Optional compiled project manifest. Manifest v3 contributes explicit
   * relationship proof to the generated-SQL guard; dbt DAG lineage never does.
   */
  manifest?: DQLManifest;
  /** Project + user-level Skills. */
  skills?: Skill[];
  /** Hints to prefer specific blocks first (vocabulary mappings from Skills). */
  blockHints?: string[];
  /**
   * Structured context from the host when the user is following up on a prior
   * answer. Generic follow-ups may reuse the same certified block; drilldowns
   * use the prior block as context but look for a distinct certified path or a
   * review-required draft.
   */
  followUp?: AgentFollowUpContext;
  /**
   * Persisted conversation-thread snapshot (working state + rolling summary +
   * recent turns). Advisory prompt context only — never changes governed routing.
   */
  conversationSnapshot?: ConversationSnapshot;
  /** Optional advisory memory. Never outranks project metadata. */
  memoryContext?: AgentMemory[];
  /** Optional AbortSignal forwarded to the provider. */
  signal?: AbortSignal;
  /**
   * Reasoning effort for the provider calls in this run (low/medium/high). The
   * host resolves it (engine per-route effort clamped by the Settings ceiling)
   * and the answer loop forwards it verbatim; providers no-op when unsupported.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Prompt/context depth. Quick keeps normal Ask AI fast; deep widens metadata
   * rendering for research, diagnostics, or explicitly high-effort runs.
   */
  analysisDepth?: AnalysisDepth;
  /** Qualified candidate IDs selected by the bounded meaning resolver. */
  preferredEvidenceIds?: string[];
  /** Qualified execution ID recommended by meaning resolution. */
  preferredExecutionId?: string;
  /** Optional shared repair/escalation budget model for this answer-loop run. */
  cascadeBudgetModel?: PartialCascadeBudgetModel;
  /**
   * Governed block executor supplied by the CLI/UI/Slack host. The answer loop
   * keeps retrieval deterministic, while hosts enforce persona/RBAC/RLS in the
   * runtime they already own.
   */
  executeCertifiedBlock?: (block: KGNode, invocation?: CertifiedBlockInvocationInput) => Promise<AgentResultPayload>;
  /**
   * Optional host-side generated SQL preview executor. Generated SQL remains
   * AI-generated and review-required; this only lets local hosts show bounded
   * data evidence before an analyst promotes the query into a certified block.
   */
  executeGeneratedSql?: (sql: string) => Promise<AgentResultPayload>;
  captureGeneratedDraft?: (proposal: {
    question: string;
    sql: string;
    intent: AgentIntent;
    followUp?: AgentFollowUpContext;
    contextPack?: LocalContextPack;
    sourceBlock?: KGNode;
    sourceDqlArtifact?: GeneratedDraftSourceDqlArtifact;
    dqlArtifact?: NonNullable<AgentAnswer['dqlArtifact']>;
    proposedEntity?: string;
    requestedFilters?: string[];
    requestedDimensions?: string[];
    validationWarnings: string[];
    outputs?: string[];
  }) => Promise<GeneratedDraftBlock | undefined> | GeneratedDraftBlock | undefined;
  /** Runtime schema/column context supplied by the host for generated analysis. */
  schemaContext?: AgentSchemaTable[];
  /**
   * Optional resolved semantic layer. When supplied, the semantic lane compiles
   * metric/member selections through SemanticLayer.composeQuery before falling
   * back to generated SQL.
   */
  semanticLayer?: SemanticLayer;
  semanticDriver?: string;
  semanticTableMapping?: Record<string, string>;
  /**
   * Optional host-backed catalog/runtime expansion for context-validation misses.
   * The answer loop stays closed-world, but the host can widen the inspected
   * world when the validator names an existing relation or column it did not see.
   */
  expandGroundingContext?: GroundingContextExpander;
  /**
   * Optional bounded tool surface for Lanes 2-3. Providers without native tool
   * support ignore this through the generate() fallback.
   */
  answerLoopTools?: AgentToolDefinition[];
  /** Shared local metadata context pack from `.dql/cache/metadata.sqlite`. */
  contextPack?: LocalContextPack;
}

const CERTIFIED_HIT_THRESHOLD = 0.18;
const HARD_NEGATIVE_RATIO = 0.5;
const EXECUTABLE_ARTIFACT_KINDS: KGNodeKind[] = ['block', 'dashboard', 'app', 'notebook'];
// Dashboards, apps, and notebooks are governed NAVIGATION targets — collections
// of tiles / a standing surface, not an executable data query. They can ground or
// be cited, but they never produce the row-level answer to an analytical question,
// so they must not terminate a data ask as a "certified answer" with no data.
const NAVIGATION_ARTIFACT_KINDS: KGNodeKind[] = ['dashboard', 'app', 'notebook'];
const BUSINESS_CONTEXT_KINDS: KGNodeKind[] = ['term', 'business_view', 'domain', 'skill', 'relationship', 'contract', 'domain_export', 'domain_import', 'conformance', 'evaluation'];
const ARTIFACT_KINDS: KGNodeKind[] = [...EXECUTABLE_ARTIFACT_KINDS, ...BUSINESS_CONTEXT_KINDS];
const SEMANTIC_KINDS: KGNodeKind[] = ['metric', 'dimension', 'measure', 'entity', 'semantic_model', 'saved_query'];
const MANIFEST_KINDS: KGNodeKind[] = ['dbt_model', 'dbt_source'];

function refusalCodeForValidation(code: SqlContextValidationCode | undefined): AnswerRefusalCode {
  if (code === 'unknown_relation' || code === 'unknown_column' || code === 'insufficient_context' || code === 'missing_baseline') {
    return 'grounding_gap';
  }
  if (code === 'ambiguous_filter') return 'ambiguous';
  return 'model_declined';
}

/**
 * An analytical-policy result is never a generic grounding gap. A missing
 * relation/path can enter the bounded exploratory lane; every other result is
 * an explicit governance boundary that the host must surface without retrying
 * the same candidate or asking the user a misleading clarification question.
 */
function refusalCodeForAnalyticalPolicy(
  code: AnalyticalPolicyCode | undefined,
  hasExploratoryCandidate = false,
): AnswerRefusalCode {
  if (hasExploratoryCandidate || code === 'unbound_relation' || code === 'unplanned_join' || code === 'relationship_not_certified') {
    return 'grounding_gap';
  }
  return 'policy_blocked';
}

/**
 * The governed guard is intentionally strict. Only the two outcomes that mean
 * "this repository has not modeled this join yet" may be handed to a host's
 * exploratory lane. All other decisions are explicit governance/safety
 * denials and must remain terminal in this loop.
 */
function exploratoryCandidateFromDbtFirstGuard(
  sql: string,
  decision: ReturnType<typeof evaluateDbtFirstGeneratedSql>,
): ExploratorySqlCandidate | undefined {
  const reason = decision.code;
  if (decision.safe || (reason !== 'unbound_relation' && reason !== 'unplanned_join' && reason !== 'relationship_not_certified')) {
    return undefined;
  }
  // `unplanned_join` can also mean the model ignored an existing certified
  // relationship plan. That is a governed-query error, not missing modeling,
  // and must remain blocked. It is exploratory only when no plan was resolved.
  if (decision.code === 'unplanned_join' && decision.relationshipIds.length > 0) {
    return undefined;
  }
  return {
    kind: 'dbt_grounded_exploration',
    reason,
    sql,
    message: decision.message
      ?? 'This query is grounded in dbt metadata but has no certified DQL relationship path yet.',
    modeledEntityIds: decision.entities,
    relationshipIds: decision.relationshipIds,
    executionStatus: 'not_executed',
  };
}

function formatOffendingValidationToken(offending: SqlContextValidationOffending | undefined): string {
  if (!offending?.relation && !offending?.column) return '';
  const parts = [
    offending.relation ? `relation=${offending.relation}` : undefined,
    offending.column ? `column=${offending.column}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `Offending metadata token: ${parts.join(', ')}`;
}

function formatValidationWarningsForPrompt(warnings: string[]): string {
  const useful = warnings.filter((warning) => warning.trim().length > 0).slice(0, 6);
  return useful.length > 0 ? `Additional inspected-context notes:\n${useful.map((warning) => `- ${warning}`).join('\n')}` : '';
}

/**
 * Central honesty gate — applied once at the single answer() exit so EVERY return
 * site (certified, semantic-metric, generated) is covered by construction. A DATA
 * answer must have PRODUCED ROWS: when execution was attempted (a result or an
 * execution error came back) but no rows resulted, it may never read as a confident
 * answer.
 *  - A generated / governed-metric (uncertified) answer downgrades to a low-
 *    confidence, review-required no-data state with an honest message — the SQL is
 *    still surfaced so the user can inspect and fix it.
 *  - A CERTIFIED block keeps its badge (an empty certified result can be a correct
 *    "none matched" answer) but gains a non-blocking note to verify data currency.
 * An UN-executed answer (offline SQL preview / certified citation with no executor)
 * is left untouched — that is a legitimate preview, not a hollow answer.
 */
function applyHollowAnswerGate(result: AgentAnswer): AgentAnswer {
  if (result.kind === 'no_answer') return result;
  const attempted = result.result !== undefined || result.executionError !== undefined;
  const producedRows = Boolean(result.result && typeof result.result.rowCount === 'number' && result.result.rowCount > 0);
  if (!attempted || producedRows) return result;

  if (result.kind === 'certified') {
    const note = result.executionError
      ? 'This certified block failed to execute — review the source data before relying on it.'
      : 'This certified block returned 0 rows — verify the source data is current before relying on it.';
    return {
      ...result,
      text: [result.text, note].filter(Boolean).join('\n\n'),
      answer: [result.answer ?? result.text, note].filter(Boolean).join('\n\n'),
      validationWarnings: [...(result.validationWarnings ?? []), note],
    };
  }

  const honestText = [
    result.executionError
      ? `The governed query could not be executed (${result.executionError}).`
      : 'The governed query executed but returned no rows.',
    'This usually means a filter, grain, or join is off — review the SQL preview and refine before reuse.',
  ].join('\n\n');
  const warning = result.executionError
    ? 'The governed query failed to execute and returned no data — review before reuse.'
    : 'The governed query executed but returned no rows — review the SQL, filters, and joins before reuse.';
  return {
    ...result,
    reviewStatus: 'analyst_review_required',
    confidence: Math.min(result.confidence ?? 0.2, 0.2),
    text: honestText,
    answer: honestText,
    validationWarnings: [...(result.validationWarnings ?? []), warning],
  };
}

export async function answer(input: AnswerLoopInput): Promise<AgentAnswer> {
  const result = applyHollowAnswerGate(await runAnswerLoop(input));
  // Attach the canonical trust label once, at the single exit point, so every
  // return site inside runAnswerLoop stays untouched and backward compatible.
  // Freshness-aware trust: for a certified answer, fold the source block's data
  // health (stale/failed upstream) into the label so it reads "Certified ·
  // stale data" / "Certified · upstream failed". Non-certified or fresh answers
  // are unaffected.
  const { _semanticMetricMatch, ...publicResult } = result;
  const chosenRoute = result.route ?? deriveAiRoute(result, _semanticMetricMatch);
  // P0 — record the high-level action this turn warranted, so callers can route
  // (compose_app → app build, investigate → research) and the UI can show the
  // agent's reasoning. Computed once at the single exit from the finished answer.
  const tier = chosenRoute?.tier;
  const intentDecision = decideAgentAction({
    question: input.question,
    intent: tier === 'no_answer' ? 'clarify' : 'ad_hoc_ranking',
    signals: {
      certifiedScore: tier === 'certified_block' ? 0.9 : 0,
      metricScore: tier === 'semantic_metric' ? 0.9 : 0,
      hasRetrieval: (result.considered?.length ?? 0) > 0,
      missingContext: tier === 'no_answer' ? ['Need a clearer business object, measure, or grain before answering.'] : [],
    },
    isFollowUp: Boolean(input.followUp),
  });
  const trustLabelInfo = stampTrustLabel(result);
  return {
    ...publicResult,
    domainContext: input.domainContext,
    intentDecision,
    trustLabelInfo,
    provenanceFooter: buildProvenanceFooter(result, trustLabelInfo),
    cascade: publicResult.cascade ?? createCascadeAnswerResult({
      routeTier: chosenRoute.tier,
      label: chosenRoute.label,
      ref: chosenRoute.ref,
      artifactKind: result.dqlArtifact?.kind,
      refusalCode: result.refusalCode,
      reason: result.refusalDetails?.message ?? (result.kind === 'no_answer' ? result.text : undefined),
      rowCount: result.result?.rowCount,
      executionStatus: cascadeExecutionStatus(result),
      draftBlockId: result.draftBlockId ?? result.draftBlock?.path,
      metrics: result.dqlArtifact?.metrics,
      dimensions: result.dqlArtifact?.dimensions,
      hasSqlPreview: Boolean(result.proposedSql ?? result.sql),
    }),
    // Stamp the SELECTED skills that shaped the answer (transparency). Computed
    // here so every return site inside runAnswerLoop stays untouched.
    appliedSkills:
      result.appliedSkills ??
      selectRelevantSkills(input.skills ?? [], input.question, {
        userId: input.userId ?? null,
        modelAreaIds: input.domainContext?.modelAreaId ? [input.domainContext.modelAreaId] : [],
        domains: Array.from(new Set([
          ...domainContextSearchDomains(input.domainContext),
          ...(input.domain ? [input.domain] : []),
          ...(input.contextPack?.objects ?? []).slice(0, 20).flatMap((object) => object.domain ? [object.domain] : []),
        ])),
      }).map((s) => ({
        id: s.id,
        description: s.description,
      })),
    // Stamp the chosen route once, at the single exit point, so every return
    // site inside runAnswerLoop stays untouched (spec 17, part C).
    route: chosenRoute,
  };
}

function cascadeExecutionStatus(result: AgentAnswer): 'executed' | 'failed' | 'not_requested' | 'not_applicable' {
  if (result.kind === 'no_answer') return 'not_applicable';
  if (result.executionError) return 'failed';
  if (result.result) return 'executed';
  if (result.block || result.dqlArtifact || result.proposedSql || result.sql) return 'not_requested';
  return 'not_applicable';
}

/**
 * Derive the UI-facing route from a finished answer (spec 17, part C). The
 * semantic-metric tier is named explicitly when the loop matched a governed
 * metric; otherwise the route is mapped from the answer's source tier / kind.
 */
function deriveAiRoute(result: AgentAnswer, metricMatch?: MetricMatch): AiRoute {
  if (result.kind === 'no_answer') {
    if (result.exploratoryCandidate) {
      return {
        tier: 'no_answer',
        label: 'Governed SQL stopped at missing relationship modeling; a DBT-grounded exploratory candidate is ready for bounded validation.',
      };
    }
    return { tier: 'no_answer', label: 'No governed answer — needs more context or review.' };
  }
  if (result.kind === 'certified') {
    if (result.sourceTier === 'business_context') {
      const ref = result.citations[0]?.name;
      return {
        tier: 'business_context',
        label: ref ? `Answered from certified business context ${ref}` : 'Answered from certified business context',
        ref,
      };
    }
    const ref = result.sourceCertifiedBlock ?? result.block?.name ?? result.citations[0]?.name;
    return {
      tier: 'certified_block',
      label: ref ? `Answered from certified block ${ref}` : 'Answered from a certified block',
      ref,
    };
  }
  // Uncertified: a governed metric matched → semantic_metric; else generated preview.
  if (result.sourceTier === 'semantic_layer' && metricMatch) {
    return {
      tier: 'semantic_metric',
      label: `Answered from metric ${metricMatch.metric.name}`,
      ref: metricMatch.metric.name,
    };
  }
  return result.dqlArtifact
    ? { tier: 'generated_sql', label: 'Prepared review-required DQL artifact with SQL preview.' }
    : { tier: 'generated_sql', label: 'Prepared review-required SQL preview.' };
}

async function runAnswerLoop(input: AnswerLoopInput): Promise<AgentAnswer> {
  const { question, userId, domain, provider, kg, skills = [], blockHints = [] } = input;
  // AGT-004: with no explicit domain selection, let direct question evidence
  // establish a narrow prompt boundary before broad retrieval can introduce an
  // unrelated domain. This is deliberately a prompt/retrieval preference, not
  // an authorization decision; the final manifest guard remains authoritative.
  const directQuestionEntityIds = input.manifest
    ? inferAnalyticalEntityIds(question, [], input.manifest)
    : [];
  const directQuestionDomains = input.manifest?.modeling
    ? Array.from(new Set(directQuestionEntityIds.map((id) => input.manifest!.modeling!.entities[id]?.domain).filter((value): value is string => Boolean(value))))
    : [];
  const hasExplicitDomainScope = Boolean(input.domain || input.domainContext?.activeDomain);
  const questionDomainScope = hasExplicitDomainScope ? [] : directQuestionDomains;
  const scopedContextPack = questionDomainScope.length > 0
    ? scopeContextPackToQuestionDomains(input.contextPack, questionDomainScope, input.manifest)
    : input.contextPack;
  // Select the RELEVANT skills (not all) for this question; keep pinned project
  // skills (SQL conventions). Block hints still come from the full set so a
  // preferred-block mapping is never lost.
  const authorizedDomains = domainContextSearchDomains(input.domainContext);
  const inferredDomains = Array.from(new Set([
    ...authorizedDomains,
    ...questionDomainScope,
    ...(domain ? [domain] : []),
    ...(questionDomainScope.length === 0
      ? (input.contextPack?.objects ?? []).slice(0, 20).flatMap((object) => object.domain ? [object.domain] : [])
      : []),
  ]));
  const selectedSkills = selectRelevantSkills(skills, question, {
    userId: userId ?? null,
    domains: inferredDomains,
    modelAreaIds: input.domainContext?.modelAreaId ? [input.domainContext.modelAreaId] : [],
  });
  const effectiveBlockHints = Array.from(new Set([
    ...blockHints,
    // Only selected skills may influence block ranking. Previously a preferred
    // block from any active but unrelated domain skill could jump to the front.
    ...buildSkillBlockHints(selectedSkills, userId ?? null),
  ]));
  const effectiveMetricHints = buildSkillMetricHints(selectedSkills, userId ?? null);
  const semanticQuestion = expandQuestionWithSkillVocabulary(question, selectedSkills, userId ?? null);
  const followUpSourceBlock = input.followUp?.sourceBlockName
    ? kg.getNode(`block:${input.followUp.sourceBlockName}`)
    : null;
  const excludedArtifactIds = input.followUp?.kind === 'drilldown' && followUpSourceBlock
    ? new Set([followUpSourceBlock.nodeId])
    : undefined;

  const searchScope = authorizedDomains.length > 0 ? { domains: authorizedDomains } : { domain };
  const executableArtifactHits = kg.search({ query: question, ...searchScope, kinds: EXECUTABLE_ARTIFACT_KINDS, limit: 10 });
  const businessHits = kg.search({ query: question, ...searchScope, kinds: BUSINESS_CONTEXT_KINDS, limit: 10 });
  const artifactHits = mergeHits(executableArtifactHits, businessHits).slice(0, 12);
  const semanticHits = kg.search({ query: question, ...searchScope, kinds: SEMANTIC_KINDS, limit: 12 });
  const manifestHits = kg.search({ query: question, ...searchScope, kinds: MANIFEST_KINDS, limit: 12 });
  const considered = mergeHits(
    artifactHits,
    semanticHits,
    manifestHits,
    kg.search({ query: question, domain, limit: 10 }),
  ).slice(0, 30);
  const schemaContext = schemaContextWithAllowedSqlContext(
    schemaContextWithinQuestionScope(input.schemaContext ?? [], input.contextPack, scopedContextPack),
    scopedContextPack,
  );
  const catalogRoute = input.contextPack?.routeDecision;
  const questionPlan = input.contextPack?.questionPlan?.requestedShape
    ? input.contextPack.questionPlan
    : buildAnalysisQuestionPlan(question, input.followUp);
  // Retrieval may surface a high-trust block because its source tables and
  // vocabulary overlap the question even when its output contract does not.
  // Keep such candidates in the audit trail, but do not put their SQL or a stale
  // "exact certified" route into the generation prompt. The model should decide
  // from compatible certified evidence, semantic members, and dbt/runtime
  // columns—not copy a customer-grain worked example into a product-grain ask.
  const promptContextPack = contextPackForRequestedShape(
    scopedContextPack,
    question,
    questionPlan,
    kg,
  );
  const repairBudgetState = createCascadeBudgetState(input.cascadeBudgetModel);
  const fallbackIntent = classifyAgentIntent({
    question,
    followUp: input.followUp,
    artifactHits,
    semanticHits,
    manifestHits,
    schemaContext,
  });
  let intent = catalogRoute ? agentIntentFromCatalogRoute(catalogRoute) : fallbackIntent;

  // Resolve a governed metric before accepting a catalog-proposed certified
  // block. Catalog token overlap can call a generic word such as "total" an
  // exact block match (for example total tax → total revenue); the metric match
  // is the precise measure signal that prevents that wrong Tier-1 shortcut.
  const semanticMetricNodes = collectMetricCandidates(semanticHits, considered, kg);
  for (const metric of effectiveMetricHints) {
    const node = kg.getNode(`metric:${metric}`);
    if (node && !semanticMetricNodes.some((candidate) => candidate.nodeId === node.nodeId)) semanticMetricNodes.push(node);
  }
  const preferredSemanticMetric = resolvePreferredSemanticMetric(
    [input.preferredExecutionId, ...(input.preferredEvidenceIds ?? [])],
    semanticMetricNodes,
    kg,
  );
  let semanticMetricMatch = preferredSemanticMetric
    ? { metric: preferredSemanticMetric, score: 1, basis: 'name' as const }
    : await matchSemanticMetric(semanticQuestion, semanticMetricNodes, {
        measureTerms: [...questionPlan.requestedShape.measures, ...questionPlan.metricTerms],
      }).catch(() => null);

  // Stage 1: certified artifact match. Blocks can be executed; dashboards,
  // Apps, and notebooks are returned as governed citations/navigation targets.
  const drilldownCertifiedHit = input.followUp?.kind === 'drilldown'
    ? pickCertifiedDrilldownArtifact({
        executableArtifactHits,
        question,
        questionPlan,
        followUp: input.followUp,
        excludedArtifactIds,
        kg,
      })
    : null;
  const shouldTryCertifiedRoute = shouldUseCertifiedRoute(catalogRoute, intent);
  const catalogCertifiedHit = shouldTryCertifiedRoute
    ? certifiedHitFromContextPack(input.contextPack, kg)
    : null;
  // Catalog route scores are retrieval evidence, not permission to execute a
  // block. Always enforce the output/grain/filter contract—even when no semantic
  // metric happened to match. Previously this guard only ran when Lane 2 had a
  // metric, so a high-scoring `top_beverage_customers` catalog hit could answer a
  // product-type → product-name flow request with customer rows.
  const unsafeCatalogCertifiedHit = catalogCertifiedHit?.node.kind === 'block'
    && !hasCertifiedNodeFit(question, questionPlan, catalogCertifiedHit.node)
    ? null
    : catalogCertifiedHit;
  const fallbackCertifiedHit = shouldTryCertifiedRoute ? pickCertifiedArtifact({
          artifactHits,
          executableArtifactHits,
          businessHits,
          question,
          questionPlan,
          blockHints: input.followUp?.kind === 'drilldown' ? [] : effectiveBlockHints,
          excludedArtifactIds,
          kg,
        }) : null;
  let artifactHit = drilldownCertifiedHit ?? unsafeCatalogCertifiedHit
    ?? (catalogCertifiedHit ? null : fallbackCertifiedHit);
  // Certified remains first when it actually covers the question. If the
  // retrieved block does not fit but a governed semantic metric does, never
  // let the broad catalog match pre-empt Lane 2.
  // A certified TERM / BUSINESS VIEW is documentation, not data: it can be the
  // terminal answer only for a definition-style question with no data ask. A
  // question that requests a data shape (dimensions/measures/outputs/top-N) or
  // continues an ongoing data conversation must be ANSWERED WITH DATA — the
  // matched business context falls through as grounding for the executable
  // tiers (certified block → governed metric → generated SQL), never instead
  // of them. "Certified" always means "a governed, executable definition
  // produced this result", not "a certified document sounded related".
  const businessContextTerminal = (() => {
    if (!artifactHit || artifactHit.node.kind === 'block') return true;
    // An ongoing data conversation (prior turn produced result columns/values)
    // must be answered with data even when the phrasing looks definitional
    // ("so Matthew is the top — what is his 360 profile view?").
    if (input.followUp?.priorResultValues || input.followUp?.priorResultColumns?.length) return false;
    // A dashboard / app / notebook is a NAVIGATION target, not executable data.
    // It can only terminate a question that explicitly asks to open/see THAT
    // artifact by name ("open the Jaffle Growth Command Center"); any analytical
    // ask ("top customers who bought the top products with revenue") must fall
    // through to the executable + generated tiers and use the artifact only as
    // grounding — never returned as a no-data "certified answer".
    if (NAVIGATION_ARTIFACT_KINDS.includes(artifactHit.node.kind)) {
      return objectNameInQuestion(question, artifactHit.node);
    }
    // Terms, skills, domains, relationships, and business views are grounding
    // documents, not executable data. They may terminate only when the user
    // explicitly names the object in a definition request ("what is Revenue
    // Health?"). A broad lexical match must never turn an analytical question
    // into a no-data Certified answer merely because it starts with "what is".
    return isPureBusinessDefinitionQuestion(question)
      && objectNameInQuestion(question, artifactHit.node);
  })();
  if (artifactHit && businessContextTerminal) {
    let result: AgentResultPayload | undefined;
    let executionError: string | undefined;
    if (artifactHit.node.kind === 'block' && input.executeCertifiedBlock) {
      try {
        result = await input.executeCertifiedBlock(artifactHit.node, { question });
        result = trimResultToRequestedTopN(result, questionPlan);
      } catch (err) {
        executionError = err instanceof Error ? err.message : String(err);
      }
    }
    const missingParameters = /^I need values for:\s*(.+?)\.?$/i.exec(executionError ?? '')?.[1]
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
    if (missingParameters.length > 0) {
      const text = `The certified block "${artifactHit.node.name}" needs ${missingParameters.join(', ')} before it can run. Please provide ${missingParameters.length === 1 ? 'that value' : 'those values'}; I will reuse the same certified block.`;
      const citations: AgentCitation[] = [{
        nodeId: artifactHit.node.nodeId,
        kind: artifactHit.node.kind,
        name: artifactHit.node.name,
        gitSha: artifactHit.node.gitSha,
        sourceTier: 'certified_artifact',
        provenance: artifactHit.node.provenance,
      }];
      const analysisPlan = buildAnalysisPlan({
        question,
        intent: 'clarify',
        routeReason: 'A certified block matched, but a required values-only parameter is unresolved.',
        selectedNodes: [artifactHit.node],
        schemaContext,
        assumptions: [`Required parameter values: ${missingParameters.join(', ')}.`],
      });
      return {
        kind: 'no_answer',
        sourceTier: 'certified_artifact',
        certification: 'analyst_review_required',
        reviewStatus: 'none',
        confidence: 0.95,
        text,
        answer: text,
        block: artifactHit.node,
        executionError,
        sourceCertifiedBlock: artifactHit.node.name,
        contextPackId: input.contextPack?.id,
        citations,
        memoryContext: input.memoryContext,
        analysisPlan,
        evidence: buildNoAnswerEvidence({
          question,
          reason: text,
          artifactHits,
          businessHits,
          semanticHits,
          manifestHits,
          considered,
          memoryContext: input.memoryContext ?? [],
          analysisPlan,
          budgetTrace: cascadeBudgetTrace(repairBudgetState),
        }),
        contextPack: input.contextPack,
        considered,
        providerUsed: provider.name,
      };
    }
    const resultShapeWarnings = result ? validateAnswerResultShape(questionPlan, result).warnings : [];
    // When a certified block's execution was ATTEMPTED and FAILED, the answer
    // cannot wear the certified badge — a failed run has no data to stand behind.
    // Downgrade to analyst_review_required (the error is surfaced in the text).
    // Note: a matched-but-unexecuted block (no executor / dry-run) legitimately
    // stays a certified *citation* — non-execution is a separate axis surfaced via
    // cascade.executionStatus ('not_requested') and freshness dataState, not a
    // reason to strip source trust.
    const certifiedShapePassed = executionError === undefined && resultShapeWarnings.length === 0;
    const certifiedText = composeCertifiedAnswer(artifactHit.node, question, result, executionError);
    const text = resultShapeWarnings.length > 0
      ? `${certifiedText}\n\nReview required: ${resultShapeWarnings.join(' ')}`
      : certifiedText;
    const sourceTier: AnswerSourceTier = artifactHit.node.sourceTier === 'business_context'
      ? 'business_context'
      : 'certified_artifact';
    const citations: AgentCitation[] = [
      {
        nodeId: artifactHit.node.nodeId,
        kind: artifactHit.node.kind,
        name: artifactHit.node.name,
        gitSha: artifactHit.node.gitSha,
        sourceTier,
        provenance: artifactHit.node.provenance,
      },
    ];
    const analysisPlan = buildAnalysisPlan({
      question,
      intent,
      routeReason: catalogRoute?.reason ?? 'The question matched a certified DQL artifact closely enough to answer without generating new SQL.',
      selectedNodes: [artifactHit.node],
      schemaContext,
      sql: result?.sql,
      suggestedViz: result?.chartConfig ? chartNameFromConfig(result.chartConfig) : undefined,
    });
    const dqlArtifact = buildCertifiedBlockDqlArtifact(artifactHit.node, result);
    return {
      kind: certifiedShapePassed ? 'certified' : 'uncertified',
      sourceTier,
      certification: certifiedShapePassed ? 'certified' : 'analyst_review_required',
      reviewStatus: certifiedShapePassed ? 'certified' : 'analyst_review_required',
      confidence: certifiedShapePassed ? 0.95 : 0.45,
      text,
      answer: text,
      block: artifactHit.node.kind === 'block' ? artifactHit.node : undefined,
      result,
      executionError,
      sql: result?.sql,
      dqlArtifact,
      trustLabel: certifiedShapePassed ? input.contextPack?.trustLabel ?? 'certified' : 'mixed',
      sourceCertifiedBlock: artifactHit.node.kind === 'block' ? artifactHit.node.name : undefined,
      contextPackId: input.contextPack?.id,
      validationWarnings: resultShapeWarnings,
      selectedEvidence: input.contextPack?.evidenceRoles?.slice(0, 12),
      citations,
      memoryContext: input.memoryContext,
      analysisPlan,
      evidence: buildCertifiedEvidence({
        question,
        artifact: artifactHit.node,
        businessHits,
        semanticHits,
        manifestHits,
        considered,
        result,
        executionError,
        resultShapeWarnings,
        executorWasAvailable: Boolean(input.executeCertifiedBlock),
        citations,
        memoryContext: input.memoryContext ?? [],
        analysisPlan,
      }),
      contextPack: input.contextPack,
      considered,
      providerUsed: provider.name,
    };
  }

  // Spec 17, part C — SEMANTIC-METRIC MATCHING. Must run BEFORE the clarify
  // short-circuit: FTS alone misses clear metric questions ("total revenue" never
  // literally names a metric), so a clarify route would otherwise refuse a question
  // a governed metric can answer. Match by name + synonyms + measure family + hybrid
  // rank over the FTS semantic hits, then ALL metric KG nodes (revenue ⇄
  // cumulative_revenue). Certified-first is still preserved (checked above).
  const clarifyBeforeGeneration = shouldClarifyBeforeGeneration({
    intent,
    routeDecision: catalogRoute,
    hasSemanticMetricMatch: Boolean(semanticMetricMatch),
    schemaContextCount: schemaContext.length,
    allowedRelationCount: input.contextPack?.allowedSqlContext?.relations.length ?? 0,
    sourceBlockSqlCount: input.contextPack?.allowedSqlContext?.sourceBlockSql.length ?? 0,
    metadataObjectCount: considered.length,
  });

  // Clarify only when there is ALSO no confident governed-metric match and no
  // usable schema/catalog context. A conservative catalog "clarify" decision is
  // not a terminal lane if runtime or SQL context can still answer with review.
  if (clarifyBeforeGeneration) {
    const text = composeCatalogClarificationText(question, catalogRoute) ?? composeClarificationText(question, considered, schemaContext);
    const analysisPlan = buildAnalysisPlan({
      question,
      intent,
      routeReason: catalogRoute?.reason ?? 'No certified artifact, semantic object, dbt/source table, or runtime schema match was strong enough to safely generate SQL.',
      selectedNodes: considered.slice(0, 4).map((hit) => hit.node),
      schemaContext,
      assumptions: catalogRoute?.missingContext.length
        ? catalogRoute.missingContext.map((item) => item.message)
        : ['Need a clearer business object, measure, or grain before querying.'],
    });
    return {
      kind: 'no_answer',
      sourceTier: 'no_answer',
      certification: 'analyst_review_required',
      reviewStatus: 'none',
      confidence: 0.15,
      text,
      answer: text,
      citations: [],
      memoryContext: input.memoryContext,
      analysisPlan,
      evidence: buildNoAnswerEvidence({
        question,
        reason: text,
        artifactHits,
        businessHits,
        semanticHits,
        manifestHits,
        considered,
        memoryContext: input.memoryContext ?? [],
        analysisPlan,
        budgetTrace: cascadeBudgetTrace(repairBudgetState),
      }),
      contextPack: input.contextPack,
      considered,
      providerUsed: provider.name,
    };
  }
  if (intent === 'clarify') intent = questionPlan.routeIntent;

  // Stage 2/3: generate only after certified artifacts miss. Semantic context
  // wins over raw dbt manifest context; memory is appended last as advisory.
  // A confident metric match forces the semantic tier even when FTS returned no
  // semantic hits, so the governed metric (not refusal) answers the question.
  const activeTier: AnswerSourceTier = sourceTierFromContextPack(input.contextPack)
    ?? (semanticHits.length > 0 || semanticMetricMatch
      ? 'semantic_layer'
      : manifestHits.length > 0
        ? 'dbt_manifest'
        : 'dbt_manifest');
  const reviewRequiredArtifactHits = artifactHits
    .filter((hit) => hit.score >= CERTIFIED_HIT_THRESHOLD && !isCertifiedHit(hit, kg))
    .slice(0, 4);
  const trustedArtifactContext = rankGeneratedContextHits(
    executableArtifactHits.filter((hit) => !excludedArtifactIds?.has(hit.node.nodeId)),
    schemaContext,
    question,
  )
    .filter((hit) => !excludedArtifactIds?.has(hit.node.nodeId))
    .slice(0, 5);
  // When a governed metric matched (spec 17, part C), pin it at the front of the
  // semantic context so the generated SQL is grounded on the metric definition.
  const matchedMetricHit: KGSearchHit[] = semanticMetricMatch
    ? [{ node: semanticMetricMatch.metric, score: Math.max(semanticMetricMatch.score, CERTIFIED_HIT_THRESHOLD) }]
    : [];
  // Reserve prompt slots per source instead of appending semantic hits LAST and
  // truncating the whole list to 14 — the old behavior dropped semantic-model hits
  // out of the generation prompt entirely whenever artifact/business hits filled
  // the budget first, so even a question a semantic metric could answer never saw
  // the metric. Each group gets a guaranteed minimum; leftover budget is filled
  // round-robin. See interleaveContextHits.
  const contextHits = activeTier === 'semantic_layer'
    ? interleaveContextHits([
        { hits: matchedMetricHit, reserve: matchedMetricHit.length },
        { hits: semanticHits, reserve: 5 },
        { hits: trustedArtifactContext, reserve: 3 },
        { hits: reviewRequiredArtifactHits, reserve: 2 },
        { hits: businessHits.slice(0, 4), reserve: 2 },
        { hits: manifestHits, reserve: 2 },
      ], 14)
    : interleaveContextHits([
        { hits: trustedArtifactContext, reserve: 5 },
        { hits: reviewRequiredArtifactHits, reserve: 3 },
        { hits: businessHits.slice(0, 4), reserve: 3 },
        { hits: manifestHits, reserve: 3 },
      ], 14);
  const contextNodes = mergeNodes(
    followUpSourceBlock && input.followUp?.kind === 'drilldown' ? [followUpSourceBlock] : [],
    (contextHits.length > 0 ? contextHits : considered.slice(0, 6)).map((h) => h.node),
  ).filter((node) => questionDomainScope.length === 0 || !node.domain || questionDomainScope.includes(node.domain));
  const kgJoinPathHints = buildKgJoinPathHints(kg, contextNodes, questionPlan);
  const contextBlocks = contextNodes.filter((node) => {
    if (node.kind !== 'block') return false;
    if (node.status !== 'certified') return true;
    const fit = evaluateCertifiedBlockFit({ question, plan: questionPlan, block: node });
    return fit.kind === 'exact' || fit.kind === 'trim_safe';
  });
  const contextBusiness = contextNodes.filter((n) => BUSINESS_CONTEXT_KINDS.includes(n.kind));
  const contextOther = contextNodes.filter((n) => n.kind !== 'block' && !BUSINESS_CONTEXT_KINDS.includes(n.kind));
  const promptBudget = promptContextBudgetForQuestion({
    questionPlan,
    requestedDepth: input.analysisDepth,
    reasoningEffort: input.reasoningEffort,
  });

  const messages: AgentMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  const skillsPrompt = buildSkillsPrompt(selectedSkills, userId ?? null);
  if (skillsPrompt) messages.push({ role: 'system', content: skillsPrompt });
  const analyticalPlan = input.manifest
    ? planAnalyticalPath(input.manifest, {
        entityIds: inferAnalyticalEntityIds(question, contextNodes, input.manifest),
        ownerDomain: input.domainContext?.activeDomain ?? input.domain,
        purpose: input.domainContext?.purpose,
        domainContext: input.domainContext,
      })
    : undefined;
  const analyticalPlanPrompt = renderAnalyticalPlanPrompt(analyticalPlan);
  if (analyticalPlanPrompt) messages.push({ role: 'system', content: analyticalPlanPrompt });
  if (questionDomainScope.length > 0) {
    messages.push({
      role: 'system',
      content: [
        'QUESTION DOMAIN BOUNDARY (authoritative for this generation):',
        `The question is directly grounded in: ${questionDomainScope.join(', ')}.`,
        'Use only relations and business context from those domains plus unscoped runtime/dbt relations supplied below.',
        'Do not introduce, search for, or join another domain (including cross-domain acquisition/attribution paths) unless the user explicitly asks for that business concept or supplies a domain/purpose.',
        'If the required relation is not modeled in this domain, prefer the bounded DBT-grounded exploratory candidate over an unrelated cross-domain relationship.',
      ].join('\n'),
    });
  }

  messages.push({
    role: 'system',
    content: renderContextPrompt(
      contextBlocks,
      contextBusiness,
      contextOther,
      activeTier,
      input.memoryContext ?? [],
      input.extraContext,
      input.followUp,
      schemaContext,
      intent,
      promptContextPack,
      input.conversationSnapshot,
      kgJoinPathHints,
      promptBudget,
      input.semanticDriver,
    ),
  });
  messages.push({ role: 'user', content: question });

  // ── Tier 2: semantic-layer metrics + dimensions (governed hierarchy) ──────
  // Certified blocks already missed (Stage 1). Before LLM generation, a
  // confidently matched governed metric whose definition can
  // express the question's full requested shape (scalar KPI, or a group-by whose
  // dimensions all resolve to columns on the metric's own table) answers
  // deterministically. Only when no metric fits does the question fall through
  // to SQL generation, where the metric still grounds the prompt as context.
  let governedMetricAnswer = false;
  const semanticBridgeToolCalls: AgentEvidenceToolCall[] = [];
  let semanticBridgeAnswer: SemanticBridgeQueryResult | undefined;
  if (input.semanticLayer && semanticMetricMatch) {
    semanticBridgeAnswer = composeSemanticQueryForQuestion({
      semanticLayer: input.semanticLayer,
      question,
      questionPlan,
      matchedMetric: semanticMetricMatch.metric,
      filterValueColumns: (value) => resolveFilterValueColumns(value, schemaContext),
      filterValueBindings: (value) => resolveAgentFilterValueBindings(value, schemaContext),
      ...(input.semanticDriver ? { driver: input.semanticDriver } : {}),
      ...(input.semanticTableMapping ? { tableMapping: input.semanticTableMapping } : {}),
    });
    // Lane-2 LLM fallback: the deterministic token matcher missed, but a metric
    // matched so the semantic layer IS relevant. Spend ONE call to have the model
    // pick members (the query_semantic_model contract); the compiler still owns the
    // SQL, so a paraphrased metric question stays governed instead of dropping to
    // Lane-3 generation.
    if (!semanticBridgeAnswer) {
      const selection = await selectSemanticMembersViaLlm({
        provider,
        semanticLayer: input.semanticLayer,
        question,
        signal: input.signal,
        reasoningEffort: input.reasoningEffort,
      });
      if (selection) {
        const composed = composeSemanticQueryFromMembers({
          semanticLayer: input.semanticLayer,
          question,
          selection,
          ...(input.semanticDriver ? { driver: input.semanticDriver } : {}),
          ...(input.semanticTableMapping ? { tableMapping: input.semanticTableMapping } : {}),
        });
        // Coverage guard: if the question asked for a breakdown but the LLM
        // selection produced none, the governed answer would silently DROP the
        // requested grouping (governed-but-wrong). Fall through to Lane-3
        // generation, which can express the breakdown.
        const wantedBreakdown = questionPlan.requestedShape.dimensions.length > 0
          || questionPlan.dimensionTerms.length > 0;
        const dropsBreakdown = Boolean(composed)
          && wantedBreakdown
          && composed!.dimensions.length === 0
          && !composed!.timeDimension;
        if (composed && !dropsBreakdown) {
          semanticBridgeAnswer = composed;
          semanticBridgeToolCalls.push({
            name: 'query_semantic_model',
            status: 'checked',
            inputSummary: `metrics: ${selection.metrics.join(', ')}${selection.dimensions?.length ? `; by ${selection.dimensions.join(', ')}` : ''}`,
            outputSummary: 'LLM-selected semantic members compiled via composeQuery',
            order: semanticBridgeToolCalls.length + 1,
          });
        }
      }
    }
  }
  const metricFirst = semanticMetricMatch
    ? buildGovernedMetricFirstSql({
        metric: semanticMetricMatch.metric,
        pool: semanticMetricNodes,
        requestedShape: questionPlan.requestedShape,
        schemaTables: schemaContext.map((table) => ({
          relation: table.relation,
          name: table.name,
          columns: table.columns.map((column) => ({ name: column.name })),
        })),
        semanticLayer: input.semanticLayer,
      })
    : undefined;

  let contextLedger: ContextLedger = createContextLedger({
    contextPack: input.contextPack,
    schemaContext,
  });
  // W2.2 — certified-block adaptation lane. When a certified block is context-only
  // ONLY because the question adds exactly one filter whose value maps to a column
  // the block already outputs, adapt the certified SQL (wrap + filter its result)
  // instead of regenerating from scratch. It executes through the governed path
  // (pre-validated, since the wrapper only restricts an already-certified result)
  // and is labeled BELOW certified. Falls through to generation on any miss.
  let certifiedAdaptation: CertifiedAdaptation | undefined;
  if (!semanticBridgeAnswer && !metricFirst && input.executeGeneratedSql) {
    const fit = input.contextPack?.routeDecision?.blockFit;
    const sourceBlock = input.contextPack?.allowedSqlContext?.sourceBlockSql?.[0];
    if (fit && sourceBlock?.sql) {
      const shape = extractSimpleSelectShape(sourceBlock.sql);
      const blockOutputs = shape
        ? shape.selectExpressions.map((expression) => selectExpressionOutputName(expression)).filter((name): name is string => Boolean(name))
        : [];
      certifiedAdaptation = planCertifiedAdaptation({
        blockFit: fit,
        certifiedSql: sourceBlock.sql,
        blockName: sourceBlock.name,
        blockOutputs,
        resolveFilterColumn: (value) => resolveFilterValueColumns(value, schemaContext),
      }) ?? undefined;
    }
  }

  let proposed = '';
  let parsed: ParsedProposal;
  const proposalToolCalls: AgentEvidenceToolCall[] = [...semanticBridgeToolCalls];
  // Stage-B toolset: the host's warehouse/validation tools PLUS the answer loop's
  // own governed semantic tools (search_semantic_layer, compile_semantic_query,
  // scan_manifest), so tool-driven generation can compile governed SQL itself and
  // grep the live graph — across every provider (native or text-protocol). Every
  // governed compile is recorded so the answer can be labeled governed, not
  // hand-written, downstream (deriveAgenticTrust).
  const compiledSemanticRecords: CompiledSemanticRecord[] = [];
  const stageBTools: AgentToolDefinition[] = [
    ...(input.answerLoopTools ?? []),
    ...buildSemanticStageTools({
      semanticLayer: input.semanticLayer,
      kg,
      driver: input.semanticDriver,
      tableMapping: input.semanticTableMapping,
      onCompiled: (record) => compiledSemanticRecords.push(record),
    }),
  ];
  if (semanticBridgeAnswer) {
    governedMetricAnswer = true;
    parsed = {
      sql: semanticBridgeAnswer.sql,
      text: `Answered from governed semantic metric${semanticBridgeAnswer.metrics.length === 1 ? '' : 's'} ${semanticBridgeAnswer.metrics.join(', ')}${semanticBridgeAnswer.dimensions.length > 0 ? ` by ${semanticBridgeAnswer.dimensions.join(', ')}` : ''}. The semantic compiler owns this query; saving it as a reusable certified block still requires review.`,
      viz: semanticBridgeAnswer.dimensions.length === 0 && !semanticBridgeAnswer.timeDimension ? 'single_value' : undefined,
    };
  } else if (metricFirst) {
    semanticMetricMatch = { ...semanticMetricMatch!, metric: metricFirst.metric };
    governedMetricAnswer = true;
    parsed = {
      sql: metricFirst.sql,
      text: `Answered from the governed metric ${metricFirst.metric.name}${metricFirst.dimensions.length > 0 ? ` by ${metricFirst.dimensions.join(', ')}` : ''}. The semantic definition owns the calculation; reusable block certification remains a separate review.`,
      viz: metricFirst.dimensions.length === 0 ? 'single_value' : undefined,
    };
  } else if (certifiedAdaptation) {
    // Pre-validated governed path (the wrapper only restricts a certified result).
    governedMetricAnswer = true;
    parsed = {
      sql: certifiedAdaptation.sql,
      text: certifiedAdaptation.provenance,
    };
  } else {
    // Tier 2.5 — METRIC-ANCHORED generation. A governed metric matched this question,
    // but its semantic definition couldn't compose the exact requested shape (typically
    // the breakdown needs a join the semantic layer doesn't own — e.g. a location-grain
    // tax metric asked for "by product"). Rather than throw the metric away and let the
    // model reinvent the aggregation from scratch, inject the metric's CERTIFIED
    // definition as a required building block, so the generated SQL reuses the trusted
    // measure and only generates the join/grouping around it. Keeps the number
    // consistent with the governed metric. Degrades to plain generation when the metric
    // has no resolvable definition. The grain ledger + validation still gate the output.
    const metricAnchor = semanticMetricMatch && input.semanticLayer
      ? resolveGovernedMetricDefinition(semanticMetricMatch.metric, semanticMetricNodes, input.semanticLayer)
      : undefined;
    const generationMessages = metricAnchor
      ? [...messages, { role: 'system' as const, content: metricAnchorInstruction(metricAnchor.metric.name, metricAnchor.def) }]
      : messages;
    try {
      proposed = await generateProposalWithOptionalTools({
        provider,
        messages: generationMessages,
        tools: stageBTools,
        questionPlan,
        intent,
        signal: input.signal,
        reasoningEffort: input.reasoningEffort,
        analysisDepth: input.analysisDepth,
        toolCalls: proposalToolCalls,
      });
    } catch (err) {
      const text = `Provider error: ${(err as Error).message}`;
      return {
        kind: 'no_answer',
        sourceTier: 'no_answer',
        certification: 'analyst_review_required',
        reviewStatus: 'none',
        confidence: 0,
        text,
        answer: text,
        refusalCode: 'provider_error',
        refusalDetails: { code: 'provider_error', message: text },
        citations: [],
        memoryContext: input.memoryContext,
        evidence: buildNoAnswerEvidence({
          question,
          reason: text,
          artifactHits,
          businessHits,
          semanticHits,
          manifestHits,
          considered,
          memoryContext: input.memoryContext ?? [],
          toolCalls: proposalToolCalls,
        }),
        contextPack: input.contextPack,
        considered,
        providerUsed: provider.name,
      };
    }

    parsed = parseProposal(proposed);
    // Surface the tier choice (WS3): when generation was anchored on a governed
    // metric, say so, so the answer reads as "reused the certified measure" rather
    // than an opaque hand-written query.
    if (metricAnchor && parsed.sql) {
      const anchorNote = `Computed using the governed metric ${metricAnchor.metric.name}'s certified definition, joined to add the requested breakdown. Review-required (not itself certified).`;
      parsed = { ...parsed, text: parsed.text ? `${parsed.text}\n\n${anchorNote}` : anchorNote };
    }
    // Stage-B governed promotion: when the model drove compile_semantic_query and
    // adopted its output VERBATIM (deriveAgenticTrust — exact match only), the SQL
    // is governed semantic SQL the compiler owns and already validated, not
    // hand-written. Treat it like the deterministic governed path: skip the
    // hallucination guard (governedMetricAnswer) and note the provenance. Any edit
    // to the compiled SQL falls back to generated/review-required by construction.
    if (!governedMetricAnswer && parsed.sql) {
      const trust = deriveAgenticTrust(parsed.sql, compiledSemanticRecords);
      if (trust.tier === 'semantic_metric' && trust.compiled) {
        governedMetricAnswer = true;
        const compiled = trust.compiled;
        const governedNote = `Answered from governed semantic metric${compiled.metrics.length === 1 ? '' : 's'} ${compiled.metrics.join(', ')}${compiled.dimensions.length > 0 ? ` by ${compiled.dimensions.join(', ')}` : ''} (compiled via the semantic layer). Reusable block certification remains a separate review.`;
        parsed = { ...parsed, text: parsed.text ? `${parsed.text}\n\n${governedNote}` : governedNote };
        proposalToolCalls.push({
          name: 'compile_semantic_query',
          status: 'checked',
          inputSummary: `metrics: ${compiled.metrics.join(', ')}${compiled.dimensions.length ? `; by ${compiled.dimensions.join(', ')}` : ''}`,
          outputSummary: 'Model-selected semantic members compiled to governed SQL',
          order: proposalToolCalls.length + 1,
        });
      }
    }
  }
  let deepCandidateResult: AgentResultPayload | undefined;
  let deepCandidateExecutionError: string | undefined;
  let deepCandidateNotes: string[] = [];
  if (!governedMetricAnswer && input.analysisDepth === 'deep' && parsed.sql) {
    const selection = await selectDeepGeneratedProposalCandidate({
      provider,
      messages,
      question,
      questionPlan,
      intent,
      initial: { raw: proposed, parsed },
      contextLedger,
      executeGeneratedSql: input.executeGeneratedSql,
      signal: input.signal,
      reasoningEffort: input.reasoningEffort,
      maxAlternatives: deepAlternativeCountForQuestion(questionPlan, intent),
    });
    if (selection.selected) {
      proposed = selection.selected.raw;
      parsed = selection.selected.parsed;
      deepCandidateResult = selection.selected.result;
      deepCandidateExecutionError = selection.selected.executionError;
    }
    deepCandidateNotes = selection.notes;
  }
  // `governedMetricAnswer` (declared above): true when `parsed.sql` was
  // synthesized deterministically from a governed semantic-layer metric (not the
  // LLM). Such SQL is trusted and grounded against the runtime schema, so it
  // skips the hallucination-guard context validation that exists to catch
  // model-invented relations/columns.
  if (!parsed.sql) {
    // Spec 17, part C — if a governed metric matched confidently but the model
    // declined SQL, answer from the metric definition (deterministic, offline)
    // rather than refusing. The semantic tier is the governed answer here. A
    // derived MetricFlow metric (e.g. `revenue`) often carries no executable
    // definition itself — its `table:`/`sql:` live on the backing measure node
    // (`order_item.revenue`). resolveGovernedMetricSql resolves a thin metric to
    // that synthesizable sibling so the route lands on a real number, not refusal.
    const resolved = activeTier === 'semantic_layer' && semanticMetricMatch
      ? resolveGovernedMetricSql(semanticMetricMatch.metric, semanticMetricNodes, input.semanticLayer)
      : undefined;
    if (resolved) {
      // Point the match at the metric we actually answered from so the route
      // badge, citation, and carrier all reflect the executable definition used.
      semanticMetricMatch = { ...semanticMetricMatch!, metric: resolved.metric };
      governedMetricAnswer = true;
      parsed = {
        sql: resolved.sql,
        text:
          parsed.text ||
          `Answered from the governed metric ${resolved.metric.name}. The semantic definition owns the calculation; reusable block certification remains a separate review.`,
        viz: parsed.viz ?? 'single_value',
      };
    }
  }
  // Forced-join retry. The model declined SQL (rule 8 escape) — but a composite
  // "top X who did top Y" that spans several concepts often trips the model into
  // "there's no combined dataset — show them separately", which is a FALSE refusal
  // when the grounded tables and KG join routes to connect them are right there in
  // context. If the question genuinely wants generated data and we DO have usable
  // relations/schema to build the join, re-issue ONCE with an explicit instruction
  // to compose the join rather than refuse. A truly absent table/column/join key
  // still falls through to the honest no_answer below.
  const wantsGeneratedData =
    questionPlan.requestedShape.measures.length > 0
    || questionPlan.requestedShape.dimensions.length > 0
    || questionPlan.requestedShape.requiredOutputs.length > 0
    || Boolean(questionPlan.requestedShape.topN);
  const hasGeneratableContext =
    schemaContext.length > 0
    || (input.contextPack?.allowedSqlContext?.relations.length ?? 0) > 0
    || (input.contextPack?.allowedSqlContext?.sourceBlockSql.length ?? 0) > 0
    || contextBlocks.length > 0;
  if (!parsed.sql && !governedMetricAnswer && wantsGeneratedData && hasGeneratableContext && analyticalPlan?.safe !== false) {
    try {
      proposed = await generateProposalWithOptionalTools({
        provider,
        messages: [...messages, { role: 'system', content: FORCE_JOIN_INSTRUCTION }],
        tools: stageBTools,
        questionPlan,
        intent,
        signal: input.signal,
        reasoningEffort: input.reasoningEffort,
        analysisDepth: input.analysisDepth,
        toolCalls: proposalToolCalls,
      });
      parsed = parseProposal(proposed);
    } catch {
      // keep the original decline; fall through to the honest no_answer.
    }
  }
  if (!parsed.sql) {
    // Deterministic honest refusal. The model's own decline prose is STOCHASTIC
    // ("there's no combined dataset — show them separately" one run, a different
    // phrasing the next), which reads as flaky and inconsistent across surfaces.
    // When the question wanted data AND usable context existed (a groundable ask
    // the model still declined even after the forced-join retry), surface ONE
    // consistent, actionable message so the same question yields the same outcome
    // every run and every surface — instead of passing through the model's varying
    // text. A genuinely context-less ask keeps the plain honest message.
    const declinedDespiteContext = wantsGeneratedData && hasGeneratableContext;
    const text = analyticalPlan?.safe === false
      ? analyticalPlan.message ?? 'DQL could not prove a safe analytical relationship path.'
      : declinedDespiteContext
      ? 'I could not compose a governed query for this from the available tables and metrics. This usually needs a clearer join path or an explicit metric and grouping — name the specific measure and how to break it down, and I can generate a review-required draft.'
      : parsed.text || 'No answer (the model declined to propose SQL).';
    return {
      kind: 'no_answer',
      sourceTier: 'no_answer',
      certification: 'analyst_review_required',
      reviewStatus: 'none',
      confidence: 0.1,
      text,
      refusalCode: analyticalPlan?.safe === false
        ? refusalCodeForAnalyticalPolicy(analyticalPlan.code)
        : 'model_declined',
      refusalDetails: {
        code: analyticalPlan?.safe === false
          ? analyticalPlan.code ?? 'unsafe_relationship'
          : 'model_declined',
        message: text,
      },
      answer: text,
      citations: [],
      memoryContext: input.memoryContext,
      evidence: buildNoAnswerEvidence({
        question,
        reason: text,
        artifactHits,
        businessHits,
        semanticHits,
        manifestHits,
        considered,
        memoryContext: input.memoryContext ?? [],
      }),
      contextPack: input.contextPack,
      considered,
      providerUsed: provider.name,
    };
  }

  if (parsed.sql) {
    const tightenedFlow = tightenSourceTargetFlowProjection(parsed.sql, question, questionPlan);
    if (tightenedFlow && tightenedFlow.sql !== parsed.sql) {
      parsed.sql = tightenedFlow.sql;
      parsed.outputs = tightenedFlow.outputs;
      // Any edit to compiler-owned SQL is no longer an exact governed compile.
      // Keep the corrected result review-required instead of overstating trust.
      governedMetricAnswer = false;
      // A deep candidate may already have executed the wider proposal. The
      // narrowed SQL is now authoritative and must be executed/validated anew.
      deepCandidateResult = undefined;
      deepCandidateExecutionError = undefined;
      deepCandidateNotes.push('Removed an unrelated grouping from the source-to-target flow projection.');
    }
  }

  // Shared grounding (spec 15): deterministically qualify any bare relation the
  // model emitted to its real warehouse relation from the runtime schema BEFORE
  // governance validation. Same resolver the build path uses — one grounding,
  // no weak path. `allowedSqlContext` relations are already qualified.
  if (parsed.sql) {
    parsed.sql = contextLedger.qualifySql(parsed.sql).sql;
  }

  // Validation gate. Governed metric SQL synthesized from the semantic layer is
  // already trusted (deterministic + grounded); model SQL is validated against the
  // inspected context to catch hallucinated relations/columns.
  const semanticMetricRoute = activeTier === 'semantic_layer' && Boolean(semanticMetricMatch);
  const scalarGovernedMetricRecoveryAllowed = questionPlan.requestedShape.dimensions.length === 0
    && questionPlan.requestedShape.filters.length === 0
    && !questionPlan.requestedShape.topN;
  type AnswerValidation =
    | { ok: true; warnings: string[] }
    | {
        ok: false;
        code?: SqlContextValidationCode;
        error: string;
        warnings: string[];
        offending?: SqlContextValidationOffending;
      };
  let contextValidation: AnswerValidation;
  const initialValidation = contextLedger.validateSql(parsed.sql, {
    question,
    intent,
    filterValues: input.followUp?.filters,
    trustedFilterValues: trustedFollowUpFilterValues(input.followUp),
  });
  contextValidation = initialValidation.ok
    ? { ok: true, warnings: initialValidation.warnings }
    : {
        ok: false,
        code: initialValidation.code,
        error: initialValidation.error,
        warnings: initialValidation.warnings,
        offending: initialValidation.offending,
      };
  // Semantic compilation owns metric meaning, but a later dimensional join can
  // still make a compiled bare expression ambiguous at the warehouse binder.
  // Revoke governed trust for an invalid composition so the bounded repair lane
  // can qualify it and keep the repaired SQL review-required.
  if (governedMetricAnswer && !contextValidation.ok) governedMetricAnswer = false;

  // Spec 17, part C — semantic-metric route recovery. A metric question is often
  // catalog-routed to clarify, leaving a thin contextPack that rejects otherwise-valid
  // SQL. Rather than refuse, recover in two steps:
  //   1) Re-judge the model's own SQL against the RUNTIME grounding. If it references
  //      real relations/columns it is valid (the contextPack rejection was a false
  //      negative) — keep the model SQL so a precise answer like `count(*) FROM orders`
  //      stands instead of guessing a measure.
  //   2) Otherwise fall back to a CLEAN governed-metric definition (direct or exact
  //      leaf-measure; no fuzzy family guess that could answer the wrong measure).
  if (!contextValidation.ok && semanticMetricRoute && semanticMetricMatch) {
    const grounded = contextLedger.validateRuntimeGrounding(parsed.sql);
    if (grounded?.ok) {
      contextValidation = { ok: true, warnings: grounded.warnings };
    } else if (scalarGovernedMetricRecoveryAllowed) {
      const recovered = resolveGovernedMetricSql(semanticMetricMatch.metric, semanticMetricNodes, input.semanticLayer);
      if (recovered) {
        semanticMetricMatch = { ...semanticMetricMatch, metric: recovered.metric };
        parsed.sql = contextLedger.qualifySql(recovered.sql).sql;
        parsed.viz = parsed.viz ?? 'single_value';
        parsed.text = parsed.text
          || `Answered from the governed metric ${recovered.metric.name}. This result is uncertified until reviewed and promoted.`;
        governedMetricAnswer = true;
        contextValidation = {
          ok: true,
          warnings: ['SQL preview failed context validation; answered from the governed metric definition instead.'],
        };
      }
    }
  }

  if (!contextValidation.ok && !governedMetricAnswer && input.expandGroundingContext && canUseLaneRepair(repairBudgetState, 'reground')) {
    recordLaneRepair(repairBudgetState, 'reground');
    try {
      const expansion = await input.expandGroundingContext({
        question,
        sql: parsed.sql,
        code: contextValidation.code ?? 'insufficient_context',
        offending: contextValidation.offending,
        contextPack: contextLedger.contextPack,
        schemaContext: contextLedger.schemaContext,
      });
      const merged = contextLedger.withExpansion(expansion);
      if (merged.notes.length > 0) {
        contextLedger = merged.ledger;
        parsed.sql = contextLedger.qualifySql(parsed.sql).sql;
        const revalidated = contextLedger.validateSql(parsed.sql, {
          question,
          intent,
          filterValues: input.followUp?.filters,
          trustedFilterValues: trustedFollowUpFilterValues(input.followUp),
        });
        contextValidation = revalidated.ok
          ? {
              ok: true,
              warnings: [
                ...revalidated.warnings,
                ...merged.notes.map((note) => `Re-grounded metadata context before repair: ${note}`),
              ],
            }
          : {
              ok: false,
              code: revalidated.code,
              error: revalidated.error,
              warnings: [
                ...revalidated.warnings,
                ...merged.notes.map((note) => `Re-grounded metadata context before repair: ${note}`),
              ],
              offending: revalidated.offending,
            };
      }
    } catch {
      // Re-grounding is best-effort; the bounded self-repair below still runs.
    }
  }

  // One bounded self-repair before refusing: hand the model the EXACT guard
  // error (e.g. `column "product_name" outside the inspected columns for
  // order_items`) so it can correct itself — usually by joining the relation
  // that actually carries the column. Deterministic paths that never called the
  // provider get the same single chance; any provider failure keeps the honest
  // refusal below. This mirrors the engine-level repair loop, applied to the
  // context-validation gate that previously refused on first failure.
  if (!contextValidation.ok && !governedMetricAnswer && canUseLaneRepair(repairBudgetState, 'reground')) {
    recordLaneRepair(repairBudgetState, 'reground');
    try {
      const failedSql = parsed.sql ?? '';
      const repairPrompt = [
        `Your SQL was rejected before execution: ${contextValidation.error}`,
        formatOffendingValidationToken(contextValidation.offending),
        formatValidationWarningsForPrompt(contextValidation.warnings),
        'Correct it using ONLY the relations and columns from the inspected context above.',
        'If a needed column lives on a different relation, JOIN that relation using the suggested join paths.',
        'If the requested column does not exist anywhere in the inspected context, return the closest answerable SQL and say what is missing.',
        'Return a single ```json fenced object: {"summary":"...","sql":"SELECT ...","viz":"table","outputs":["column"],"dql":{"entity":"...","dimensions":["..."],"filters":["..."]}}.',
      ].join('\n');
      const repairRaw = await provider.generate(
        [...messages, { role: 'assistant', content: failedSql }, { role: 'user', content: repairPrompt }],
        { signal: input.signal, reasoningEffort: input.reasoningEffort },
      );
      const reparsed = parseProposal(repairRaw);
      if (reparsed.sql) {
        reparsed.sql = contextLedger.qualifySql(reparsed.sql).sql;
        const revalidated = contextLedger.validateSql(reparsed.sql, {
          question,
          intent,
          filterValues: input.followUp?.filters,
          trustedFilterValues: trustedFollowUpFilterValues(input.followUp),
        });
        if (revalidated.ok) {
          const repairedSql: string = reparsed.sql;
          parsed.sql = repairedSql;
          parsed.text = reparsed.text || parsed.text;
          parsed.viz = reparsed.viz ?? parsed.viz;
          applyParsedProposalMetadata(parsed, reparsed);
          contextValidation = {
            ok: true,
            warnings: [...revalidated.warnings, 'Repaired after context-validation failure (1 repair).'],
          };
        }
      }
    } catch {
      // Repair is best-effort — the refusal below stays the honest fallback.
    }
  }
  // W1.3 — deterministic, warn-only fan-out check. When the generated SQL aggregates
  // an additive measure across a one-to-many join (grain ledger knows the keys), the
  // number can silently double-count. Surface a caution so it is reviewed. This never
  // blocks: it only appends to warnings, and it is conservative (no key data ⇒ no flag).
  if (contextValidation.ok && parsed.sql && input.contextPack?.objects?.length) {
    try {
      const fanoutWarnings = fanoutWarningsForSql(parsed.sql, input.contextPack.objects);
      if (fanoutWarnings.length > 0) {
        contextValidation = { ok: true, warnings: [...contextValidation.warnings, ...fanoutWarnings] };
      }
    } catch {
      // Fan-out detection is advisory; any failure must not affect the answer.
    }
  }

  if (!contextValidation.ok) {
    const text = `I could not safely prepare this review-required DQL artifact from the inspected context. The SQL preview failed validation: ${contextValidation.error}`;
    const analysisPlan = buildAnalysisPlan({
      question,
      intent,
      routeReason: catalogRoute?.reason ?? 'SQL preview for the review-required DQL artifact failed metadata context validation before preview execution or draft capture.',
      selectedNodes: contextNodes,
      schemaContext,
      sql: parsed.sql,
      suggestedViz: parsed.viz ?? 'table',
      assumptions: [
        'SQL preview was rejected before execution because it did not match inspected metadata context.',
        ...contextValidation.warnings,
        ...deepCandidateNotes,
      ],
    });
    return {
      kind: 'no_answer',
      sourceTier: 'no_answer',
      certification: 'analyst_review_required',
      reviewStatus: 'none',
      confidence: 0.15,
      text,
      refusalCode: refusalCodeForValidation(contextValidation.code),
      refusalDetails: {
        code: contextValidation.code ?? 'insufficient_context',
        message: contextValidation.error,
        offending: contextValidation.offending,
      },
      answer: text,
      proposedSql: parsed.sql,
      sql: parsed.sql,
      trustLabel: input.contextPack?.trustLabel,
      sourceCertifiedBlock: followUpSourceBlock?.name ?? input.followUp?.sourceBlockName,
      contextPackId: input.contextPack?.id,
      validationWarnings: [...contextValidation.warnings, ...deepCandidateNotes],
      selectedEvidence: input.contextPack?.evidenceRoles?.slice(0, 12),
      citations: [],
      memoryContext: input.memoryContext,
      analysisPlan,
      evidence: buildNoAnswerEvidence({
        question,
        reason: contextValidation.error,
        artifactHits,
        businessHits,
        semanticHits,
        manifestHits,
        considered,
        memoryContext: input.memoryContext ?? [],
        analysisPlan,
      }),
      contextPack: input.contextPack,
      considered,
      providerUsed: provider.name,
    };
  }

  const dbtFirstJoinSafety = input.manifest
    ? evaluateDbtFirstGeneratedSql(parsed.sql, input.manifest, input.domainContext?.purpose, input.domainContext)
    : undefined;
  if (dbtFirstJoinSafety && !dbtFirstJoinSafety.safe) {
    const text = dbtFirstJoinSafety.message
      ?? 'DQL could not prove this generated join from certified analytical relationships.';
    const exploratoryCandidate = exploratoryCandidateFromDbtFirstGuard(parsed.sql, dbtFirstJoinSafety);
    const analysisPlan = buildAnalysisPlan({
      question,
      intent,
      routeReason: exploratoryCandidate
        ? 'Governed relationship coverage is missing, so DQL prepared a bounded DBT-grounded exploratory candidate for host validation.'
        : 'The generated SQL did not pass the governed relationship policy.',
      selectedNodes: contextNodes,
      schemaContext,
      sql: parsed.sql,
      suggestedViz: parsed.viz ?? 'table',
      assumptions: [
        ...contextValidation.warnings,
        'DBT metadata is grounding evidence, not certified relationship proof.',
      ],
    });
    return {
      kind: 'no_answer',
      sourceTier: 'no_answer',
      certification: 'analyst_review_required',
      reviewStatus: 'none',
      confidence: 0.1,
      text,
      answer: text,
      proposedSql: parsed.sql,
      sql: parsed.sql,
      ...(exploratoryCandidate ? { exploratoryCandidate } : {}),
      refusalCode: refusalCodeForAnalyticalPolicy(dbtFirstJoinSafety.code, Boolean(exploratoryCandidate)),
      refusalDetails: {
        code: dbtFirstJoinSafety.code ?? 'unsafe_relationship',
        message: text,
      },
      validationWarnings: [
        ...contextValidation.warnings,
        `DQL v3 relationship guard: ${dbtFirstJoinSafety.code ?? 'unsafe relationship'}.`,
        ...(exploratoryCandidate
          ? ['A bounded DBT-grounded exploratory route may validate this missing modeled relationship; governed SQL was not executed.']
          : []),
      ],
      citations: [],
      memoryContext: input.memoryContext,
      analysisPlan,
      evidence: buildNoAnswerEvidence({
        question,
        reason: text,
        artifactHits,
        businessHits,
        semanticHits,
        manifestHits,
        considered,
        memoryContext: input.memoryContext ?? [],
        analysisPlan,
      }),
      contextPack: input.contextPack,
      considered,
      providerUsed: provider.name,
    };
  }

  const generatedCitations: AgentCitation[] = [
    ...contextPackCitations(input.contextPack, 4),
    ...contextNodes.slice(0, 4).map((n) => ({
      nodeId: n.nodeId,
      kind: n.kind,
      name: n.name,
      gitSha: n.gitSha,
      sourceTier: citationSourceTier(n, activeTier),
      provenance: n.provenance,
    })),
    ...(input.memoryContext ?? []).slice(0, 2).map((m) => ({
      nodeId: m.id,
      kind: 'memory' as const,
      name: m.title,
      sourceTier: 'memory' as const,
      provenance: m.source,
    })),
    ...schemaCitations(schemaContext, Math.max(0, 4 - contextNodes.length)),
  ];
  let result: AgentResultPayload | undefined;
  let executionError: string | undefined;
  let repairAttempts = 0;
  // The repair turn returns error-recovery prose ("the column X was not recognized…"),
  // NOT a user-facing answer. Keep it for the trace only — never as the answer text.
  let repairNarrative: string | undefined;
  if (deepCandidateResult) {
    result = deepCandidateResult;
  }
  if (deepCandidateExecutionError) {
    executionError = deepCandidateExecutionError;
  }
  if (input.executeGeneratedSql && !result) {
    try {
      if (!executionError) result = await input.executeGeneratedSql(parsed.sql);
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
    }
    if (executionError) {
      if (isRetryableGeneratedSqlError(executionError)) {
        const localRepairSql = repairGeneratedSqlLocally(parsed.sql, executionError, schemaContext);
        if (localRepairSql && canUseLaneRepair(repairBudgetState, 'execution')) {
          recordLaneRepair(repairBudgetState, 'execution');
          const qualifiedLocalRepairSql = contextLedger.qualifySql(localRepairSql).sql;
          const localRepairValidation = contextLedger.validateSql(qualifiedLocalRepairSql, {
            question,
            intent,
            filterValues: input.followUp?.filters,
            trustedFilterValues: trustedFollowUpFilterValues(input.followUp),
          });
          if (localRepairValidation.ok) {
            repairAttempts = 1;
            parsed.sql = qualifiedLocalRepairSql;
            contextValidation = {
              ok: true,
              warnings: [
                ...localRepairValidation.warnings,
                'Execution-repaired SQL passed context validation.',
              ],
            };
            try {
              result = await input.executeGeneratedSql(parsed.sql);
              executionError = undefined;
            } catch (retryErr) {
              executionError = retryErr instanceof Error ? retryErr.message : String(retryErr);
            }
          } else {
            executionError = localRepairValidation.error;
          }
        }
        if (executionError && canUseLaneRepair(repairBudgetState, 'execution')) {
          recordLaneRepair(repairBudgetState, 'execution');
          const repairedRaw = await requestSqlRepair({
            provider,
            baseMessages: messages,
            question,
            parsed,
            executionError,
            schemaContext,
            signal: input.signal,
            reasoningEffort: input.reasoningEffort,
          });
          const repaired = parseProposal(repairedRaw);
          if (repaired.sql) {
            repaired.sql = contextLedger.qualifySql(repaired.sql).sql;
            const repairedValidation = contextLedger.validateSql(repaired.sql, {
              question,
              intent,
              filterValues: input.followUp?.filters,
              trustedFilterValues: trustedFollowUpFilterValues(input.followUp),
            });
            if (repairedValidation.ok) {
              repairAttempts += 1;
              // Adopt the corrected SQL, but do NOT let the repair prose become the answer.
              repairNarrative = repaired.text?.trim() || undefined;
              parsed.sql = repaired.sql;
              parsed.viz = repaired.viz ?? parsed.viz;
              applyParsedProposalMetadata(parsed, repaired);
              contextValidation = {
                ok: true,
                warnings: [
                  ...repairedValidation.warnings,
                  'Execution-repaired SQL passed context validation.',
                ],
              };
              try {
                result = await input.executeGeneratedSql(parsed.sql);
                executionError = undefined;
              } catch (retryErr) {
                executionError = retryErr instanceof Error ? retryErr.message : String(retryErr);
              }
            } else {
              executionError = repairedValidation.error;
            }
          }
        }
      }
    }
  }
  const analysisPlan = buildAnalysisPlan({
    question,
    intent,
    routeReason: catalogRoute?.reason ?? (intent === 'drillthrough'
      ? 'The user asked for a drill-through or follow-up, so DQL prepared a review-required artifact with a SQL preview from the prior context and current metadata.'
      : 'The question asks for a custom analysis, ranking, breakdown, comparison, or grain that should not be answered by a loose certified block match.'),
    selectedNodes: contextNodes,
    schemaContext,
    sql: parsed.sql,
    suggestedViz: parsed.viz ?? 'table',
    assumptions: [
      'The SQL preview is uncertified until an analyst reviews and promotes the DQL artifact.',
      ...(repairNarrative ? [`Auto-corrected the query after an execution error: ${repairNarrative}`] : []),
      ...contextValidation.warnings,
      ...(executionError ? ['The preview execution error must be reviewed before reuse.'] : []),
    ],
      repairAttempts,
    });
    // Global top-N asks must return exactly N rows even when the generated SQL
    // returned more (missing/oversized LIMIT) — mirrors the certified path so a
    // "top 10" question never shows 200 rows. per_group scope is left intact by
    // trimResultToRequestedTopN. Domain-agnostic.
    let topNTrimNote: string | undefined;
    if (result) {
      const beforeRows = Array.isArray(result.rows) ? result.rows.length : result.rowCount;
      result = trimResultToRequestedTopN(result, questionPlan);
      const afterRows = Array.isArray(result.rows) ? result.rows.length : result.rowCount;
      if (afterRows < beforeRows) {
        topNTrimNote = `Showed the top ${questionPlan.requestedShape.topN?.n ?? afterRows} of ${beforeRows} rows the query returned.`;
      }
    }
    const resultShape = result ? validateAnswerResultShape(questionPlan, result) : undefined;
    // ANY question whose SQL executed but dropped multiple requested columns used to
    // REFUSE outright ("no governed answer"), throwing away a result that actually
    // ran. Instead, SURFACE the partial result (review-required) with a warning that
    // names the missing columns — a partial table the user can see and refine beats a
    // blank clarify. Domain-agnostic: works for every project, not just jaffle. The
    // shape gate downgrades trust rather than blocking the answer.
    const partialShapeMismatch = Boolean(resultShape && result && result.rowCount > 0
      && generatedResultShapeIsPartial(resultShape));
    const partialShapeWarning = partialShapeMismatch && resultShape
      ? `Partial answer: the result is missing ${resultShape.missingOutputs.join(', ')}`
        + `. Showing the closest table that executed — review before reuse, or narrow the question to the columns shown.`
      : undefined;
    const validationWarnings = [
      ...(input.contextPack?.warnings ?? []),
      ...contextValidation.warnings,
      ...deepCandidateNotes,
      ...(resultShape?.warnings ?? []),
      ...(partialShapeWarning ? [partialShapeWarning] : []),
      ...(topNTrimNote ? [topNTrimNote] : []),
      ...(executionError ? ['The preview execution error must be reviewed before reuse.'] : []),
    ];
    const generatedOutputs = parsed.outputs?.length ? parsed.outputs : resultColumnNames(result);
    const generatedRequestedFilters = mergeProposalStringLists(input.followUp?.filters, parsed.requestedFilters);
    const generatedRequestedDimensions = mergeProposalStringLists(input.followUp?.dimensions, parsed.requestedDimensions);
    const dqlArtifact = semanticBridgeAnswer?.dqlArtifact ?? buildGeneratedSqlDqlArtifact({
      question,
      sql: parsed.sql,
      intent,
      domain,
      followUp: input.followUp,
      contextPack: input.contextPack,
      sourceBlock: followUpSourceBlock ?? undefined,
      sourceDqlArtifact: input.followUp?.priorDqlArtifact,
      proposedEntity: parsed.proposedEntity,
      requestedFilters: generatedRequestedFilters,
      requestedDimensions: generatedRequestedDimensions,
      validationWarnings,
      outputs: generatedOutputs,
    });
    let draftBlock: GeneratedDraftBlock | undefined;
    let draftCaptureError: string | undefined;
    if (input.captureGeneratedDraft && parsed.sql) {
      try {
        draftBlock = await input.captureGeneratedDraft({
          question,
          sql: parsed.sql,
          intent,
          followUp: input.followUp,
          contextPack: input.contextPack,
          sourceBlock: followUpSourceBlock ?? undefined,
          sourceDqlArtifact: input.followUp?.priorDqlArtifact,
          dqlArtifact,
          proposedEntity: parsed.proposedEntity,
          requestedFilters: generatedRequestedFilters,
          requestedDimensions: generatedRequestedDimensions,
          validationWarnings,
          outputs: generatedOutputs,
        });
      } catch (err) {
        draftCaptureError = err instanceof Error ? err.message : String(err);
        validationWarnings.push(`Draft capture failed: ${draftCaptureError}`);
      }
    }
    const answerDqlArtifact = dqlArtifact && draftBlock?.path
      ? { ...dqlArtifact, sourcePath: dqlArtifact.sourcePath ?? draftBlock.path }
      : dqlArtifact;
    const sourceCertifiedBlock = followUpSourceBlock?.name ?? input.followUp?.sourceBlockName;
    const trustExplanation = governedMetricAnswer
      ? undefined
      : generatedTrustExplanation({
          followUp: input.followUp,
          sourceCertifiedBlock,
          draftBlock,
        });
    const cleanedSummary = cleanGeneratedSummary(parsed.text);
    const generatedText = [partialShapeWarning, trustExplanation, cleanedSummary]
      .filter(Boolean)
      .join('\n\n');
    // A metric can be resolved directly from the loaded semantic layer even if
    // the small metadata pack happened to contain only dbt objects.  The answer
    // is still compiler-owned semantic SQL in that case; do not accidentally
    // downgrade its route/trust to generated SQL because of retrieval order.
    const semanticMetricCertification = governedMetricAnswer
      ? semanticMetricMatch?.metric.certification
      : undefined;
    const certifiedMetricAnswer = semanticMetricCertification === 'certified' || semanticMetricCertification === 'reviewed';
    return {
      kind: 'uncertified',
      sourceTier: governedMetricAnswer ? 'semantic_layer' : activeTier,
      certification: governedMetricAnswer ? 'governed' : 'ai_generated',
      reviewStatus: governedMetricAnswer ? 'governed' : 'draft_ready',
      semanticMetricCertification,
      confidence: certifiedMetricAnswer ? 0.8 : governedMetricAnswer ? 0.72 : 0.55,
      text: generatedText,
      answer: generatedText,
      proposedSql: parsed.sql,
      sql: parsed.sql,
      result,
      executionError,
      suggestedViz: parsed.viz ?? 'table',
      dqlArtifact: answerDqlArtifact,
      draftBlock,
      draftBlockId: draftBlock?.path,
      promoteCommand: draftBlock ? `dql certify --from-draft ${draftBlock.path}` : undefined,
      trustLabel: input.contextPack?.trustLabel,
      sourceCertifiedBlock,
      contextPackId: input.contextPack?.id,
      validationWarnings,
      selectedEvidence: input.contextPack?.evidenceRoles?.slice(0, 12),
      citations: generatedCitations,
      memoryContext: input.memoryContext,
      analysisPlan,
      evidence: buildGeneratedEvidence({
        question,
        activeTier,
        terminalLane: governedMetricAnswer ? 'semantic' : 'generated',
        terminalDetail: governedMetricAnswer
          ? semanticBridgeAnswer?.metrics.join(', ') ?? semanticMetricMatch?.metric.name
          : answerDqlArtifact?.name ?? draftBlock?.path,
        intent,
        contextNodes,
        schemaContext,
        followUp: input.followUp,
        contextPack: input.contextPack,
        businessHits,
        semanticHits,
        manifestHits,
        considered,
        citations: generatedCitations,
        memoryContext: input.memoryContext ?? [],
        result,
        executionError,
        executorWasAvailable: Boolean(input.executeGeneratedSql),
        analysisPlan,
        toolCalls: proposalToolCalls,
        budgetTrace: cascadeBudgetTrace(repairBudgetState),
      }),
      contextPack: input.contextPack,
      considered,
      providerUsed: provider.name,
      // Carry the governed metric match so the exit point can name a
      // `semantic_metric` route (spec 17, part C).
      _semanticMetricMatch: governedMetricAnswer ? semanticMetricMatch ?? undefined : undefined,
  };
}

function trimResultToRequestedTopN(result: AgentResultPayload, plan: AnalysisQuestionPlan): AgentResultPayload {
  const topN = plan.requestedShape.topN;
  if (!topN || topN.scope === 'per_group' || !Array.isArray(result.rows) || result.rows.length <= topN.n) return result;
  return {
    ...result,
    rows: result.rows.slice(0, topN.n),
    rowCount: Math.min(result.rowCount, topN.n),
  };
}

function resultColumnNames(result?: AgentResultPayload): string[] | undefined {
  if (!result?.columns) return undefined;
  const columns = result.columns
    .map((column) => {
      if (typeof column === 'string') return column.trim();
      if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
        return (column as { name: string }).name.trim();
      }
      return '';
    })
    .filter(Boolean);
  return columns?.length ? columns : undefined;
}

const SYSTEM_PROMPT = `You are the DQL Analytics Agent.

Rules:
1. First classify the question: exact saved artifact/direct KPI, entity-specific
   lookup, ad hoc ranking/breakdown/comparison/custom grain, drill-through
   follow-up, or insufficient context.
2. Use certified DQL blocks only when the user's question exactly asks for that
   saved block, direct KPI, or definition. For single-user/customer/account,
   custom filters, rankings, breakdowns, comparisons, drill-throughs, or custom
   grains, prepare a review-required DQL artifact with a SQL preview from
   supplied metadata and cite certified context as evidence.
3. If you must create a SQL preview, return a single \`\`\`json fenced object with:
   {"summary": "...", "sql": "SELECT ...", "viz": "table", "outputs": ["column_a"], "dql": {"entity": "orders", "dimensions": ["region"], "filters": ["last 30 days"]}}.
   The SQL string must be one read-only SELECT/WITH statement. Do not include a
   separate SQL code fence when using JSON. The optional "dql" object is
   metadata for the deterministic draft-DQL renderer; do not hand-write a full
   DQL block.
   Design the SELECT for a business reader: prefer a joined/display name, label,
   title, or business value over raw *_id, *_uuid, *_key, or technical codes.
   Alias calculated outputs with clear business names. Include identifiers only
   when the question asks for them or no readable field exists. Give every FROM
   and JOIN relation an explicit short alias, and use only those exact aliases in
   SELECT, ON, WHERE, GROUP BY, and ORDER BY. When a query reads more than one
   relation, qualify every column reference with its exact relation alias; never
   emit a bare column name. Include every requested output. Match the requested
   result grain exactly: project and GROUP BY only the entities or dimensions the
   user asked to compare. A category/value used only to filter the result is not
   an additional output dimension. An entity ranking filtered to a category
   value must return one row per requested entity, not one row per
   entity-category-member pair.
   For a Sankey/source-to-target flow, return exactly two categorical columns
   (the requested source first, then the requested target) plus one numeric
   weight. Do not add an unrelated grouping such as customer type, segment, or
   region unless the question explicitly asks for it.
4. In summary, state your QUERY PLAN first: the grain (one row per WHAT), the
   measures and how they aggregate, the dimensions/filters, and the exact join
   path + join keys between the grounded tables. Then make the SQL match that
   plan — an explicit grain and join path prevents wrong-grain answers and
   fan-out (row-multiplying) joins. Treat lifetime, cumulative, balance,
   snapshot, rate, ratio, average, and already-aggregated values as
   non-additive across lower-grain joins: pre-aggregate at their native grain,
   or use a grain-preserving value only when the owning entity remains in the
   output. Never SUM the repeated parent value at child grain. If the question
   requires allocating a parent value to children, ask for the allocation rule.
   For an entity-relative measure comparison such as "customers who paid less
   tax than Melissa", first aggregate the measure for every peer at the same
   entity grain, obtain the named reference entity's aggregate in a CTE or
   scalar subquery, then compare peers with the requested < or > predicate and
   exclude the reference entity. Do not filter the result down to the reference
   entity, compare unaggregated fact rows, or return one global aggregate.
5. Choose a visualization deliberately in the "viz" JSON field: use single_value
   or kpi for one aggregate, line/area only for an ordered time series, bar for a
   categorical comparison, grouped-bar for multiple measures by one category,
   donut for a small part-to-whole result, scatter for two continuous measures,
   histogram for a distribution, funnel for ordered stages, waterfall for signed
   contributions, sankey for source-to-target flows, and table for detailed rows.
   Do not default to bar. The runtime validates this preference against returned
   rows before displaying it.
6. NEVER fabricate column names that are not present in the supplied schema,
   dbt metadata, or certified source SQL shape context. If a requested filter
   value is supplied as a matched value, prefer the table and column that
   matched that value.
7. Return one read-only SELECT or WITH query for the local warehouse/runtime.
   Do NOT use dbt/Jinja macros such as {{ ref(...) }} or {{ source(...) }} in
   proposed SQL. Do not emit INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, COPY,
   PRAGMA, SET, or multiple statements.
8. If the schema is insufficient, DISCOVER before you decline: use
   search_metadata to find candidate relations, get_table_schema to confirm a
   relation's real columns and inferred join keys, and expand_context for a
   relation you already know by name. Only ask a clarifying question once those
   come up empty AND the question is genuinely ambiguous — never decline just
   because the initially supplied context pack didn't already include the table.
   A MULTI-ENTITY question ("top customers who bought the top products", "accounts
   with the most overdue invoices") is NOT insufficient context when the grounded
   tables and a join route between them are supplied (see any "Knowledge graph
   join routes" section) or discoverable via the tools above. In that case you
   MUST compose the joined SELECT that answers it directly — never refuse it or
   offer to show the parts as separate datasets. Reserve the clarifying question
   for a genuinely absent table, column, or join key.
9. Write directly to the analyst. Do not say "the user is asking", "the user
   requested", "I will generate", or describe internal routing. State the
   answer, the certified context used, the DQL artifact expectation, and the
   review requirement.
10. For notebook research, SQL build or repair, DQL import/build, or DQL reuse
   checks, start with one line in this form: "Outcome: <decision>". Use one of
   these decisions: Reuse certified block, Use existing draft, Review SQL preview,
   Fix SQL, Create DQL draft, Needs review, Cannot answer yet.`;

// Appended on a single retry when the model declined SQL for a question that the
// grounded schema + KG join routes can actually answer. Turns a false "no
// combined dataset — show them separately" refusal into the join the user asked
// for, while still allowing an honest refusal if context is truly missing.
const FORCE_JOIN_INSTRUCTION = `Your previous attempt declined to produce SQL. Re-read the supplied schema, metadata, and any "Knowledge graph join routes": this question CAN be answered by joining the grounded tables along their documented keys. Do NOT refuse, and do NOT suggest showing the datasets separately — compose ONE read-only SELECT/WITH that joins the relevant tables to answer it directly, following the JSON contract from rule 3. State the grain and the exact join path in the summary. Only if a required table, column, or join key is truly absent from the supplied context may you still ask a clarifying question.`;

/**
 * Produces the prompt-facing subset of a broad local context pack. Global
 * records remain available, while a record explicitly owned by another domain
 * cannot steer an otherwise single-domain question into its relationship path.
 * This is not a security boundary; manifest/domain-context validation still
 * happens after generation and at execution.
 */
function scopeContextPackToQuestionDomains(
  contextPack: LocalContextPack | undefined,
  domains: string[],
  manifest?: DQLManifest,
): LocalContextPack | undefined {
  if (!contextPack || domains.length === 0) return contextPack;
  const allowedDomains = new Set(domains);
  const relationDomains = manifestRelationDomains(manifest);
  const objectDomain = (object: LocalContextPack['objects'][number]): string | undefined =>
    object.domain ?? inferredManifestDomainForMetadataObject(object, relationDomains);
  const objects = contextPack.objects.filter((object) => {
    const domain = objectDomain(object);
    return !domain || allowedDomains.has(domain);
  });
  const objectKeys = new Set(objects.map((object) => object.objectKey));
  const relations = contextPack.allowedSqlContext.relations.filter((relation) =>
    (!relation.objectKey || objectKeys.has(relation.objectKey))
    && (!relationDomains.get(normalizeRelationKey(relation.relation))
      || allowedDomains.has(relationDomains.get(normalizeRelationKey(relation.relation))!)));
  const relationKeys = new Set(relations.map((relation) => normalizeRelationKey(relation.relation)));
  const selectedRelations = contextPack.retrievalDiagnostics.selectedRelations?.filter((relation) =>
    relationKeys.has(normalizeRelationKey(relation.relation)));
  const selectedJoinPaths = contextPack.retrievalDiagnostics.selectedJoinPaths?.filter((path) =>
    relationKeys.has(normalizeRelationKey(path.leftRelation))
    && relationKeys.has(normalizeRelationKey(path.rightRelation)));
  return {
    ...contextPack,
    focusObjectKey: contextPack.focusObjectKey && objectKeys.has(contextPack.focusObjectKey)
      ? contextPack.focusObjectKey
      : objects[0]?.objectKey ?? null,
    objects,
    skills: contextPack.skills.filter((skill) => !skill.domain || allowedDomains.has(skill.domain)),
    edges: contextPack.edges.filter((edge) => objectKeys.has(edge.fromKey) && objectKeys.has(edge.toKey)),
    citations: contextPack.citations.filter((citation) => objectKeys.has(citation.objectKey)),
    evidenceSummaries: contextPack.evidenceSummaries.filter((summary) => !summary.objectKey || objectKeys.has(summary.objectKey)),
    evidenceRoles: contextPack.evidenceRoles.filter((role) => objectKeys.has(role.objectKey)),
    allowedSqlContext: {
      relations,
      sourceBlockSql: contextPack.allowedSqlContext.sourceBlockSql.filter((source) => objectKeys.has(source.objectKey)),
    },
    retrievalDiagnostics: {
      ...contextPack.retrievalDiagnostics,
      selectedObjects: objects.length,
      selectedEvidence: contextPack.retrievalDiagnostics.selectedEvidence.filter((evidence) => objectKeys.has(evidence.objectKey)),
      selectedRelations,
      selectedJoinPaths,
      schemaShapeCandidates: contextPack.retrievalDiagnostics.schemaShapeCandidates?.filter((candidate) => objectKeys.has(candidate.objectKey)),
      certifiedCandidateFits: contextPack.retrievalDiagnostics.certifiedCandidateFits.filter((candidate) => objectKeys.has(candidate.objectKey)),
    },
  };
}

/**
 * Build the prompt-facing evidence pack after enforcing the certified output
 * contract. Incompatible blocks remain in the returned answer's `considered`
 * evidence for inspection, but their prose/SQL cannot steer generation.
 */
function contextPackForRequestedShape(
  contextPack: LocalContextPack | undefined,
  question: string,
  questionPlan: AnalysisQuestionPlan,
  kg: KGStore,
): LocalContextPack | undefined {
  if (!contextPack) return undefined;
  const incompatibleBlockKeys = new Set<string>();
  for (const object of contextPack.objects) {
    if (object.objectType !== 'dql_block') continue;
    const blockName = object.name || object.objectKey.replace(/^dql:block:/, '');
    const node = kg.getNode(`block:${blockName}`);
    if (node?.kind === 'block') {
      const fit = evaluateCertifiedBlockFit({ question, plan: questionPlan, block: node });
      if (fit.kind === 'context_only' || fit.kind === 'not_applicable') {
        incompatibleBlockKeys.add(object.objectKey);
      }
    }
  }
  if (incompatibleBlockKeys.size === 0) return contextPack;

  // Some embedders/tests provide a lightweight pack without a route decision.
  // The prompt still benefits from removing mismatched worked-example SQL.
  const existingRoute = contextPack.routeDecision;
  if (!existingRoute) {
    return {
      ...contextPack,
      allowedSqlContext: {
        ...contextPack.allowedSqlContext,
        sourceBlockSql: contextPack.allowedSqlContext.sourceBlockSql.filter(
          (source) => !incompatibleBlockKeys.has(source.objectKey),
        ),
      },
    };
  }
  const exactWasRemoved = Boolean(
    existingRoute.exactObjectKey
    && incompatibleBlockKeys.has(existingRoute.exactObjectKey),
  );
  const routeDecision = exactWasRemoved
    ? (() => {
        const {
          exactObjectKey: _exactObjectKey,
          grainGate: _grainGate,
          ...route
        } = existingRoute;
        return {
          ...route,
          route: 'generated_sql' as const,
          reason: 'No certified block satisfies the requested output shape; use compatible semantic and SQL evidence.',
          routeReason: 'The retrieved certified candidate has a different grain or output contract and is context-only.',
          trustLabel: route.trustLabel === 'certified' ? 'mixed' as const : route.trustLabel,
          reviewStatus: 'draft_ready' as const,
          certifiedApplicability: route.certifiedApplicability
            ? { ...route.certifiedApplicability, kind: 'context_only' as const }
            : undefined,
          selectedEvidence: route.selectedEvidence,
        };
      })()
    : {
        ...existingRoute,
      };

  return {
    ...contextPack,
    trustLabel: exactWasRemoved && contextPack.trustLabel === 'certified' ? 'mixed' : contextPack.trustLabel,
    routeDecision,
    allowedSqlContext: {
      ...contextPack.allowedSqlContext,
      sourceBlockSql: contextPack.allowedSqlContext.sourceBlockSql.filter(
        (source) => !incompatibleBlockKeys.has(source.objectKey),
      ),
    },
  };
}

function manifestRelationDomains(manifest: DQLManifest | undefined): Map<string, string> {
  const domains = new Map<string, string>();
  if (!manifest?.modeling || !manifest.dbtProvenance) return domains;
  for (const entity of Object.values(manifest.modeling.entities)) {
    const relation = manifest.dbtProvenance.nodes[entity.dbtUniqueId]?.relation;
    if (relation && entity.domain) domains.set(normalizeRelationKey(relation), entity.domain);
  }
  return domains;
}

function inferredManifestDomainForMetadataObject(
  object: LocalContextPack['objects'][number],
  relationDomains: Map<string, string>,
): string | undefined {
  const payload = object.payload ?? {};
  const relation = typeof payload.relation === 'string' ? payload.relation : undefined;
  if (relation) {
    const direct = relationDomains.get(normalizeRelationKey(relation));
    if (direct) return direct;
  }
  const haystack = `${object.objectKey} ${object.name}`.toLowerCase();
  for (const [relation, domain] of relationDomains) {
    const model = relation.split('.').at(-1);
    if (model && haystack.includes(model)) return domain;
  }
  return undefined;
}

/** Removes runtime tables that were explicitly present in, then excluded from, a broad context pack. */
function schemaContextWithinQuestionScope(
  schemaContext: AgentSchemaTable[],
  fullContextPack: LocalContextPack | undefined,
  scopedContextPack: LocalContextPack | undefined,
): AgentSchemaTable[] {
  if (!fullContextPack || fullContextPack === scopedContextPack) return schemaContext;
  const fullRelations = new Set(fullContextPack.allowedSqlContext.relations.map((relation) => normalizeRelationKey(relation.relation)));
  const scopedRelations = new Set((scopedContextPack?.allowedSqlContext.relations ?? []).map((relation) => normalizeRelationKey(relation.relation)));
  return schemaContext.filter((table) => {
    const key = normalizeRelationKey(table.relation);
    return !fullRelations.has(key) || scopedRelations.has(key);
  });
}

export function inferAnalyticalEntityIds(question: string, contextNodes: KGNode[], manifest: DQLManifest): string[] {
  if (manifest.manifestVersion !== 3 || !manifest.modeling || !manifest.dbtProvenance) return [];
  const normalizedQuestion = question.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const contextIds = new Set(contextNodes.map((node) => node.nodeId.toLowerCase()));
  const entityIdentifierTokens = new Set(Object.values(manifest.modeling.entities).flatMap((entity) =>
    entityIdentifierTokensForMatching(entity).map((token) => token.toLowerCase())));
  const scored = Object.entries(manifest.modeling.entities).map(([key, entity]) => {
    const dbt = manifest.dbtProvenance?.nodes[entity.dbtUniqueId];
    const entityTokens = entityIdentifierTokensForMatching(entity);
    // A backing dbt model may contain another entity's name (for example
    // `dim_customer_acquisition`). Its `customer` token must not turn a plain
    // customer question into an acquisition request. Only model tokens that are
    // unique to this entity are supplemental lexical evidence.
    const modelTokens = (dbt?.name ?? '')
      .toLowerCase()
      .replace(/^(fct|dim|stg)_/, '')
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !entityIdentifierTokens.has(token));
    const direct = entityTokens.some((token) => normalizedQuestion.includes(token))
      || modelTokens.some((token) => normalizedQuestion.includes(token));
    const inContext = contextIds.has(`entity:${entity.qualifiedId ?? entity.id}`.toLowerCase())
      || contextIds.has(`dbt_model:${entity.dbtUniqueId}`.toLowerCase())
      || contextNodes.some((node) => node.kind === 'dbt_model' && node.name === dbt?.name);
    return { id: key, direct, inContext };
  });
  // AGT-004: context retrieval is useful for completing a clearly named model,
  // but it must not manufacture a second entity merely because an unrelated
  // cross-domain block ranked in the context window. That was how a Commerce
  // product question reached Growth's attribution path. Prefer lexical evidence
  // whenever the question names at least one modeled entity; use context-only
  // inference solely as a fallback for genuinely indirect wording.
  const direct = scored.filter((entry) => entry.direct);
  const candidates = direct.length > 0 ? direct : scored.filter((entry) => entry.inContext);
  return candidates
    .sort((a, b) => Number(b.direct) - Number(a.direct) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((entry) => entry.id);
}

function entityIdentifierTokensForMatching(entity: { localId?: string; id: string }): string[] {
  return [entity.localId ?? entity.id]
    .flatMap((value) => value.toLowerCase().replace(/^(fct|dim|stg)_/, '').split(/[^a-z0-9]+/))
    .filter((token) => token.length > 2 && token !== 'entity');
}

function renderAnalyticalPlanPrompt(plan: AnalyticalPathPlan | undefined): string | undefined {
  if (!plan || plan.entities.length < 2) return undefined;
  if (!plan.safe) {
    return [
      'DQL ANALYTICAL POLICY DECISION: BLOCKED.',
      plan.message ?? 'No certified analytical relationship path is available.',
      `Policy code: ${plan.code ?? 'unsafe_relationship'}.`,
      'Do not invent a join from dbt lineage or shared column names. Return a clarification or refusal that asks for the missing relationship, export/import, or attribution policy.',
    ].join('\n');
  }
  return [
    'DQL CERTIFIED ANALYTICAL JOIN PLAN (authoritative):',
    ...plan.edges.map((edge, index) => [
      `${index + 1}. ${edge.fromEntity} (${edge.fromRelation ?? 'bound dbt model'}) -> ${edge.toEntity} (${edge.toRelation ?? 'bound dbt model'})`,
      `   relationship=${edge.relationshipId}; keys=${edge.keys.map((key) => `${key.from}=${key.to}`).join(', ')}; cardinality=${edge.cardinality}; fanout=${edge.fanout}`,
      edge.importRefs.length ? `   imports=${edge.importRefs.join(', ')}` : '',
    ].filter(Boolean).join('\n')),
    'Use only these relationships and exact key pairs. dbt DAG lineage and same-named columns are not join authorization. Any different join must be refused.',
  ].join('\n');
}

// Metric-anchored generation (Tier 2.5): a governed metric matched the question but
// the semantic layer couldn't compose the exact shape. Reuse the metric's CERTIFIED
// definition as the measure rather than reinventing it, so the number stays consistent
// with the governed metric — only the join/grouping around it is generated.
function metricAnchorInstruction(metricName: string, def: { expr: string; table: string }): string {
  return `A GOVERNED metric matched this question, but the semantic layer could not compose the exact requested shape on its own (the breakdown likely needs a join the metric's table does not own). You MUST compute the measure using this certified definition — do NOT redefine, rename, or approximate it:\n  metric "${metricName}": ${def.expr}   (defined over ${def.table})\nCompose ONE read-only SELECT/WITH using explicit aliases for every relation and include every output the user requested. Preserve the metric at its native grain before joining to a lower-grain dimension. NEVER SUM a lifetime, cumulative, balance, snapshot, rate, ratio, or already-aggregated value after a one-to-many join. If the requested result retains the metric's owning entity, expose the native-grain value (or a grain-preserving MAX after deduplication) for each entity/dimension pair; if it asks to allocate that value to the child dimension, request the missing allocation policy instead of inventing one. Join ${def.table} to other grounded tables only along documented keys. State the join path, output grain, and whether each measure is an entity-level attribute or an allocated child-level measure. Reusing the governed definition keeps the answer consistent with the certified metric; if the semantic layer cannot authorize the requested dimensional composition, keep the result exploratory/review-required rather than claiming semantic provenance.`;
}

function renderContextPrompt(
  blocks: KGNode[],
  businessContext: KGNode[],
  others: KGNode[],
  activeTier: AnswerSourceTier,
  memoryContext: AgentMemory[],
  extraContext?: string,
  followUp?: AgentFollowUpContext,
  schemaContext: AgentSchemaTable[] = [],
  intent: AgentIntent = 'ad_hoc_analysis',
  contextPack?: LocalContextPack,
  conversationSnapshot?: ConversationSnapshot,
  kgJoinPathHints: string[] = [],
  budget: PromptContextBudget = QUICK_PROMPT_CONTEXT_BUDGET,
  driver?: string,
): string {
  // W1.5 — dialect conventions so the model writes warehouse-correct SQL
  // (quoting, row-limiting, date functions) instead of a DuckDB/Postgres default
  // that fails on Snowflake/BigQuery/etc. Only emitted when a driver is known.
  const dialectSection = driver
    ? `\n\n## SQL dialect\n\n${describeDialectForPrompt(driver)}`
    : '';
  const intentSection = `## Routing intent\n\nintent: ${intent}\n${intent === 'exact_certified_lookup'
    ? 'Use a certified artifact only if it exactly answers the question.'
    : 'Prepare a review-required DQL artifact with a SQL preview for this question. Certified blocks are trusted context, not a reason to answer the wrong grain.'}`;
  const budgetSection = `\n\n## Context budget\n\nContext budget: ${budget.label} (relations=${budget.relationCardLimit}, relation_columns=${budget.relationColumnLimit}, objects=${budget.contextObjectLimit}, edges=${budget.edgeLimit}).`;
  const blockSection = blocks.length > 0
    ? `## Relevant DQL blocks\n\n${blocks
        .map((b) => `- \`${b.nodeId}\` (${b.domain ?? 'unscoped'}, ${b.status ?? b.certification ?? 'review_required'}): ${b.description ?? b.llmContext ?? '(no description)'}`)
        .join('\n')}`
    : '## Relevant DQL blocks: (none matched)';
  const businessSection = businessContext.length > 0
    ? `\n\n## Business context from DQL terms and business views\n\n${businessContext
        .map((n) => `- ${n.kind.replace('_', ' ')} \`${n.name}\`${n.domain ? ` (domain: ${n.domain})` : ''}${n.description ? ` — ${n.description}` : ''}${n.llmContext ? `\n  ${n.llmContext.replace(/\n/g, '\n  ')}` : ''}`)
        .join('\n')}`
    : '';
  const otherSection = others.length > 0
    ? `\n\n## Related ${activeTier === 'semantic_layer' ? 'semantic layer' : 'dbt manifest'} context\n\n${others
        .map((n) => `- ${n.kind} \`${n.name}\`${n.domain ? ` (domain: ${n.domain})` : ''}${n.description ? ` — ${n.description}` : ''}${n.llmContext ? `\n  ${n.llmContext.replace(/\n/g, '\n  ')}` : ''}`)
        .join('\n')}`
    : '';
  const kgJoinSection = kgJoinPathHints.length > 0
    ? `\n\n## Knowledge graph join routes\n\nUse these as relationship/navigation evidence for multi-entity analysis. SQL must still use inspected relation columns from the schema or metadata context.\n${kgJoinPathHints.map((hint) => `- ${hint}`).join('\n')}`
    : '';
  const schemaSection = schemaContext.length > 0
    ? `\n\n## Runtime schema context\n\nUse only these runtime relations and columns when generating SQL unless the dbt manifest context gives an equivalent relation.\n${schemaContext
        .slice(0, budget.schemaTableLimit)
        .map((table) => {
          const cols = table.columns
            .slice(0, budget.schemaColumnLimit)
            .map((col) => {
              const sampleValues = col.sampleValues?.length
                ? `; matched values: ${col.sampleValues.slice(0, 4).map(formatPromptValue).join(', ')}`
                : '';
              return `${col.name}${col.type ? ` ${col.type}` : ''}${col.description ? ` (${col.description})` : ''}${sampleValues}`;
            })
            .join(', ');
          return `- ${table.relation}${table.description ? ` — ${table.description}` : ''}\n  columns: ${cols}`;
        })
        .join('\n')}`
    : '';
  const memorySection = memoryContext.length > 0
    ? `\n\n## Advisory local memory\n\nMemory can clarify business language but MUST NOT override certified artifacts, semantic metrics, or dbt metadata.\n${memoryContext
        .slice(0, 6)
        .map((m) => `- ${m.scope}${m.scopeId ? `:${m.scopeId}` : ''} \`${m.title}\` (${m.source}, confidence ${m.confidence}): ${m.content}`)
        .join('\n')}`
    : '';
  // Approved, scope-matched correction hints from the Hint Graph. These are
  // human-reviewed lessons (often from a prior wrong→right SQL correction), so
  // they carry more weight than advisory memory when preparing a SQL preview — but they
  // still must NOT override a certified artifact that already answers exactly.
  const appliedHints = contextPack?.appliedHints ?? [];
  const hintsSection = appliedHints.length > 0
    ? `\n\n## Applied governed hints (human-approved corrections)\n\nReviewed, scope-matched corrections from your team. Apply them when preparing a SQL preview to avoid known mistakes; they refine the DQL artifact's SQL preview but MUST NOT override a certified artifact that already answers the question.\n${appliedHints
        .slice(0, 6)
        .map((h) => `- \`${h.title}\`: ${h.guidance}${h.correctedSql ? `\n  corrected SQL pattern: ${h.correctedSql.replace(/\s+/g, ' ').trim().slice(0, 240)}` : ''}`)
        .join('\n')}`
    : '';
  const extraSection = extraContext?.trim()
    ? `\n\n## Current notebook/app context\n\nThis context may help interpret the user's request, but it MUST NOT override certified artifacts, semantic metrics, dbt metadata, or SQL preview validation.\n\n${extraContext.trim()}`
    : '';
  const followUpSection = followUp
    ? `\n\n## Follow-up routing context\n\n${renderFollowUpContext(followUp)}`
    : '';
  const conversationSection = conversationSnapshot
    ? `\n\n## Conversation state (session)\n\n${renderConversationSnapshot(conversationSnapshot)}`
    : '';
  const contextPackSection = contextPack
    ? `\n\n## Local metadata context pack\n\n${renderContextPackForPrompt(contextPack, budget)}`
    : '';
  return `${intentSection}${budgetSection}${dialectSection}\n\n${blockSection}${businessSection}${otherSection}${kgJoinSection}${schemaSection}${contextPackSection}${memorySection}${hintsSection}${conversationSection}${extraSection}${followUpSection}`;
}

function buildKgJoinPathHints(kg: KGStore, nodes: KGNode[], questionPlan: AnalysisQuestionPlan): string[] {
  const candidates = nodes
    .filter((node) => ['block', 'business_view', 'metric', 'entity', 'semantic_model', 'dbt_model', 'dbt_source'].includes(node.kind))
    .slice(0, 8);
  if (candidates.length < 2) return [];
  const domains = new Set(candidates.map((node) => node.domain).filter((domain): domain is string => Boolean(domain)));
  const shouldSearch = domains.size > 1 || questionPlan.entities.length > 1 || questionPlan.dimensionTerms.length > 1;
  if (!shouldSearch) return [];

  const hints: string[] = [];
  const seen = new Set<string>();
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      if (hints.length >= 6) return hints;
      const left = candidates[leftIndex]!;
      const right = candidates[rightIndex]!;
      const path = kg.findJoinPath(left.nodeId, right.nodeId, 4);
      if (!path || path.length < 2) continue;
      const key = path.join('>');
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push(path.map((nodeId) => formatKgPathNode(kg, nodeId)).join(' -> '));
    }
  }
  return hints;
}

function formatKgPathNode(kg: KGStore, nodeId: string): string {
  const node = kg.getNode(nodeId);
  if (!node) return nodeId;
  return `${node.kind}:${node.name}`;
}

/**
 * Bounded rendering of the persisted conversation snapshot: working state one-liner
 * (≤300 chars), compacted rolling summary (≤600), and up to 4 recent turns (≤280 each).
 */
function renderConversationSnapshot(snapshot: ConversationSnapshot): string {
  const parts: string[] = [];
  const state = snapshot.workingState;
  if (state) {
    const stateLine = [
      state.entities.length ? `entities=${state.entities.join(',')}` : '',
      state.measures.length ? `measures=${state.measures.join(',')}` : '',
      state.dimensions.length ? `dimensions=${state.dimensions.join(',')}` : '',
      state.filters.length ? `filters=${state.filters.map((f) => f.value).join(',')}` : '',
      state.limit ? `limit=${state.limit}` : '',
      state.timeframe ? `timeframe=${state.timeframe}` : '',
      snapshot.topicRelation ? `topic=${snapshot.topicRelation}` : '',
    ].filter(Boolean).join('; ');
    if (stateLine) parts.push(`Working state: ${stateLine.slice(0, 300)}`);
  } else if (snapshot.topicRelation) {
    parts.push(`Working state: topic=${snapshot.topicRelation}`);
  }
  if (snapshot.rollingSummary) {
    parts.push(`Earlier in this conversation (compacted):\n${snapshot.rollingSummary.slice(0, 600)}`);
  }
  if (snapshot.recentTurns.length > 0) {
    const turns = snapshot.recentTurns.slice(-4).map((turn, index) => {
      return `${index + 1}. ${renderConversationSnapshotTurnLine(turn, 520)}`;
    });
    parts.push(`Recent turns:\n${turns.join('\n')}`);
  }
  if (snapshot.recalledTurns?.length) {
    parts.push(`Recalled earlier turns (semantic match):\n${snapshot.recalledTurns.slice(0, 3)
      .map((turn) => `- ${renderConversationSnapshotTurnLine(turn, 520)}`)
      .join('\n')}`);
  }
  parts.push('Use this only where the question refers to it. On a new topic, answer fresh.');
  return parts.join('\n\n');
}

function renderConversationSnapshotTurnLine(turn: ConversationSnapshot['recentTurns'][number], max: number): string {
  const line = [
    `Q: ${turn.question}`,
    turn.answerSummary ? `A: ${turn.answerSummary}` : '',
    turn.resultColumns?.length ? `cols: ${turn.resultColumns.slice(0, 6).join(', ')}` : '',
    typeof turn.resultRowCount === 'number' ? `rows: ${turn.resultRowCount}` : '',
    turn.sourceSql ? `sql: ${compactSqlSnippet(turn.sourceSql, 180)}` : '',
    turn.dqlArtifact?.name ? `dql: ${turn.dqlArtifact.name}` : '',
    turn.sourceCertifiedBlock ? `block: ${turn.sourceCertifiedBlock}` : '',
  ].filter(Boolean).join(' | ');
  return line.slice(0, max);
}

function renderContextPackForPrompt(contextPack: LocalContextPack, budget: PromptContextBudget): string {
  const questionPlan = contextPack.questionPlan
    ? [
        `Question plan: ${contextPack.questionPlan.mode} -> ${contextPack.questionPlan.routeIntent}`,
        contextPack.questionPlan.entities.length
          ? `Entities: ${contextPack.questionPlan.entities.map((entity) => entity.text).join(', ')}`
          : '',
        contextPack.questionPlan.metricTerms.length ? `Metric terms: ${contextPack.questionPlan.metricTerms.join(', ')}` : '',
        contextPack.questionPlan.dimensionTerms.length ? `Dimension terms: ${contextPack.questionPlan.dimensionTerms.join(', ')}` : '',
        `Answer shape: ${contextPack.questionPlan.outputShape}`,
      ].filter(Boolean).join('\n')
    : '';
  const certifiedApplicability = contextPack.routeDecision?.certifiedApplicability
    ? `\nCertified applicability: ${contextPack.routeDecision.certifiedApplicability.name} is ${contextPack.routeDecision.certifiedApplicability.kind} (${contextPack.routeDecision.certifiedApplicability.reasons.join('; ')})`
    : '';
  const blockFit = contextPack.routeDecision?.blockFit
    ? `\nCertified block fit: ${contextPack.routeDecision.blockFit.kind} / ${contextPack.routeDecision.blockFit.confidence} (${contextPack.routeDecision.blockFit.reasons.join('; ')})`
    : '';
  const warnings = contextPack.warnings.length
    ? `Warnings:\n${contextPack.warnings.slice(0, budget.warningLimit).map((warning) => `- ${warning}`).join('\n')}\n`
    : '';
  const objects = contextPack.objects.slice(0, budget.contextObjectLimit).map((object) => {
    const detail = [
      object.objectType,
      object.domain ? `domain: ${object.domain}` : '',
      object.status ? `status: ${object.status}` : '',
      object.description ? `description: ${object.description}` : '',
    ].filter(Boolean).join('; ');
    return `- ${object.objectKey} (${detail})`;
  }).join('\n');
  const conflicts = contextPack.retrievalDiagnostics.candidateConflicts.length
    ? `\nCandidate conflicts:\n${contextPack.retrievalDiagnostics.candidateConflicts.slice(0, 4).map((conflict) => `- ${conflict.reason} ${conflict.prompt}`).join('\n')}`
    : '';
  const route = contextPack.routeDecision
    ? `\nRoute decision: ${contextPack.routeDecision.route} / ${contextPack.routeDecision.intent}\nReason: ${contextPack.routeDecision.reason}${certifiedApplicability}${blockFit}\nMissing context: ${contextPack.routeDecision.missingContext.map((item) => item.message).join(' ') || 'none'}`
    : '';
  const allowed = renderAllowedSqlRelationsForPrompt(contextPack, budget);
  const joins = renderCandidateJoinsForPrompt(contextPack, budget);
  const lineage = renderColumnLineageForPrompt(contextPack, budget);
  const edges = renderContextEdgesForPrompt(contextPack, budget);
  const relationDiagnostics = contextPack.retrievalDiagnostics?.selectedRelations?.length
    ? `\nSelected relation reasoning:\n${contextPack.retrievalDiagnostics.selectedRelations.slice(0, budget.selectedRelationReasonLimit).map((relation) => `- ${relation.relation} (score ${relation.score.toFixed(1)}): ${relation.reason}`).join('\n')}`
    : '';
  const sourceSql = renderSourceBlockSqlContext(contextPack, budget);
  return [
    `context_pack_id: ${contextPack.id}`,
    `trust_label: ${contextPack.trustLabel}`,
    contextPack.trustLabelInfo ? `trust_label_canonical: ${contextPack.trustLabelInfo.display}` : '',
    questionPlan.trim(),
    route.trim(),
    warnings.trim(),
    `Selected evidence:\n${objects || '- none'}`,
    allowed.trim(),
    joins.trim(),
    edges.trim(),
    lineage.trim(),
    relationDiagnostics.trim(),
    sourceSql.trim(),
    conflicts.trim(),
  ].filter(Boolean).join('\n');
}

function renderCandidateJoinsForPrompt(contextPack: LocalContextPack, budget: PromptContextBudget): string {
  const joins = contextPack.retrievalDiagnostics.selectedJoinPaths?.length
    ? contextPack.retrievalDiagnostics.selectedJoinPaths.slice(0, budget.joinPathLimit).map((join) => ({
        leftRelation: join.leftRelation,
        leftColumn: join.leftColumn,
        rightRelation: join.rightRelation,
        rightColumn: join.rightColumn,
        reason: join.reason,
      }))
    : buildCandidateJoinPaths(schemaContextWithAllowedSqlContext([], contextPack)).slice(0, budget.joinPathLimit);
  if (joins.length === 0) return '';
  return [
    'Suggested join paths from selected metadata:',
    ...joins.map((join) =>
      `- ${join.leftRelation}.${join.leftColumn} -> ${join.rightRelation}.${join.rightColumn}${join.reason ? ` (${join.reason})` : ''}`
    ),
  ].join('\n');
}

function renderContextEdgesForPrompt(contextPack: LocalContextPack, budget: PromptContextBudget): string {
  if (budget.edgeLimit <= 0) return '';
  const edges = contextPack.edges.slice(0, budget.edgeLimit);
  if (edges.length === 0) return '';
  return [
    'Context graph edges:',
    'Use these object relationships as metadata evidence; SQL still must use inspected relation columns and join keys.',
    ...edges.map((edge) => {
      const confidence = typeof edge.confidence === 'number' ? ` (confidence ${edge.confidence.toFixed(2)})` : '';
      return `- ${edge.edgeType}: ${edge.fromKey} -> ${edge.toKey}${confidence}`;
    }),
  ].join('\n');
}

function renderColumnLineageForPrompt(contextPack: LocalContextPack, budget: PromptContextBudget): string {
  const lineageEdges = contextPack.edges
    .filter((edge) => edge.edgeType === 'derives_from')
    .slice(0, budget.lineageEdgeLimit);
  if (lineageEdges.length === 0) return '';
  const objectsByKey = new Map(contextPack.objects.map((object) => [object.objectKey, object]));
  return [
    'Column lineage from governed metadata:',
    'Use this when adapting certified blocks or dbt models into a DQL artifact SQL preview so derived output columns map back to their physical source columns.',
    ...lineageEdges.map((edge) => {
      const from = objectsByKey.get(edge.fromKey);
      const to = objectsByKey.get(edge.toKey);
      const aggregateFn = typeof edge.payload?.aggregateFn === 'string' && edge.payload.aggregateFn.trim()
        ? ` via ${edge.payload.aggregateFn.trim().toUpperCase()}`
        : '';
      const confidence = typeof edge.confidence === 'number' ? `, confidence ${edge.confidence.toFixed(2)}` : '';
      return `- ${formatLineageObjectForPrompt(from, edge.fromKey)} derives from ${formatLineageObjectForPrompt(to, edge.toKey)}${aggregateFn}${confidence}`;
    }),
  ].join('\n');
}

function formatLineageObjectForPrompt(
  object: LocalContextPack['objects'][number] | undefined,
  fallbackKey: string,
): string {
  if (!object) return fallbackKey;
  return object.fullName ?? object.name ?? object.objectKey;
}

function renderAllowedSqlRelationsForPrompt(contextPack: LocalContextPack, budget: PromptContextBudget): string {
  const relations = contextPack.allowedSqlContext?.relations ?? [];
  if (relations.length === 0) return '';
  const selectedLookup = selectedRelationLookup(contextPack);
  const cards = relations.slice(0, budget.relationCardLimit).map((relation, index) => {
    const selection = relationSelectionFor(relation.relation, selectedLookup);
    const rank = selection?.rank ?? index + 1;
    const score = typeof selection?.score === 'number' ? `, score ${selection.score.toFixed(1)}` : '';
    const reason = selection?.reason ? `\n  why selected: ${selection.reason}` : '';
    const columns = relation.columns.length
      ? relation.columns.slice(0, budget.relationColumnLimit).map(formatRelationColumnForPrompt).join(', ')
      : '(columns unavailable; use certified source SQL shape or inspect metadata before inventing columns)';
    return [
      `- [rank ${rank}${score}] ${relation.relation} (${relation.source})`,
      reason,
      `\n  columns: ${columns}`,
    ].join('');
  });
  const otherRelations = renderOtherAvailableRelationsForPrompt(contextPack, budget);
  return [
    'Selected SQL relation context:',
    'Use these ranked relations and columns as the primary SQL-generation boundary. Prefer lower rank when multiple relations look plausible.',
    ...cards,
    otherRelations,
  ].filter(Boolean).join('\n');
}

function renderOtherAvailableRelationsForPrompt(contextPack: LocalContextPack, budget: PromptContextBudget): string {
  const names = new Map<string, string>();
  for (const relation of (contextPack.allowedSqlContext?.relations ?? []).slice(budget.otherRelationStart, budget.otherRelationEnd)) {
    names.set(normalizePromptRelationName(relation.relation), relation.relation);
  }
  for (const item of contextPack.retrievalDiagnostics.topRejected ?? []) {
    if (!isRelationLikeRejectedObject(item.objectType)) continue;
    names.set(normalizePromptRelationName(item.name), item.name);
  }
  const values = [...names.values()].slice(0, budget.otherRelationLimit);
  if (values.length === 0) return '';
  return `Other available relations (names only - expand context before using columns): ${values.join(', ')}`;
}

function isRelationLikeRejectedObject(objectType: string): boolean {
  return objectType === 'dbt_model'
    || objectType === 'dbt_source'
    || objectType === 'warehouse_table'
    || objectType === 'runtime_table';
}

function normalizePromptRelationName(name: string): string {
  return name.toLowerCase().replace(/["`]/g, '').trim();
}

function formatRelationColumnForPrompt(column: AgentSchemaColumn): string {
  const type = column.type ? ` ${column.type}` : '';
  const description = column.description ? ` - ${column.description.replace(/\s+/g, ' ').trim()}` : '';
  const samples = column.sampleValues?.length
    ? `; matched values: ${column.sampleValues.slice(0, 4).map(formatPromptValue).join(', ')}`
    : '';
  return `${column.name}${type}${description}${samples}`;
}

function renderSourceBlockSqlContext(contextPack: LocalContextPack, budget: PromptContextBudget): string {
  const sources = contextPack.allowedSqlContext?.sourceBlockSql ?? [];
  if (sources.length === 0) return '';
  const lines = sources.slice(0, budget.sourceSqlLimit).map((source) => {
    const shape = extractSimpleSelectShape(source.sql);
    const projectedColumns = shape
      ? shape.selectExpressions
          .map(selectExpressionOutputName)
          .filter((value): value is string => Boolean(value))
          .slice(0, budget.sourceSqlColumnLimit)
          .join(', ')
      : '';
    const snippet = compactSqlSnippet(source.sql, 280);
    // Pair each certified block's SQL with the natural-language question it
    // answers so it reads as a question→SQL few-shot exemplar (DAIL-SQL).
    const anchorRaw = source.exampleQuestion ?? source.description;
    const anchor = anchorRaw ? anchorRaw.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    return [
      `- ${source.name}${source.status ? ` (${source.status})` : ''}${source.grain ? ` — grain: ${source.grain}` : ''}`,
      anchor ? `  answers: ${anchor}` : '',
      shape?.relation ? `  relation: ${shape.relation}` : '',
      projectedColumns ? `  projected columns: ${projectedColumns}` : '',
      snippet ? `  sql: ${snippet}` : '',
    ].filter(Boolean).join('\n');
  });
  return `## Worked examples from certified blocks (few-shot patterns)\n\nThese certified blocks already answer similar questions. Learn their join paths, grain, and filters and ADAPT them to the question — do not copy blindly, and do not relabel a review-required DQL artifact or SQL preview as certified.\n${lines.join('\n')}`;
}

function contextPackCitations(contextPack: LocalContextPack | undefined, limit: number): AgentCitation[] {
  if (!contextPack) return [];
  return contextPack.objects.slice(0, limit).map((object) => ({
    nodeId: object.objectKey,
    kind: metadataObjectKindForCitation(object.objectType),
    name: object.name,
    sourceTier: metadataObjectSourceTier(object.objectType),
    provenance: object.sourceSystem,
  }));
}

function agentIntentFromCatalogRoute(route: MetadataRouteDecision): AgentIntent {
  if (route.route === 'clarify') return 'clarify';
  if (route.route === 'certified') return route.intent === 'definition_lookup' ? 'definition_lookup' : 'exact_certified_lookup';
  return route.intent;
}

function shouldUseCertifiedRoute(route: MetadataRouteDecision | undefined, intent: AgentIntent): boolean {
  if (route) return route.route === 'certified';
  return intent === 'exact_certified_lookup' || intent === 'definition_lookup';
}

function certifiedHitFromContextPack(contextPack: LocalContextPack | undefined, kg: KGStore): KGSearchHit | null {
  if (contextPack?.routeDecision.blockFit && !certifiedFitAllowsTier1(contextPack.routeDecision.blockFit)) return null;
  const key = contextPack?.routeDecision.exactObjectKey;
  if (!key) return null;
  const object = contextPack.objects.find((item) => item.objectKey === key);
  if (!object) return null;
  const nodeId = object.objectType === 'dql_block'
    ? `block:${object.name}`
    : object.objectType === 'dql_term'
      ? `term:${object.name}`
      : object.objectType === 'business_view'
        ? `business_view:${object.name}`
        : undefined;
  const node = nodeId ? kg.getNode(nodeId) : null;
  return node ? { node, score: 1, snippet: object.snippet } : null;
}

/**
 * Reduce a possibly-composed prompt to the user's actual question for display.
 * Callers (e.g. the Build-SQL-draft modal) sometimes prepend a multi-line instruction
 * and end with "User question: <q>" / "User request: <q>"; echoing the whole blob in a
 * clarify message leaks the system prompt. Extract the trailing question, collapse
 * whitespace, and bound the length so clarify text is always a clean one-liner.
 */
export function extractUserQuestion(raw: string): string {
  const marker = /(?:^|\n)\s*user (?:question|request)\s*:\s*([\s\S]+)$/i.exec(raw);
  const picked = (marker ? marker[1] : raw).replace(/\s+/g, ' ').trim();
  return picked.length > 160 ? `${picked.slice(0, 157)}…` : picked;
}

function composeCatalogClarificationText(question: string, route: MetadataRouteDecision | undefined): string | undefined {
  if (!route?.missingContext.length) return undefined;
  const missing = route.missingContext.map((item) => item.message).join(' ');
  const followUp = route.followUps[0] ? ` ${route.followUps[0]}?` : '';
  return `I need one more detail before querying "${extractUserQuestion(question)}". ${missing}${followUp}`;
}

function sourceTierFromContextPack(contextPack: LocalContextPack | undefined): AnswerSourceTier | undefined {
  if (!contextPack) return undefined;
  if (contextPack.objects.some((object) => object.objectType === 'semantic_metric')) return 'semantic_layer';
  if (contextPack.objects.some((object) => object.objectType.startsWith('dbt_') || object.objectType === 'warehouse_table' || object.objectType === 'runtime_table')) return 'dbt_manifest';
  if (contextPack.objects.some((object) => object.objectType === 'dql_term' || object.objectType === 'business_view')) return 'business_context';
  if (contextPack.objects.some((object) => object.objectType === 'dql_block')) return 'certified_artifact';
  return undefined;
}

function metadataObjectKindForCitation(objectType: string): AgentCitation['kind'] {
  if (objectType === 'dql_block') return 'block';
  if (objectType === 'dql_term') return 'term';
  if (objectType === 'business_view') return 'business_view';
  if (objectType === 'semantic_metric') return 'metric';
  if (objectType === 'semantic_dimension') return 'dimension';
  if (objectType === 'dbt_model') return 'dbt_model';
  if (objectType === 'dbt_source' || objectType === 'warehouse_table') return 'dbt_source';
  if (objectType === 'notebook') return 'notebook';
  if (objectType === 'dashboard') return 'dashboard';
  if (objectType === 'app') return 'app';
  return 'runtime_schema';
}

function metadataObjectSourceTier(objectType: string): AgentCitation['sourceTier'] {
  if (objectType === 'dql_block') return 'certified_artifact';
  if (objectType === 'dql_term' || objectType === 'business_view') return 'business_context';
  if (objectType.startsWith('semantic_')) return 'semantic_layer';
  if (objectType.startsWith('dbt_') || objectType === 'warehouse_table') return 'dbt_manifest';
  return 'business_context';
}

function renderFollowUpContext(followUp: AgentFollowUpContext): string {
  const parts = [
    `kind: ${followUp.kind}`,
    followUp.sourceBlockName ? `source certified block: ${followUp.sourceBlockName}` : '',
    followUp.sourceQuestion ? `source question: ${followUp.sourceQuestion}` : '',
    followUp.sourceAnswer ? `source answer: ${followUp.sourceAnswer.slice(0, 700)}` : '',
    followUp.filters?.length ? `requested filters: ${followUp.filters.join(', ')}` : '',
    followUp.dimensions?.length ? `requested dimensions: ${followUp.dimensions.join(', ')}` : '',
    followUp.priorResultColumns?.length ? `prior result columns: ${followUp.priorResultColumns.join(', ')}` : '',
    followUp.priorResultValues ? `prior result values: ${formatPriorResultValues(followUp.priorResultValues)}` : '',
    followUp.priorResultRef ? renderPriorResultReference(followUp.priorResultRef) : '',
    followUp.priorDqlArtifact ? renderPriorDqlArtifactReference(followUp.priorDqlArtifact) : '',
    followUp.priorLimit ? `prior result limit: ${followUp.priorLimit}` : '',
  ].filter(Boolean);
  const rule = followUp.kind === 'drilldown'
    ? 'routing rule: find a distinct certified drilldown block first; if none exists, prepare a review-required DQL artifact with a SQL preview as a draft drilldown. Do not silently re-run the source block unless it explicitly supports the requested filter or dimension.'
    : followUp.kind === 'contextual'
      ? 'routing rule: this is prior-turn context (advisory). The user may be continuing from it — resolve references like "these"/"those"/"same" against it when the question refers to it. If this question starts a genuinely new topic, ignore the prior-turn context entirely and answer fresh.'
      : 'routing rule: reuse the prior certified block when the user asks a generic follow-up.';
  return [...parts, rule].join('\n');
}

function renderPriorResultReference(ref: AgentPriorResultReference): string {
  const lines = [
    `prior result ref: result:${ref.id}`,
    ref.question ? `prior result question: ${ref.question.slice(0, 220)}` : '',
    ref.columns.length ? `prior result schema: ${ref.columns.slice(0, 24).join(', ')}` : '',
    typeof ref.rowCount === 'number' ? `prior result row count: ${ref.rowCount}` : '',
    ref.sourceSql ? `prior result source SQL: ${compactSqlSnippet(ref.sourceSql, 500)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function renderPriorDqlArtifactReference(artifact: AgentDqlArtifactReference): string {
  const lines = [
    `prior DQL artifact kind: ${artifact.kind}`,
    artifact.name ? `prior DQL artifact name: ${artifact.name}` : '',
    artifact.sourcePath ? `prior DQL artifact path: ${artifact.sourcePath}` : '',
    artifact.metrics?.length ? `prior DQL metrics: ${artifact.metrics.slice(0, 12).join(', ')}` : '',
    artifact.dimensions?.length ? `prior DQL dimensions: ${artifact.dimensions.slice(0, 12).join(', ')}` : '',
    artifact.filters?.length ? `prior DQL filters: ${artifact.filters.slice(0, 8).map(formatDqlArtifactFilter).join('; ')}` : '',
    artifact.timeDimension ? `prior DQL time: ${artifact.timeDimension.name} / ${artifact.timeDimension.granularity}` : '',
    artifact.source.trim() ? `prior DQL artifact source:\n${compactSqlSnippet(artifact.source, 1400)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function formatDqlArtifactFilter(filter: { dimension: string; operator: string; values: string[] }): string {
  return `${filter.dimension} ${filter.operator} ${filter.values.slice(0, 8).join(', ')}`;
}

function formatPriorResultValues(values: Record<string, string[]>): string {
  return Object.entries(values)
    .slice(0, 8)
    .map(([key, vals]) => `${key}=[${vals.slice(0, 12).join(', ')}]`)
    .join('; ');
}

function generatedTrustExplanation(input: {
  followUp?: AgentFollowUpContext;
  sourceCertifiedBlock?: string;
  draftBlock?: GeneratedDraftBlock;
}): string | undefined {
  if (input.followUp?.kind !== 'drilldown') return undefined;
  const source = input.sourceCertifiedBlock
    ? ` I used the certified \`${input.sourceCertifiedBlock}\` block for the business definition,`
    : ' I used certified context where available,';
  const filters = [
    ...(input.followUp.filters ?? []),
    ...(input.followUp.dimensions ?? []),
  ];
  const grain = filters.length ? ` at the requested ${filters.join('/')} grain` : ' at the requested drilldown grain';
  const draft = input.draftBlock
    ? ` The DQL draft was saved at \`${input.draftBlock.path}\` for review.`
    : ' The review-required DQL artifact and SQL preview still need analyst review before certification.';
  return `This is an uncertified drilldown.${source} then prepared a SQL preview${grain}.${draft}`;
}

function cleanGeneratedSummary(text: string): string {
  return text
    .trim()
    .replace(/^(?:the user (?:is asking|asked|wants|requested)[^.]*\.\s*)+/i, '')
    .replace(/\s*(?:therefore,\s*)?i will generate review-required sql[^.]*\.\s*/gi, ' ')
    .replace(/\s*(?:therefore,\s*)?i will prepare (?:a )?review-required dql artifact[^.]*\.\s*/gi, ' ')
    .replace(/\s*(?:therefore,\s*)?i will generate[^.]*\.\s*/gi, ' ')
    .trim();
}

interface ParsedProposal {
  text: string;
  sql?: string;
  viz?: string;
  outputs?: string[];
  proposedEntity?: string;
  requestedFilters?: string[];
  requestedDimensions?: string[];
}

/**
 * A source-to-target flow has a strict three-field contract. Models sometimes
 * add a high-overlap but unrelated categorical grouping from retrieved context
 * (for example customer_type), which splits edge weights and corrupts both the
 * summary and Sankey. For a simple generated SELECT, narrow the projection and
 * GROUP BY to the two fields explicitly named in the question plus one
 * aggregate. This never invents SQL and leaves complex CTE queries untouched.
 */
export function tightenSourceTargetFlowProjection(
  sql: string,
  question: string,
  plan: AnalysisQuestionPlan,
): { sql: string; outputs: string[] } | undefined {
  if (!/\bsankey|flow|source.?to.?target|from .+ to\b/i.test(question)) return undefined;
  if (!/^\s*select\b/i.test(sql)) return undefined;
  const shape = extractSimpleSelectShape(sql);
  if (!shape || shape.selectExpressions.length < 3) return undefined;

  const entries = shape.selectExpressions.map((expression) => ({
    expression,
    output: selectExpressionOutputName(expression),
  })).filter((entry): entry is { expression: string; output: string } => Boolean(entry.output));
  const measureTerms = new Set(plan.requestedShape.measures.map(normalizeFlowField));
  const aggregates = entries.filter((entry) =>
    /\b(?:sum|count|avg|average|min|max)\s*\(/i.test(entry.expression)
    || [...measureTerms].some((measure) => flowFieldCovers(entry.output, measure))
  );
  const measure = aggregates[0];
  if (!measure) return undefined;

  const mentionedDimensions = entries
    .filter((entry) => entry !== measure)
    .map((entry) => ({ ...entry, position: flowFieldPosition(question, entry.output) }))
    .filter((entry) => entry.position >= 0)
    .sort((left, right) => left.position - right.position);
  const source = mentionedDimensions[0];
  const target = mentionedDimensions.find((entry) => entry.output !== source?.output);
  if (!source || !target) return undefined;

  const kept = [source, target, measure];
  const outputs = kept.map((entry) => entry.output);
  if (entries.length === kept.length && entries.every((entry, index) => entry.output === outputs[index])) {
    return { sql, outputs };
  }
  const selectMatch = /\bselect\b[\s\S]*?\bfrom\b/i.exec(sql);
  if (!selectMatch || selectMatch.index !== sql.search(/\bselect\b/i)) return undefined;
  const replacement = `SELECT\n  ${kept.map((entry) => entry.expression).join(',\n  ')}\nFROM`;
  let narrowed = `${sql.slice(0, selectMatch.index)}${replacement}${sql.slice(selectMatch.index + selectMatch[0].length)}`;
  const groupExpressions = [source, target].map((entry) => selectSourceExpression(entry.expression));
  narrowed = narrowed.replace(
    /\bgroup\s+by\b[\s\S]*?(?=\bhaving\b|\border\s+by\b|\blimit\b|$)/i,
    `GROUP BY ${groupExpressions.join(', ')}`,
  );
  return { sql: narrowed.trim(), outputs };
}

function selectSourceExpression(expression: string): string {
  return expression
    .replace(/\s+as\s+["`]?\w+["`]?\s*$/i, '')
    .trim();
}

function flowFieldPosition(question: string, field: string): number {
  const normalizedQuestion = normalizeFlowField(question);
  const normalizedField = normalizeFlowField(field);
  return normalizedField ? normalizedQuestion.indexOf(normalizedField) : -1;
}

function flowFieldCovers(field: string, term: string): boolean {
  const normalizedField = normalizeFlowField(field);
  return normalizedField === term || normalizedField.split(' ').includes(term);
}

function normalizeFlowField(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Public for tests. Prefer the structured W2.7 JSON proposal contract, then
 * fall back to the legacy prose + ```sql block + Viz line format.
 */
export function parseProposal(raw: string): ParsedProposal {
  const structured = parseStructuredProposal(raw);
  if (structured) return structured;
  const sqlMatch = raw.match(/```sql\s*([\s\S]*?)```/i);
  const sql = sqlMatch ? sqlMatch[1].trim() : undefined;
  const vizMatch = raw.match(/^Viz:\s*([a-z_]+)/im);
  const viz = vizMatch ? vizMatch[1].trim().toLowerCase() : undefined;
  // Strip the SQL block + Viz line from the prose to keep the summary clean.
  const text = raw
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/```sql[\s\S]*?```/gi, '')
    .replace(/^Viz:.*$/gim, '')
    .trim();
  return { text, sql, viz };
}

function parseStructuredProposal(raw: string): ParsedProposal | undefined {
  const trimmed = raw.trim();
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [
    fenced,
    trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const proposal = parsedProposalFromJson(parsed);
      if (proposal) return proposal;
    } catch {
      // Invalid structured output falls through to the legacy SQL-fence parser.
    }
  }
  return undefined;
}

function parsedProposalFromJson(value: unknown): ParsedProposal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sql = firstJsonString(record.sql, record.query)?.trim();
  const text = firstJsonString(record.summary, record.text, record.answer, record.description)?.trim() ?? '';
  const viz = firstJsonString(record.viz, record.visualization, record.chartType)
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, '');
  const dql = jsonRecord(record.dql);
  const outputs = firstJsonStringList(record.outputs, dql?.outputs);
  const proposedEntity = firstJsonString(
    dql?.entity,
    dql?.proposedEntity,
    dql?.proposed_entity,
    record.proposedEntity,
    record.proposed_entity,
    record.entity,
  )?.replace(/\s+/g, ' ').trim().slice(0, 160);
  const requestedFilters = firstJsonStringList(
    dql?.filters,
    dql?.requestedFilters,
    dql?.requested_filters,
    record.requestedFilters,
    record.requested_filters,
    record.filters,
  );
  const requestedDimensions = firstJsonStringList(
    dql?.dimensions,
    dql?.requestedDimensions,
    dql?.requested_dimensions,
    record.requestedDimensions,
    record.requested_dimensions,
    record.dimensions,
  );
  if (!sql && !text) return undefined;
  return {
    text,
    ...(sql ? { sql } : {}),
    ...(viz ? { viz } : {}),
    ...(outputs?.length ? { outputs } : {}),
    ...(proposedEntity ? { proposedEntity } : {}),
    ...(requestedFilters?.length ? { requestedFilters } : {}),
    ...(requestedDimensions?.length ? { requestedDimensions } : {}),
  };
}

function firstJsonString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstJsonStringList(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    const list = normalizeProposalStringList(value);
    if (list.length > 0) return list;
  }
  return undefined;
}

function normalizeProposalStringList(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawValues) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 20) break;
  }
  return out;
}

function mergeProposalStringLists(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = normalizeProposalStringList(lists.flatMap((list) => list ?? []));
  return merged.length > 0 ? merged : undefined;
}

function applyParsedProposalMetadata(target: ParsedProposal, source: ParsedProposal): void {
  target.outputs = source.outputs ?? target.outputs;
  target.proposedEntity = source.proposedEntity ?? target.proposedEntity;
  target.requestedFilters = source.requestedFilters ?? target.requestedFilters;
  target.requestedDimensions = source.requestedDimensions ?? target.requestedDimensions;
}

function buildCertifiedBlockDqlArtifact(
  block: KGNode,
  result?: AgentResultPayload,
): NonNullable<AgentAnswer['dqlArtifact']> | undefined {
  if (block.kind !== 'block') return undefined;
  const sql = block.sql?.trim() ?? result?.sql?.trim() ?? block.examples?.find((example) => example.sql?.trim())?.sql?.trim();
  if (!sql) {
    // The block answered but its SQL was not inlined in the index (navigation /
    // reference artifacts). Still hand back a reference artifact pointing at the
    // governed source file so every certified-block answer carries a DQL artifact
    // the UI can open or save, rather than dropping it silently.
    if (!block.name) return undefined;
    return {
      kind: 'certified_block',
      name: block.name,
      sourcePath: block.sourcePath,
      source: `// Certified DQL block "${escapeDqlArtifactString(block.name)}"`
        + `${block.sourcePath ? `\n// source: ${block.sourcePath}` : ''}`
        + `\n// SQL is not inlined in the index — open the source file to view or edit the query.`,
    };
  }
  const domain = block.domain ?? 'misc';
  const description = block.description ?? `Certified DQL block ${block.name}`;
  const sourcePathComment = block.sourcePath ? `\n    // source: ${block.sourcePath}` : '';
  const source = `block "${escapeDqlArtifactString(block.name)}" {
    domain = "${escapeDqlArtifactString(domain)}"
    type = "custom"
    status = "certified"${block.owner ? `\n    owner = "${escapeDqlArtifactString(block.owner)}"` : ''}
    description = """${escapeDqlArtifactTripleString(description)}"""${sourcePathComment}

    query = """
        ${sql.replace(/"""/g, '\\"\\"\\"').split('\n').join('\n        ')}
    """
}
`;
  return {
    kind: 'certified_block',
    name: block.name,
    sourcePath: block.sourcePath,
    source,
  };
}

function buildGeneratedSqlDqlArtifact(input: {
  question: string;
  sql?: string;
  intent: AgentIntent;
  domain?: string;
  followUp?: AgentFollowUpContext;
  contextPack?: LocalContextPack;
  sourceBlock?: KGNode;
  sourceDqlArtifact?: GeneratedDraftSourceDqlArtifact;
  proposedEntity?: string;
  requestedFilters?: string[];
  requestedDimensions?: string[];
  validationWarnings: string[];
  outputs?: string[];
}): NonNullable<AgentAnswer['dqlArtifact']> | undefined {
  const sql = input.sql?.trim();
  if (!sql) return undefined;
  const slug = deriveGeneratedDraftSlug(input.question);
  const proposedDomain = input.sourceBlock?.domain
    ?? input.contextPack?.objects.find((object) => object.domain)?.domain
    ?? input.domain
    ?? 'misc';
  return {
    kind: 'sql_block',
    name: slug,
    source: renderGeneratedSqlDqlArtifact({
      slug,
      question: input.question,
      proposedSql: sql,
      proposedContractId: `${proposedDomain}.Unknown.${slug}`,
      proposedDomain,
      sourceQuestion: input.followUp?.sourceQuestion,
      sourceBlock: input.followUp?.sourceBlockName ?? input.sourceBlock?.name,
      sourceDqlArtifact: input.sourceDqlArtifact,
      followupKind: input.followUp?.kind,
      proposedEntity: input.proposedEntity,
      requestedFilters: input.requestedFilters,
      requestedDimensions: input.requestedDimensions,
      outputs: input.outputs,
      contextPackId: input.contextPack?.id,
      routeIntent: String(input.intent),
      validationWarnings: input.validationWarnings,
    }),
  };
}

function escapeDqlArtifactString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeDqlArtifactTripleString(value: string): string {
  return value.replace(/"""/g, '\\"\\"\\"');
}

/**
 * Generic partial-shape signal: the SQL executed but dropped MULTIPLE explicitly
 * requested output columns. Domain-agnostic — this downgrades trust and attaches a
 * "partial answer, missing <cols>" warning (and biases deep-candidate selection
 * toward the complete-shape candidate) for ANY project, not just product/customer/
 * revenue. It never refuses; the executed rows are always returned.
 */
function generatedResultShapeIsPartial(
  resultShape: ReturnType<typeof validateAnswerResultShape>,
): boolean {
  return resultShape.missingOutputs.length >= 2;
}

function trustedFollowUpFilterValues(followUp: AgentFollowUpContext | undefined): string[] | undefined {
  const filters = new Set((followUp?.filters ?? []).map((value) => value.trim()).filter(Boolean));
  if (!filters.size || !followUp?.priorResultValues) return undefined;
  const priorValues = Object.values(followUp.priorResultValues).flat().map((value) => value.trim()).filter(Boolean);
  const trusted = priorValues.filter((value) => filters.has(value));
  return trusted.length > 0 ? uniqueDrilldownStrings(trusted) : undefined;
}

function buildCandidateJoinPaths(schemaContext: AgentSchemaTable[]): AgentJoinPath[] {
  const tables = [...schemaContext]
    .filter((table) => table.columns.some((column) => isJoinKeyColumn(column.name)))
    .sort((a, b) =>
      (a.selectionRank ?? Number.MAX_SAFE_INTEGER) - (b.selectionRank ?? Number.MAX_SAFE_INTEGER) ||
      a.relation.localeCompare(b.relation)
    )
    .slice(0, 16);
  const joins: AgentJoinPath[] = [];
  const seen = new Set<string>();
  for (let leftIndex = 0; leftIndex < tables.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tables.length; rightIndex += 1) {
      const left = tables[leftIndex]!;
      const right = tables[rightIndex]!;
      const join = pickJoinColumns(left, right);
      if (!join) continue;
      const key = [
        normalizeRelationKey(left.relation),
        join.leftColumn.toLowerCase(),
        normalizeRelationKey(right.relation),
        join.rightColumn.toLowerCase(),
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      joins.push({
        leftRelation: left.relation,
        leftColumn: join.leftColumn,
        rightRelation: right.relation,
        rightColumn: join.rightColumn,
        reason: joinReason(join.leftColumn, join.rightColumn, join.score),
      });
    }
  }
  return joins.slice(0, 12);
}

function joinReason(leftColumn: string, rightColumn: string, score: number): string {
  if (namesEqualLoose(leftColumn, rightColumn)) return `shared key ${leftColumn}`;
  const leftSubject = joinSubjectForColumn(leftColumn);
  const rightSubject = joinSubjectForColumn(rightColumn);
  if (leftSubject && rightSubject && leftSubject === rightSubject) return `matching ${leftSubject} key`;
  if (score >= 55) return 'foreign-key style id match';
  return 'join-key style column match';
}

interface JoinColumnSelection {
  leftColumn: string;
  rightColumn: string;
  score: number;
}

function pickJoinColumns(left: AgentSchemaTable, right: AgentSchemaTable): JoinColumnSelection | undefined {
  const candidates: JoinColumnSelection[] = [];
  const leftColumns = left.columns.filter((column) => isJoinKeyColumn(column.name)).slice(0, 32);
  const rightColumns = right.columns.filter((column) => isJoinKeyColumn(column.name)).slice(0, 32);
  for (const leftColumn of leftColumns) {
    for (const rightColumn of rightColumns) {
      const score = joinColumnScore(leftColumn.name, rightColumn.name, left, right);
      if (score <= 0) continue;
      candidates.push({ leftColumn: leftColumn.name, rightColumn: rightColumn.name, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.leftColumn.localeCompare(b.leftColumn))[0];
}

function joinColumnScore(
  leftColumn: string,
  rightColumn: string,
  leftTable: AgentSchemaTable,
  rightTable: AgentSchemaTable,
): number {
  const leftKey = normalizeRelationKey(leftColumn).replace(/\./g, '_');
  const rightKey = normalizeRelationKey(rightColumn).replace(/\./g, '_');
  const leftJoinLike = isJoinKeyColumn(leftColumn);
  const rightJoinLike = isJoinKeyColumn(rightColumn);
  if (!leftJoinLike || !rightJoinLike) return 0;
  if (leftKey === rightKey) return 70;
  const leftSubject = joinSubjectForColumn(leftColumn);
  const rightSubject = joinSubjectForColumn(rightColumn);
  if (leftSubject && rightSubject && leftSubject === rightSubject) return 62;
  const leftTableTokens = tableEntityTokens(leftTable);
  const rightTableTokens = tableEntityTokens(rightTable);
  if (leftSubject && rightKey === 'id' && rightTableTokens.has(leftSubject)) return 58;
  if (rightSubject && leftKey === 'id' && leftTableTokens.has(rightSubject)) return 58;
  if (leftSubject && rightTableTokens.has(leftSubject) && rightKey.endsWith('_key')) return 42;
  if (rightSubject && leftTableTokens.has(rightSubject) && leftKey.endsWith('_key')) return 42;
  return 0;
}

function isJoinKeyColumn(column: string): boolean {
  const normalized = column.toLowerCase();
  return normalized === 'id' ||
    /(^|_)(id|key|uuid|sk)$/.test(normalized) ||
    /_(id|key|uuid|sk)$/.test(normalized);
}

function joinSubjectForColumn(column: string): string | undefined {
  const normalized = column.toLowerCase();
  const subject = normalized.replace(/_(id|key|uuid|sk)$/i, '');
  if (!subject || subject === normalized || subject === 'id' || subject === 'key') return undefined;
  return normalizeToken(subject.split('_').at(-1) ?? subject);
}

function tableEntityTokens(table: AgentSchemaTable): Set<string> {
  const tokens = exactMatchTokens([table.name, table.relation.split('.').at(-1) ?? table.relation].join(' '));
  for (const generic of ['dim', 'fct', 'fact', 'stg', 'stage', 'model', 'table']) tokens.delete(generic);
  return tokens;
}

function schemaContextWithAllowedSqlContext(
  schemaContext: AgentSchemaTable[],
  contextPack: LocalContextPack | undefined,
): AgentSchemaTable[] {
  const byRelation = new Map<string, AgentSchemaTable>();
  const relationSelections = selectedRelationLookup(contextPack);
  for (const table of schemaContext) {
    const selection = relationSelectionFor(table.relation, relationSelections);
    byRelation.set(normalizeRelationKey(table.relation), {
      ...table,
      columns: table.columns.map((column) => ({ ...column, sampleValues: column.sampleValues?.slice() })),
      selectionRank: selection?.rank ?? table.selectionRank,
      selectionScore: selection?.score ?? table.selectionScore,
      selectionReason: selection?.reason ?? table.selectionReason,
    });
  }
  for (const relation of contextPack?.allowedSqlContext?.relations ?? []) {
    const key = normalizeRelationKey(relation.relation);
    const existing = byRelation.get(key);
    const selection = relationSelectionFor(relation.relation, relationSelections);
    if (!existing) {
      byRelation.set(key, {
        relation: relation.relation,
        name: relation.name,
        columns: relation.columns.map((column) => ({
          name: column.name,
          type: column.type,
          description: column.description,
          sampleValues: column.sampleValues?.slice(),
        })),
        source: relation.source,
        selectionRank: selection?.rank,
        selectionScore: selection?.score,
        selectionReason: selection?.reason,
      });
      continue;
    }
    existing.selectionRank = selection?.rank ?? existing.selectionRank;
    existing.selectionScore = selection?.score ?? existing.selectionScore;
    existing.selectionReason = selection?.reason ?? existing.selectionReason;
    const columns = new Map(existing.columns.map((column) => [column.name.toLowerCase(), column]));
    for (const column of relation.columns) {
      const existingColumn = columns.get(column.name.toLowerCase());
      if (!existingColumn) {
        existing.columns.push({
          name: column.name,
          type: column.type,
          description: column.description,
          sampleValues: column.sampleValues?.slice(),
        });
        continue;
      }
      existingColumn.sampleValues = uniqueDrilldownStrings([
        ...(existingColumn.sampleValues ?? []),
        ...(column.sampleValues ?? []),
      ]).slice(0, 8);
      existingColumn.type ??= column.type;
      existingColumn.description ??= column.description;
    }
  }
  return Array.from(byRelation.values());
}

function selectedRelationLookup(
  contextPack: LocalContextPack | undefined,
): Map<string, NonNullable<LocalContextPack['retrievalDiagnostics']['selectedRelations']>[number]> {
  const lookup = new Map<string, NonNullable<LocalContextPack['retrievalDiagnostics']['selectedRelations']>[number]>();
  for (const relation of contextPack?.retrievalDiagnostics?.selectedRelations ?? []) {
    for (const key of relationLookupKeys(relation.relation)) {
      lookup.set(key, relation);
    }
  }
  return lookup;
}

function relationSelectionFor(
  relation: string,
  lookup: Map<string, NonNullable<LocalContextPack['retrievalDiagnostics']['selectedRelations']>[number]>,
): NonNullable<LocalContextPack['retrievalDiagnostics']['selectedRelations']>[number] | undefined {
  for (const key of relationLookupKeys(relation)) {
    const selection = lookup.get(key);
    if (selection) return selection;
  }
  return undefined;
}

function cleanSqlIdentifier(identifier: string): string {
  return identifier.replace(/^["`]|["`]$/g, '').trim();
}

function namesEqualLoose(a: string, b: string): boolean {
  return cleanSqlIdentifier(a).replace(/[_-]+/g, ' ').toLowerCase() === cleanSqlIdentifier(b).replace(/[_-]+/g, ' ').toLowerCase();
}

function normalizeRelationKey(relation: string): string {
  return relation.replace(/["`]/g, '').replace(/\s*\.\s*/g, '.').toLowerCase().trim();
}

function relationLookupKeys(relation: string): string[] {
  const normalized = normalizeRelationKey(relation);
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  if (parts.length >= 1) keys.add(parts[parts.length - 1]!);
  return Array.from(keys);
}

function uniqueDrilldownStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function humanizeIdentifier(identifier: string): string {
  return identifier.replace(/[_-]+/g, ' ');
}

function pickCertifiedArtifact(input: {
  artifactHits: KGSearchHit[];
  executableArtifactHits: KGSearchHit[];
  businessHits: KGSearchHit[];
  question: string;
  questionPlan: AnalysisQuestionPlan;
  blockHints: string[];
  excludedArtifactIds?: Set<string>;
  kg: KGStore;
}): KGSearchHit | null {
  // Hint match wins immediately: the active Skill's vocabulary points the
  // user at a specific block. We still validate it's certified.
  for (const hint of input.blockHints) {
    const node = input.kg.getNode(`block:${hint}`);
    if (node && node.status === 'certified' && hasCertifiedNodeFit(input.question, input.questionPlan, node)) {
      return { node, score: 1, snippet: undefined };
    }
  }

  const executableHit = pickFirstCertifiedHit(input.executableArtifactHits, input.kg, input.excludedArtifactIds, input.question, input.questionPlan);
  if (isPureBusinessDefinitionQuestion(input.question)) {
    if (executableHit && hasExactExecutableArtifactSignal(input.question, executableHit.node)) {
      return executableHit;
    }
    const businessHit = pickFirstCertifiedHit(input.businessHits, input.kg);
    if (businessHit) return businessHit;
  }

  if (executableHit && shouldDeferCertifiedArtifactForReviewPath({
    hits: input.executableArtifactHits,
    selected: executableHit,
    question: input.question,
    kg: input.kg,
    excludedArtifactIds: input.excludedArtifactIds,
  })) {
    return null;
  }
  if (executableHit) return executableHit;

  const hasExecutableCandidate = input.executableArtifactHits.some((hit) => hit.score >= CERTIFIED_HIT_THRESHOLD);
  if (!hasExecutableCandidate) {
    const businessHit = pickFirstCertifiedHit(input.businessHits, input.kg, input.excludedArtifactIds);
    if (businessHit) return businessHit;
  }

  return null;
}

function pickFirstCertifiedHit(
  hits: KGSearchHit[],
  kg: KGStore,
  excludedNodeIds?: Set<string>,
  question?: string,
  questionPlan?: AnalysisQuestionPlan,
): KGSearchHit | null {
  for (const hit of hits) {
    if (hit.score < CERTIFIED_HIT_THRESHOLD) break;
    if (excludedNodeIds?.has(hit.node.nodeId)) continue;
    if (!isCertifiedHit(hit, kg)) continue;
    if (question && questionPlan && hit.node.kind === 'block' && !hasCertifiedNodeFit(question, questionPlan, hit.node)) continue;
    if (question && !questionPlan && hit.node.kind === 'block' && !hasCompatibleCertifiedBlockMatch(question, hit.node)) continue;
    return hit;
  }
  return null;
}

function pickCertifiedDrilldownArtifact(input: {
  executableArtifactHits: KGSearchHit[];
  question: string;
  questionPlan: AnalysisQuestionPlan;
  followUp: AgentFollowUpContext;
  excludedArtifactIds?: Set<string>;
  kg: KGStore;
}): KGSearchHit | null {
  const requestedTerms = meaningfulTokens([
    input.question,
    ...(input.followUp.filters ?? []),
    ...(input.followUp.dimensions ?? []),
  ].join(' '));
  for (const hit of input.executableArtifactHits) {
    if (hit.score < CERTIFIED_HIT_THRESHOLD) break;
    if (input.excludedArtifactIds?.has(hit.node.nodeId)) continue;
    if (hit.node.kind !== 'block') continue;
    if (!isCertifiedHit(hit, input.kg)) continue;
    if (!hasCertifiedNodeFit(input.question, input.questionPlan, hit.node, { allowInferredContract: true })) continue;
    if (!hasRequestedDrilldownOverlap(hit.node, requestedTerms)) continue;
    return hit;
  }
  return null;
}

function hasRequestedDrilldownOverlap(node: KGNode, requestedTerms: Set<string>): boolean {
  if (requestedTerms.size === 0) return false;
  const nodeTerms = meaningfulTokens(certifiedBlockSignalText(node));
  let overlaps = 0;
  for (const term of requestedTerms) {
    if (nodeTerms.has(term)) overlaps += 1;
  }
  return overlaps >= 2 || (requestedTerms.size === 1 && overlaps === 1);
}

function shouldDeferCertifiedArtifactForReviewPath(input: {
  hits: KGSearchHit[];
  selected: KGSearchHit;
  question: string;
  kg: KGStore;
  excludedArtifactIds?: Set<string>;
}): boolean {
  if (!isBreakdownOrDrilldownQuestion(input.question)) return false;
  const selectedIndex = input.hits.findIndex((hit) => hit.node.nodeId === input.selected.node.nodeId);
  if (selectedIndex <= 0) return false;
  const strongerReviewHit = input.hits.slice(0, selectedIndex).find((hit) => {
    if (hit.score < CERTIFIED_HIT_THRESHOLD) return false;
    if (input.excludedArtifactIds?.has(hit.node.nodeId)) return false;
    if (isCertifiedHit(hit, input.kg)) return false;
    return hit.score >= input.selected.score * 0.9;
  });
  return Boolean(strongerReviewHit);
}

function isCertifiedHit(hit: KGSearchHit, kg: KGStore): boolean {
  if (hit.node.kind === 'block') {
    if (hit.node.status !== 'certified') return false;
    const fb = kg.blockFeedbackScore(hit.node.nodeId);
    const total = fb.up + fb.down;
    return !(total > 0 && fb.down / total > HARD_NEGATIVE_RATIO);
  }
  return hit.node.status === 'certified' || hit.node.certification === 'certified';
}

function isBusinessDefinitionQuestion(question: string): boolean {
  return /\b(what is|what are|define|definition|meaning of|what does .+ mean)\b/i.test(question);
}

/** Definition that may terminate with documentation instead of executing data. */
function isPureBusinessDefinitionQuestion(question: string): boolean {
  return questionTypeFromText(question) === 'definition';
}

function isBreakdownOrDrilldownQuestion(question: string): boolean {
  return /\b(break\s*down|breakdown|drill\s*(?:down|into)|slice|segment|split|by\s+[a-z][\w\s-]{1,40})\b/i.test(question);
}

const GENERIC_ANALYTIC_TOKENS = new Set([
  'all',
  'and',
  'average',
  'avg',
  'count',
  'data',
  'flag',
  'for',
  'from',
  'group',
  'how',
  'include',
  'list',
  'many',
  'metric',
  'number',
  'preview',
  'record',
  'records',
  'show',
  'sum',
  'table',
  'total',
  'using',
  'value',
  'versus',
  'with',
]);

function hasMeaningfulCertifiedBlockSignal(question: string, node: KGNode): boolean {
  const questionTokens = meaningfulTokens(question);
  if (questionTokens.size === 0) return true;
  const nodeTokens = meaningfulTokens([
    node.name,
    node.domain ?? '',
    ...(node.tags ?? []),
  ].join(' '));
  for (const token of questionTokens) {
    if (nodeTokens.has(token)) return true;
  }
  return false;
}

type RankingDirection = 'top' | 'bottom';

function hasCompatibleCertifiedBlockMatch(question: string, node: KGNode): boolean {
  return hasMeaningfulCertifiedBlockSignal(question, node)
    && hasCompatibleRankingDirection(question, node);
}

function hasCertifiedNodeFit(
  question: string,
  plan: AnalysisQuestionPlan,
  node: KGNode,
  options: { allowInferredContract?: boolean } = {},
): boolean {
  if (!hasCompatibleRankingDirection(question, node)) return false;
  const definitionLookup = isPureBusinessDefinitionQuestion(question) && objectNameInQuestion(question, node);
  const exactExampleMatch = (node.examples ?? []).some((example) =>
    normalizeQuestion(example.question) === normalizeQuestion(question)
  );
  const exactObjectRequest = objectNameInQuestion(question, node)
    && /\b(run|use|open|show|execute|certified|saved|block)\b/i.test(question);
  if (!definitionLookup && !exactExampleMatch && !exactObjectRequest && !hasMeaningfulCertifiedBlockSignal(question, node)) return false;
  const fit = evaluateCertifiedBlockFit({
    question,
    plan,
    block: node,
    exactExampleMatch: exactExampleMatch || exactObjectRequest,
    definitionLookup,
  });
  if (certifiedFitAllowsTier1(fit)) return true;
  return Boolean(options.allowInferredContract
    && fit.kind === 'exact'
    && fit.confidence === 'medium'
    && fit.missingDimensions.length === 0
    && fit.missingOutputs.length === 0
    && fit.unsupportedFilters.length === 0
    && !fit.grainMismatch);
}

function objectNameInQuestion(question: string, node: Pick<KGNode, 'name'>): boolean {
  const questionText = normalizeQuestion(question);
  const name = normalizeQuestion(node.name);
  return Boolean(name && questionText.includes(name));
}

function normalizeQuestion(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasCompatibleRankingDirection(question: string, node: KGNode): boolean {
  const questionDirection = rankingDirectionFromText(question);
  if (!questionDirection) return true;
  const blockDirection = rankingDirectionFromText(certifiedBlockSignalText(node));
  if (!blockDirection) return true;
  return questionDirection === blockDirection;
}

function rankingDirectionFromText(text: string): RankingDirection | undefined {
  const lower = text.toLowerCase();
  const hasBottomSignal = /\b(bottom|least|fewest|lowest|minimum|min|smallest|worst|underperform(?:ing|ed|er|ers)?)\b/.test(lower);
  const hasTopSignal = /\b(top|most|highest|maximum|max|greatest|best|leader|leaders|leading)\b/.test(lower);
  if (hasBottomSignal && !hasTopSignal) return 'bottom';
  if (hasTopSignal && !hasBottomSignal) return 'top';
  return undefined;
}

function certifiedBlockSignalText(node: KGNode): string {
  const examples = (node.examples ?? [])
    .flatMap((example) => [example.question, example.sql ?? '']);
  return [
    node.name,
    node.domain ?? '',
    node.description ?? '',
    node.llmContext ?? '',
    node.provenance ?? '',
    ...(node.tags ?? []),
    ...(node.businessRules ?? []),
    ...(node.caveats ?? []),
    ...examples,
  ].join(' ');
}

function hasExactExecutableArtifactSignal(question: string, node: KGNode): boolean {
  if (!EXECUTABLE_ARTIFACT_KINDS.includes(node.kind)) return false;
  const questionTokens = exactMatchTokens(question);
  const nameTokens = exactMatchTokens(node.name);
  if (nameTokens.size === 0) return false;
  for (const token of nameTokens) {
    if (!questionTokens.has(token)) return false;
  }
  return true;
}

function rankGeneratedContextHits(
  hits: KGSearchHit[],
  schemaContext: AgentSchemaTable[],
  question: string,
): KGSearchHit[] {
  const schemaTokens = schemaEntityTokens(schemaContext, question);
  if (schemaTokens.size === 0) return hits;
  const filteredEntityQuestion = isFilteredEntityQuestion(question);
  return [...hits].sort((a, b) => {
    const aScore = generatedContextScore(a, schemaTokens, filteredEntityQuestion);
    const bScore = generatedContextScore(b, schemaTokens, filteredEntityQuestion);
    return bScore - aScore;
  });
}

function generatedContextScore(
  hit: KGSearchHit,
  schemaTokens: Set<string>,
  filteredEntityQuestion: boolean,
): number {
  const identityTokens = exactMatchTokens([
    hit.node.name,
    hit.node.domain ?? '',
    ...(hit.node.tags ?? []),
  ].join(' '));
  const bodyTokens = exactMatchTokens([
    hit.node.description ?? '',
    hit.node.llmContext ?? '',
  ].join(' '));
  let score = hit.score;
  for (const token of schemaTokens) {
    if (identityTokens.has(token)) {
      score += filteredEntityQuestion ? 0.6 : 0.25;
    } else if (bodyTokens.has(token)) {
      score += filteredEntityQuestion ? 0.15 : 0.05;
    }
  }
  if (hit.node.kind === 'block') score += 0.2;
  return score;
}

function schemaEntityTokens(schemaContext: AgentSchemaTable[], question: string): Set<string> {
  const tokens = new Set<string>();
  for (const table of schemaContext) {
    const hasMatchedValues = table.columns.some((column) => column.sampleValues?.length);
    if (!hasMatchedValues) continue;
    for (const token of exactMatchTokens([table.relation, table.name, table.description ?? ''].join(' '))) {
      tokens.add(token);
    }
    for (const column of table.columns) {
      if (!column.sampleValues?.length) continue;
      for (const token of exactMatchTokens(column.name)) tokens.add(token);
    }
  }
  if (tokens.size > 0 || !isFilteredEntityQuestion(question)) return tokens;
  for (const table of schemaContext) {
    for (const token of exactMatchTokens([table.relation, table.name, table.description ?? ''].join(' '))) {
      if (ENTITY_CONTEXT_TOKENS.has(token)) tokens.add(token);
    }
    for (const column of table.columns) {
      for (const token of exactMatchTokens(column.name)) {
        if (ENTITY_CONTEXT_TOKENS.has(token)) tokens.add(token);
      }
    }
  }
  return tokens;
}

const ENTITY_CONTEXT_TOKENS = new Set([
  'account',
  'customer',
  'location',
  'member',
  'order',
  'product',
  'region',
  'segment',
  'subscriber',
  'user',
]);

function meaningfulTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    for (const part of raw.split('_')) {
      const normalized = normalizeToken(part);
      if (!normalized || normalized.length < 3 || GENERIC_ANALYTIC_TOKENS.has(normalized)) continue;
      tokens.add(normalized);
    }
  }
  return tokens;
}

function exactMatchTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    for (const part of raw.split('_')) {
      const normalized = normalizeToken(part);
      if (!normalized || normalized.length < 3) continue;
      tokens.add(normalized);
    }
  }
  return tokens;
}

function normalizeToken(token: string): string {
  if (token === 'skus') return 'sku';
  if (token === 'orders') return 'order';
  if (token === 'customers') return 'customer';
  if (token === 'supplies') return 'supply';
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function classifyAgentIntent(input: {
  question: string;
  followUp?: AgentFollowUpContext;
  artifactHits: KGSearchHit[];
  semanticHits: KGSearchHit[];
  manifestHits: KGSearchHit[];
  schemaContext: AgentSchemaTable[];
}): AgentIntent {
  if (input.followUp?.kind === 'drilldown') return 'drillthrough';
  if (isExplicitSavedArtifactQuestion(input.question, input.artifactHits)) return 'exact_certified_lookup';

  const hasContext =
    input.artifactHits.some((hit) => hit.score >= CERTIFIED_HIT_THRESHOLD) ||
    input.semanticHits.some((hit) => hit.score >= CERTIFIED_HIT_THRESHOLD) ||
    input.manifestHits.some((hit) => hit.score >= CERTIFIED_HIT_THRESHOLD) ||
    input.schemaContext.length > 0;
  if (isFilteredEntityQuestion(input.question)) return hasContext ? 'ad_hoc_analysis' : 'clarify';
  if (isBusinessDefinitionQuestion(input.question)) return 'exact_certified_lookup';
  if (isAdHocAnalysisQuestion(input.question)) return hasContext ? 'ad_hoc_analysis' : 'clarify';
  if (looksLikeDataQuestion(input.question) && !hasContext) return 'clarify';
  return 'exact_certified_lookup';
}

function isExplicitSavedArtifactQuestion(question: string, artifactHits: KGSearchHit[]): boolean {
  const lower = question.toLowerCase();
  if (!/\b(block|certified|saved|existing|approved|governed)\b/.test(lower)) return false;
  return artifactHits.some((hit) => {
    if (hit.score < CERTIFIED_HIT_THRESHOLD) return false;
    const normalizedName = hit.node.name.toLowerCase();
    const spacedName = normalizedName.replace(/[_-]+/g, ' ');
    return lower.includes(normalizedName) || lower.includes(spacedName);
  });
}

function isAdHocAnalysisQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (isBusinessDefinitionQuestion(question)) return false;
  const asksCountBreakdown = /\b(how many|number of|count of|count)\b/i.test(lower)
    && /\b(by\s+[a-z][\w\s-]{1,40}|per|for each|group(?:ed)? by|split|segment)\b/i.test(lower);
  return asksCountBreakdown
    || /\b(break\s*down|breakdown|drill\s*(?:down|into)|slice|segment|split|compare|versus|vs\.?|trend|over time|top|bottom|best|worst|highest|lowest|least|fewest|minimum|min|smallest|rank|ranking|performed better|better performing|why|what drove|driver|drivers|top movers?|changed?|change|dropped?|drop|decreased?|decrease|declined?|decline|increased?|increase|anomal(?:y|ies)|exceptions?|root cause|contribut(?:e|ed|ion)|variance|delta|by\s+[a-z][\w\s-]{1,40})\b/i.test(lower)
    || /\b(show|list|find|give)\b.+\b(account|accounts|customer|customers|product|products|order|orders|region|location|month|week|day|user|users)\b/i.test(lower);
}

function isFilteredEntityQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (!looksLikeDataQuestion(question)) return false;
  if (/\b(for|where|only|specific|single|individual|named|called)\b.+\b(account|accounts|customer|customers|product|products|sku|user|users)\b/i.test(lower)) {
    return true;
  }
  if (/\b(account|customer|product|sku|user)\s+(?:id|name|email)\b/i.test(lower)) {
    return !mentionsEntityIdentifierAsRequestedOutput(lower);
  }
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}/.test(question) && /\b(revenue|sales|order|orders|spend|value|churn|usage|activity|performance|performed|metric|kpi)\b/i.test(lower)) {
    return true;
  }
  if (/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(question)) return true;
  return false;
}

function mentionsEntityIdentifierAsRequestedOutput(lowerQuestion: string): boolean {
  return /\b(?:with|including|include|return|show|list|give|provide|columns?|fields?|results?)\b[^.?!]{0,100}\b(?:account|customer|product|sku|user)\s+(?:id|name|email)\b/i.test(lowerQuestion);
}

function looksLikeDataQuestion(question: string): boolean {
  return /\b(show|list|find|what|which|how many|how much|compare|trend|revenue|account|accounts|customer|customers|order|orders|product|products|sales|metric|kpi|dashboard|performance|performed|user|users)\b/i.test(question);
}

function citationSourceTier(node: KGNode, fallback: AnswerSourceTier): AnswerSourceTier {
  if (node.sourceTier === 'certified_artifact') return 'certified_artifact';
  if (node.sourceTier === 'business_context') return 'business_context';
  if (node.sourceTier === 'semantic_layer') return 'semantic_layer';
  if (node.sourceTier === 'dbt_manifest') return 'dbt_manifest';
  return fallback;
}

function buildAnalysisPlan(input: {
  question: string;
  intent: AgentIntent;
  routeReason: string;
  selectedNodes: KGNode[];
  schemaContext: AgentSchemaTable[];
  sql?: string;
  suggestedViz?: string;
  assumptions?: string[];
  repairAttempts?: number;
}): AgentAnalysisPlan {
  const tokens = meaningfulTokens(input.question);
  const dimensions = inferDimensions(input.question, input.selectedNodes, input.schemaContext);
  const measures = inferMeasures(input.question, input.selectedNodes, input.schemaContext);
  const candidateJoins = buildCandidateJoinPaths(input.schemaContext);
  const candidateTables = [...input.schemaContext].sort((a, b) =>
    (a.selectionRank ?? Number.MAX_SAFE_INTEGER) - (b.selectionRank ?? Number.MAX_SAFE_INTEGER) ||
    a.relation.localeCompare(b.relation)
  ).slice(0, 8).map((table) => ({
    relation: table.relation,
    columns: table.columns.slice(0, 16).map((col) => col.name),
    reason: tableReason(table, tokens),
  }));
  const trustedContext = input.selectedNodes.slice(0, 8).map((node) => ({
    kind: node.kind,
    name: node.name,
    certification: certificationForNode(node),
    sourceTier: node.sourceTier,
  }));
  return {
    question: input.question,
    intent: input.intent,
    routeReason: input.routeReason,
    grain: dimensions.length > 0 ? dimensions.join(', ') : undefined,
    measures,
    dimensions,
    candidateTables,
    candidateJoins,
    trustedContext,
    assumptions: input.assumptions ?? [],
    sql: input.sql,
    suggestedViz: input.suggestedViz,
    followUps: buildFollowUpSuggestions(input.intent, measures, dimensions),
    repairAttempts: input.repairAttempts,
  };
}

function inferDimensions(question: string, selectedNodes: KGNode[], schemaContext: AgentSchemaTable[]): string[] {
  const dims = new Set<string>();
  for (const match of question.matchAll(/\bby\s+([a-z][a-z0-9_ -]{1,40})/gi)) {
    const value = match[1].replace(/\b(who|have|has|with|for|where|that|and|over|in)\b.*$/i, '').trim();
    if (value) dims.add(normalizeHumanLabel(value));
  }
  for (const dim of ['customer', 'product', 'region', 'location', 'month', 'week', 'day', 'segment', 'channel']) {
    if (new RegExp(`\\b${dim}s?\\b`, 'i').test(question)) dims.add(dim);
  }
  for (const node of selectedNodes) {
    if (node.kind === 'dimension' || node.kind === 'entity') dims.add(node.name);
  }
  for (const table of schemaContext.slice(0, 4)) {
    for (const col of table.columns) {
      const normalized = col.name.toLowerCase();
      if (/(customer|product|region|location|month|week|segment|channel|type|name)$/.test(normalized) && question.toLowerCase().includes(normalized.split('_')[0])) {
        dims.add(col.name);
      }
    }
  }
  return Array.from(dims).slice(0, 6);
}

function inferMeasures(question: string, selectedNodes: KGNode[], schemaContext: AgentSchemaTable[]): string[] {
  const measures = new Set<string>();
  const lower = question.toLowerCase();
  for (const metric of ['revenue', 'sales', 'orders', 'order count', 'customers', 'spend', 'value', 'cost', 'margin']) {
    if (lower.includes(metric)) measures.add(metric);
  }
  for (const node of selectedNodes) {
    if (node.kind === 'metric' || node.kind === 'measure' || node.kind === 'block') {
      for (const token of meaningfulTokens(node.name)) {
        if (!['customer', 'product', 'region', 'location'].includes(token)) measures.add(token);
      }
    }
  }
  for (const table of schemaContext.slice(0, 4)) {
    for (const col of table.columns) {
      const normalized = col.name.toLowerCase();
      if (/(amount|total|revenue|spend|orders|count|cost|value)$/.test(normalized) && lower.includes(normalized.split('_').at(-1) ?? normalized)) {
        measures.add(col.name);
      }
    }
  }
  return Array.from(measures).slice(0, 6);
}

function tableReason(table: AgentSchemaTable, questionTokens: Set<string>): string | undefined {
  if (table.selectionReason) {
    return table.selectionRank
      ? `metadata rank ${table.selectionRank}: ${table.selectionReason}`
      : table.selectionReason;
  }
  const tableTokens = meaningfulTokens([table.relation, table.name, table.description ?? ''].join(' '));
  const columnTokens = meaningfulTokens(table.columns.map((col) => col.name).join(' '));
  const matches = [...questionTokens].filter((token) => tableTokens.has(token) || columnTokens.has(token));
  return matches.length > 0 ? `matched ${matches.slice(0, 4).join(', ')}` : table.source;
}

function normalizeHumanLabel(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildFollowUpSuggestions(intent: AgentIntent, measures: string[], dimensions: string[]): string[] {
  if (intent === 'clarify') {
    return ['Which metric should define performance?', 'Which business object should be the row grain?', 'What time period should this cover?'];
  }
  const mainMeasure = measures[0] ?? 'the result';
  const mainDimension = dimensions[0] ?? 'segment';
  return [
    `Drill into ${mainMeasure} by ${mainDimension}`,
    'Show the trend over time',
    'Pin this answer to the app for review',
  ];
}

function chartNameFromConfig(config: unknown): string | undefined {
  if (config && typeof config === 'object' && typeof (config as { chart?: unknown }).chart === 'string') {
    return (config as { chart: string }).chart;
  }
  return undefined;
}

function formatPromptValue(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const shown = compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
  return JSON.stringify(shown);
}

function composeClarificationText(question: string, considered: KGSearchHit[], schemaContext: AgentSchemaTable[]): string {
  const context = considered.slice(0, 3).map((hit) => hit.node.name).join(', ');
  const tables = schemaContext.slice(0, 3).map((table) => table.relation).join(', ');
  const available = [context ? `matched context: ${context}` : '', tables ? `available tables: ${tables}` : ''].filter(Boolean).join('; ');
  return `I need one more detail before querying: which metric or business object should define the answer for "${extractUserQuestion(question)}"?${available ? ` I found ${available}, but not enough to choose a safe grain.` : ''}`;
}

async function requestSqlRepair(input: {
  provider: AgentProvider;
  baseMessages: AgentMessage[];
  question: string;
  parsed: ParsedProposal;
  executionError: string;
  schemaContext: AgentSchemaTable[];
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
}): Promise<string> {
  const schema = input.schemaContext.length > 0
    ? input.schemaContext
        .slice(0, 8)
        .map((table) => `${table.relation}: ${table.columns.slice(0, 40).map((col) => col.name).join(', ')}`)
        .join('\n')
    : '(no runtime schema supplied)';
  return input.provider.generate([
    ...input.baseMessages,
    {
      role: 'assistant',
      content: `${input.parsed.text}\n\n\`\`\`sql\n${input.parsed.sql ?? ''}\n\`\`\`\n\nViz: ${input.parsed.viz ?? 'table'}`,
    },
    {
      role: 'user',
      content: [
        'The SQL preview for the review-required DQL artifact failed during bounded preview execution.',
        `Question: ${input.question}`,
        `Execution error: ${input.executionError}`,
        'Return one corrected read-only SQL query using only the runtime schema below, as a single ```json fenced object with summary, sql, viz, outputs, and optional dql metadata fields.',
        schema,
      ].join('\n\n'),
    },
  ], {
    signal: input.signal,
    // Reuse the run's already-ceiling-clamped effort. We deliberately do NOT bump
    // here: the effort was clamped to the user's Settings ceiling upstream, and
    // bumping would let an internal preview-repair exceed that cap. Escalation-level
    // repairs bump-then-clamp in the host (resolveRunReasoningEffort).
    reasoningEffort: input.reasoningEffort,
  });
}

async function generateProposalWithOptionalTools(input: {
  provider: AgentProvider;
  messages: AgentMessage[];
  tools?: AgentToolDefinition[];
  questionPlan: AnalysisQuestionPlan;
  intent: AgentIntent;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  analysisDepth?: AnalysisDepth;
  toolCalls?: AgentEvidenceToolCall[];
}): Promise<string> {
  const tools = input.tools?.filter((tool) => tool.name && tool.description) ?? [];
  const options = {
    signal: input.signal,
    reasoningEffort: input.reasoningEffort,
  };
  // No tools → plain generation (nothing for the loop to drive).
  if (tools.length === 0) {
    return input.provider.generate(input.messages, options);
  }
  const toolBudget = proposalToolBudgetForQuestion(input.questionPlan, input.intent, {
    analysisDepth: input.analysisDepth,
    reasoningEffort: input.reasoningEffort,
  });
  const toolPolicy = [
    'You may use the supplied DQL tools to inspect semantic members, certified context, metadata context, and bounded repair options.',
    `Tool budget for this question: ${toolBudget.maxToolCalls} call(s) (${toolBudget.effortClass}: ${toolBudget.reason}). Stop as soon as a lane can answer.`,
    'Prefer a governed semantic compile (search_semantic_layer → compile_semantic_query) over hand-written SQL when the semantic layer contains the requested metric/dimensions/time grain.',
    'When the supplied context is missing a table, column, or join key, DISCOVER it with `search_metadata` (find candidate relations) then `get_table_schema` (confirm real columns + inferred join keys) before declining. Use `search_project_files` for a bounded live source grep when indexed retrieval missed an identifier; use `scan_manifest` for cached graph objects; do not loop on the same failed context.',
    'When unsure a relation/column exists, validate a composed query with `validate_sql` rather than guessing.',
    'Final response must be a single ```json fenced object with summary, sql, viz, outputs, and optional dql metadata fields.',
  ].join('\n');
  // runAgenticToolLoop drives the loop over ANY provider: native tool use where the
  // provider implements generateWithTools (Claude/OpenAI), and an equivalent text
  // protocol otherwise (subscription-CLI passthrough, Ollama). This is what gives
  // every provider — not just the two API ones — a real tool-driven Stage B.
  return runAgenticToolLoop(input.provider, [...input.messages], tools, {
    ...options,
    toolPolicy,
    maxToolCalls: toolBudget.maxToolCalls,
    onToolCall: (event) => {
      const sink = input.toolCalls;
      if (sink) sink.push(evidenceToolCallFromEvent(event, sink.length + 1));
    },
  });
}

interface DeepGeneratedProposalCandidate {
  raw: string;
  parsed: ParsedProposal;
  index: number;
  validationOk: boolean;
  validationError?: string;
  result?: AgentResultPayload;
  executionError?: string;
  resultSignature?: string;
  score: number;
}

async function selectDeepGeneratedProposalCandidate(input: {
  provider: AgentProvider;
  messages: AgentMessage[];
  question: string;
  questionPlan: AnalysisQuestionPlan;
  intent: AgentIntent;
  initial: { raw: string; parsed: ParsedProposal };
  contextLedger: ContextLedger;
  executeGeneratedSql?: (sql: string) => Promise<AgentResultPayload>;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  maxAlternatives?: number;
}): Promise<{ selected?: DeepGeneratedProposalCandidate; notes: string[] }> {
  const initial = await scoreDeepGeneratedProposalCandidate(input, {
    raw: input.initial.raw,
    parsed: input.initial.parsed,
    index: 1,
  });
  // Deep mode diversifies whenever we can COMPARE candidate results (an executor
  // is available) — so a valid-but-subtly-wrong first candidate can be out-voted
  // by execution-result agreement — or when the first candidate failed and needs a
  // repair alternative. Without an executor, a validated first candidate is the
  // most we can assess, so return it and skip the extra generations.
  const shouldDiversify = Boolean(input.executeGeneratedSql) || !initial.validationOk;
  if (!shouldDiversify) {
    return { selected: initial, notes: [] };
  }

  const candidates: DeepGeneratedProposalCandidate[] = [initial];
  const alternatives = await generateDeepAlternativeProposals(input);
  for (const [offset, raw] of alternatives.entries()) {
    if (!raw.trim()) continue;
    candidates.push(await scoreDeepGeneratedProposalCandidate(input, {
      raw,
      parsed: parseProposal(raw),
      index: offset + 2,
    }));
    if (candidates.length >= 5) break;
  }

  const signatureCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.resultSignature) continue;
    signatureCounts.set(candidate.resultSignature, (signatureCounts.get(candidate.resultSignature) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    const equivalenceCount = candidate.resultSignature ? signatureCounts.get(candidate.resultSignature) ?? 0 : 0;
    if (equivalenceCount > 1) candidate.score += equivalenceCount * 10;
  }

  const selected = candidates
    .slice()
    .sort((a, b) =>
      b.score - a.score ||
      Number(b.validationOk) - Number(a.validationOk) ||
      Number(Boolean(b.result && !b.executionError)) - Number(Boolean(a.result && !a.executionError)) ||
      a.index - b.index,
    )[0];
  if (!selected) return { notes: [] };

  const status = selected.validationOk
    ? selected.executionError
      ? `validated but preview failed: ${selected.executionError}`
      : selected.result
        ? `validated and previewed ${selected.result.rowCount.toLocaleString()} row(s)`
        : 'validated'
    : `failed validation: ${selected.validationError ?? 'unknown validation issue'}`;
  // Surface how much the candidates disagreed: distinct execution-result
  // signatures among the candidates that executed cleanly.
  const executedCandidates = candidates.filter((candidate) => candidate.resultSignature);
  const distinctResults = new Set(executedCandidates.map((candidate) => candidate.resultSignature)).size;
  const agreementNote = executedCandidates.length > 1
    ? distinctResults === 1
      ? ` All ${executedCandidates.length} executed candidates agreed on the result.`
      : ` Candidates disagreed: ${distinctResults} distinct results across ${executedCandidates.length} executed candidates — selected the highest-scoring.`
    : '';
  return {
    selected,
    notes: [
      `Deep candidate selection reviewed ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} and selected candidate ${selected.index} (${status}).${agreementNote}`,
    ],
  };
}

async function scoreDeepGeneratedProposalCandidate(
  input: {
    question: string;
    questionPlan: AnalysisQuestionPlan;
    intent: AgentIntent;
    contextLedger: ContextLedger;
    executeGeneratedSql?: (sql: string) => Promise<AgentResultPayload>;
  },
  candidate: { raw: string; parsed: ParsedProposal; index: number },
): Promise<DeepGeneratedProposalCandidate> {
  const parsed = cloneParsedProposal(candidate.parsed);
  if (parsed.sql) parsed.sql = input.contextLedger.qualifySql(parsed.sql).sql;
  let validationOk = false;
  let validationError: string | undefined;
  let result: AgentResultPayload | undefined;
  let executionError: string | undefined;
  let score = parsed.sql ? 10 : -200;

  if (parsed.sql) {
    const validation = input.contextLedger.validateSql(parsed.sql, {
      question: input.question,
      intent: input.intent,
    });
    validationOk = validation.ok;
    if (validation.ok) {
      score += 100;
      if (input.executeGeneratedSql) {
        try {
          result = await input.executeGeneratedSql(parsed.sql);
          score += 40;
          if (result.rowCount > 0) score += 8;
          const resultShape = validateAnswerResultShape(input.questionPlan, result);
          score -= resultShape.warnings.length * 6;
          if (generatedResultShapeIsPartial(resultShape)) score -= 120;
        } catch (error) {
          executionError = error instanceof Error ? error.message : String(error);
          score -= 20;
        }
      }
    } else {
      validationError = validation.error;
      score -= 100;
    }
    if (parsed.outputs?.length) score += Math.min(6, parsed.outputs.length);
  }

  return {
    raw: candidate.raw,
    parsed,
    index: candidate.index,
    validationOk,
    validationError,
    result,
    executionError,
    resultSignature: result && !executionError ? resultEquivalenceSignature(result) : undefined,
    score,
  };
}

async function generateDeepAlternativeProposals(input: {
  provider: AgentProvider;
  messages: AgentMessage[];
  question: string;
  initial: { raw: string; parsed: ParsedProposal };
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  maxAlternatives?: number;
}): Promise<string[]> {
  const previousSql = input.initial.parsed.sql
    ? `\nInitial SQL candidate:\n\`\`\`sql\n${input.initial.parsed.sql}\n\`\`\``
    : '';
  // Diverse candidate styles (CHASE-SQL-style): each explores the solution space
  // differently so execution-result agreement between styles is a strong signal.
  const variants = [
    'Create a second candidate that favors the most direct inspected relations and explicit joins.',
    'Create a third candidate using QUERY-PLAN reasoning: first outline the grain, measures, dimensions, and join path as steps, then write SQL that follows that plan exactly.',
    'Create a fourth candidate by DECOMPOSITION: break the question into sub-questions, solve each as a CTE, then compose the final SELECT — avoiding assumptions hidden in the first candidate.',
  ];
  const temperatures = [0.2, 0.35, 0.5];
  // How many diverse alternatives to generate is set by the question SHAPE (S1):
  // a lightweight 1-candidate agreement check for join/breakdown shapes, the full
  // 3-candidate vote for deep-research, none for a single-table lookup. The
  // generations are independent, so they run in PARALLEL — the deep vote's
  // wall-clock cost is one generation, not the serial sum of all of them.
  const count = Math.max(0, Math.min(input.maxAlternatives ?? variants.length, variants.length));
  const selected = variants.slice(0, count);
  const results = await Promise.all(selected.map(async (instruction, index) => {
    try {
      const raw = await input.provider.generate([
        ...input.messages,
        { role: 'assistant', content: input.initial.raw },
        {
          role: 'user',
          content: [
            'Deep mode is allowed to compare multiple review-required SQL candidates before choosing one.',
            `Question: ${input.question}`,
            instruction,
            previousSql,
            'Return only one ```json fenced object with summary, sql, viz, outputs, and optional dql metadata fields.',
          ].filter(Boolean).join('\n\n'),
        },
      ], {
        signal: input.signal,
        reasoningEffort: input.reasoningEffort,
        temperature: temperatures[index] ?? 0.4,
      });
      return raw.trim() ? raw : '';
    } catch {
      // Alternative candidates are opportunistic; the initial candidate remains.
      return '';
    }
  }));
  return results.filter((raw) => raw.trim());
}

function cloneParsedProposal(proposal: ParsedProposal): ParsedProposal {
  return {
    text: proposal.text,
    ...(proposal.sql ? { sql: proposal.sql } : {}),
    ...(proposal.viz ? { viz: proposal.viz } : {}),
    ...(proposal.outputs?.length ? { outputs: proposal.outputs.slice() } : {}),
    ...(proposal.proposedEntity ? { proposedEntity: proposal.proposedEntity } : {}),
    ...(proposal.requestedFilters?.length ? { requestedFilters: proposal.requestedFilters.slice() } : {}),
    ...(proposal.requestedDimensions?.length ? { requestedDimensions: proposal.requestedDimensions.slice() } : {}),
  };
}

function resultEquivalenceSignature(result: AgentResultPayload): string {
  const columns = result.columns.map((column) => String(column)).join('|');
  const rows = result.rows.slice(0, 25).map((row) => stableResultRow(row)).join('\n');
  return `${columns}\n${rows}`;
}

function stableResultRow(row: unknown): string {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return JSON.stringify(row);
  }
  const record = row as Record<string, unknown>;
  return JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
}

function evidenceToolCallFromEvent(
  event: { name: string; input: unknown; output?: unknown; isError?: boolean; durationMs?: number },
  order: number,
): AgentEvidenceToolCall {
  return {
    name: event.name,
    status: event.isError ? 'failed' : 'checked',
    inputSummary: summarizeEvidencePayload(event.input),
    outputSummary: summarizeEvidencePayload(event.output),
    order,
    ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
  };
}

function summarizeEvidencePayload(value: unknown, maxLength = 700): string | undefined {
  if (value === undefined) return undefined;
  let raw: string | undefined;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  if (!raw) return undefined;
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function isRetryableGeneratedSqlError(error: string): boolean {
  return !/\b(read-only|readonly|select or with|unsafe|delete|insert|update|drop|alter|create|attach|copy|pragma)\b/i.test(error);
}

function repairGeneratedSqlLocally(sql: string, error: string, schemaContext: AgentSchemaTable[]): string | undefined {
  const missing = error.match(/(?:Values list|Referenced table)\s+"([^"]+)"\s+does not have a column named\s+"([^"]+)"/i)
    ?? error.match(/Referenced column\s+"([^"]+)"\s+not found/i);
  if (!missing) return undefined;
  const badAlias = missing.length >= 3 ? missing[1] : undefined;
  const missingColumn = missing.length >= 3 ? missing[2] : missing[1];
  if (!missingColumn) return undefined;
  const aliasToRelation = extractSqlAliases(sql);
  const columnOwnerAliases = aliasesWithColumn(aliasToRelation, schemaContext, missingColumn);
  const replacementAlias = columnOwnerAliases.find((alias) => alias !== badAlias) ?? columnOwnerAliases[0];
  if (!replacementAlias) return undefined;
  if (badAlias && new RegExp(`\\b${escapeRegex(badAlias)}\\.${escapeRegex(missingColumn)}\\b`, 'i').test(sql)) {
    return sql.replace(new RegExp(`\\b${escapeRegex(badAlias)}\\.${escapeRegex(missingColumn)}\\b`, 'gi'), `${replacementAlias}.${missingColumn}`);
  }
  return undefined;
}

function extractSqlAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of sql.matchAll(/\b(?:from|join)\s+([a-zA-Z_][\w.]*)(?:\s+as)?\s+([a-zA-Z_][\w]*)/gi)) {
    const relation = match[1];
    const alias = match[2];
    if (!relation || !alias) continue;
    if (/^(where|join|on|group|order|limit)$/i.test(alias)) continue;
    aliases.set(alias, relation);
  }
  return aliases;
}

function aliasesWithColumn(aliasToRelation: Map<string, string>, schemaContext: AgentSchemaTable[], column: string): string[] {
  const aliases: string[] = [];
  for (const [alias, relation] of aliasToRelation) {
    const normalizedRelation = relation.toLowerCase();
    const table = schemaContext.find((item) =>
      item.relation.toLowerCase() === normalizedRelation ||
      item.name.toLowerCase() === normalizedRelation ||
      normalizedRelation.endsWith(`.${item.name.toLowerCase()}`),
    );
    if (!table) continue;
    if (table.columns.some((col) => col.name.toLowerCase() === column.toLowerCase())) aliases.push(alias);
  }
  return aliases;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function composeCertifiedAnswer(
  artifact: KGNode,
  question: string,
  result?: AgentResultPayload,
  executionError?: string,
): string {
  const desc = artifact.description ?? artifact.llmContext ?? '';
  const tag = artifact.gitSha ? ` · ${artifact.gitSha.slice(0, 8)}` : '';
  const resultText = result
    ? `Returned ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}.`
    : executionError
      ? `The certified block matched, but governed execution failed: ${executionError}`
      : artifact.kind === 'block'
        ? 'Governed execution was not requested by this host.'
        : `Matched certified ${artifact.kind.replace('_', ' ')} context.`;
  // Freshness-aware trust: the block's logic is certified, but its upstream
  // data may be stale or its last dbt run may have failed. Caveat the answer so
  // a consumer can weigh it — "certified" is not the same as "fresh".
  const freshnessCaveat = certifiedFreshnessCaveat(artifact);
  return `Outcome: Reuse certified block\n\nAnswered by certified ${artifact.kind.replace('_', ' ')} **${artifact.name}**${tag}.\n\n${desc ? `${desc}\n\n${resultText}` : resultText}`
    + (freshnessCaveat ? `\n\n${freshnessCaveat}` : '')
    + `\n\n_Question:_ ${question}`;
}

/**
 * Build a one-line data-freshness caveat for a certified answer, or `undefined`
 * when the upstream data is fresh / un-instrumented. Stale and failed upstreams
 * are surfaced so a certified-but-stale answer is never presented as if its data
 * were current.
 */
function certifiedFreshnessCaveat(artifact: KGNode): string | undefined {
  switch (artifact.dataState) {
    case 'failed':
      return `⚠️ Data caveat: an upstream dbt model's last run failed, so this certified result may be missing or out of date.${artifact.dataStateDetail ? ` ${artifact.dataStateDetail}` : ''}`;
    case 'stale':
      return `⚠️ Data caveat: upstream data is past its freshness window, so this certified result may be stale.${artifact.dataStateDetail ? ` ${artifact.dataStateDetail}` : ''}`;
    default:
      return undefined;
  }
}

function provenanceSourceTierLabel(tier: AnswerSourceTier | undefined): string | undefined {
  switch (tier) {
    case 'certified_artifact': return 'Certified block';
    case 'semantic_layer': return 'Governed semantic metric';
    case 'business_context': return 'Business context';
    case 'dbt_manifest': return 'Generated SQL';
    default: return undefined;
  }
}

/**
 * Anthropic-style provenance footer: one line telling a stakeholder WHERE the
 * answer came from (source tier), how much to trust it, who owns the source, and
 * whether the underlying data is current. Built once at the single exit from the
 * finished answer; omitted for no-answer outcomes.
 */
export function buildProvenanceFooter(result: AgentAnswer, trust: ResolvedTrustLabel | undefined): string | undefined {
  if (result.kind === 'no_answer') return undefined;
  const parts: string[] = [];
  const tierLabel = provenanceSourceTierLabel(result.sourceTier);
  if (tierLabel) parts.push(`Source: ${tierLabel}`);
  if (trust?.display) parts.push(`Trust: ${trust.display}`);
  if (result.block?.owner) parts.push(`Owner: ${result.block.owner}`);
  const freshness = result.block?.dataState === 'stale' ? 'stale — verify currency'
    : result.block?.dataState === 'failed' ? 'upstream run failed'
    : result.block?.dataState === 'fresh' ? 'current'
    : undefined;
  if (freshness) parts.push(`Data: ${freshness}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function mergeHits(...groups: KGSearchHit[][]): KGSearchHit[] {
  const byId = new Map<string, KGSearchHit>();
  for (const group of groups) {
    for (const hit of group) {
      const existing = byId.get(hit.node.nodeId);
      if (!existing || hit.score > existing.score) byId.set(hit.node.nodeId, hit);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

function mergeNodes(...groups: KGNode[][]): KGNode[] {
  const byId = new Map<string, KGNode>();
  for (const group of groups) {
    for (const node of group) {
      if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
    }
  }
  return Array.from(byId.values());
}

/**
 * Merge prioritized hit groups into a single deduped list under a total budget,
 * giving each group a guaranteed minimum number of slots. Pass 1 takes up to
 * `reserve` from each group in priority order; pass 2 fills any remaining budget
 * round-robin from each group's leftovers. This prevents a high-priority group
 * from starving a lower one out of the prompt entirely (the semantic-hit
 * truncation bug) while still honoring priority for the reserved slots.
 */
function interleaveContextHits(
  groups: Array<{ hits: KGSearchHit[]; reserve: number }>,
  budget: number,
): KGSearchHit[] {
  const seen = new Set<string>();
  const out: KGSearchHit[] = [];
  const cursors = groups.map(() => 0);
  const take = (hit: KGSearchHit): boolean => {
    if (out.length >= budget || seen.has(hit.node.nodeId)) return false;
    seen.add(hit.node.nodeId);
    out.push(hit);
    return true;
  };
  // Pass 1: reserved minimums, in priority order.
  groups.forEach((group, gi) => {
    let taken = 0;
    while (cursors[gi] < group.hits.length && taken < group.reserve && out.length < budget) {
      if (take(group.hits[cursors[gi]])) taken += 1;
      cursors[gi] += 1;
    }
  });
  // Pass 2: round-robin fill from leftovers until the budget is exhausted.
  let progressed = true;
  while (out.length < budget && progressed) {
    progressed = false;
    for (let gi = 0; gi < groups.length && out.length < budget; gi += 1) {
      const group = groups[gi];
      while (cursors[gi] < group.hits.length) {
        const before = out.length;
        take(group.hits[cursors[gi]]);
        cursors[gi] += 1;
        if (out.length > before) { progressed = true; break; }
      }
    }
  }
  return out;
}

/**
 * Candidate metric KG nodes for semantic-metric matching (spec 17, part C).
 * Starts with the FTS semantic + considered hits, then folds in every metric
 * node from the KG so a confident measure-family match is found even when FTS
 * surfaced no metric at all. Metric headers are compact; correctness must not
 * depend on an alphabetical first-200 slice in an enterprise catalog.
 */
function collectMetricCandidates(
  semanticHits: KGSearchHit[],
  considered: KGSearchHit[],
  kg: KGStore,
): KGNode[] {
  const byId = new Map<string, KGNode>();
  for (const hit of [...semanticHits, ...considered]) {
    if (hit.node.kind === 'metric') byId.set(hit.node.nodeId, hit.node);
  }
  try {
    for (const node of kg.getNodesByKind('metric', 100_000)) {
      if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
    }
  } catch {
    // Best-effort: a KG without a getNodesByKind still matches the FTS hits.
  }
  return Array.from(byId.values());
}

/**
 * Bind a validated meaning-resolution ID to the exact KG metric node. This is
 * deliberately ID-only: labels/aliases are not reinterpreted here, and the
 * semantic compiler still has to prove the requested dimensions and filters.
 */
function resolvePreferredSemanticMetric(
  ids: Array<string | undefined>,
  pool: KGNode[],
  kg: KGStore,
): KGNode | undefined {
  const byId = new Map(pool.filter((node) => node.kind === 'metric').map((node) => [node.nodeId, node]));
  for (const rawId of ids) {
    const id = rawId?.trim();
    if (!id) continue;
    const nodeId = id.startsWith('semantic:metric:')
      ? id.slice('semantic:'.length)
      : id.startsWith('metric:')
        ? id
        : undefined;
    if (!nodeId) continue;
    const node = byId.get(nodeId) ?? kg.getNode(nodeId);
    if (node?.kind === 'metric') return node;
  }
  return undefined;
}


function buildCertifiedEvidence(input: {
  question: string;
  artifact: KGNode;
  businessHits: KGSearchHit[];
  semanticHits: KGSearchHit[];
  manifestHits: KGSearchHit[];
  considered: KGSearchHit[];
  result?: AgentResultPayload;
  executionError?: string;
  resultShapeWarnings?: string[];
  executorWasAvailable: boolean;
  citations: AgentCitation[];
  memoryContext: AgentMemory[];
  analysisPlan?: AgentAnalysisPlan;
}): AgentEvidence {
  const businessContextAssets = uniqueAssets(
    input.businessHits
      .map((hit) => hit.node)
      .filter((node) => node.nodeId !== input.artifact.nodeId)
      .map(assetFromNode),
  ).slice(0, 6);
  const semanticObjects = uniqueAssets(input.semanticHits.map((hit) => assetFromNode(hit.node))).slice(0, 6);
  const sourceTables = uniqueAssets(input.manifestHits.map((hit) => assetFromNode(hit.node))).slice(0, 6);
  const relatedConsumers = input.considered
    .map((hit) => hit.node)
    .filter((node) => node.nodeId !== input.artifact.nodeId && ARTIFACT_KINDS.includes(node.kind))
    .slice(0, 4);
  return {
    route: [
      ...cascadeTraceToEvidenceRouteSteps(createCascadeTrace({
        terminalLane: 'certified',
        lanes: {
          certified: {
            label: `Lane 1 answered from certified ${input.artifact.kind.replace('_', ' ')}`,
            detail: input.artifact.name,
          },
          semantic: {
            label: 'Lane 2 semantic compile skipped because certified context already answered',
          },
          generated: {
            label: 'Lane 3 generated DQL artifact skipped because certified context already answered',
          },
        },
      })),
      {
        tool: 'search_certified_artifacts',
        status: 'selected',
        label: `Selected certified ${input.artifact.kind.replace('_', ' ')}`,
        detail: input.artifact.name,
      },
      {
        tool: 'query_certified_artifact',
        status: input.executionError ? 'failed' : input.result ? 'selected' : input.executorWasAvailable ? 'checked' : 'skipped',
        label: input.executionError
          ? 'Certified execution failed'
          : input.result
            ? 'Executed certified block'
            : input.artifact.kind === 'block'
              ? 'Certified block was not executed by this host'
              : 'Certified navigation artifact selected',
        detail: input.executionError ?? (input.result ? `${input.result.rowCount} rows` : undefined),
      },
      {
        tool: 'search_business_context',
        status: BUSINESS_CONTEXT_KINDS.includes(input.artifact.kind)
          ? 'selected'
          : input.businessHits.length > 0
            ? 'checked'
            : 'skipped',
        label: BUSINESS_CONTEXT_KINDS.includes(input.artifact.kind)
          ? `Selected ${input.artifact.kind.replace('_', ' ')}`
          : input.businessHits.length > 0
            ? 'Business context attached'
            : 'No business context needed',
      },
      {
        tool: 'search_semantic_layer',
        status: input.semanticHits.length > 0 ? 'checked' : 'skipped',
        label: input.semanticHits.length > 0 ? 'Semantic context attached' : 'No semantic context needed',
      },
      {
        tool: 'search_dbt_manifest',
        status: input.manifestHits.length > 0 ? 'checked' : 'skipped',
        label: input.manifestHits.length > 0 ? 'dbt/source context attached' : 'No dbt fallback needed',
      },
    ],
    lineage: [
      questionLineageNode(input.question),
      { ...assetFromNode(input.artifact), role: 'selected_asset' },
      ...businessContextAssets.map((asset) => ({ ...asset, role: 'business_context' as const })),
      ...semanticObjects.map((asset) => ({ ...asset, role: 'semantic_object' as const })),
      ...sourceTables.map((asset) => ({ ...asset, role: 'source_table' as const })),
      ...relatedConsumers.map((node) => ({ ...assetFromNode(node), role: 'consumer' as const })),
    ],
    businessContext: [
      ...businessContextForNode(input.artifact),
      ...input.memoryContext.slice(0, 3).map((memory) => ({
        label: 'Memory advisory',
        value: `${memory.title}: ${memory.content}`,
        source: memory.source,
      })),
    ],
    outcome: outcomeForNode(input.artifact),
    selectedAssets: [assetFromNode(input.artifact)],
    sourceTables,
    semanticObjects,
    validation: {
      status: input.executionError ? 'failed' : input.resultShapeWarnings?.length ? 'warning' : 'passed',
      message: input.executionError
        ? 'The certified artifact matched, but execution returned an error.'
        : input.resultShapeWarnings?.length
          ? `Certified artifact executed, but the result shape needs review: ${input.resultShapeWarnings.join(' ')}`
        : 'Certified artifact routing passed; no review-required DQL artifact was promoted.',
    },
    execution: executionEvidence(input.artifact, input.result, input.executionError, input.executorWasAvailable),
    citations: input.citations,
    analysisPlan: input.analysisPlan,
  };
}

function buildGeneratedEvidence(input: {
  question: string;
  activeTier: AnswerSourceTier;
  terminalLane: Extract<CascadeLane, 'semantic' | 'generated'>;
  terminalDetail?: string;
  intent: AgentIntent;
  contextNodes: KGNode[];
  schemaContext: AgentSchemaTable[];
  followUp?: AgentFollowUpContext;
  contextPack?: LocalContextPack;
  businessHits: KGSearchHit[];
  semanticHits: KGSearchHit[];
  manifestHits: KGSearchHit[];
  considered: KGSearchHit[];
  citations: AgentCitation[];
  memoryContext: AgentMemory[];
  result?: AgentResultPayload;
  executionError?: string;
  executorWasAvailable: boolean;
  analysisPlan?: AgentAnalysisPlan;
  toolCalls?: AgentEvidenceToolCall[];
  budgetTrace?: CascadeBudgetTrace;
}): AgentEvidence {
  const selectedNodes = input.contextNodes.slice(0, 4);
  const businessAssets = uniqueAssets(
    [...input.contextNodes, ...input.businessHits.map((hit) => hit.node)]
      .filter((node) => BUSINESS_CONTEXT_KINDS.includes(node.kind))
      .map(assetFromNode),
  ).slice(0, 6);
  const semanticObjects = uniqueAssets(
    [...input.contextNodes, ...input.semanticHits.map((hit) => hit.node)]
      .filter((node) => SEMANTIC_KINDS.includes(node.kind))
      .map(assetFromNode),
  ).slice(0, 6);
  const sourceTables = uniqueAssets(
    [
      ...[...input.contextNodes, ...input.manifestHits.map((hit) => hit.node)]
        .filter((node) => MANIFEST_KINDS.includes(node.kind))
        .map(assetFromNode),
      ...schemaContextAssets(input.schemaContext),
    ],
  ).slice(0, 6);
  const selectedAssets = uniqueAssets(selectedNodes.map(assetFromNode)).slice(0, 4);
  const selectedSemantic = input.activeTier === 'semantic_layer' && semanticObjects.length > 0;
  const certifiedFitStep = certifiedFitEvidenceStep(input.contextPack);
  const certifiedCandidateFitSteps = certifiedCandidateFitEvidenceSteps(input.contextPack);
  return {
    route: [
      ...cascadeTraceToEvidenceRouteSteps(createCascadeTrace({
        terminalLane: input.terminalLane,
        lanes: {
          certified: {
            label: input.followUp?.kind === 'drilldown'
              ? 'Lane 1 checked for a distinct certified drilldown block'
              : 'Lane 1 checked certified blocks for exact answer fit',
          },
          semantic: {
            label: input.terminalLane === 'semantic'
              ? 'Lane 2 answered through semantic metric compile'
              : input.semanticHits.length > 0
                ? 'Lane 2 semantic context was checked but did not fully answer'
                : 'Lane 2 semantic context had no strong match',
            ...(input.terminalLane === 'semantic' && input.terminalDetail ? { detail: input.terminalDetail } : {}),
          },
          generated: {
            label: input.terminalLane === 'generated'
              ? 'Lane 3 prepared review-required DQL artifact with SQL preview'
              : 'Lane 3 generated SQL skipped because semantic compile answered',
            ...(input.terminalLane === 'generated' && input.terminalDetail ? { detail: input.terminalDetail } : {}),
          },
        },
      })),
      ...cascadeBudgetEvidenceRouteSteps(input.budgetTrace),
      {
        tool: 'search_certified_artifacts',
        status: 'checked',
        label: input.intent === 'ad_hoc_analysis'
          ? 'Certified artifacts considered as context; dynamic SQL selected for the requested grain'
          : input.followUp?.kind === 'drilldown'
          ? 'No distinct certified drilldown block was strong enough for this question'
          : 'No certified artifact was strong enough for this question',
        detail: input.followUp?.sourceBlockName,
      },
      ...(certifiedFitStep ? [certifiedFitStep] : []),
      ...certifiedCandidateFitSteps,
      {
        tool: 'propose_drilldown',
        status: input.followUp?.kind === 'drilldown' ? 'checked' : 'skipped',
        label: input.followUp?.kind === 'drilldown'
          ? 'Using prior answer context for a review-required drilldown draft'
          : 'Not a drilldown follow-up',
        detail: input.followUp?.filters?.length || input.followUp?.dimensions?.length
          ? [...(input.followUp.filters ?? []), ...(input.followUp.dimensions ?? [])].join(', ')
          : undefined,
      },
      ...providerToolEvidenceRouteSteps(input.toolCalls),
      {
        tool: 'search_business_context',
        status: businessAssets.length > 0 ? 'checked' : 'skipped',
        label: businessAssets.length > 0 ? 'Business context considered' : 'No business context match',
      },
      {
        tool: 'search_semantic_layer',
        status: selectedSemantic ? 'selected' : input.semanticHits.length > 0 ? 'checked' : 'skipped',
        label: selectedSemantic ? 'Selected semantic context' : input.semanticHits.length > 0 ? 'Semantic context considered' : 'No semantic match',
      },
      {
        tool: input.activeTier === 'semantic_layer' ? 'compose_semantic_query' : 'search_dbt_manifest',
        status: 'selected',
        label: input.activeTier === 'semantic_layer'
          ? 'Composed SQL from semantic context'
          : input.schemaContext.length > 0
            ? 'Composed SQL from runtime schema and project metadata'
            : 'Composed SQL from dbt manifest context',
      },
      {
        tool: 'inspect_runtime_schema',
        status: input.schemaContext.length > 0 ? 'checked' : 'skipped',
        label: input.schemaContext.length > 0 ? 'Runtime tables and columns attached' : 'No runtime schema context available',
        detail: input.schemaContext.slice(0, 3).map((table) => table.relation).join(', ') || undefined,
      },
      {
        tool: 'validate_sql',
        status: 'checked',
        label: 'SQL preview for DQL artifact requires host validation before certification',
      },
      {
        tool: 'execute_generated_sql',
        status: input.executionError
          ? 'failed'
          : input.result
            ? 'selected'
            : input.executorWasAvailable
              ? 'skipped'
              : 'skipped',
        label: input.executionError
          ? 'SQL preview failed'
          : input.result
            ? 'Executed SQL preview for DQL artifact'
            : 'SQL preview not requested',
        detail: input.executionError ?? (input.result ? `${input.result.rowCount} rows` : undefined),
      },
      {
        tool: 'create_draft_block',
        status: 'checked',
        label: input.followUp?.kind === 'drilldown'
          ? 'Drilldown draft is ready for analyst review'
          : 'Draft block proposal is ready for analyst review',
      },
    ],
    lineage: [
      questionLineageNode(input.question),
      ...selectedAssets.map((asset) => ({ ...asset, role: selectedAssetRole(asset, selectedSemantic) })),
      ...businessAssets
        .filter((asset) => !selectedAssets.some((selected) => selected.nodeId === asset.nodeId))
        .map((asset) => ({ ...asset, role: 'business_context' as const })),
      ...sourceTables.map((asset) => ({ ...asset, role: 'source_table' as const })),
      ...semanticObjects
        .filter((asset) => !selectedAssets.some((selected) => selected.nodeId === asset.nodeId))
        .map((asset) => ({ ...asset, role: 'semantic_object' as const })),
    ],
    businessContext: [
      ...selectedNodes.flatMap(businessContextForNode),
      ...input.memoryContext.slice(0, 3).map((memory) => ({
        label: 'Memory advisory',
        value: `${memory.title}: ${memory.content}`,
        source: memory.source,
      })),
    ],
    outcome: outcomeForNode(selectedNodes[0]),
    selectedAssets,
    sourceTables,
    semanticObjects,
    ...(input.toolCalls?.length ? { toolCalls: input.toolCalls } : {}),
    validation: {
      status: 'warning',
      message: input.followUp?.kind === 'drilldown'
        ? 'Review-required drilldown DQL artifact is not certified. Its SQL preview should be validated, reviewed, and promoted only after analyst approval.'
        : 'Review-required DQL artifact is not certified. Its SQL preview should be validated, reviewed, and promoted only after analyst approval.',
    },
    execution: {
      status: input.executionError ? 'failed' : input.result ? 'executed' : 'not_requested',
      message: input.executionError
        ? input.executionError
        : input.result
          ? 'Executed SQL preview as an uncertified bounded preview for the DQL artifact.'
          : 'Review-required DQL artifact was returned for review; SQL preview execution is handled by the host after validation.',
      rowCount: input.result?.rowCount,
      executionTime: input.result?.executionTime,
    },
    citations: input.citations,
    analysisPlan: input.analysisPlan,
  };
}

function certifiedFitEvidenceStep(contextPack: LocalContextPack | undefined): AgentEvidenceRouteStep | undefined {
  const fit = contextPack?.routeDecision?.blockFit;
  if (!fit) return undefined;
  const applicability = contextPack?.routeDecision?.certifiedApplicability;
  const allowed = certifiedFitAllowsTier1(fit);
  return {
    tool: 'check_certified_fit',
    status: allowed ? 'selected' : 'checked',
    label: allowed
      ? `Certified block fit passed${applicability?.name ? ` for ${applicability.name}` : ''}`
      : `Certified block kept as context${applicability?.name ? `: ${applicability.name}` : ''}`,
    detail: fit.reasons.length > 0
      ? fit.reasons.join('; ')
      : allowed
        ? 'Certified block covers the requested answer contract.'
        : 'Certified block did not prove an exact answer contract match.',
  };
}

function certifiedCandidateFitEvidenceSteps(contextPack: LocalContextPack | undefined): AgentEvidenceRouteStep[] {
  const candidates = contextPack?.retrievalDiagnostics.certifiedCandidateFits ?? [];
  return candidates
    .slice(0, 4)
    .map((candidate) => ({
      tool: 'check_certified_candidate_fit',
      status: candidate.action === 'certified_answer'
        ? 'selected'
        : 'checked',
      label: certifiedCandidateFitLabel(candidate.name, candidate.action),
      detail: [
        `applicability=${candidate.applicabilityKind}`,
        `fit=${candidate.fit.kind}/${candidate.fit.confidence}`,
        candidate.fit.reasons.join('; '),
      ].filter(Boolean).join(' | '),
    }));
}

function certifiedCandidateFitLabel(name: string, action: NonNullable<LocalContextPack['retrievalDiagnostics']['certifiedCandidateFits']>[number]['action']): string {
  switch (action) {
    case 'certified_answer':
      return `Certified candidate selected: ${name}`;
    case 'context_only':
      return `Certified candidate used as context only: ${name}`;
    case 'eligible_not_selected':
      return `Certified candidate fit passed but was not selected: ${name}`;
    case 'rejected_for_fit':
      return `Certified candidate rejected for answer fit: ${name}`;
  }
}

function providerToolEvidenceRouteSteps(toolCalls: AgentEvidenceToolCall[] | undefined): AgentEvidenceRouteStep[] {
  return (toolCalls ?? []).slice(0, 8).map((call) => ({
    tool: call.name,
    status: call.status,
    label: call.status === 'failed'
      ? `Provider tool failed: ${call.name}`
      : `Provider tool observed: ${call.name}`,
    detail: [
      call.inputSummary ? `input=${truncateEvidenceDetail(call.inputSummary)}` : '',
      call.outputSummary ? `output=${truncateEvidenceDetail(call.outputSummary)}` : '',
    ].filter(Boolean).join(' | ') || undefined,
  }));
}

function cascadeBudgetEvidenceRouteSteps(trace: CascadeBudgetTrace | undefined): AgentEvidenceRouteStep[] {
  if (!trace) return [];
  const { usage, limits } = trace;
  const used = usage.laneRegroundAttemptsUsed + usage.laneExecutionAttemptsUsed + usage.engineEscalationsUsed;
  if (used === 0) return [];
  return [{
    tool: 'cascade_budget',
    status: 'checked',
    label: `Repair budget used: re-ground ${usage.laneRegroundAttemptsUsed}/${limits.lane.reground}, execution ${usage.laneExecutionAttemptsUsed}/${limits.lane.execution}`,
    detail: `engine escalations ${usage.engineEscalationsUsed}/${limits.engineEscalations}`,
  }];
}

function truncateEvidenceDetail(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function buildNoAnswerEvidence(input: {
  question: string;
  reason: string;
  artifactHits: KGSearchHit[];
  businessHits: KGSearchHit[];
  semanticHits: KGSearchHit[];
  manifestHits: KGSearchHit[];
  considered: KGSearchHit[];
  memoryContext: AgentMemory[];
  analysisPlan?: AgentAnalysisPlan;
  toolCalls?: AgentEvidenceToolCall[];
  budgetTrace?: CascadeBudgetTrace;
}): AgentEvidence {
  return {
    route: [
      ...cascadeTraceToEvidenceRouteSteps(createCascadeTrace({
        terminalLane: 'refusal',
        lanes: {
          certified: {
            label: input.artifactHits.length > 0
              ? 'Lane 1 certified blocks were checked but not selected'
              : 'Lane 1 found no certified block match',
          },
          semantic: {
            label: input.semanticHits.length > 0
              ? 'Lane 2 semantic context was checked but did not answer'
              : 'Lane 2 found no semantic match',
          },
          generated: {
            label: 'Lane 3 could not produce a validated review-required DQL artifact',
          },
          refusal: {
            label: 'Lane 4 returned an honest refusal or clarification',
            detail: input.reason,
          },
        },
      })),
      ...cascadeBudgetEvidenceRouteSteps(input.budgetTrace),
      {
        tool: 'search_certified_artifacts',
        status: input.artifactHits.length > 0 ? 'checked' : 'skipped',
        label: input.artifactHits.length > 0 ? 'Certified artifacts considered but not selected' : 'No certified artifact match',
      },
      {
        tool: 'search_business_context',
        status: input.businessHits.length > 0 ? 'checked' : 'skipped',
        label: input.businessHits.length > 0 ? 'Business context considered' : 'No business context match',
      },
      {
        tool: 'search_semantic_layer',
        status: input.semanticHits.length > 0 ? 'checked' : 'skipped',
        label: input.semanticHits.length > 0 ? 'Semantic context considered' : 'No semantic match',
      },
      {
        tool: 'search_dbt_manifest',
        status: input.manifestHits.length > 0 ? 'checked' : 'skipped',
        label: input.manifestHits.length > 0 ? 'dbt context considered' : 'No dbt match',
      },
      ...providerToolEvidenceRouteSteps(input.toolCalls),
      {
        tool: 'validate_sql',
        status: 'failed',
        label: input.reason,
      },
    ],
    lineage: [
      questionLineageNode(input.question),
      ...input.considered.slice(0, 6).map((hit) => ({ ...assetFromNode(hit.node), role: 'selected_asset' as const })),
    ],
    businessContext: [
      ...input.businessHits.slice(0, 4).flatMap((hit) => businessContextForNode(hit.node)),
      ...input.memoryContext.slice(0, 3).map((memory) => ({
        label: 'Memory advisory',
        value: `${memory.title}: ${memory.content}`,
        source: memory.source,
      })),
    ],
    selectedAssets: [],
    sourceTables: uniqueAssets(input.manifestHits.map((hit) => assetFromNode(hit.node))).slice(0, 6),
    semanticObjects: uniqueAssets(input.semanticHits.map((hit) => assetFromNode(hit.node))).slice(0, 6),
    ...(input.toolCalls?.length ? { toolCalls: input.toolCalls } : {}),
    validation: {
      status: 'failed',
      message: input.reason,
    },
    execution: {
      status: 'not_applicable',
      message: 'No SQL or certified block was executed.',
    },
    citations: [],
    analysisPlan: input.analysisPlan,
  };
}

function questionLineageNode(question: string): AgentEvidenceLineageNode {
  return {
    nodeId: 'question',
    kind: 'question',
    name: question,
    role: 'question',
  };
}

function selectedAssetRole(asset: AgentEvidenceAsset, selectedSemantic: boolean): AgentEvidenceLineageRole {
  if (asset.kind === 'term' || asset.kind === 'business_view') return 'business_context';
  if (asset.kind && SEMANTIC_KINDS.includes(asset.kind as KGNodeKind)) return 'semantic_object';
  if (asset.kind && MANIFEST_KINDS.includes(asset.kind as KGNodeKind)) return 'source_table';
  return selectedSemantic ? 'semantic_object' : 'selected_asset';
}

function assetFromNode(node: KGNode): AgentEvidenceAsset {
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    description: node.description,
    sourceTier: node.sourceTier,
    certification: certificationForNode(node),
    provenance: node.provenance,
    sourcePath: node.sourcePath,
    owner: node.owner,
    domain: node.domain,
    status: node.status,
  };
}

function schemaContextAssets(schemaContext: AgentSchemaTable[]): AgentEvidenceAsset[] {
  return schemaContext.slice(0, 6).map((table) => ({
    nodeId: `runtime_schema:${table.relation}`,
    kind: 'runtime_schema',
    name: table.relation,
    description: table.description ?? `${table.columns.length} runtime column${table.columns.length === 1 ? '' : 's'} available for DQL artifact SQL previews.`,
    sourceTier: 'project',
    certification: 'ai_generated',
    provenance: table.source ?? 'runtime information_schema',
    sourcePath: table.relation,
  }));
}

function schemaCitations(schemaContext: AgentSchemaTable[], limit: number): AgentCitation[] {
  if (limit <= 0) return [];
  return schemaContext.slice(0, limit).map((table) => ({
    nodeId: `runtime_schema:${table.relation}`,
    kind: 'runtime_schema',
    name: table.relation,
    sourceTier: 'dbt_manifest',
    provenance: table.source ?? 'runtime information_schema',
  }));
}

function certificationForNode(node: KGNode): AgentEvidenceAsset['certification'] {
  const certification = node.certification as string | undefined;
  if (node.status === 'certified' || certification === 'certified') return 'certified';
  if (certification === 'reviewed' || node.status === 'review' || node.status === 'reviewed') return 'reviewed';
  if (certification === 'conflict') return 'conflict';
  if (certification === 'insufficient_context') return 'insufficient_context';
  if (certification === 'analyst_review_required') return 'analyst_review_required';
  if (certification === 'ai_generated' || certification === 'uncertified') return 'ai_generated';
  return undefined;
}

function businessContextForNode(node: KGNode): AgentEvidenceContextItem[] {
  const items: AgentEvidenceContextItem[] = [];
  if (node.description) items.push({ label: 'Definition', value: node.description, source: node.provenance });
  if (node.llmContext) items.push({ label: 'Business rule', value: node.llmContext, source: node.provenance });
  if (node.businessOutcome) items.push({ label: 'Business outcome', value: node.businessOutcome, source: node.provenance });
  if (node.decisionUse) items.push({ label: 'Decision use', value: node.decisionUse, source: node.provenance });
  if (node.owner) items.push({ label: 'Owner', value: node.owner, source: node.provenance });
  if (node.businessOwner && node.businessOwner !== node.owner) items.push({ label: 'Business owner', value: node.businessOwner, source: node.provenance });
  if (node.domain) items.push({ label: 'Domain', value: node.domain, source: node.provenance });
  if (node.status) items.push({ label: 'Certification status', value: node.status, source: node.provenance });
  if (node.reviewCadence) items.push({ label: 'Review cadence', value: node.reviewCadence, source: node.provenance });
  if (node.freshness) items.push({ label: 'Freshness', value: node.freshness, source: node.provenance });
  for (const rule of node.businessRules ?? []) items.push({ label: 'Business rule', value: rule, source: node.provenance });
  for (const caveat of node.caveats ?? []) items.push({ label: 'Caveat', value: caveat, source: node.provenance });
  return items;
}

function outcomeForNode(node: KGNode | undefined): AgentEvidenceOutcome | undefined {
  if (!node) return undefined;
  const outcome: AgentEvidenceOutcome = {
    name: node.businessOutcome,
    owner: node.businessOwner ?? node.owner,
    decisionUse: node.decisionUse,
    reviewCadence: node.reviewCadence,
    caveats: node.caveats,
  };
  return Object.values(outcome).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)) ? outcome : undefined;
}

function executionEvidence(
  artifact: KGNode,
  result: AgentResultPayload | undefined,
  executionError: string | undefined,
  executorWasAvailable: boolean,
): AgentEvidence['execution'] {
  if (result) {
    return {
      status: 'executed',
      message: `Executed certified block ${artifact.name}.`,
      rowCount: result.rowCount,
      executionTime: result.executionTime,
    };
  }
  if (executionError) {
    return {
      status: 'failed',
      message: executionError,
    };
  }
  if (artifact.kind === 'block' && !executorWasAvailable) {
    return {
      status: 'not_requested',
      message: 'The host selected the certified block but did not request governed execution.',
    };
  }
  return {
    status: 'not_applicable',
    message: `Selected certified ${artifact.kind.replace('_', ' ')} context.`,
  };
}

function uniqueAssets(assets: AgentEvidenceAsset[]): AgentEvidenceAsset[] {
  const byId = new Map<string, AgentEvidenceAsset>();
  for (const asset of assets) {
    if (!byId.has(asset.nodeId)) byId.set(asset.nodeId, asset);
  }
  return Array.from(byId.values());
}
