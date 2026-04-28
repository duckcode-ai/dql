/**
 * Block-first answer loop.
 *
 * Stages:
 *  1) FTS5 search the KG for blocks matching the question. If a strong
 *     `block` hit exists, return it as a Certified answer (use the block's
 *     SQL through `query_via_block`-equivalent semantics — caller runs it).
 *  2) Otherwise, gather context (matching metrics, dimensions, dbt models,
 *     dashboards, Skills) and ask the LLM to propose SQL. Mark the answer
 *     Uncertified.
 *  3) Always cite block ids/git SHAs.
 *
 * The loop is *deterministic* — provider invocation is the only stochastic
 * step. Tests can mock the provider with a canned response and exercise the
 * full pipeline.
 */

import type { KGStore } from './kg/sqlite-fts.js';
import type { KGNode, KGNodeKind, KGSearchHit } from './kg/types.js';
import type { AgentProvider, AgentMessage } from './providers/types.js';
import type { Skill } from './skills/loader.js';
import { buildSkillsPrompt } from './skills/loader.js';
import type { AgentMemory } from './memory/sqlite-memory.js';

export type AnswerKind = 'certified' | 'uncertified' | 'no_answer';
export type AnswerSourceTier = 'certified_artifact' | 'semantic_layer' | 'dbt_manifest' | 'no_answer';
export type AnswerCertification = 'certified' | 'ai_generated' | 'analyst_review_required';
export type AnswerReviewStatus = 'none' | 'draft_ready' | 'analyst_review_required' | 'certified';

export interface AgentCitation {
  nodeId: string;
  kind: KGNode['kind'] | 'memory';
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
  kind: KGNode['kind'] | 'memory' | 'question';
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
  /** Provider name used (for telemetry / UI badge). */
  providerUsed?: string;
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
}

const CERTIFIED_HIT_THRESHOLD = 0.18;
const HARD_NEGATIVE_RATIO = 0.5;
const ARTIFACT_KINDS: KGNodeKind[] = ['block', 'dashboard', 'app', 'notebook'];
const SEMANTIC_KINDS: KGNodeKind[] = ['metric', 'dimension', 'measure', 'entity', 'semantic_model', 'saved_query'];
const MANIFEST_KINDS: KGNodeKind[] = ['dbt_model', 'dbt_source'];

export async function answer(input: AnswerLoopInput): Promise<AgentAnswer> {
  const { question, userId, domain, provider, kg, skills = [], blockHints = [] } = input;

  const artifactHits = kg.search({ query: question, domain, kinds: ARTIFACT_KINDS, limit: 10 });
  const semanticHits = kg.search({ query: question, domain, kinds: SEMANTIC_KINDS, limit: 12 });
  const manifestHits = kg.search({ query: question, domain, kinds: MANIFEST_KINDS, limit: 12 });
  const considered = mergeHits(
    artifactHits,
    semanticHits,
    manifestHits,
    kg.search({ query: question, domain, limit: 10 }),
  ).slice(0, 30);

  // Stage 1: certified artifact match. Blocks can be executed; dashboards,
  // Apps, and notebooks are returned as governed citations/navigation targets.
  const artifactHit = pickCertifiedArtifact(artifactHits, blockHints, kg);
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
    const citations: AgentCitation[] = [
      {
        nodeId: artifactHit.node.nodeId,
        kind: artifactHit.node.kind,
        name: artifactHit.node.name,
        gitSha: artifactHit.node.gitSha,
        sourceTier: 'certified_artifact',
        provenance: artifactHit.node.provenance,
      },
    ];
    return {
      kind: 'certified',
      sourceTier: 'certified_artifact',
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
      evidence: buildCertifiedEvidence({
        question,
        artifact: artifactHit.node,
        semanticHits,
        manifestHits,
        considered,
        result,
        executionError,
        executorWasAvailable: Boolean(input.executeCertifiedBlock),
        citations,
        memoryContext: input.memoryContext ?? [],
      }),
      considered,
      providerUsed: provider.name,
    };
  }

  // Stage 2/3: generate only after certified artifacts miss. Semantic context
  // wins over raw dbt manifest context; memory is appended last as advisory.
  const activeTier: AnswerSourceTier = semanticHits.length > 0
    ? 'semantic_layer'
    : manifestHits.length > 0
      ? 'dbt_manifest'
      : 'dbt_manifest';
  const contextHits = activeTier === 'semantic_layer'
    ? [...semanticHits, ...manifestHits].slice(0, 10)
    : manifestHits.slice(0, 10);
  const contextNodes = (contextHits.length > 0 ? contextHits : considered.slice(0, 6)).map((h) => h.node);
  const contextBlocks = contextNodes.filter((n) => n.kind === 'block');
  const contextOther = contextNodes.filter((n) => n.kind !== 'block');

  const messages: AgentMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  const skillsPrompt = buildSkillsPrompt(skills, userId ?? null);
  if (skillsPrompt) messages.push({ role: 'system', content: skillsPrompt });

  messages.push({
    role: 'system',
    content: renderContextPrompt(contextBlocks, contextOther, activeTier, input.memoryContext ?? [], input.extraContext),
  });
  messages.push({ role: 'user', content: question });

  let proposed = '';
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
        semanticHits,
        manifestHits,
        considered,
        memoryContext: input.memoryContext ?? [],
      }),
      considered,
      providerUsed: provider.name,
    };
  }

  const parsed = parseProposal(proposed);
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
        semanticHits,
        manifestHits,
        considered,
        memoryContext: input.memoryContext ?? [],
      }),
      considered,
      providerUsed: provider.name,
    };
  }

  const generatedCitations: AgentCitation[] = [
    ...contextNodes.slice(0, 4).map((n) => ({
      nodeId: n.nodeId,
      kind: n.kind,
      name: n.name,
      gitSha: n.gitSha,
      sourceTier: activeTier,
      provenance: n.provenance,
    })),
    ...(input.memoryContext ?? []).slice(0, 2).map((m) => ({
      nodeId: m.id,
      kind: 'memory' as const,
      name: m.title,
      sourceTier: 'memory' as const,
      provenance: m.source,
    })),
  ];
  return {
    kind: 'uncertified',
    sourceTier: activeTier,
    certification: 'ai_generated',
    reviewStatus: 'analyst_review_required',
    confidence: activeTier === 'semantic_layer' ? 0.72 : 0.55,
    text: parsed.text,
    answer: parsed.text,
    proposedSql: parsed.sql,
    sql: parsed.sql,
    suggestedViz: parsed.viz ?? 'table',
    citations: generatedCitations,
    memoryContext: input.memoryContext,
    evidence: buildGeneratedEvidence({
      question,
      activeTier,
      contextNodes,
      semanticHits,
      manifestHits,
      considered,
      citations: generatedCitations,
      memoryContext: input.memoryContext ?? [],
    }),
    considered,
    providerUsed: provider.name,
  };
}

