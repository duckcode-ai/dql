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
  resolveTrustLabel,
  composeEffectiveTrust,
  type ResolvedTrustLabel,
  type TrustLabelId,
  type DataStateLike,
} from '@duckcodeailabs/dql-core';
import type { KGStore } from './kg/sqlite-fts.js';
import type { KGNode, KGNodeKind, KGSearchHit } from './kg/types.js';
import type { AgentProvider, AgentMessage } from './providers/types.js';
import type { Skill } from './skills/loader.js';
import { buildSkillBlockHints, buildSkillsPrompt, selectRelevantSkills } from './skills/loader.js';
import type { AgentMemory } from './memory/sqlite-memory.js';
import type { LocalContextPack, MetadataAgentIntent, MetadataRouteDecision } from './metadata/catalog.js';
import type { GeneratedDraftBlock } from './metadata/drafts.js';
import { matchSemanticMetric, metricToGovernedSql, resolveGovernedMetricSql, type MetricMatch } from './metadata/metric-match.js';
import { validateSqlAgainstLocalContext } from './metadata/sql-context-validation.js';
import { buildGroundingFromRuntimeRelations, resolveRelationsInSql, validateSqlAgainstGrounding, type SchemaGrounding } from './metadata/sql-grounding.js';
import {
  compactSqlSnippet,
  extractSimpleSelectShape,
  selectExpressionOutputName,
} from './metadata/sql-shape.js';

export type AnswerKind = 'certified' | 'uncertified' | 'no_answer';
export type AnswerSourceTier = 'certified_artifact' | 'business_context' | 'semantic_layer' | 'dbt_manifest' | 'no_answer';

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
export type AnswerCertification = 'certified' | 'ai_generated' | 'analyst_review_required';
export type AnswerReviewStatus = 'none' | 'draft_ready' | 'analyst_review_required' | 'certified';
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
  certification?: AnswerCertification | 'certified' | 'uncertified';
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
    certification?: AnswerCertification | 'certified' | 'uncertified';
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

export interface AgentFollowUpContext {
  kind: 'generic' | 'drilldown';
  sourceBlockName?: string;
  sourceQuestion?: string;
  sourceAnswer?: string;
  filters?: string[];
  dimensions?: string[];
}

export interface AgentEvidence {
  route: AgentEvidenceRouteStep[];
  lineage: AgentEvidenceLineageNode[];
  businessContext: AgentEvidenceContextItem[];
  outcome?: AgentEvidenceOutcome;
  selectedAssets: AgentEvidenceAsset[];
  sourceTables: AgentEvidenceAsset[];
  semanticObjects: AgentEvidenceAsset[];
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
  confidence?: number;
  /** Final answer text (NL summary). */
  text: string;
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
  /** Alias for the structured answer envelope. */
  sql?: string;
  /** Suggested viz type for the proposed SQL (line/bar/single_value/...). */
  suggestedViz?: string;
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
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  validationWarnings?: string[];
  selectedEvidence?: LocalContextPack['evidenceRoles'];
  citations: AgentCitation[];
  /** Relevant local memory supplied as advisory context. */
  memoryContext?: AgentMemory[];
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
  /** Caller-supplied provider; the answer-loop never picks one itself. */
  provider: AgentProvider;
  /** Live KG store. */
  kg: KGStore;
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
  /** Optional advisory memory. Never outranks project metadata. */
  memoryContext?: AgentMemory[];
  /** Optional AbortSignal forwarded to the provider. */
  signal?: AbortSignal;
  /**
   * Governed block executor supplied by the CLI/UI/Slack host. The answer loop
   * keeps retrieval deterministic, while hosts enforce persona/RBAC/RLS in the
   * runtime they already own.
   */
  executeCertifiedBlock?: (block: KGNode) => Promise<AgentResultPayload>;
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
    validationWarnings: string[];
  }) => Promise<GeneratedDraftBlock | undefined> | GeneratedDraftBlock | undefined;
  /** Runtime schema/column context supplied by the host for generated analysis. */
  schemaContext?: AgentSchemaTable[];
  /** Shared local metadata context pack from `.dql/cache/metadata.sqlite`. */
  contextPack?: LocalContextPack;
}

const CERTIFIED_HIT_THRESHOLD = 0.18;
const HARD_NEGATIVE_RATIO = 0.5;
const EXECUTABLE_ARTIFACT_KINDS: KGNodeKind[] = ['block', 'dashboard', 'app', 'notebook'];
const BUSINESS_CONTEXT_KINDS: KGNodeKind[] = ['term', 'business_view'];
const ARTIFACT_KINDS: KGNodeKind[] = [...EXECUTABLE_ARTIFACT_KINDS, ...BUSINESS_CONTEXT_KINDS];
const SEMANTIC_KINDS: KGNodeKind[] = ['metric', 'dimension', 'measure', 'entity', 'semantic_model', 'saved_query'];
const MANIFEST_KINDS: KGNodeKind[] = ['dbt_model', 'dbt_source'];

/**
 * Map an answer-loop result's source tier + certification + review state to a
 * canonical trust-label id from the one shared vocabulary in dql-core.
 * Additive and lenient — keeps the legacy `trustLabel` string untouched.
 */
function canonicalTrustLabelId(result: AgentAnswer): TrustLabelId {
  if (result.kind === 'no_answer') return 'insufficient_context';
  if (result.certification === 'certified' || result.kind === 'certified') return 'certified';
  if (result.sourceTier === 'business_context' && result.reviewStatus === 'certified') return 'reviewed';
  if (
    result.certification === 'ai_generated' ||
    result.certification === 'analyst_review_required' ||
    result.reviewStatus === 'analyst_review_required' ||
    result.reviewStatus === 'draft_ready'
  ) {
    return 'ai_generated';
  }
  return 'insufficient_context';
}

export async function answer(input: AnswerLoopInput): Promise<AgentAnswer> {
  const result = await runAnswerLoop(input);
  // Attach the canonical trust label once, at the single exit point, so every
  // return site inside runAnswerLoop stays untouched and backward compatible.
  // Freshness-aware trust: for a certified answer, fold the source block's data
  // health (stale/failed upstream) into the label so it reads "Certified ·
  // stale data" / "Certified · upstream failed". Non-certified or fresh answers
  // are unaffected.
  const id = canonicalTrustLabelId(result);
  const dataState =
    id === 'certified'
      ? ((result.block as { dataState?: DataStateLike } | undefined)?.dataState)
      : undefined;
  const { _semanticMetricMatch, ...publicResult } = result;
  return {
    ...publicResult,
    trustLabelInfo: composeEffectiveTrust({ id, dataState }),
    // Stamp the SELECTED skills that shaped the answer (transparency). Computed
    // here so every return site inside runAnswerLoop stays untouched.
    appliedSkills:
      result.appliedSkills ??
      selectRelevantSkills(input.skills ?? [], input.question, { userId: input.userId ?? null }).map((s) => ({
        id: s.id,
        description: s.description,
      })),
    // Stamp the chosen route once, at the single exit point, so every return
    // site inside runAnswerLoop stays untouched (spec 17, part C).
    route: result.route ?? deriveAiRoute(result, _semanticMetricMatch),
  };
}

/**
 * Derive the UI-facing route from a finished answer (spec 17, part C). The
 * semantic-metric tier is named explicitly when the loop matched a governed
 * metric; otherwise the route is mapped from the answer's source tier / kind.
 */
