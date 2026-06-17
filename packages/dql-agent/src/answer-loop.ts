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

import type { KGStore } from './kg/sqlite-fts.js';
import type { KGNode, KGNodeKind, KGSearchHit } from './kg/types.js';
import type { AgentProvider, AgentMessage } from './providers/types.js';
import type { Skill } from './skills/loader.js';
import { buildSkillBlockHints, buildSkillsPrompt } from './skills/loader.js';
import type { AgentMemory } from './memory/sqlite-memory.js';
import type { LocalContextPack, MetadataAgentIntent, MetadataRouteDecision } from './metadata/catalog.js';

export type AnswerKind = 'certified' | 'uncertified' | 'no_answer';
export type AnswerSourceTier = 'certified_artifact' | 'business_context' | 'semantic_layer' | 'dbt_manifest' | 'no_answer';
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

export async function answer(input: AnswerLoopInput): Promise<AgentAnswer> {
  const { question, userId, domain, provider, kg, skills = [], blockHints = [] } = input;
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
  const catalogRoute = input.contextPack?.routeDecision;
  const fallbackIntent = classifyAgentIntent({
    question,
    followUp: input.followUp,
    artifactHits,
    semanticHits,
    manifestHits,
    schemaContext: input.schemaContext ?? [],
  });
  const intent = catalogRoute ? agentIntentFromCatalogRoute(catalogRoute) : fallbackIntent;

  // Stage 1: certified artifact match. Blocks can be executed; dashboards,
  // Apps, and notebooks are returned as governed citations/navigation targets.
  const artifactHit = shouldUseCertifiedRoute(catalogRoute, intent)
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
    : null;
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
      schemaContext: input.schemaContext ?? [],
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

  if (intent === 'clarify' || catalogRoute?.route === 'clarify') {
    const text = composeCatalogClarificationText(question, catalogRoute) ?? composeClarificationText(question, considered, input.schemaContext ?? []);
    const analysisPlan = buildAnalysisPlan({
      question,
      intent,
      routeReason: catalogRoute?.reason ?? 'No certified artifact, semantic object, dbt/source table, or runtime schema match was strong enough to safely generate SQL.',
      selectedNodes: considered.slice(0, 4).map((hit) => hit.node),
      schemaContext: input.schemaContext ?? [],
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
  const activeTier: AnswerSourceTier = sourceTierFromContextPack(input.contextPack) ?? (semanticHits.length > 0
    ? 'semantic_layer'
    : manifestHits.length > 0
      ? 'dbt_manifest'
      : 'dbt_manifest');
  const reviewRequiredArtifactHits = artifactHits
    .filter((hit) => hit.score >= CERTIFIED_HIT_THRESHOLD && !isCertifiedHit(hit, kg))
    .slice(0, 4);
  const trustedArtifactContext = rankGeneratedContextHits(
    executableArtifactHits.filter((hit) => !excludedArtifactIds?.has(hit.node.nodeId)),
    input.schemaContext ?? [],
    question,
  )
    .filter((hit) => !excludedArtifactIds?.has(hit.node.nodeId))
    .slice(0, 5);
  const contextHits = activeTier === 'semantic_layer'
    ? [...trustedArtifactContext, ...reviewRequiredArtifactHits, ...businessHits.slice(0, 4), ...semanticHits, ...manifestHits].slice(0, 14)
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
  const skillsPrompt = buildSkillsPrompt(skills, userId ?? null);
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
      input.schemaContext ?? [],
      intent,
      input.contextPack,
    ),
  });
  messages.push({ role: 'user', content: question });

  const localProposal = buildSchemaAwareProposal({
    question,
    intent,
    schemaContext: input.schemaContext ?? [],
  }) ?? buildContextPackAwareProposal({
    question,
    intent,
    contextPack: input.contextPack,
    followUp: input.followUp,
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
    ...schemaCitations(input.schemaContext ?? [], Math.max(0, 4 - contextNodes.length)),
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
        const localRepairSql = repairGeneratedSqlLocally(parsed.sql, executionError, input.schemaContext ?? []);
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
        if (executionError && hasUsableRepairSchema(input.schemaContext ?? [])) {
          const repairedRaw = await requestSqlRepair({
            provider,
            baseMessages: messages,
            question,
            parsed,
            executionError,
            schemaContext: input.schemaContext ?? [],
            signal: input.signal,
          });
          const repaired = parseProposal(repairedRaw);
          if (repaired.sql) {
            repairAttempts += 1;
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
  if (executionError) {
    parsed.text = composeGeneratedExecutionFailureText(question, executionError);
  }
  const analysisPlan = buildAnalysisPlan({
    question,
    intent,
    routeReason: catalogRoute?.reason ?? (intent === 'drillthrough'
      ? 'The user asked for a drill-through or follow-up, so DQL generated review-required SQL from the prior context and current metadata.'
      : 'The question asks for a custom analysis, ranking, breakdown, comparison, or grain that should not be answered by a loose certified block match.'),
    selectedNodes: contextNodes,
    schemaContext: input.schemaContext ?? [],
    sql: parsed.sql,
    suggestedViz: parsed.viz ?? 'table',
    assumptions: [
      'Generated SQL is an uncertified preview until an analyst reviews and promotes it.',
      ...(localProposal ? ['A local metadata planner selected a review-required SQL grain before provider generation.'] : []),
      ...(executionError ? ['The preview execution error must be reviewed before reuse.'] : []),
    ],
    repairAttempts,
  });
  return {
    kind: 'uncertified',
    sourceTier: activeTier,
    certification: 'ai_generated',
    reviewStatus: 'draft_ready',
    confidence: activeTier === 'semantic_layer' ? 0.72 : 0.55,
    text: parsed.text,
    answer: parsed.text,
    proposedSql: parsed.sql,
    sql: parsed.sql,
    result,
    executionError,
    suggestedViz: parsed.viz ?? 'table',
    citations: generatedCitations,
    memoryContext: input.memoryContext,
    analysisPlan,
    evidence: buildGeneratedEvidence({
      question,
      activeTier,
      intent,
      contextNodes,
      schemaContext: input.schemaContext ?? [],
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
6. NEVER fabricate column names that are not present in the supplied schema context.
   If a requested filter value is supplied as a matched value, prefer the table
   and column that matched that value.
7. Return one read-only SELECT or WITH query for the local warehouse/runtime.
   Do NOT use dbt/Jinja macros such as {{ ref(...) }} or {{ source(...) }} in
   proposed SQL. Do not emit INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, COPY,
   PRAGMA, SET, or multiple statements.
8. If the schema is insufficient to answer, say so explicitly and ask a
   clarifying question instead of guessing.`;

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
    ? `\nRoute decision: ${contextPack.routeDecision.route} / ${contextPack.routeDecision.intent}\nReason: ${contextPack.routeDecision.reason}\nMissing context: ${contextPack.routeDecision.missingContext.map((item) => item.message).join(' ') || 'none'}`
    : '';
  const allowed = contextPack.allowedSqlContext?.relations.length
    ? `\nAllowed SQL relations:\n${contextPack.allowedSqlContext.relations.slice(0, 12).map((relation) => `- ${relation.relation}: ${relation.columns.slice(0, 24).map((column) => column.name).join(', ') || '(columns unavailable)'}`).join('\n')}`
    : '';
  const sourceSql = contextPack.allowedSqlContext?.sourceBlockSql.length
    ? `\nSource block SQL for review-required drafts:\n${contextPack.allowedSqlContext.sourceBlockSql.slice(0, 4).map((source) => `- ${source.name}${source.status ? ` (${source.status})` : ''}:\n${indentSqlForPrompt(source.sql)}`).join('\n')}`
    : '';
  return [
    `context_pack_id: ${contextPack.id}`,
    `trust_label: ${contextPack.trustLabel}`,
    route.trim(),
    warnings.trim(),
    `Selected evidence:\n${objects || '- none'}`,
    allowed.trim(),
    sourceSql.trim(),
    conflicts.trim(),
  ].filter(Boolean).join('\n');
}

function indentSqlForPrompt(sql: string): string {
  const normalized = sql.trim().slice(0, 1600);
  return normalized.split(/\r?\n/).map((line) => `  ${line}`).join('\n');
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
}): ParsedProposal | undefined {
  if (!isGeneratedAgentIntent(input.intent)) return undefined;
  if (isFilteredEntityQuestion(input.question)) return undefined;
  const lower = input.question.toLowerCase();
  const asksForCustomerPerformance = /\bcustomers?\b/.test(lower)
    && /\border|orders|spend|revenue|perform|performed|better|top|best|rank|ranking\b/.test(lower)
    && !/\b(order details|specific orders|each order|all orders|order line|line item)\b/.test(lower);
  if (!asksForCustomerPerformance) return undefined;

  const customers = findSchemaTable(input.schemaContext, ['customers', 'customer']);
  if (!customers) return undefined;
  const customerName = findSchemaColumn(customers, ['customer_name', 'name', 'full_name']);
  const orderCount = findSchemaColumn(customers, ['count_lifetime_orders', 'lifetime_orders', 'order_count', 'orders_count', 'orders']);
  const spend = findSchemaColumn(customers, ['lifetime_spend', 'total_lifetime_spend', 'customer_lifetime_value', 'total_revenue', 'revenue']);
  if (customerName && orderCount && spend) {
    return {
      text: `Top performing customers ranked by ${businessMeasurePhrase(spend)} with ${businessMeasurePhrase(orderCount)} for context. This is AI-generated and needs analyst review before certification.`,
      sql: [
        'SELECT',
        `  ${sqlIdentifier(customerName)} AS customer_name,`,
        `  ${sqlIdentifier(orderCount)} AS orders,`,
        `  ROUND(${sqlIdentifier(spend)}, 2) AS lifetime_spend`,
        `FROM ${sqlRelation(customers.relation)}`,
        `ORDER BY ${sqlIdentifier(spend)} DESC, ${sqlIdentifier(orderCount)} DESC`,
        'LIMIT 10',
      ].join('\n'),
      viz: 'table',
    };
  }

  const customerId = findSchemaColumn(customers, ['customer_id', 'id']);
  const orders = findSchemaTable(input.schemaContext, ['orders', 'order']);
  if (!orders || !customerName || !customerId) return undefined;
  const orderCustomerId = findSchemaColumn(orders, ['customer_id', 'customer']);
  const orderTotal = findSchemaColumn(orders, ['order_total', 'total_order_amount', 'total_amount', 'amount', 'subtotal']);
  const orderId = findSchemaColumn(orders, ['order_id', 'id']);
  if (!orderCustomerId || !orderTotal) return undefined;
  const countExpression = orderId ? `COUNT(DISTINCT o.${sqlIdentifier(orderId)})` : 'COUNT(*)';
  return {
    text: `Top performing customers ranked from order totals with order count for context. This is AI-generated and needs analyst review before certification.`,
    sql: [
      'SELECT',
      `  c.${sqlIdentifier(customerName)} AS customer_name,`,
      `  ${countExpression} AS orders,`,
      `  ROUND(SUM(o.${sqlIdentifier(orderTotal)}), 2) AS lifetime_spend`,
      `FROM ${sqlRelation(orders.relation)} AS o`,
      `JOIN ${sqlRelation(customers.relation)} AS c ON o.${sqlIdentifier(orderCustomerId)} = c.${sqlIdentifier(customerId)}`,
      `GROUP BY c.${sqlIdentifier(customerName)}`,
      'ORDER BY lifetime_spend DESC, orders DESC',
      'LIMIT 10',
    ].join('\n'),
    viz: 'table',
  };
}

function buildContextPackAwareProposal(input: {
  question: string;
  intent: AgentIntent;
  contextPack?: LocalContextPack;
  followUp?: AgentFollowUpContext;
}): ParsedProposal | undefined {
  if (!isGeneratedAgentIntent(input.intent)) return undefined;
  if (!input.contextPack) return undefined;
  const contextPack = input.contextPack;
  const lower = input.question.toLowerCase();
  const filteredSourceProposal = buildSourceBlockFilterProposal({
    question: input.question,
    contextPack,
    followUp: input.followUp,
  });
  if (filteredSourceProposal) return filteredSourceProposal;

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

function buildSourceBlockFilterProposal(input: {
  question: string;
  contextPack: LocalContextPack;
  followUp?: AgentFollowUpContext;
}): ParsedProposal | undefined {
  const year = extractYearFilterValue(input.question, input.followUp);
  if (!year) return undefined;
  const source = preferredSourceBlockSql(input.contextPack, input.followUp?.sourceBlockName);
  if (!source?.sql.trim()) return undefined;
  const sql = source.sql.trim();
  const filterColumn = pickTimeFilterColumn(sql);
  if (!filterColumn) return undefined;
  return {
    text: `Generated a review-required ${year} view from certified block "${source.name}" as context. This filters the selected block grain instead of reusing the certified answer directly, so it remains uncertified until reviewed.`,
    sql: [
      'SELECT *',
      'FROM (',
      indentSubquerySql(stripFinalLimit(sql)),
      ') AS dql_source',
      `WHERE ${sqlIdentifier(filterColumn)} = ${year}`,
      'LIMIT 200',
    ].join('\n'),
    viz: 'table',
  };
}

function preferredSourceBlockSql(
  contextPack: LocalContextPack,
  sourceBlockName?: string,
): LocalContextPack['allowedSqlContext']['sourceBlockSql'][number] | undefined {
  const sources = contextPack.allowedSqlContext?.sourceBlockSql ?? [];
  const normalizedSource = sourceBlockName ? normalizeSourceName(sourceBlockName) : undefined;
  if (normalizedSource) {
    const exact = sources.find((source) => normalizeSourceName(source.name) === normalizedSource);
    if (exact) return exact;
  }
  return sources.find((source) => source.status === 'certified') ?? sources[0];
}

function extractYearFilterValue(question: string, followUp?: AgentFollowUpContext): string | undefined {
  const direct = question.match(/\b(19|20)\d{2}\b/)?.[0];
  if (direct) return direct;
  const fromFollowUp = followUp?.filters
    ?.map((filter) => filter.match(/\b(19|20)\d{2}\b/)?.[0])
    .find(Boolean);
  return fromFollowUp;
}

function pickTimeFilterColumn(sql: string): string | undefined {
  if (/\bseason\b/i.test(sql)) return 'season';
  if (/\byear\b/i.test(sql)) return 'year';
  return undefined;
}

function stripFinalLimit(sql: string): string {
  return sql.replace(/;\s*$/, '').replace(/\s+limit\s+\d+\s*$/i, '').trim();
}

function indentSubquerySql(sql: string): string {
  return sql.split(/\r?\n/).map((line) => `  ${line}`).join('\n');
}

function normalizeSourceName(value: string): string {
  return value.replace(/^block:/i, '').trim().toLowerCase();
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
  return /\b(break\s*down|breakdown|drill\s*(?:down|into)|slice|segment|split|compare|versus|vs\.?|trend|over time|top|bottom|best|worst|highest|lowest|least|fewest|minimum|min|smallest|rank|ranking|performed better|better performing|why|what drove|driver|drivers|top movers?|changed?|change|dropped?|drop|decreased?|decrease|declined?|decline|increased?|increase|anomal(?:y|ies)|exceptions?|root cause|contribut(?:e|ed|ion)|variance|delta|by\s+[a-z][\w\s-]{1,40})\b/i.test(lower)
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
  const candidateTables = input.schemaContext.slice(0, 8).map((table) => ({
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
        'Return only one corrected read-only SQL query in a fenced sql block using only the runtime schema below.',
        'If the runtime schema is not enough to repair the SQL, return "NEEDS_CONTEXT:" followed by one short missing-context question. Do not propose proxy tables.',
        schema,
      ].join('\n\n'),
    },
  ], { signal: input.signal });
}

function hasUsableRepairSchema(schemaContext: AgentSchemaTable[]): boolean {
  return schemaContext.some((table) => table.columns.length > 0);
}

function composeGeneratedExecutionFailureText(question: string, executionError: string): string {
  const compactError = executionError.replace(/\s+/g, ' ').trim();
  const shownError = compactError.length > 220 ? `${compactError.slice(0, 217)}...` : compactError;
  return [
    `I generated a review-required SQL draft for "${question}", but the bounded preview did not run successfully.`,
    'I did not switch to a proxy table because that could answer a different question.',
    `Execution issue: ${shownError}`,
    'Refresh the runtime schema or fix the source relation/columns, then rerun the draft.',
  ].join(' ');
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
  return `Answered by certified ${artifact.kind.replace('_', ' ')} **${artifact.name}**${tag}.\n\n${desc ? `${desc}\n\n${resultText}` : resultText}`
    + `\n\n_Question:_ ${question}`;
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