const SYSTEM_PROMPT = `You are the DQL Analytics Agent.

Rules:
1. ALWAYS prefer existing certified DQL blocks. The analytics surface marks every
   answer as Certified or AI-generated/Uncertified.
2. If you must generate SQL, return it inside a single \`\`\`sql code block.
3. Provide a one-paragraph natural-language summary BEFORE the SQL block.
4. Suggest a visualization type from this list, on a line starting with "Viz:":
   line, bar, area, pie, single_value, table, pivot, kpi.
5. NEVER fabricate column names that are not present in the supplied schema context.
6. If the schema is insufficient to answer, say so explicitly and ask a clarifying question.`;

function renderContextPrompt(
  blocks: KGNode[],
  others: KGNode[],
  activeTier: AnswerSourceTier,
  memoryContext: AgentMemory[],
  extraContext?: string,
): string {
  const blockSection = blocks.length > 0
    ? `## Certified blocks the user already has\n\n${blocks
        .map((b) => `- \`${b.nodeId}\` (${b.domain ?? 'unscoped'}): ${b.description ?? b.llmContext ?? '(no description)'}`)
        .join('\n')}`
    : '## Certified blocks: (none matched)';
  const otherSection = others.length > 0
    ? `\n\n## Related ${activeTier === 'semantic_layer' ? 'semantic layer' : 'dbt manifest'} context\n\n${others
        .map((n) => `- ${n.kind} \`${n.name}\`${n.domain ? ` (domain: ${n.domain})` : ''}${n.description ? ` — ${n.description}` : ''}${n.llmContext ? `\n  ${n.llmContext.replace(/\n/g, '\n  ')}` : ''}`)
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
  return `${blockSection}${otherSection}${memorySection}${extraSection}`;
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