function deriveAiRoute(result: AgentAnswer, metricMatch?: MetricMatch): AiRoute {
  if (result.kind === 'no_answer') {
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
  // Uncertified: a governed metric matched → semantic_metric; else generated SQL.
  if (result.sourceTier === 'semantic_layer' && metricMatch) {
    return {
      tier: 'semantic_metric',
      label: `Answered from metric ${metricMatch.metric.name}`,
      ref: metricMatch.metric.name,
    };
  }
  return { tier: 'generated_sql', label: 'Answered with generated SQL (review required).' };
}

async function runAnswerLoop(input: AnswerLoopInput): Promise<AgentAnswer> {
  const { question, userId, domain, provider, kg, skills = [], blockHints = [] } = input;
  // Select the RELEVANT skills (not all) for this question; keep pinned project
  // skills (SQL conventions). Block hints still come from the full set so a
  // preferred-block mapping is never lost.
  const selectedSkills = selectRelevantSkills(skills, question, { userId: userId ?? null });
  const effectiveBlockHints = Array.from(new Set([
    ...blockHints,
    ...buildSkillBlockHints(skills, userId ?? null),
  ]));
  const followUpSourceBlock = input.followUp?.sourceBlockName
    ? kg.getNode(`block:${input.followUp.sourceBlockName}`)
    : null;
  const excludedArtifactIds = input.followUp?.kind === 'drilldown' && followUpSourceBlock
    ? new Set([followUpSourceBlock.nodeId])
    : undefined;

  const executableArtifactHits = kg.search({ query: question, domain, kinds: EXECUTABLE_ARTIFACT_KINDS, limit: 10 });
  const businessHits = kg.search({ query: question, domain, kinds: BUSINESS_CONTEXT_KINDS, limit: 10 });
  const artifactHits = mergeHits(executableArtifactHits, businessHits).slice(0, 12);
  const semanticHits = kg.search({ query: question, domain, kinds: SEMANTIC_KINDS, limit: 12 });
  const manifestHits = kg.search({ query: question, domain, kinds: MANIFEST_KINDS, limit: 12 });
  const considered = mergeHits(
    artifactHits,
    semanticHits,
    manifestHits,
    kg.search({ query: question, domain, limit: 10 }),
  ).slice(0, 30);
  const schemaContext = schemaContextWithAllowedSqlContext(input.schemaContext ?? [], input.contextPack);
  const catalogRoute = input.contextPack?.routeDecision;
  const fallbackIntent = classifyAgentIntent({
    question,
    followUp: input.followUp,
    artifactHits,
    semanticHits,
    manifestHits,
    schemaContext,
  });
  const intent = catalogRoute ? agentIntentFromCatalogRoute(catalogRoute) : fallbackIntent;

  // Stage 1: certified artifact match. Blocks can be executed; dashboards,
  // Apps, and notebooks are returned as governed citations/navigation targets.
  const drilldownCertifiedHit = input.followUp?.kind === 'drilldown'
    ? pickCertifiedDrilldownArtifact({
        executableArtifactHits,
        question,
        followUp: input.followUp,
        excludedArtifactIds,
        kg,
      })
    : null;
  const artifactHit = drilldownCertifiedHit ?? (shouldUseCertifiedRoute(catalogRoute, intent)
    ? certifiedHitFromContextPack(input.contextPack, kg)
      ?? pickCertifiedArtifact({
          artifactHits,
          executableArtifactHits,
          businessHits,
          question,
          blockHints: input.followUp?.kind === 'drilldown' ? [] : effectiveBlockHints,
          excludedArtifactIds,
          kg,
        })
    : null);
  if (artifactHit) {
    let result: AgentResultPayload | undefined;
    let executionError: string | undefined;
    if (artifactHit.node.kind === 'block' && input.executeCertifiedBlock) {
      try {
        result = await input.executeCertifiedBlock(artifactHit.node);
      } catch (err) {
        executionError = err instanceof Error ? err.message : String(err);
      }
    }
    const text = composeCertifiedAnswer(artifactHit.node, question, result, executionError);
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
    return {
      kind: 'certified',
      sourceTier,
      certification: 'certified',
      reviewStatus: 'certified',
      confidence: 0.95,
      text,
      answer: text,
      block: artifactHit.node.kind === 'block' ? artifactHit.node : undefined,
      result,
      executionError,
      sql: result?.sql,
      trustLabel: input.contextPack?.trustLabel ?? 'certified',
      sourceCertifiedBlock: artifactHit.node.kind === 'block' ? artifactHit.node.name : undefined,
      contextPackId: input.contextPack?.id,
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
  const semanticMetricNodes = collectMetricCandidates(semanticHits, considered, kg);
  let semanticMetricMatch = await matchSemanticMetric(question, semanticMetricNodes).catch(() => null);

  // Clarify only when there is ALSO no confident governed-metric match.
  if ((intent === 'clarify' || catalogRoute?.route === 'clarify') && !semanticMetricMatch) {
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
      }),
      contextPack: input.contextPack,
      considered,
      providerUsed: provider.name,
    };
  }

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
  const contextHits = activeTier === 'semantic_layer'
    ? [...matchedMetricHit, ...trustedArtifactContext, ...reviewRequiredArtifactHits, ...businessHits.slice(0, 4), ...semanticHits, ...manifestHits].slice(0, 14)
    : [...trustedArtifactContext, ...reviewRequiredArtifactHits, ...businessHits.slice(0, 4), ...manifestHits].slice(0, 14);
  const contextNodes = mergeNodes(
    followUpSourceBlock && input.followUp?.kind === 'drilldown' ? [followUpSourceBlock] : [],
    (contextHits.length > 0 ? contextHits : considered.slice(0, 6)).map((h) => h.node),
  );
  const contextBlocks = contextNodes.filter((n) => n.kind === 'block');
  const contextBusiness = contextNodes.filter((n) => BUSINESS_CONTEXT_KINDS.includes(n.kind));
  const contextOther = contextNodes.filter((n) => n.kind !== 'block' && !BUSINESS_CONTEXT_KINDS.includes(n.kind));

  const messages: AgentMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  const skillsPrompt = buildSkillsPrompt(selectedSkills, userId ?? null);
  if (skillsPrompt) messages.push({ role: 'system', content: skillsPrompt });

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
      input.contextPack,
    ),
  });
  messages.push({ role: 'user', content: question });

  const localProposal = buildSchemaAwareProposal({
    question,
    intent,
    schemaContext,
    followUp: input.followUp,
    contextPack: input.contextPack,
  }) ?? buildContextPackAwareProposal({
    question,
    intent,
    contextPack: input.contextPack,
  });
  let proposed = '';
  let parsed: ParsedProposal;
  if (localProposal) {
    parsed = localProposal;
  } else {
    try {
      proposed = await provider.generate(messages, { signal: input.signal });
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

    parsed = parseProposal(proposed);
  }
  // True when `parsed.sql` was synthesized deterministically from a governed
  // semantic-layer metric (not the LLM). Such SQL is trusted and grounded against
  // the runtime schema, so it skips the hallucination-guard context validation
  // that exists to catch model-invented relations/columns.
  let governedMetricAnswer = false;
  if (!parsed.sql) {
    // Spec 17, part C — if a governed metric matched confidently but the model
    // declined SQL, answer from the metric definition (deterministic, offline)
    // rather than refusing. The semantic tier is the governed answer here. A
    // derived MetricFlow metric (e.g. `revenue`) often carries no executable
    // definition itself — its `table:`/`sql:` live on the backing measure node
    // (`order_item.revenue`). resolveGovernedMetricSql resolves a thin metric to
    // that synthesizable sibling so the route lands on a real number, not refusal.
    const resolved = activeTier === 'semantic_layer' && semanticMetricMatch
      ? resolveGovernedMetricSql(semanticMetricMatch.metric, semanticMetricNodes)
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
          `Answered from the governed metric ${resolved.metric.name}. This result is uncertified until reviewed and promoted.`,
        viz: parsed.viz ?? 'single_value',
      };
    }
  }
  if (!parsed.sql) {
    const text = parsed.text || 'No answer (the model declined to propose SQL).';
    return {
      kind: 'no_answer',
      sourceTier: 'no_answer',
      certification: 'analyst_review_required',
      reviewStatus: 'none',
      confidence: 0.1,
      text,
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

  // Shared grounding (spec 15): deterministically qualify any bare relation the
  // model emitted to its real warehouse relation from the runtime schema BEFORE
  // governance validation. Same resolver the build path uses — one grounding,
  // no weak path. `allowedSqlContext` relations are already qualified.
  let grounding: SchemaGrounding | undefined;
  if (parsed.sql && schemaContext.length > 0) {
    grounding = buildGroundingFromRuntimeRelations(
      schemaContext.map((table) => ({
        relation: table.relation,
        name: table.name,
        columns: table.columns.map((column) => ({ name: column.name, type: column.type, description: column.description })),
      })),
    );
    parsed.sql = resolveRelationsInSql(parsed.sql, grounding, { prefer: 'qualified' }).sql;
  }

  // Validation gate. Governed metric SQL synthesized from the semantic layer is
  // already trusted (deterministic + grounded); model SQL is validated against the
  // inspected context to catch hallucinated relations/columns.
  const semanticMetricRoute = activeTier === 'semantic_layer' && Boolean(semanticMetricMatch);
  type AnswerValidation = { ok: true; warnings: string[] } | { ok: false; error: string; warnings: string[] };
  let contextValidation: AnswerValidation;
  if (governedMetricAnswer) {
    contextValidation = { ok: true, warnings: [] };
  } else {
    const c = validateSqlAgainstLocalContext(parsed.sql, input.contextPack, {
      question,
      intent,
      filterValues: input.followUp?.filters,
    });
    contextValidation = c.ok
      ? { ok: true, warnings: c.warnings }
      : { ok: false, error: c.error, warnings: c.warnings };
  }

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
    const grounded = grounding ? validateSqlAgainstGrounding(parsed.sql, grounding) : undefined;
    if (grounded?.ok) {
      contextValidation = { ok: true, warnings: grounded.warnings };
    } else {
      const recovered = resolveGovernedMetricSql(semanticMetricMatch.metric, semanticMetricNodes);
      if (recovered) {
        semanticMetricMatch = { ...semanticMetricMatch, metric: recovered.metric };
        parsed.sql = grounding
          ? resolveRelationsInSql(recovered.sql, grounding, { prefer: 'qualified' }).sql
          : recovered.sql;
        parsed.viz = parsed.viz ?? 'single_value';
        parsed.text = parsed.text
          || `Answered from the governed metric ${recovered.metric.name}. This result is uncertified until reviewed and promoted.`;
        governedMetricAnswer = true;
        contextValidation = {
          ok: true,
          warnings: ['Generated SQL failed context validation; answered from the governed metric definition instead.'],
        };
      }
    }
  }
  if (!contextValidation.ok) {
    const text = `I could not safely prepare this generated SQL from the inspected context. ${contextValidation.error}`;
    const analysisPlan = buildAnalysisPlan({
      question,
      intent,
      routeReason: catalogRoute?.reason ?? 'Generated SQL failed metadata context validation before preview execution or draft capture.',
      selectedNodes: contextNodes,
      schemaContext,
      sql: parsed.sql,
      suggestedViz: parsed.viz ?? 'table',
      assumptions: [
        'Generated SQL was rejected before execution because it did not match inspected metadata context.',
        ...contextValidation.warnings,
      ],
    });
    return {
      kind: 'no_answer',
      sourceTier: 'no_answer',
      certification: 'analyst_review_required',
      reviewStatus: 'none',
      confidence: 0.15,
      text,
      answer: text,
      proposedSql: parsed.sql,
      sql: parsed.sql,
      trustLabel: input.contextPack?.trustLabel,
      sourceCertifiedBlock: followUpSourceBlock?.name ?? input.followUp?.sourceBlockName,
      contextPackId: input.contextPack?.id,
      validationWarnings: contextValidation.warnings,
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
      providerUsed: localProposal ? 'schema_planner' : provider.name,
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
  if (input.executeGeneratedSql) {
    try {
      result = await input.executeGeneratedSql(parsed.sql);
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
      if (isRetryableGeneratedSqlError(executionError)) {
        const localRepairSql = repairGeneratedSqlLocally(parsed.sql, executionError, schemaContext);
        if (localRepairSql) {
          repairAttempts = 1;
          parsed.sql = localRepairSql;
          try {
            result = await input.executeGeneratedSql(parsed.sql);
            executionError = undefined;
          } catch (retryErr) {
            executionError = retryErr instanceof Error ? retryErr.message : String(retryErr);
          }
        }
        if (executionError) {
          const repairedRaw = await requestSqlRepair({
            provider,
            baseMessages: messages,
            question,
            parsed,
            executionError,
            schemaContext,
            signal: input.signal,
          });
          const repaired = parseProposal(repairedRaw);
          if (repaired.sql) {
            repairAttempts += 1;
            parsed.text = repaired.text || parsed.text;
            parsed.sql = repaired.sql;
            parsed.viz = repaired.viz ?? parsed.viz;
            try {
              result = await input.executeGeneratedSql(parsed.sql);
              executionError = undefined;
            } catch (retryErr) {
              executionError = retryErr instanceof Error ? retryErr.message : String(retryErr);
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
      ? 'The user asked for a drill-through or follow-up, so DQL generated review-required SQL from the prior context and current metadata.'
      : 'The question asks for a custom analysis, ranking, breakdown, comparison, or grain that should not be answered by a loose certified block match.'),
    selectedNodes: contextNodes,
    schemaContext,
    sql: parsed.sql,
    suggestedViz: parsed.viz ?? 'table',
    assumptions: [
      'Generated SQL is an uncertified preview until an analyst reviews and promotes it.',
      ...(localProposal ? ['A local metadata planner selected a review-required SQL grain before provider generation.'] : []),
      ...contextValidation.warnings,
      ...(executionError ? ['The preview execution error must be reviewed before reuse.'] : []),
    ],
      repairAttempts,
    });
    const validationWarnings = [
      ...(input.contextPack?.warnings ?? []),
      ...contextValidation.warnings,
      ...(executionError ? ['The preview execution error must be reviewed before reuse.'] : []),
    ];
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
          validationWarnings,
        });
      } catch (err) {
        draftCaptureError = err instanceof Error ? err.message : String(err);
        validationWarnings.push(`Draft capture failed: ${draftCaptureError}`);
      }
    }
    const sourceCertifiedBlock = followUpSourceBlock?.name ?? input.followUp?.sourceBlockName;
    const trustExplanation = generatedTrustExplanation({
      followUp: input.followUp,
      sourceCertifiedBlock,
      draftBlock,
    });
    const cleanedSummary = cleanGeneratedSummary(parsed.text);
    const generatedText = trustExplanation
      ? [trustExplanation, cleanedSummary].filter(Boolean).join('\n\n')
      : cleanedSummary;
    return {
      kind: 'uncertified',
      sourceTier: activeTier,
      certification: 'ai_generated',
      reviewStatus: 'draft_ready',
      confidence: activeTier === 'semantic_layer' ? 0.72 : 0.55,
      text: generatedText,
      answer: generatedText,
      proposedSql: parsed.sql,
      sql: parsed.sql,
      result,
      executionError,
      suggestedViz: parsed.viz ?? 'table',
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
      intent,
      contextNodes,
      schemaContext,
      followUp: input.followUp,
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
    }),
    contextPack: input.contextPack,
    considered,
    providerUsed: localProposal ? 'schema_planner' : provider.name,
    // Carry the governed metric match so the exit point can name a
    // `semantic_metric` route (spec 17, part C).
    _semanticMetricMatch: activeTier === 'semantic_layer' ? semanticMetricMatch ?? undefined : undefined,
  };
}

