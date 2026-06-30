/**
 * Optional AI enrichment for proposed draft blocks.
 *
 * Principle (spec 13): **structure deterministic, content AI-optional.** The
 * propose engine (`propose.ts`) is fully deterministic — classification, grain,
 * outputs, SQL, ranking, selection. This module is the *only* place an LLM is
 * used, and only to improve human-facing *content* — `description`, `llmContext`,
 * and example questions — for the bounded set the human approved.
 *
 * It is best-effort and isolated: every call has a timeout, any failure (no
 * provider, network, bad JSON, timeout) returns `null` and the caller keeps the
 * deterministic dbt-derived content. The engine consumes the result as plain
 * data (`ProposeOptions.enrichedBySlug`); it never calls a provider itself.
 */

import type { AgentProvider } from '../providers/types.js';

export interface EnrichFacts {
  slug: string;
  model: string;
  domain: string;
  /** dbt model description, when present. */
  description?: string;
  grain?: string;
  pattern: string;
  /** Output column names. */
  columns: string[];
  entities: string[];
  /** Semantic metric the model backs, when any. */
  metric?: string;
}

export interface EnrichedContent {
  description?: string;
  llmContext?: string;
  examples?: string[];
}

export interface EnrichOptions {
  /** Per-call timeout in ms (default 25s — local models are slow). */
  timeoutMs?: number;
  /** Max concurrent provider calls (default 4). */
  concurrency?: number;
  /**
   * Editable team guidance (the `block-authoring` skill body) the agent should
   * follow when writing block metadata — e.g. prefer semantic metrics, name by
   * business term, declare grain. Advisory: it never lets the agent invent facts.
   */
  guidance?: string;
}

const SYSTEM_PROMPT =
  'You write concise governance metadata for a certified analytics block built on a dbt model. ' +
  'You are given deterministic facts; do not invent columns, grains, or metrics that are not listed. ' +
  'Respond with ONLY a JSON object — no prose, no markdown fences.';

function buildUserPrompt(facts: EnrichFacts, guidance?: string): string {
  const lines = [
    `Model: ${facts.model}`,
    `Domain: ${facts.domain}`,
    facts.description ? `dbt description: ${facts.description}` : 'dbt description: (none)',
    facts.grain ? `Grain: one row per ${facts.grain}` : 'Grain: (unknown)',
    `Pattern: ${facts.pattern}`,
    facts.metric ? `Backs semantic metric: ${facts.metric}` : null,
    `Columns: ${facts.columns.slice(0, 30).join(', ') || '(unknown)'}`,
    facts.entities.length ? `Entities: ${facts.entities.join(', ')}` : null,
  ].filter(Boolean);
  const guidanceBlock = guidance?.trim()
    ? `Team block-authoring guidance (follow it for naming, framing, and which questions matter; never invent facts not listed above):\n${guidance.trim().slice(0, 1500)}\n\n`
    : '';
  return (
    `${lines.join('\n')}\n\n` +
    guidanceBlock +
    'Produce JSON with exactly these keys:\n' +
    '- "description": one or two sentences, business-facing, what this block answers.\n' +
    '- "llmContext": one to three sentences telling an AI agent when to use this block, its grain, and any caveat.\n' +
    '- "examples": an array of exactly 3 real business questions this block can answer (strings).\n' +
    'Only reference the facts above. Output JSON only.'
  );
}

/** Pull the first balanced JSON object out of a model response. */
function extractJson(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function coerce(parsed: unknown): EnrichedContent | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const out: EnrichedContent = {};
  if (typeof obj.description === 'string' && obj.description.trim()) out.description = obj.description.trim();
  if (typeof obj.llmContext === 'string' && obj.llmContext.trim()) out.llmContext = obj.llmContext.trim();
  if (Array.isArray(obj.examples)) {
    const qs = obj.examples
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map((q) => q.trim())
      .slice(0, 3);
    if (qs.length > 0) out.examples = qs;
  }
  return out.description || out.llmContext || out.examples ? out : null;
}

/** Enrich a single proposal. Best-effort: returns null on any failure/timeout. */
export async function enrichProposal(
  facts: EnrichFacts,
  provider: AgentProvider,
  options: EnrichOptions = {},
): Promise<EnrichedContent | null> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  try {
    const response = await provider.generate(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(facts, options.guidance) },
      ],
      { maxTokens: 400, temperature: 0.2, signal: AbortSignal.timeout(timeoutMs) },
    );
    return coerce(extractJson(response));
  } catch {
    return null;
  }
}

/**
 * Enrich many proposals with bounded concurrency. Always resolves (best-effort);
 * proposals that fail simply stay deterministic. Keyed by slug.
 */
export async function enrichProposals(
  items: EnrichFacts[],
  provider: AgentProvider,
  options: EnrichOptions = {},
): Promise<Map<string, EnrichedContent>> {
  const result = new Map<string, EnrichedContent>();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const facts = items[cursor++];
      const enriched = await enrichProposal(facts, provider, options);
      if (enriched) result.set(facts.slug, enriched);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return result;
}