function pickCertifiedArtifact(
  artifactHits: KGSearchHit[],
  blockHints: string[],
  kg: KGStore,
): KGSearchHit | null {
  // Hint match wins immediately: the active Skill's vocabulary points the
  // user at a specific block. We still validate it's certified.
  for (const hint of blockHints) {
    const node = kg.getNode(`block:${hint}`);
    if (node && node.status === 'certified') {
      return { node, score: 1, snippet: undefined };
    }
  }
  // Otherwise: top FTS5 hit must be certified, exceed the score threshold,
  // and not have a hard negative ratio in feedback.
  for (const hit of artifactHits) {
    if (hit.score < CERTIFIED_HIT_THRESHOLD) break;
    if (hit.node.kind === 'block') {
      if (hit.node.status !== 'certified') continue;
      const fb = kg.blockFeedbackScore(hit.node.nodeId);
      const total = fb.up + fb.down;
      if (total > 0 && fb.down / total > HARD_NEGATIVE_RATIO) continue;
    } else if (hit.node.status !== 'certified' && hit.node.certification !== 'certified') {
      continue;
    }
    return hit;
  }
  return null;
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

function buildCertifiedEvidence(input: {
  question: string;
  artifact: KGNode;
  semanticHits: KGSearchHit[];
  manifestHits: KGSearchHit[];
  considered: KGSearchHit[];
  result?: AgentResultPayload;
  executionError?: string;
  executorWasAvailable: boolean;
  citations: AgentCitation[];
  memoryContext: AgentMemory[];
}): AgentEvidence {
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
  };
}

function buildGeneratedEvidence(input: {
  question: string;
  activeTier: AnswerSourceTier;
  contextNodes: KGNode[];
  semanticHits: KGSearchHit[];
  manifestHits: KGSearchHit[];
  considered: KGSearchHit[];
  citations: AgentCitation[];
  memoryContext: AgentMemory[];
}): AgentEvidence {
  const selectedNodes = input.contextNodes.slice(0, 4);
  const semanticObjects = uniqueAssets(
    [...input.contextNodes, ...input.semanticHits.map((hit) => hit.node)]
      .filter((node) => SEMANTIC_KINDS.includes(node.kind))
      .map(assetFromNode),
  ).slice(0, 6);
  const sourceTables = uniqueAssets(
    [...input.contextNodes, ...input.manifestHits.map((hit) => hit.node)]
      .filter((node) => MANIFEST_KINDS.includes(node.kind))
      .map(assetFromNode),
  ).slice(0, 6);
  const selectedAssets = uniqueAssets(selectedNodes.map(assetFromNode)).slice(0, 4);
  const selectedSemantic = input.activeTier === 'semantic_layer' && semanticObjects.length > 0;
  return {
    route: [
      {
        tool: 'search_certified_artifacts',
        status: 'checked',
        label: 'No certified artifact was strong enough for this question',
      },
      {
        tool: 'search_semantic_layer',
        status: selectedSemantic ? 'selected' : input.semanticHits.length > 0 ? 'checked' : 'skipped',
        label: selectedSemantic ? 'Selected semantic context' : input.semanticHits.length > 0 ? 'Semantic context considered' : 'No semantic match',
      },
      {
        tool: input.activeTier === 'semantic_layer' ? 'compose_semantic_query' : 'search_dbt_manifest',
        status: 'selected',
        label: input.activeTier === 'semantic_layer' ? 'Composed SQL from semantic context' : 'Composed SQL from dbt manifest context',
      },
      {
        tool: 'validate_sql',
        status: 'checked',
        label: 'SQL is generated and requires host validation before certification',
      },
      {
        tool: 'create_draft_block',
        status: 'skipped',
        label: 'Draft block can be created for analyst review',
      },
    ],
    lineage: [
      questionLineageNode(input.question),
      ...selectedAssets.map((asset) => ({ ...asset, role: selectedSemantic ? 'semantic_object' as const : 'source_table' as const })),
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
      message: 'Generated SQL is not certified. It should be validated, reviewed, and promoted only after analyst approval.',
    },
    execution: {
      status: 'not_requested',
      message: 'Generated SQL was returned for review; execution is handled by the host after validation.',
    },
    citations: input.citations,
  };
}

function buildNoAnswerEvidence(input: {
  question: string;
  reason: string;
  artifactHits: KGSearchHit[];
  semanticHits: KGSearchHit[];
  manifestHits: KGSearchHit[];
  considered: KGSearchHit[];
  memoryContext: AgentMemory[];
}): AgentEvidence {
  return {
    route: [
      {
        tool: 'search_certified_artifacts',
        status: input.artifactHits.length > 0 ? 'checked' : 'skipped',
        label: input.artifactHits.length > 0 ? 'Certified artifacts considered but not selected' : 'No certified artifact match',
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
    businessContext: input.memoryContext.slice(0, 3).map((memory) => ({
      label: 'Memory advisory',
      value: `${memory.title}: ${memory.content}`,
      source: memory.source,
    })),
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

function assetFromNode(node: KGNode): AgentEvidenceAsset {
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    description: node.description,
    sourceTier: node.sourceTier === 'business_context' ? 'project' : node.sourceTier,
    certification: certificationForNode(node),
    provenance: node.provenance,
    sourcePath: node.sourcePath,
    owner: node.owner,
    domain: node.domain,
    status: node.status,
  };
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