const SYSTEM_PROMPT = `You are the DQL Analytics Agent.

Rules:
1. First classify the question: exact saved artifact/direct KPI, entity-specific
   lookup, ad hoc ranking/breakdown/comparison/custom grain, drill-through
   follow-up, or insufficient context.
2. Use certified DQL blocks only when the user's question exactly asks for that
   saved block, direct KPI, or definition. For single-user/customer/account,
   custom filters, rankings, breakdowns, comparisons, drill-throughs, or custom
   grains, generate review-required SQL from supplied metadata and cite
   certified context as evidence.
3. If you must generate SQL, return it inside a single \`\`\`sql code block.
4. Provide a one-paragraph natural-language summary BEFORE the SQL block.
5. Suggest a visualization type from this list, on a line starting with "Viz:":
   line, bar, area, pie, single_value, table, pivot, kpi.
6. NEVER fabricate column names that are not present in the supplied schema,
   dbt metadata, or certified source SQL shape context. If a requested filter
   value is supplied as a matched value, prefer the table and column that
   matched that value.
7. Return one read-only SELECT or WITH query for the local warehouse/runtime.
   Do NOT use dbt/Jinja macros such as {{ ref(...) }} or {{ source(...) }} in
   proposed SQL. Do not emit INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, COPY,
   PRAGMA, SET, or multiple statements.
8. If the schema is insufficient to answer, say so explicitly and ask a
   clarifying question instead of guessing.
9. Write directly to the analyst. Do not say "the user is asking", "the user
   requested", "I will generate", or describe internal routing. State the
   answer, the certified context used, and the review requirement.
10. For notebook research, SQL build or repair, DQL import/build, or DQL reuse
   checks, start with one line in this form: "Outcome: <decision>". Use one of
   these decisions: Reuse certified block, Use existing draft, Generate SQL
   cell, Fix SQL, Create DQL draft, Needs review, Cannot answer yet.`;

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
): string {
  const intentSection = `## Routing intent\n\nintent: ${intent}\n${intent === 'exact_certified_lookup'
    ? 'Use a certified artifact only if it exactly answers the question.'
    : 'Generate review-required SQL for this question. Certified blocks are trusted context, not a reason to answer the wrong grain.'}`;
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
  const schemaSection = schemaContext.length > 0
    ? `\n\n## Runtime schema context\n\nUse only these runtime relations and columns when generating SQL unless the dbt manifest context gives an equivalent relation.\n${schemaContext
        .slice(0, 12)
        .map((table) => {
          const cols = table.columns
            .slice(0, 50)
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
  const extraSection = extraContext?.trim()
    ? `\n\n## Current notebook/app context\n\nThis context may help interpret the user's request, but it MUST NOT override certified artifacts, semantic metrics, dbt metadata, or generated SQL validation.\n\n${extraContext.trim()}`
    : '';
  const followUpSection = followUp
    ? `\n\n## Follow-up routing context\n\n${renderFollowUpContext(followUp)}`
    : '';
  const contextPackSection = contextPack
    ? `\n\n## Local metadata context pack\n\n${renderContextPackForPrompt(contextPack)}`
    : '';
  return `${intentSection}\n\n${blockSection}${businessSection}${otherSection}${schemaSection}${contextPackSection}${memorySection}${extraSection}${followUpSection}`;
}

