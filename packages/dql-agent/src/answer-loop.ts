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
import type { KGNode, KGSearchHit } from './kg/types.js';
import type { AgentProvider, AgentMessage } from './providers/types.js';
import type { Skill } from './skills/loader.js';
import { buildSkillsPrompt } from './skills/loader.js';

export type AnswerKind = 'certified' | 'uncertified' | 'no_answer';

export interface AgentCitation {
  nodeId: string;
  kind: KGNode['kind'];
  name: string;
  /** Frozen-in-time SHA at the moment of indexing. */
  gitSha?: string;
}

export interface AgentAnswer {
  kind: AnswerKind;
  /** Final answer text (NL summary). */
  text: string;
  /** Certified path: the matched block — caller runs its SQL. */
  block?: KGNode;
  /** Uncertified path: the LLM-proposed SQL the analyst should review. */
  proposedSql?: string;
  /** Suggested viz type for the proposed SQL (line/bar/single_value/...). */
  suggestedViz?: string;
  citations: AgentCitation[];
  /** Provider name used (for telemetry / UI badge). */
  providerUsed?: string;
  /** Top KG hits the loop considered, useful for the UI's "we considered" panel. */
  considered: KGSearchHit[];
}

export interface AnswerLoopInput {
  question: string;
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
  /** Optional AbortSignal forwarded to the provider. */
  signal?: AbortSignal;
}

const CERTIFIED_HIT_THRESHOLD = 0.18;
const HARD_NEGATIVE_RATIO = 0.5;

export async function answer(input: AnswerLoopInput): Promise<AgentAnswer> {
  const { question, userId, domain, provider, kg, skills = [], blockHints = [] } = input;

  const considered = kg.search({
    query: question,
    domain,
    limit: 10,
  });

  // Stage 1: certified-block match
  const blockHits = considered.filter((h) => h.node.kind === 'block');
  const blockHit = pickCertifiedBlock(blockHits, blockHints, kg);
  if (blockHit) {
    return {
      kind: 'certified',
      text: composeCertifiedAnswer(blockHit.node, question),
      block: blockHit.node,
      citations: [
        {
          nodeId: blockHit.node.nodeId,
          kind: blockHit.node.kind,
          name: blockHit.node.name,
          gitSha: blockHit.node.gitSha,
        },
      ],
      considered,
      providerUsed: provider.name,
    };
  }

  // Stage 2: uncertified — gather context, ask the LLM
  const contextNodes = considered.slice(0, 6).map((h) => h.node);
  const contextBlocks = contextNodes.filter((n) => n.kind === 'block');
  const contextOther = contextNodes.filter((n) => n.kind !== 'block');

  const messages: AgentMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  const skillsPrompt = buildSkillsPrompt(skills, userId ?? null);
  if (skillsPrompt) messages.push({ role: 'system', content: skillsPrompt });

  messages.push({
    role: 'system',
    content: renderContextPrompt(contextBlocks, contextOther),
  });
  messages.push({ role: 'user', content: question });

  let proposed = '';
  try {
    proposed = await provider.generate(messages, { signal: input.signal });
  } catch (err) {
    return {
      kind: 'no_answer',
      text: `Provider error: ${(err as Error).message}`,
      citations: [],
      considered,
      providerUsed: provider.name,
    };
  }

  const parsed = parseProposal(proposed);
  if (!parsed.sql) {
    return {
      kind: 'no_answer',
      text: parsed.text || 'No answer (the model declined to propose SQL).',
      citations: [],
      considered,
      providerUsed: provider.name,
    };
  }

  return {
    kind: 'uncertified',
    text: parsed.text,
    proposedSql: parsed.sql,
    suggestedViz: parsed.viz ?? 'table',
    citations: contextNodes.slice(0, 4).map((n) => ({
      nodeId: n.nodeId,
      kind: n.kind,
      name: n.name,
      gitSha: n.gitSha,
    })),
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

function renderContextPrompt(blocks: KGNode[], others: KGNode[]): string {
  const blockSection = blocks.length > 0
    ? `## Certified blocks the user already has\n\n${blocks
        .map((b) => `- \`${b.nodeId}\` (${b.domain ?? 'unscoped'}): ${b.description ?? b.llmContext ?? '(no description)'}`)
        .join('\n')}`
    : '## Certified blocks: (none matched)';
  const otherSection = others.length > 0
    ? `\n\n## Related semantic + warehouse context\n\n${others
        .map((n) => `- ${n.kind} \`${n.name}\`${n.domain ? ` (domain: ${n.domain})` : ''}${n.description ? ` — ${n.description}` : ''}`)
        .join('\n')}`
    : '';
  return `${blockSection}${otherSection}`;
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

function pickCertifiedBlock(
  blockHits: KGSearchHit[],
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
  for (const hit of blockHits) {
    if (hit.score < CERTIFIED_HIT_THRESHOLD) break;
    if (hit.node.status !== 'certified') continue;
    const fb = kg.blockFeedbackScore(hit.node.nodeId);
    const total = fb.up + fb.down;
    if (total > 0 && fb.down / total > HARD_NEGATIVE_RATIO) continue;
    return hit;
  }
  return null;
}

function composeCertifiedAnswer(block: KGNode, question: string): string {
  const desc = block.description ?? block.llmContext ?? '';
  const tag = block.gitSha ? ` · ${block.gitSha.slice(0, 8)}` : '';
  return `Answered by certified block **${block.name}**${tag}.\n\n${desc || 'Run the block to see the result.'}`
    + `\n\n_Question:_ ${question}`;
}