function renderContextPackForPrompt(contextPack: LocalContextPack): string {
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
  const warnings = contextPack.warnings.length
    ? `Warnings:\n${contextPack.warnings.slice(0, 8).map((warning) => `- ${warning}`).join('\n')}\n`
    : '';
  const objects = contextPack.objects.slice(0, 18).map((object) => {
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
    ? `\nRoute decision: ${contextPack.routeDecision.route} / ${contextPack.routeDecision.intent}\nReason: ${contextPack.routeDecision.reason}${certifiedApplicability}\nMissing context: ${contextPack.routeDecision.missingContext.map((item) => item.message).join(' ') || 'none'}`
    : '';
  const allowed = renderAllowedSqlRelationsForPrompt(contextPack);
  const joins = renderCandidateJoinsForPrompt(contextPack);
  const relationDiagnostics = contextPack.retrievalDiagnostics?.selectedRelations?.length
    ? `\nSelected relation reasoning:\n${contextPack.retrievalDiagnostics.selectedRelations.slice(0, 8).map((relation) => `- ${relation.relation} (score ${relation.score.toFixed(1)}): ${relation.reason}`).join('\n')}`
    : '';
  const sourceSql = renderSourceBlockSqlContext(contextPack);
  return [
    `context_pack_id: ${contextPack.id}`,
    `trust_label: ${contextPack.trustLabel}`,
    questionPlan.trim(),
    route.trim(),
    warnings.trim(),
    `Selected evidence:\n${objects || '- none'}`,
    allowed.trim(),
    joins.trim(),
    relationDiagnostics.trim(),
    sourceSql.trim(),
    conflicts.trim(),
  ].filter(Boolean).join('\n');
}

function renderCandidateJoinsForPrompt(contextPack: LocalContextPack): string {
  const joins = contextPack.retrievalDiagnostics.selectedJoinPaths?.length
    ? contextPack.retrievalDiagnostics.selectedJoinPaths.slice(0, 8).map((join) => ({
        leftRelation: join.leftRelation,
        leftColumn: join.leftColumn,
        rightRelation: join.rightRelation,
        rightColumn: join.rightColumn,
        reason: join.reason,
      }))
    : buildCandidateJoinPaths(schemaContextWithAllowedSqlContext([], contextPack)).slice(0, 8);
  if (joins.length === 0) return '';
  return [
    'Suggested join paths from selected metadata:',
    ...joins.map((join) =>
      `- ${join.leftRelation}.${join.leftColumn} -> ${join.rightRelation}.${join.rightColumn}${join.reason ? ` (${join.reason})` : ''}`
    ),
  ].join('\n');
}

function renderAllowedSqlRelationsForPrompt(contextPack: LocalContextPack): string {
  const relations = contextPack.allowedSqlContext?.relations ?? [];
  if (relations.length === 0) return '';
  const selectedLookup = selectedRelationLookup(contextPack);
  const cards = relations.slice(0, 12).map((relation, index) => {
    const selection = relationSelectionFor(relation.relation, selectedLookup);
    const rank = selection?.rank ?? index + 1;
    const score = typeof selection?.score === 'number' ? `, score ${selection.score.toFixed(1)}` : '';
    const reason = selection?.reason ? `\n  why selected: ${selection.reason}` : '';
    const columns = relation.columns.length
      ? relation.columns.slice(0, 32).map(formatRelationColumnForPrompt).join(', ')
      : '(columns unavailable; use certified source SQL shape or inspect metadata before inventing columns)';
    return [
      `- [rank ${rank}${score}] ${relation.relation} (${relation.source})`,
      reason,
      `\n  columns: ${columns}`,
    ].join('');
  });
  return [
    'Selected SQL relation context:',
    'Use these ranked relations and columns as the primary SQL-generation boundary. Prefer lower rank when multiple relations look plausible.',
    ...cards,
  ].join('\n');
}

function formatRelationColumnForPrompt(column: AgentSchemaColumn): string {
  const type = column.type ? ` ${column.type}` : '';
  const description = column.description ? ` - ${column.description.replace(/\s+/g, ' ').trim()}` : '';
  const samples = column.sampleValues?.length
    ? `; matched values: ${column.sampleValues.slice(0, 4).map(formatPromptValue).join(', ')}`
    : '';
  return `${column.name}${type}${description}${samples}`;
}

function renderSourceBlockSqlContext(contextPack: LocalContextPack): string {
  const sources = contextPack.allowedSqlContext?.sourceBlockSql ?? [];
  if (sources.length === 0) return '';
  const lines = sources.slice(0, 5).map((source) => {
    const shape = extractSimpleSelectShape(source.sql);
    const projectedColumns = shape
      ? shape.selectExpressions
          .map(selectExpressionOutputName)
          .filter((value): value is string => Boolean(value))
          .slice(0, 24)
          .join(', ')
      : '';
    const snippet = compactSqlSnippet(source.sql, 280);
    return [
      `- ${source.name}${source.status ? ` (${source.status})` : ''}`,
      shape?.relation ? `  relation: ${shape.relation}` : '',
      projectedColumns ? `  projected columns: ${projectedColumns}` : '',
      snippet ? `  sql: ${snippet}` : '',
    ].filter(Boolean).join('\n');
  });
  return `Certified source SQL shape context:\n${lines.join('\n')}`;
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

function composeCatalogClarificationText(question: string, route: MetadataRouteDecision | undefined): string | undefined {
  if (!route?.missingContext.length) return undefined;
  const missing = route.missingContext.map((item) => item.message).join(' ');
  const followUp = route.followUps[0] ? ` ${route.followUps[0]}?` : '';
  return `I need one more detail before querying "${question}". ${missing}${followUp}`;
}

function sourceTierFromContextPack(contextPack: LocalContextPack | undefined): AnswerSourceTier | undefined {
  if (!contextPack) return undefined;
  if (contextPack.objects.some((object) => object.objectType === 'semantic_metric')) return 'semantic_layer';
  if (contextPack.objects.some((object) => object.objectType.startsWith('dbt_') || object.objectType === 'warehouse_table' || object.objectType === 'runtime_table')) return 'dbt_manifest';
  if (contextPack.objects.some((object) => object.objectType === 'dql_term' || object.objectType === 'business_view')) return 'business_context';
  if (contextPack.objects.some((object) => object.objectType === 'dql_block')) return 'certified_artifact';
  return undefined;
}

function isGeneratedAgentIntent(intent: AgentIntent): boolean {
  return intent === 'ad_hoc_analysis'
    || intent === 'drillthrough'
    || intent === 'ad_hoc_ranking'
    || intent === 'driver_breakdown'
    || intent === 'diagnose_change'
    || intent === 'segment_compare'
    || intent === 'entity_drilldown'
    || intent === 'anomaly_investigation';
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
  ].filter(Boolean);
  const rule = followUp.kind === 'drilldown'
    ? 'routing rule: find a distinct certified drilldown block first; if none exists, generate review-required SQL as a draft drilldown. Do not silently re-run the source block unless it explicitly supports the requested filter or dimension.'
    : 'routing rule: reuse the prior certified block when the user asks a generic follow-up.';
  return [...parts, rule].join('\n');
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
    ? ` The draft was saved at \`${input.draftBlock.path}\` for review.`
    : ' The generated SQL still needs analyst review before certification.';
  return `This is an uncertified drilldown.${source} then generated new SQL${grain}.${draft}`;
}

function cleanGeneratedSummary(text: string): string {
  return text
    .trim()
    .replace(/^(?:the user (?:is asking|asked|wants|requested)[^.]*\.\s*)+/i, '')
    .replace(/\s*(?:therefore,\s*)?i will generate review-required sql[^.]*\.\s*/gi, ' ')
    .replace(/\s*(?:therefore,\s*)?i will generate[^.]*\.\s*/gi, ' ')
    .trim();
}

interface ParsedProposal {
  text: string;
  sql?: string;
  viz?: string;
}

/**
 * Public for tests. Pulls the first ```sql block and an optional Viz: line
 * out of an LLM response.
 */
export function parseProposal(raw: string): ParsedProposal {
  const sqlMatch = raw.match(/```sql\s*([\s\S]*?)```/i);
  const sql = sqlMatch ? sqlMatch[1].trim() : undefined;
  const vizMatch = raw.match(/^Viz:\s*([a-z_]+)/im);
  const viz = vizMatch ? vizMatch[1].trim().toLowerCase() : undefined;
  // Strip the SQL block + Viz line from the prose to keep the summary clean.
  const text = raw
    .replace(/```sql[\s\S]*?```/gi, '')
    .replace(/^Viz:.*$/gim, '')
    .trim();
  return { text, sql, viz };
}

function buildSchemaAwareProposal(input: {
  question: string;
  intent: AgentIntent;
  schemaContext: AgentSchemaTable[];
  followUp?: AgentFollowUpContext;
  contextPack?: LocalContextPack;
}): ParsedProposal | undefined {
  if (!isGeneratedAgentIntent(input.intent)) return undefined;
  const schemaContext = schemaContextWithAllowedSqlContext(input.schemaContext, input.contextPack);
  const drilldownProposal = buildMatchedEntityDrilldownProposal({ ...input, schemaContext });
  if (drilldownProposal) return drilldownProposal;
  const profileProposal = buildEntityProfileProposal({ ...input, schemaContext });
  if (profileProposal) return profileProposal;
  if (isFilteredEntityQuestion(input.question)) return undefined;
  const lower = input.question.toLowerCase();
  const asksForCustomerPerformance = /\bcustomers?\b/.test(lower)
    && /\border|orders|spend|revenue|perform|performed|better|top|best|rank|ranking|bottom|least|fewest|lowest|less|worst|underperform/.test(lower)
    && !/\b(order details|specific orders|each order|all orders|order line|line item)\b/.test(lower);
  if (asksForCustomerPerformance) {
    const direction = customerRankingDirectionFromText(input.question);
    const orderDirection = direction === 'bottom' ? 'ASC' : 'DESC';
    const orderFocused = /\border|orders|order count|ordered\b/.test(lower)
      && !/\b(spend|revenue|sales|amount|lifetime spend|value)\b/.test(lower);
    const customers = findSchemaTable(schemaContext, ['customers', 'customer']);
    if (customers) {
      const customerName = findSchemaColumn(customers, ['customer_name', 'name', 'full_name']);
      const orderCount = findSchemaColumn(customers, ['count_lifetime_orders', 'lifetime_orders', 'order_count', 'orders_count', 'orders']);
      const spend = findSchemaColumn(customers, ['lifetime_spend', 'total_lifetime_spend', 'customer_lifetime_value', 'total_revenue', 'revenue']);
      if (customerName && orderCount && spend) {
        const primarySort = orderFocused ? orderCount : spend;
        const secondarySort = orderFocused ? spend : orderCount;
        const rankingLabel = direction === 'bottom'
          ? orderFocused ? 'Customers with the fewest orders' : 'Lowest performing customers'
          : orderFocused ? 'Top customers by order count' : 'Top performing customers';
        return {
          text: `${rankingLabel}, with ${businessMeasurePhrase(orderCount)} and ${businessMeasurePhrase(spend)} for context. This is AI-generated and needs analyst review before certification.`,
          sql: [
            'SELECT',
            `  ${sqlIdentifier(customerName)} AS customer_name,`,
            `  ${sqlIdentifier(orderCount)} AS orders,`,
            `  ROUND(${sqlIdentifier(spend)}, 2) AS lifetime_spend`,
            `FROM ${sqlRelation(customers.relation)}`,
            `ORDER BY ${sqlIdentifier(primarySort)} ${orderDirection}, ${sqlIdentifier(secondarySort)} ${orderDirection}`,
            'LIMIT 10',
          ].join('\n'),
          viz: 'table',
        };
      }

      const customerId = findSchemaColumn(customers, ['customer_id', 'id']);
      const orders = findSchemaTable(schemaContext, ['orders', 'order']);
      const orderCustomerId = orders ? findSchemaColumn(orders, ['customer_id', 'customer']) : undefined;
      const orderTotal = orders ? findSchemaColumn(orders, ['order_total', 'total_order_amount', 'total_amount', 'amount', 'subtotal']) : undefined;
      const orderId = orders ? findSchemaColumn(orders, ['order_id', 'id']) : undefined;
      if (orders && customerName && customerId && orderCustomerId && orderTotal) {
        const countExpression = orderId ? `COUNT(DISTINCT o.${sqlIdentifier(orderId)})` : 'COUNT(*)';
        const primarySort = orderFocused ? 'orders' : 'lifetime_spend';
        const secondarySort = orderFocused ? 'lifetime_spend' : 'orders';
        const rankingLabel = direction === 'bottom'
          ? orderFocused ? 'Customers with the fewest orders' : 'Lowest performing customers'
          : orderFocused ? 'Top customers by order count' : 'Top performing customers';
        return {
          text: `${rankingLabel} from order totals, with order count for context. This is AI-generated and needs analyst review before certification.`,
          sql: [
            'SELECT',
            `  c.${sqlIdentifier(customerName)} AS customer_name,`,
            `  ${countExpression} AS orders,`,
            `  ROUND(SUM(o.${sqlIdentifier(orderTotal)}), 2) AS lifetime_spend`,
            `FROM ${sqlRelation(orders.relation)} AS o`,
            `JOIN ${sqlRelation(customers.relation)} AS c ON o.${sqlIdentifier(orderCustomerId)} = c.${sqlIdentifier(customerId)}`,
            `GROUP BY c.${sqlIdentifier(customerName)}`,
            `ORDER BY ${sqlIdentifier(primarySort)} ${orderDirection}, ${sqlIdentifier(secondarySort)} ${orderDirection}`,
            'LIMIT 10',
          ].join('\n'),
          viz: 'table',
        };
      }
    }
  }

  const genericJoinProposal = buildGenericJoinProposal({ ...input, schemaContext });
  if (genericJoinProposal) return genericJoinProposal;
  const genericProposal = buildGenericSingleTableProposal({ ...input, schemaContext });
  if (genericProposal) return genericProposal;
  return undefined;
}

function customerRankingDirectionFromText(text: string): RankingDirection {
  const lower = text.toLowerCase();
  if (/\b(less|lesser)\s+(?:order|orders|ordering)\b/.test(lower) || /\borders?\s+(?:less|least|fewest|lowest)\b/.test(lower)) {
    return 'bottom';
  }
  return rankingDirectionFromText(text) ?? 'top';
}

function buildGenericJoinProposal(input: {
  question: string;
  intent: AgentIntent;
  schemaContext: AgentSchemaTable[];
  followUp?: AgentFollowUpContext;
  contextPack?: LocalContextPack;
}): ParsedProposal | undefined {
  const planMode = input.contextPack?.questionPlan?.mode;
  if (planMode === 'entity_profile' || planMode === 'diagnose_change' || planMode === 'anomaly' || planMode === 'trust_review') {
    return undefined;
  }
  const lower = input.question.toLowerCase();
  if (/\b(why|root cause|diagnos|changed?|drop|decline|increase|decrease|repair|fix|bad|details?|detail rows?|line items?|raw rows?)\b/i.test(lower)) {
    return undefined;
  }
  if (!/\b(by\s+[a-z]|per\s+[a-z]|for each|group(?:ed)? by|split|segment|break\s*down|breakdown|compare)\b/i.test(lower)) {
    return undefined;
  }

  const candidate = pickGenericJoinCandidate(input.schemaContext, input.question);
  if (!candidate) return undefined;

  const direction = rankingDirectionFromText(input.question);
  const orderDirection = direction === 'bottom' ? 'ASC' : 'DESC';
  const limit = /\b(all|complete|full)\b/i.test(input.question) ? 50 : 10;
  const chart = isTimeLikeGenericColumn(candidate.dimensionColumn) ? 'line' : 'bar';
  const metricExpression = qualifiedMetricExpression(candidate.metric, 'f');
  const metricAlias = candidate.metric.alias;
  const dimensionAlias = candidate.dimensionColumn;

  return {
    text: `Prepared a review-required ${businessMeasurePhrase(candidate.metric.column)} breakdown by ${humanizeIdentifier(candidate.dimensionColumn)} by joining ${candidate.metricTable.relation} to ${candidate.dimensionTable.relation}. This result is uncertified until reviewed and promoted.`,
    sql: [
      'SELECT',
      `  d.${sqlIdentifier(candidate.dimensionColumn)} AS ${sqlIdentifier(dimensionAlias)},`,
      `  ${metricExpression} AS ${sqlIdentifier(metricAlias)}`,
      `FROM ${sqlRelation(candidate.metricTable.relation)} AS f`,
      `JOIN ${sqlRelation(candidate.dimensionTable.relation)} AS d ON f.${sqlIdentifier(candidate.metricJoinColumn)} = d.${sqlIdentifier(candidate.dimensionJoinColumn)}`,
      `GROUP BY d.${sqlIdentifier(candidate.dimensionColumn)}`,
      `ORDER BY ${sqlIdentifier(metricAlias)} ${orderDirection}`,
      `LIMIT ${limit}`,
    ].join('\n'),
    viz: chart,
  };
}

function buildGenericSingleTableProposal(input: {
  question: string;
  intent: AgentIntent;
  schemaContext: AgentSchemaTable[];
  followUp?: AgentFollowUpContext;
  contextPack?: LocalContextPack;
}): ParsedProposal | undefined {
  const planMode = input.contextPack?.questionPlan?.mode;
  if (planMode === 'entity_profile' || planMode === 'diagnose_change' || planMode === 'anomaly' || planMode === 'trust_review') {
    return undefined;
  }
  const lower = input.question.toLowerCase();
  if (/\b(why|root cause|diagnos|changed?|drop|decline|increase|decrease|repair|fix|bad|details?|detail rows?|line items?|raw rows?)\b/i.test(lower)) {
    return undefined;
  }
  if (!/\b(show|list|top|bottom|best|worst|highest|lowest|least|fewest|rank|ranking|compare|trend|by\s+[a-z]|how many|number of|revenue|sales|orders?|points?|score|count|total|average|avg|sum)\b/i.test(lower)) {
    return undefined;
  }
  const table = pickGenericAnalysisTable(input.schemaContext, input.question);
  if (!table) return undefined;
  const metric = inferGenericMetric(table, input.question);
  if (!metric) return undefined;
  const dimensions = augmentGenericRankingDimensions(
    table,
    inferGenericDimensions(table, input.question, metric.column),
    metric,
    input.question,
  ).slice(0, 2);
  const direction = rankingDirectionFromText(input.question);
  const limit = /\b(all|complete|full)\b/i.test(input.question) ? 50 : 10;
  const metricAlias = metric.alias;

  if (dimensions.length === 0) {
    return {
      text: `Prepared a review-required ${businessMeasurePhrase(metric.column)} summary from ${table.relation}. This result is uncertified until reviewed and promoted.`,
      sql: [
        'SELECT',
        `  ${metric.expression} AS ${sqlIdentifier(metricAlias)}`,
        `FROM ${sqlRelation(table.relation)}`,
      ].join('\n'),
      viz: 'single_value',
    };
  }

  if (direction && metric.preAggregated) {
    return {
      text: `Prepared a review-required ${businessMeasurePhrase(metric.column)} ranking by ${dimensions.map(humanizeIdentifier).join(' and ')} from ${table.relation}. This result is uncertified until reviewed and promoted.`,
      sql: [
        'SELECT',
        ...dimensions.map((dimension) => `  ${sqlIdentifier(dimension)} AS ${sqlIdentifier(dimension)},`),
        `  ${sqlIdentifier(metric.column)} AS ${sqlIdentifier(metric.column)}`,
        `FROM ${sqlRelation(table.relation)}`,
        `ORDER BY ${sqlIdentifier(metric.column)} ${direction === 'bottom' ? 'ASC' : 'DESC'}`,
        `LIMIT ${limit}`,
      ].join('\n'),
      viz: 'table',
    };
  }

  const selectDimensions = dimensions.map((dimension) => `  ${sqlIdentifier(dimension)} AS ${sqlIdentifier(dimension)},`);
  const groupBy = dimensions.map(sqlIdentifier).join(', ');
  const orderDirection = direction === 'bottom' ? 'ASC' : 'DESC';
  const chart = dimensions.some(isTimeLikeGenericColumn) ? 'line' : 'bar';
  return {
    text: `Prepared a review-required ${businessMeasurePhrase(metric.column)} breakdown by ${dimensions.map(humanizeIdentifier).join(' and ')} from ${table.relation}. This result is uncertified until reviewed and promoted.`,
    sql: [
      'SELECT',
      ...selectDimensions,
      `  ${metric.expression} AS ${sqlIdentifier(metricAlias)}`,
      `FROM ${sqlRelation(table.relation)}`,
      `GROUP BY ${groupBy}`,
      `ORDER BY ${sqlIdentifier(metricAlias)} ${orderDirection}`,
      `LIMIT ${limit}`,
    ].join('\n'),
    viz: chart,
  };
}

interface GenericMetricSelection {
  column: string;
  expression: string;
  alias: string;
  score: number;
  preAggregated: boolean;
}

function pickGenericAnalysisTable(
  schemaContext: AgentSchemaTable[],
  question: string,
): AgentSchemaTable | undefined {
  return schemaContext
    .filter((table) => table.columns.length > 0)
    .map((table, index) => ({
      table,
      metric: inferGenericMetric(table, question),
      dimensions: inferGenericDimensions(table, question),
      index,
    }))
    .filter((candidate) => candidate.metric)
    .sort((a, b) =>
      genericTableScore(b.table, question, b.metric, b.dimensions) -
      genericTableScore(a.table, question, a.metric, a.dimensions) ||
      a.index - b.index
    )[0]?.table;
}

function genericTableScore(
  table: AgentSchemaTable,
  question: string,
  metric: GenericMetricSelection | undefined,
  dimensions: string[],
): number {
  const questionTokens = meaningfulTokens(question);
  const tableTokens = meaningfulTokens([table.relation, table.name, table.description ?? ''].join(' '));
  const columnTokens = meaningfulTokens(table.columns.map((column) => column.name).join(' '));
  const overlap = [...questionTokens].filter((token) => tableTokens.has(token) || columnTokens.has(token)).length;
  const selectedRelationBoost = table.selectionRank
    ? Math.max(0, 56 - table.selectionRank * 3) + Math.min(table.selectionScore ?? 0, 24)
    : 0;
  return selectedRelationBoost + overlap * 8 + (metric?.score ?? 0) + dimensions.length * 8 + Math.min(table.columns.length, 20) * 0.3;
}

interface GenericJoinCandidate {
  metricTable: AgentSchemaTable;
  dimensionTable: AgentSchemaTable;
  metric: GenericMetricSelection;
  dimensionColumn: string;
  metricJoinColumn: string;
  dimensionJoinColumn: string;
  score: number;
}

function pickGenericJoinCandidate(
  schemaContext: AgentSchemaTable[],
  question: string,
): GenericJoinCandidate | undefined {
  const requestedDimensions = requestedDimensionPhrases(question);
  if (requestedDimensions.length === 0) return undefined;
  const metricCandidates = schemaContext
    .filter((table) => table.columns.length > 0)
    .map((table, index) => ({
      table,
      metric: inferGenericMetric(table, question),
      localDimensions: inferGenericDimensions(table, question),
      index,
    }))
    .filter((candidate): candidate is {
      table: AgentSchemaTable;
      metric: GenericMetricSelection;
      localDimensions: string[];
      index: number;
    } => Boolean(candidate.metric))
    .filter((candidate) =>
      !candidate.localDimensions.some((dimension) =>
        !isJoinKeyColumn(dimension) && requestedDimensionMatchesColumn(requestedDimensions, dimension)
      )
    );

  const candidates: GenericJoinCandidate[] = [];
  for (const metricCandidate of metricCandidates) {
    for (const dimensionTable of schemaContext) {
      if (normalizeRelationKey(dimensionTable.relation) === normalizeRelationKey(metricCandidate.table.relation)) continue;
      const dimensionColumn = pickRequestedDimensionColumn(dimensionTable, question, requestedDimensions);
      if (!dimensionColumn || namesEqualLoose(dimensionColumn, metricCandidate.metric.column)) continue;
      const join = pickJoinColumns(metricCandidate.table, dimensionTable);
      if (!join) continue;
      const dimensionScore = genericDimensionScore(
        { name: dimensionColumn, type: findColumnType(dimensionTable, dimensionColumn) },
        question,
        Math.max(0, dimensionTable.columns.findIndex((column) => namesEqualLoose(column.name, dimensionColumn))),
        metricCandidate.metric.column,
      );
      candidates.push({
        metricTable: metricCandidate.table,
        dimensionTable,
        metric: metricCandidate.metric,
        dimensionColumn,
        metricJoinColumn: join.leftColumn,
        dimensionJoinColumn: join.rightColumn,
        score:
          genericTableScore(metricCandidate.table, question, metricCandidate.metric, metricCandidate.localDimensions) +
          dimensionScore +
          join.score +
          selectedRelationWeight(dimensionTable),
      });
    }
  }

  return candidates
    .sort((a, b) =>
      b.score - a.score ||
      (a.metricTable.selectionRank ?? Number.MAX_SAFE_INTEGER) - (b.metricTable.selectionRank ?? Number.MAX_SAFE_INTEGER) ||
      a.metricTable.relation.localeCompare(b.metricTable.relation)
    )[0];
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

function requestedDimensionPhrases(question: string): string[] {
  const lower = question.toLowerCase();
  const phrases = [
    ...Array.from(lower.matchAll(/\bby\s+([a-z][a-z0-9_ -]{1,50})/g)).map((match) => match[1] ?? ''),
    ...Array.from(lower.matchAll(/\bper\s+([a-z][a-z0-9_ -]{1,50})/g)).map((match) => match[1] ?? ''),
    ...Array.from(lower.matchAll(/\bfor each\s+([a-z][a-z0-9_ -]{1,50})/g)).map((match) => match[1] ?? ''),
  ];
  return uniqueDrilldownStrings(phrases
    .flatMap((phrase) => phrase.split(/\band\b|,|\//i))
    .map((phrase) => phrase
      .replace(/\b(desc|asc|top|bottom|highest|lowest|least|most|over time|where|for|with|from|in|during|last|this|next)\b.*$/gi, '')
      .replace(/[^a-z0-9_ -]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter((phrase) => phrase.length > 0));
}

function pickRequestedDimensionColumn(
  table: AgentSchemaTable,
  question: string,
  requestedDimensions: string[],
): string | undefined {
  for (const phrase of requestedDimensions) {
    const direct = findSchemaColumn(table, dimensionColumnCandidatesForPhrase(phrase));
    if (direct && !isJoinKeyColumn(direct) && !isNumericLikeColumn({ name: direct, type: findColumnType(table, direct) })) {
      return direct;
    }
  }
  const inferred = inferGenericDimensions(table, question)
    .find((dimension) => !isJoinKeyColumn(dimension) && requestedDimensionMatchesColumn(requestedDimensions, dimension));
  return inferred;
}

function dimensionColumnCandidatesForPhrase(phrase: string): string[] {
  const tokens = (phrase.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .flatMap((token) => token.split('_'))
    .map(normalizeToken)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return [];
  const joined = tokens.join('_');
  const tail = tokens.slice(1).join('_');
  return uniqueDrilldownStrings([
    joined,
    phrase.replace(/\s+/g, '_').toLowerCase(),
    tail,
    tokens.at(-1) ?? '',
    ...tokens,
  ].filter(Boolean));
}

function requestedDimensionMatchesColumn(requestedDimensions: string[], column: string): boolean {
  const columnTokens = exactMatchTokens(column);
  return requestedDimensions.some((phrase) => {
    const phraseTokens = (phrase.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
      .flatMap((token) => token.split('_'))
      .map(normalizeToken)
      .filter((token) => token.length > 0);
    return phraseTokens.some((token) => columnTokens.has(token));
  });
}

function selectedRelationWeight(table: AgentSchemaTable): number {
  return table.selectionRank
    ? Math.max(0, 30 - table.selectionRank * 2) + Math.min(table.selectionScore ?? 0, 16)
    : 0;
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

function findColumnType(table: AgentSchemaTable, columnName: string): string | undefined {
  return table.columns.find((column) => namesEqualLoose(column.name, columnName))?.type;
}

function qualifiedMetricExpression(metric: GenericMetricSelection, tableAlias: string): string {
  const column = `${tableAlias}.${sqlIdentifier(metric.column)}`;
  if (metric.column === 'rows') return 'COUNT(*)';
  if (/^COUNT\s*\(\s*DISTINCT\b/i.test(metric.expression)) return `COUNT(DISTINCT ${column})`;
  if (metric.preAggregated) return column;
  const aggregate = metric.expression.match(/^(SUM|AVG|MIN|MAX|MEDIAN)\s*\(/i)?.[1]?.toUpperCase()
    ?? (/avg|average|mean/i.test(metric.alias) ? 'AVG' : 'SUM');
  return `${aggregate}(${column})`;
}

function inferGenericMetric(table: AgentSchemaTable, question: string): GenericMetricSelection | undefined {
  const lower = question.toLowerCase();
  const wantsCount = /\b(count|how many|number of|volume)\b/i.test(lower);
  const candidates = table.columns
    .map((column) => {
      const name = column.name.toLowerCase();
      const tokens = meaningfulTokens(column.name);
      let score = isNumericLikeColumn(column) ? 20 : 0;
      for (const token of meaningfulTokens(question)) {
        if (tokens.has(token)) score += 18;
      }
      if (/\b(revenue|sales|amount|total|spend|cost|margin|profit|value|points?|score|orders?|count|quantity|duration|minutes?|rate|average|avg)\b/i.test(name.replace(/_/g, ' '))) {
        score += 18;
      }
      if (/\b(id|key|code|zip|postal|phone|season|year|month|week|day|date|time)\b/i.test(name.replace(/_/g, ' '))) {
        score -= 14;
      }
      return { column: column.name, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const countSubject = wantsCount ? inferCountSubject(question) : undefined;
  if (wantsCount) {
    const precomputed = candidates.find((candidate) => isPrecomputedCountMetric(candidate.column, countSubject));
    if (precomputed) {
      return {
        column: precomputed.column,
        expression: isPreAggregatedMetricColumn(precomputed.column) ? sqlIdentifier(precomputed.column) : `SUM(${sqlIdentifier(precomputed.column)})`,
        alias: isPreAggregatedMetricColumn(precomputed.column) ? precomputed.column : `${precomputed.column}_sum`,
        score: precomputed.score + 8,
        preAggregated: isPreAggregatedMetricColumn(precomputed.column),
      };
    }
    const distinctColumn = countSubject ? findDistinctCountColumn(table, countSubject) : undefined;
    if (distinctColumn) {
      return {
        column: distinctColumn,
        expression: `COUNT(DISTINCT ${sqlIdentifier(distinctColumn)})`,
        alias: `${countSubject}_count`,
        score: 34,
        preAggregated: false,
      };
    }
  }

  const selected = candidates[0];
  if (!selected && !wantsCount) return undefined;
  if (!selected || wantsCount && selected.score < 26) {
    return {
      column: 'rows',
      expression: 'COUNT(*)',
      alias: 'row_count',
      score: 18,
      preAggregated: true,
    };
  }
  const aggregate = /\b(avg|average|mean)\b/i.test(lower) ? 'AVG' : 'SUM';
  const aliasBase = `${selected.column}_${aggregate.toLowerCase()}`;
  const preAggregated = isPreAggregatedMetricColumn(selected.column);
  return {
    column: selected.column,
    expression: preAggregated ? sqlIdentifier(selected.column) : `${aggregate}(${sqlIdentifier(selected.column)})`,
    alias: preAggregated ? selected.column : aliasBase,
    score: selected.score,
    preAggregated,
  };
}

function inferCountSubject(question: string): string | undefined {
  const lower = question.toLowerCase();
  const match = lower.match(/\b(?:how many|number of|count of|count|total)\s+(?:distinct\s+|unique\s+)?([a-z][a-z0-9_-]*)/);
  const raw = match?.[1] ?? lower.match(/\b(customers?|accounts?|users?|members?|orders?|products?|players?|teams?|transactions?|sessions?|events?|records?|rows?)\b/)?.[1];
  if (!raw) return undefined;
  const normalized = normalizeToken(raw.replace(/[^a-z0-9_]/g, ''));
  if (!normalized || normalized === 'row' || normalized === 'record') return undefined;
  return normalized;
}

function findDistinctCountColumn(table: AgentSchemaTable, subject: string): string | undefined {
  const preferred = [
    `${subject}_id`,
    `${subject}_key`,
    `${subject}_uuid`,
    `${subject}_sk`,
    `${subject}_name`,
    subject,
  ];
  const direct = findSchemaColumn(table, preferred);
  if (direct) return direct;
  const tableTokens = meaningfulTokens([table.name, table.relation].join(' '));
  if (!tableTokens.has(subject)) return undefined;
  return findSchemaColumn(table, ['id', 'key', 'uuid']);
}

function isPrecomputedCountMetric(column: string, subject?: string): boolean {
  const normalized = column.toLowerCase();
  const text = normalized.replace(/_/g, ' ');
  if (/\b(id|key|uuid|code)\b/i.test(text)) return false;
  if (/\b(count|cnt|number|num)\b/i.test(text)) {
    return !subject || text.includes(subject) || text.includes(pluralizeSimple(subject));
  }
  return Boolean(subject && (
    normalized === `total_${subject}` ||
    normalized === `total_${pluralizeSimple(subject)}`
  ));
}

function pluralizeSimple(value: string): string {
  if (value.endsWith('y')) return `${value.slice(0, -1)}ies`;
  if (value.endsWith('s')) return value;
  return `${value}s`;
}

function augmentGenericRankingDimensions(
  table: AgentSchemaTable,
  dimensions: string[],
  metric: GenericMetricSelection,
  question: string,
): string[] {
  const direction = rankingDirectionFromText(question);
  if (!direction || !metric.preAggregated || /\bby\s+/i.test(question)) return dimensions;
  const timeColumn = table.columns
    .map((column) => column.name)
    .find((name) => isTimeLikeGenericColumn(name) && !dimensions.some((dimension) => namesEqualLoose(dimension, name)));
  return timeColumn ? [...dimensions, timeColumn] : dimensions;
}

function inferGenericDimensions(
  table: AgentSchemaTable,
  question: string,
  metricColumn?: string,
): string[] {
  const lower = question.toLowerCase();
  const requested = Array.from(lower.matchAll(/\bby\s+([a-z][a-z0-9_ -]{1,40})/g))
    .map((match) => match[1] ?? '')
    .flatMap((value) => value.split(/\band\b|,|\//i))
    .map((value) => value.replace(/\b(desc|asc|top|bottom|highest|lowest|least|most|over time)\b/gi, '').trim())
    .filter(Boolean);
  const direct = requested
    .map((value) => findSchemaColumn(table, [value, value.replace(/\s+/g, '_')]))
    .filter((value): value is string => Boolean(value));
  if (direct.length > 0) return uniqueDrilldownStrings(direct);

  const domainHints = [
    /\bcustomers?\b/.test(lower) ? ['customer_name', 'customer', 'customer_id'] : [],
    /\bproducts?\b/.test(lower) ? ['product_name', 'product', 'sku', 'product_id'] : [],
    /\bplayers?\b/.test(lower) ? ['player_name', 'player', 'player_id'] : [],
    /\bteams?\b/.test(lower) ? ['team_name', 'team', 'team_id'] : [],
    /\bregions?\b|\bmarkets?\b/.test(lower) ? ['region', 'market', 'geo'] : [],
    /\bsegments?\b/.test(lower) ? ['segment', 'customer_segment', 'type'] : [],
    /\bchannels?\b/.test(lower) ? ['channel', 'source_channel'] : [],
    /\b(month|monthly)\b/.test(lower) ? ['month', 'order_month', 'created_month'] : [],
    /\b(week|weekly)\b/.test(lower) ? ['week', 'order_week', 'created_week'] : [],
    /\b(year|season|yearly)\b/.test(lower) ? ['season', 'year', 'order_year'] : [],
  ].flat();
  const hinted = findSchemaColumn(table, domainHints);
  if (hinted) return [hinted];

  const fallback = table.columns
    .map((column, index) => ({
      column: column.name,
      score: genericDimensionScore(column, question, index, metricColumn),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.column);
  return uniqueDrilldownStrings(fallback).slice(0, 1);
}

function genericDimensionScore(
  column: AgentSchemaColumn,
  question: string,
  index: number,
  metricColumn?: string,
): number {
  if (metricColumn && namesEqualLoose(column.name, metricColumn)) return -100;
  const name = column.name.toLowerCase();
  const text = name.replace(/_/g, ' ');
  let score = Math.max(0, 10 - index * 0.05);
  if (/\b(name|category|type|segment|region|market|channel|status|team|player|customer|product|vendor|account|month|week|year|season|date)\b/i.test(text)) {
    score += 24;
  }
  if (isNumericLikeColumn(column) && !isTimeLikeGenericColumn(column.name)) score -= 18;
  for (const token of meaningfulTokens(question)) {
    if (meaningfulTokens(column.name).has(token)) score += 10;
  }
  return score;
}

function isNumericLikeColumn(column: AgentSchemaColumn): boolean {
  const type = column.type ?? '';
  const name = column.name.toLowerCase();
  return /\b(INT|INTEGER|BIGINT|DECIMAL|DOUBLE|FLOAT|NUMBER|NUMERIC|REAL)\b/i.test(type)
    || /\b(total|count|amount|revenue|sales|spend|cost|margin|profit|value|points?|score|quantity|duration|minutes?|rate|avg|average)\b/i.test(name.replace(/_/g, ' '));
}

function isPreAggregatedMetricColumn(name: string): boolean {
  return /^(total|count|avg|average|median|min|max)_/i.test(name)
    || /_(total|count|avg|average|median|min|max)$/i.test(name);
}

function isTimeLikeGenericColumn(name: string): boolean {
  return /\b(date|time|day|week|month|quarter|year|season|period)\b/i.test(name);
}

function buildEntityProfileProposal(input: {
  question: string;
  intent: AgentIntent;
  schemaContext: AgentSchemaTable[];
  followUp?: AgentFollowUpContext;
  contextPack?: LocalContextPack;
}): ParsedProposal | undefined {
  const entityTexts = entityMentionsForProfile(input.question, input.contextPack);
  if (entityTexts.length === 0 || !isEntityProfileQuestion(input.question, input.contextPack)) return undefined;

  const candidates = input.schemaContext
    .map((table) => profileTableCandidate(table, input.question, input.followUp, entityTexts))
    .filter((candidate): candidate is ProfileTableCandidate => Boolean(candidate))
    .sort((a, b) => b.score - a.score);
  const selected = candidates[0];
  if (!selected) return undefined;

  const where = selected.filterValue
    ? [`WHERE ${sqlIdentifier(selected.entityColumn)} = ${sqlStringLiteral(selected.filterValue)}`]
    : [];
  const columns = selected.selectColumns.map((column) => `  ${sqlIdentifier(column)}`).join(',\n');
  const text = [
    `Prepared a review-required profile query for ${selected.filterValue ?? entityTexts[0]} from ${selected.table.relation}.`,
    selected.usedSampleValue
      ? `The entity filter uses an inspected value match on ${selected.entityColumn}.`
      : `The entity filter uses the likely entity column ${selected.entityColumn} from inspected schema metadata.`,
    'This result is uncertified until reviewed and promoted.',
  ].join(' ');

  return {
    text,
    sql: [
      'SELECT',
      columns,
      `FROM ${sqlRelation(selected.table.relation)}`,
      ...where,
      'LIMIT 50',
    ].join('\n'),
    viz: 'table',
  };
}

interface ProfileTableCandidate {
  table: AgentSchemaTable;
  entityColumn: string;
  filterValue: string;
  selectColumns: string[];
  usedSampleValue: boolean;
  score: number;
}

function profileTableCandidate(
  table: AgentSchemaTable,
  question: string,
  followUp: AgentFollowUpContext | undefined,
  entityTexts: string[],
): ProfileTableCandidate | undefined {
  if (table.columns.length === 0) return undefined;
  const matchedFilters = matchedEntityFiltersForQuestion(table, question, followUp);
  const sampled = matchedFilters.find((filter) =>
    entityTexts.some((entity) => normalizeForEntityMatch(entity) === normalizeForEntityMatch(filter.value)),
  ) ?? matchedFilters[0];
  const entityColumn = sampled?.column ?? pickEntityProfileColumn(table, question);
  if (!entityColumn) return undefined;
  const filterValue = sampled?.value ?? entityTexts[0];
  if (!filterValue) return undefined;
  const selectColumns = orderedProfileColumns(table, entityColumn, question);
  if (selectColumns.length === 0) return undefined;

  const questionTokens = meaningfulTokens(question);
  const tableTokens = meaningfulTokens([table.relation, table.name, table.description ?? ''].join(' '));
  const columnTokens = meaningfulTokens(table.columns.map((column) => column.name).join(' '));
  const overlap = [...questionTokens].filter((token) => tableTokens.has(token) || columnTokens.has(token)).length;
  const profileSignal = selectColumns.filter((column) => isProfileMeasureColumn(column, table)).length;
  const score =
    (sampled ? 80 : 42) +
    overlap * 6 +
    profileSignal * 3 +
    (/\b(player|customer|account|user|member|person|entity)\b/i.test(table.name) ? 8 : 0);

  return {
    table,
    entityColumn,
    filterValue,
    selectColumns,
    usedSampleValue: Boolean(sampled),
    score,
  };
}

function isEntityProfileQuestion(question: string, contextPack: LocalContextPack | undefined): boolean {
  const mode = contextPack?.questionPlan?.mode;
  if (mode === 'entity_profile') return true;
  return /\b(profile|overview|360|complete\s+(?:stats|statistics|view)|full\s+(?:stats|statistics|view)|all\s+(?:stats|statistics|metrics)|research|reserach)\b/i.test(question);
}

function entityMentionsForProfile(question: string, contextPack: LocalContextPack | undefined): string[] {
  const values = [
    ...(contextPack?.questionPlan?.entities ?? []).map((entity) => entity.text),
    ...Array.from(question.matchAll(/\b(?:for|on|profile\s+for|research\s+on|reserach\s+on)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,5})/g))
      .map((match) => match[1] ?? ''),
  ];
  if (isEntityProfileQuestion(question, contextPack)) {
    values.push(...Array.from(question.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,5})\b/g)).map((match) => match[1] ?? ''));
  }
  return uniqueDrilldownStrings(values
    .map((value) => value.replace(/\b(profile|stats|statistics|details|summary)\b.*$/i, '').trim())
    .filter((value) => value.length > 1 && !/^(Can You|Could You|Tell Me|Show Me)$/i.test(value)))
    .slice(0, 6);
}

function pickEntityProfileColumn(table: AgentSchemaTable, question: string): string | undefined {
  const lower = question.toLowerCase();
  const domainHints = [
    /\bplayers?\b/.test(lower) ? 'player' : '',
    /\bcustomers?\b/.test(lower) ? 'customer' : '',
    /\baccounts?\b/.test(lower) ? 'account' : '',
    /\busers?\b/.test(lower) ? 'user' : '',
    /\bmembers?\b/.test(lower) ? 'member' : '',
    /\bteams?\b/.test(lower) ? 'team' : '',
    /\bproducts?\b/.test(lower) ? 'product' : '',
  ].filter(Boolean);
  const preferred = [
    ...domainHints.flatMap((hint) => [`${hint}_name`, `${hint}_full_name`, hint]),
    'name',
    'full_name',
    'display_name',
    'title',
  ];
  const direct = findSchemaColumn(table, preferred);
  if (direct) return direct;

  const scored = table.columns
    .map((column) => {
      const name = column.name.toLowerCase();
      let score = 0;
      if (name.endsWith('_name') || name === 'name') score += 30;
      if (/\b(name|title|email)\b/i.test(name.replace(/_/g, ' '))) score += 20;
      if (domainHints.some((hint) => name.includes(hint))) score += 16;
      if (/\b(id|key|code|date|time|amount|total|count|score|points|revenue)\b/i.test(name.replace(/_/g, ' '))) score -= 12;
      return { column: column.name, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.column;
}

function orderedProfileColumns(table: AgentSchemaTable, entityColumn: string, question: string): string[] {
  const scored = table.columns
    .map((column, index) => ({
      column: column.name,
      score: profileColumnScore(column, question, index),
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = uniqueDrilldownStrings([
    entityColumn,
    ...scored.map((item) => item.column),
  ]).slice(0, 24);
  return selected.length > 0 ? selected : [entityColumn];
}

function profileColumnScore(column: AgentSchemaColumn, question: string, index: number): number {
  const name = column.name.toLowerCase();
  const text = name.replace(/_/g, ' ');
  const lowerQuestion = question.toLowerCase();
  let score = Math.max(0, 12 - index * 0.1);
  if (isProfileMeasureColumn(column.name, { relation: '', name: '', columns: [column] })) score += 35;
  if (/\b(name|title|team|season|year|date|type|category|segment|status)\b/i.test(text)) score += 18;
  if (/\b(id|key|code)\b/i.test(text)) score += 2;
  for (const token of meaningfulTokens(lowerQuestion)) {
    if (meaningfulTokens(column.name).has(token)) score += 12;
  }
  if (column.description && meaningfulTokens(column.description).size > 0) score += 4;
  return score;
}

function isProfileMeasureColumn(columnName: string, table: AgentSchemaTable): boolean {
  const column = table.columns.find((item) => namesEqualLoose(item.name, columnName));
  const name = columnName.toLowerCase();
  const text = name.replace(/_/g, ' ');
  return /\b(total|count|avg|average|sum|rate|score|points|pts|rebounds?|assists?|steals?|blocks?|turnovers?|minutes?|games?|wins?|losses?|revenue|amount|spend|orders?|quantity|margin|cost|value|stat)\b/i.test(text)
    || /\b(INT|INTEGER|BIGINT|DECIMAL|DOUBLE|FLOAT|NUMBER|NUMERIC|REAL)\b/i.test(column?.type ?? '');
}

function buildMatchedEntityDrilldownProposal(input: {
  question: string;
  intent: AgentIntent;
  schemaContext: AgentSchemaTable[];
  followUp?: AgentFollowUpContext;
  contextPack?: LocalContextPack;
}): ParsedProposal | undefined {
  if (input.intent !== 'entity_drilldown' && input.followUp?.kind !== 'drilldown') return undefined;
  const table = pickDrilldownTable(input.schemaContext, input.question, input.followUp);
  if (!table) return undefined;

  const dimension = inferDrilldownDimension(table, input.question, input.followUp);
  if (!dimension) return undefined;

  const entityFilters = matchedEntityFiltersForQuestion(table, input.question, input.followUp);
  if (entityFilters.length === 0) return undefined;
  if (entityFilters.some((filter) => namesEqualLoose(filter.column, dimension))) return undefined;

  const sourceSql = selectSourceBlockSql(input.contextPack, input.followUp?.sourceBlockName);
  const metric = inferDrilldownMetric(table, input.question, sourceSql);
  if (!metric) return undefined;

  const timePredicates = drilldownTimePredicates({
    question: input.question,
    followUp: input.followUp,
    table,
    sourceSql,
  });
  if (mentionsRelativeTime(input.question, input.followUp) && timePredicates.length === 0) return undefined;

  const predicates = [
    ...entityFilters.map((filter) => `${sqlIdentifier(filter.column)} = ${sqlStringLiteral(filter.value)}`),
    ...timePredicates,
  ];
  const where = predicates.length ? [`WHERE ${predicates.join(' AND ')}`] : [];
  return {
    text: [
      `Prepared a review-required ${humanizeIdentifier(dimension)} drilldown from inspected metadata.`,
      `The entity filter uses ${entityFilters.map((filter) => `${filter.column} = ${filter.value}`).join(', ')} from matched sample values.`,
      'This result is uncertified until reviewed and promoted.',
    ].join(' '),
    sql: [
      'SELECT',
      `  ${sqlIdentifier(dimension)} AS ${sqlIdentifier(dimension)},`,
      `  ${metric.expression} AS ${sqlIdentifier(metric.alias)}`,
      `FROM ${sqlRelation(table.relation)}`,
      ...where,
      `GROUP BY ${sqlIdentifier(dimension)}`,
      `ORDER BY ${sqlIdentifier(metric.alias)} DESC`,
      'LIMIT 50',
    ].join('\n'),
    viz: 'bar',
  };
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

interface MatchedEntityFilter {
  column: string;
  value: string;
}

interface DrilldownMetric {
  expression: string;
  alias: string;
}

function pickDrilldownTable(
  schemaContext: AgentSchemaTable[],
  question: string,
  followUp: AgentFollowUpContext | undefined,
): AgentSchemaTable | undefined {
  const scored = schemaContext
    .map((table) => ({
      table,
      filters: matchedEntityFiltersForQuestion(table, question, followUp).length,
      dimension: inferDrilldownDimension(table, question, followUp) ? 1 : 0,
      measure: inferDrilldownMetric(table, question, undefined) ? 1 : 0,
    }))
    .filter((candidate) => candidate.filters > 0 && candidate.dimension > 0 && candidate.measure > 0)
    .sort((a, b) => (b.filters + b.dimension + b.measure) - (a.filters + a.dimension + a.measure));
  return scored[0]?.table;
}

function inferDrilldownDimension(
  table: AgentSchemaTable,
  question: string,
  followUp: AgentFollowUpContext | undefined,
): string | undefined {
  const lower = question.toLowerCase();
  const requested = [
    ...(followUp?.dimensions ?? []),
    ...Array.from(lower.matchAll(/\bby\s+([a-z][a-z0-9_ -]{1,40})/g)).map((match) => match[1] ?? ''),
  ]
    .flatMap((value) => value.split(/\band\b|,|\//i))
    .map((value) => value.replace(/\b(last|this|next|previous|prior|current)\s+(day|week|month|quarter|year)\b/gi, '').trim())
    .filter(Boolean);

  const direct = findSchemaColumn(table, requested);
  if (direct) return direct;

  if (/\bcustomers?\b/.test(lower)) {
    const customer = findSchemaColumn(table, ['customer', 'customer_name', 'account', 'account_name']);
    if (customer) return customer;
  }
  if (/\bsegments?\b/.test(lower)) {
    const segment = findSchemaColumn(table, ['segment', 'customer_segment', 'market_segment']);
    if (segment) return segment;
  }
  if (/\bproducts?\b/.test(lower)) {
    const product = findSchemaColumn(table, ['product', 'product_name', 'sku']);
    if (product) return product;
  }
  if (/\bregions?\b/.test(lower)) {
    const region = findSchemaColumn(table, ['region', 'market', 'geo']);
    if (region) return region;
  }
  return undefined;
}

function matchedEntityFiltersForQuestion(
  table: AgentSchemaTable,
  question: string,
  followUp: AgentFollowUpContext | undefined,
): MatchedEntityFilter[] {
  const text = normalizeForEntityMatch([
    question,
    ...(followUp?.filters ?? []),
  ].join(' '));
  const filters: MatchedEntityFilter[] = [];
  for (const column of table.columns) {
    for (const sampleValue of column.sampleValues ?? []) {
      if (isTemporalDrilldownValue(sampleValue)) continue;
      const needle = normalizeForEntityMatch(sampleValue);
      if (!needle || !text.includes(needle)) continue;
      filters.push({ column: column.name, value: sampleValue });
    }
  }
  return uniqueMatchedEntityFilters(filters);
}

function inferDrilldownMetric(
  table: AgentSchemaTable,
  question: string,
  sourceSql: string | undefined,
): DrilldownMetric | undefined {
  const sourceMetric = sourceSql ? aggregateMetricFromSourceSql(table, sourceSql) : undefined;
  if (sourceMetric) return sourceMetric;

  const lower = question.toLowerCase();
  const candidates = /\brevenue|arr|mrr|sales\b/.test(lower)
    ? ['revenue', 'net_revenue', 'gross_revenue', 'amount', 'order_total', 'total_amount', 'sales', 'arr', 'mrr']
    : ['amount', 'revenue', 'order_total', 'total_amount', 'value', 'spend'];
  const column = findSchemaColumn(table, candidates);
  if (!column) return undefined;
  const alias = /\brevenue|arr|mrr|sales\b/.test(lower) ? 'revenue_total' : `${column}_total`;
  return {
    expression: `SUM(${sqlIdentifier(column)})`,
    alias,
  };
}

function aggregateMetricFromSourceSql(table: AgentSchemaTable, sourceSql: string): DrilldownMetric | undefined {
  for (const column of table.columns) {
    const columnPattern = sqlIdentifierPattern(column.name);
    const aggregatePattern = new RegExp(
      `\\b(SUM|COUNT|AVG|MIN|MAX)\\s*\\(\\s*(?:["\`]?\\w+["\`]?\\s*\\.\\s*)?(${columnPattern}|\\*)\\s*\\)\\s*(?:AS\\s+(["\`]?\\w+["\`]?))?`,
      'i',
    );
    const match = sourceSql.match(aggregatePattern);
    if (!match) continue;
    const fn = (match[1] ?? 'SUM').toUpperCase();
    const target = match[2] === '*' ? '*' : sqlIdentifier(column.name);
    const alias = cleanSqlIdentifier(match[3] ?? defaultMetricAlias(fn, column.name));
    return {
      expression: `${fn}(${target})`,
      alias,
    };
  }
  return undefined;
}

function drilldownTimePredicates(input: {
  question: string;
  followUp?: AgentFollowUpContext;
  table: AgentSchemaTable;
  sourceSql?: string;
}): string[] {
  if (!mentionsRelativeTime(input.question, input.followUp)) return [];
  if (!input.sourceSql) return [];
  const timeColumns = input.table.columns.map((column) => column.name).filter(isTimeLikeDrilldownColumn);
  if (timeColumns.length === 0) return [];
  return extractWherePredicates(input.sourceSql)
    .map(stripSqlAliasQualifiers)
    .filter((predicate) => isReusableSqlPredicate(predicate))
    .filter((predicate) => timeColumns.some((column) => predicateReferencesColumn(predicate, column)))
    .slice(0, 3);
}

function selectSourceBlockSql(contextPack: LocalContextPack | undefined, sourceBlockName: string | undefined): string | undefined {
  const sourceSql = contextPack?.allowedSqlContext?.sourceBlockSql ?? [];
  if (sourceSql.length === 0) return undefined;
  const preferred = sourceBlockName
    ? sourceSql.find((source) => namesEqualLoose(source.name, sourceBlockName))
    : undefined;
  return (preferred ?? sourceSql.find((source) => source.status === 'certified') ?? sourceSql[0])?.sql;
}

function extractWherePredicates(sql: string): string[] {
  const match = sql.match(/\bWHERE\b([\s\S]*?)(\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i);
  if (!match) return [];
  return (match[1] ?? '')
    .split(/\s+AND\s+/i)
    .map((part) => part.trim().replace(/^\(+|\)+$/g, '').replace(/\s+/g, ' '))
    .filter(Boolean);
}

function mentionsRelativeTime(question: string, followUp: AgentFollowUpContext | undefined): boolean {
  const text = [question, ...(followUp?.filters ?? [])].join(' ');
  return /\b(last|this|next|previous|prior|current)\s+(day|week|month|quarter|year)\b/i.test(text)
    || /\b(today|yesterday|tomorrow|ytd|mtd|qtd|wtd)\b/i.test(text);
}

function isTimeLikeDrilldownColumn(name: string): boolean {
  return /\b(date|time|day|week|month|quarter|year|period|created_at|updated_at)\b/i.test(name);
}

function stripSqlAliasQualifiers(predicate: string): string {
  return predicate.replace(/\b["`]?\w+["`]?\s*\.\s*(["`]?\w+["`]?)/g, '$1');
}

function isReusableSqlPredicate(predicate: string): boolean {
  if (!predicate || predicate.length > 240) return false;
  if (/[;]/.test(predicate) || /--|\/\*/.test(predicate)) return false;
  return !/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COPY|PRAGMA|SET)\b/i.test(predicate);
}

function predicateReferencesColumn(predicate: string, column: string): boolean {
  return new RegExp(`(^|[^\\w])${sqlIdentifierPattern(column)}([^\\w]|$)`, 'i').test(predicate);
}

function sqlIdentifierPattern(identifier: string): string {
  const escaped = escapeRegExp(identifier);
  return `(?:"${escaped}"|\`${escaped}\`|${escaped})`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function defaultMetricAlias(fn: string, column: string): string {
  if (fn === 'SUM' && /revenue|amount|sales|arr|mrr/i.test(column)) return 'revenue_total';
  return `${column}_${fn.toLowerCase()}`;
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

function normalizeForEntityMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.%+-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueMatchedEntityFilters(filters: MatchedEntityFilter[]): MatchedEntityFilter[] {
  const seen = new Set<string>();
  const unique: MatchedEntityFilter[] = [];
  for (const filter of filters) {
    const key = `${filter.column.toLowerCase()}\0${filter.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(filter);
  }
  return unique;
}

function uniqueDrilldownStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isTemporalDrilldownValue(value: string): boolean {
  return mentionsRelativeTime(value, undefined) || /^\d{4}-\d{2}-\d{2}/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildContextPackAwareProposal(input: {
  question: string;
  intent: AgentIntent;
  contextPack?: LocalContextPack;
}): ParsedProposal | undefined {
  if (!isGeneratedAgentIntent(input.intent)) return undefined;
  if (!input.contextPack) return undefined;
  const profileProposal = buildContextPackProfileProposal(input.question, input.contextPack);
  if (profileProposal) return profileProposal;
  const lower = input.question.toLowerCase();
  if (!/\b(least|lowest|fewest|bottom|min(?:imum)?)\b/.test(lower)) return undefined;

  for (const object of input.contextPack.objects) {
    if (object.objectType !== 'dql_block' || object.status !== 'certified') continue;
    const sql = typeof object.payload?.sql === 'string' ? object.payload.sql.trim() : '';
    if (!sql || !/\border\s+by\b/i.test(sql) || !/\bdesc\b/i.test(sql)) continue;
    const inverted = invertRankingSql(sql);
    if (!inverted || inverted === sql) continue;
    return {
      text: `Generated a review-required least-ranking query by using certified block "${object.name}" as context and reversing its ranking direction. This result is uncertified until reviewed and promoted.`,
      sql: ensurePreviewLimit(inverted, 10),
      viz: 'table',
    };
  }
  return undefined;
}

function buildContextPackProfileProposal(
  question: string,
  contextPack: LocalContextPack,
): ParsedProposal | undefined {
  const entityTexts = entityMentionsForProfile(question, contextPack);
  if (entityTexts.length === 0 || !isEntityProfileQuestion(question, contextPack)) return undefined;

  const sources = [...(contextPack.allowedSqlContext?.sourceBlockSql ?? [])]
    .sort((a, b) => {
      const preferred = contextPack.routeDecision.certifiedApplicability?.objectKey;
      if (preferred && a.objectKey === preferred) return -1;
      if (preferred && b.objectKey === preferred) return 1;
      return 0;
    });
  for (const source of sources) {
    const shape = extractSimpleSelectShape(source.sql);
    if (!shape) continue;
    const entityColumn = pickEntityColumnFromSelectExpressions(shape.selectExpressions, question);
    if (!entityColumn) continue;
    const selectExpressions = uniqueSqlSelectExpressions(shape.selectExpressions).slice(0, 24);
    if (selectExpressions.length === 0) continue;
    const orderColumn = selectExpressions
      .map(selectExpressionOutputName)
      .find((column) => column && /\b(season|year|date|month|week|game_date|created_at)\b/i.test(column));
    const sql = [
      'SELECT',
      selectExpressions.map((expression) => `  ${expression}`).join(',\n'),
      `FROM ${shape.relation}`,
      `WHERE ${sqlIdentifier(entityColumn)} = ${sqlStringLiteral(entityTexts[0]!)}`,
      orderColumn ? `ORDER BY ${sqlIdentifier(orderColumn)} DESC` : '',
      'LIMIT 50',
    ].filter(Boolean).join('\n');
    return {
      text: `Prepared a review-required profile query for ${entityTexts[0]} by using certified block "${source.name}" as SQL-shape context. This result is uncertified until reviewed and promoted.`,
      sql,
      viz: 'table',
    };
  }
  return undefined;
}

function pickEntityColumnFromSelectExpressions(expressions: string[], question: string): string | undefined {
  const outputNames = expressions
    .map(selectExpressionOutputName)
    .filter((value): value is string => Boolean(value));
  const lower = question.toLowerCase();
  const hints = [
    /\bplayers?\b/.test(lower) ? 'player' : '',
    /\bcustomers?\b/.test(lower) ? 'customer' : '',
    /\baccounts?\b/.test(lower) ? 'account' : '',
    /\busers?\b/.test(lower) ? 'user' : '',
    /\bteams?\b/.test(lower) ? 'team' : '',
    /\bproducts?\b/.test(lower) ? 'product' : '',
  ].filter(Boolean);
  const preferred = [
    ...hints.flatMap((hint) => [`${hint}_name`, `${hint}_full_name`, hint]),
    'name',
    'full_name',
    'display_name',
  ];
  for (const wanted of preferred) {
    const match = outputNames.find((name) => namesEqualLoose(name, wanted));
    if (match) return match;
  }
  return outputNames.find((name) => /(^|_)(name|title|email)$/.test(name.toLowerCase()));
}

function uniqueSqlSelectExpressions(expressions: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const expression of expressions) {
    const normalized = expression.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(expression.replace(/\s+/g, ' ').trim());
  }
  return unique;
}

function invertRankingSql(sql: string): string | undefined {
  const withoutTrailingSemicolon = sql.replace(/;\s*$/, '').trim();
  const inverted = withoutTrailingSemicolon.replace(
    /\border\s+by\s+([\s\S]*?)(\blimit\b|$)/i,
    (match: string, orderExpr: string, limitKeyword: string) => {
      if (!/\bdesc\b/i.test(orderExpr)) return match;
      const nextExpr = orderExpr
        .replace(/\bDESC\b/gi, 'ASC')
        .replace(/\bNULLS\s+FIRST\b/gi, 'NULLS LAST');
      return `ORDER BY ${nextExpr}${limitKeyword}`;
    },
  );
  return inverted !== withoutTrailingSemicolon ? inverted : undefined;
}

function ensurePreviewLimit(sql: string, limit: number): string {
  if (/\blimit\s+\d+\b/i.test(sql)) return sql;
  return `${sql.replace(/;\s*$/, '').trim()}\nLIMIT ${limit}`;
}

function findSchemaTable(schemaContext: AgentSchemaTable[], names: string[]): AgentSchemaTable | undefined {
  return schemaContext.find((table) => {
    const tableNames = new Set([table.name, table.relation.split('.').at(-1) ?? table.relation].map((name) => name.toLowerCase()));
    return names.some((name) => tableNames.has(name.toLowerCase()));
  });
}

function findSchemaColumn(table: AgentSchemaTable, names: string[]): string | undefined {
  const byLower = new Map(table.columns.map((column) => [column.name.toLowerCase(), column.name]));
  for (const name of names) {
    const exact = byLower.get(name.toLowerCase());
    if (exact) return exact;
  }
  return undefined;
}

function sqlRelation(relation: string): string {
  return relation.split('.').map(sqlIdentifier).join('.');
}

function sqlIdentifier(identifier: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)
    ? identifier
    : `"${identifier.replace(/"/g, '""')}"`;
}

function humanizeIdentifier(identifier: string): string {
  return identifier.replace(/[_-]+/g, ' ');
}

function businessMeasurePhrase(identifier: string): string {
  const lower = identifier.toLowerCase();
  if (lower.includes('lifetime_spend')) return 'lifetime spend';
  if (lower.includes('count_lifetime_orders') || lower.includes('lifetime_orders') || lower.includes('order_count')) {
    return 'lifetime order count';
  }
  return humanizeIdentifier(identifier);
}

function pickCertifiedArtifact(input: {
  artifactHits: KGSearchHit[];
  executableArtifactHits: KGSearchHit[];
  businessHits: KGSearchHit[];
  question: string;
  blockHints: string[];
  excludedArtifactIds?: Set<string>;
  kg: KGStore;
}): KGSearchHit | null {
  // Hint match wins immediately: the active Skill's vocabulary points the
  // user at a specific block. We still validate it's certified.
  for (const hint of input.blockHints) {
    const node = input.kg.getNode(`block:${hint}`);
    if (node && node.status === 'certified' && hasCompatibleCertifiedBlockMatch(input.question, node)) {
      return { node, score: 1, snippet: undefined };
    }
  }

  const executableHit = pickFirstCertifiedHit(input.executableArtifactHits, input.kg, input.excludedArtifactIds, input.question);
  if (isBusinessDefinitionQuestion(input.question)) {
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
): KGSearchHit | null {
  for (const hit of hits) {
    if (hit.score < CERTIFIED_HIT_THRESHOLD) break;
    if (excludedNodeIds?.has(hit.node.nodeId)) continue;
    if (!isCertifiedHit(hit, kg)) continue;
    if (question && hit.node.kind === 'block' && !hasCompatibleCertifiedBlockMatch(question, hit.node)) continue;
    return hit;
  }
  return null;
}

function pickCertifiedDrilldownArtifact(input: {
  executableArtifactHits: KGSearchHit[];
  question: string;
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
    if (!hasCompatibleCertifiedBlockMatch(input.question, hit.node)) continue;
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
  if (/\b(account|customer|product|sku|user)\s+(?:id|name|email)\b/i.test(lower)) return true;
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}/.test(question) && /\b(revenue|sales|order|orders|spend|value|churn|usage|activity|performance|performed|metric|kpi)\b/i.test(lower)) {
    return true;
  }
  if (/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(question)) return true;
  return false;
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
  return `I need one more detail before querying: which metric or business object should define the answer for "${question}"?${available ? ` I found ${available}, but not enough to choose a safe grain.` : ''}`;
}

async function requestSqlRepair(input: {
  provider: AgentProvider;
  baseMessages: AgentMessage[];
  question: string;
  parsed: ParsedProposal;
  executionError: string;
  schemaContext: AgentSchemaTable[];
  signal?: AbortSignal;
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
        'The generated SQL failed during bounded preview execution.',
        `Question: ${input.question}`,
        `Execution error: ${input.executionError}`,
        'Return one corrected read-only SQL query using only the runtime schema below.',
        schema,
      ].join('\n\n'),
    },
  ], { signal: input.signal });
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
 * Candidate metric KG nodes for semantic-metric matching (spec 17, part C).
 * Starts with the FTS semantic + considered hits, then folds in EVERY metric
 * node from the KG so a confident measure-family match is found even when FTS
 * surfaced no metric at all (the "total revenue" miss). Bounded for safety.
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
    for (const node of kg.getNodesByKind('metric', 200)) {
      if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
    }
  } catch {
    // Best-effort: a KG without a getNodesByKind still matches the FTS hits.
  }
  return Array.from(byId.values());
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
      status: input.executionError ? 'failed' : 'passed',
      message: input.executionError
        ? 'The certified artifact matched, but execution returned an error.'
        : 'Certified artifact routing passed; no generated SQL was promoted.',
    },
    execution: executionEvidence(input.artifact, input.result, input.executionError, input.executorWasAvailable),
    citations: input.citations,
    analysisPlan: input.analysisPlan,
  };
}

function buildGeneratedEvidence(input: {
  question: string;
  activeTier: AnswerSourceTier;
  intent: AgentIntent;
  contextNodes: KGNode[];
  schemaContext: AgentSchemaTable[];
  followUp?: AgentFollowUpContext;
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
  return {
    route: [
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
        label: 'SQL is generated and requires host validation before certification',
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
          ? 'Generated SQL preview failed'
          : input.result
            ? 'Executed generated SQL as bounded preview'
            : 'Generated SQL preview not requested',
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
    validation: {
      status: 'warning',
      message: input.followUp?.kind === 'drilldown'
        ? 'Generated drilldown SQL is not certified. It should be validated, reviewed, and promoted only after analyst approval.'
        : 'Generated SQL is not certified. It should be validated, reviewed, and promoted only after analyst approval.',
    },
    execution: {
      status: input.executionError ? 'failed' : input.result ? 'executed' : 'not_requested',
      message: input.executionError
        ? input.executionError
        : input.result
          ? 'Executed generated SQL as an uncertified bounded preview.'
          : 'Generated SQL was returned for review; execution is handled by the host after validation.',
      rowCount: input.result?.rowCount,
      executionTime: input.result?.executionTime,
    },
    citations: input.citations,
    analysisPlan: input.analysisPlan,
  };
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
}): AgentEvidence {
  return {
    route: [
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
    description: table.description ?? `${table.columns.length} runtime column${table.columns.length === 1 ? '' : 's'} available for generated SQL.`,
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
  if (node.status === 'certified' || node.certification === 'certified') return 'certified';
  if (node.certification === 'analyst_review_required') return 'analyst_review_required';
  if (node.certification === 'ai_generated' || node.certification === 'uncertified') return 'ai_generated';
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
