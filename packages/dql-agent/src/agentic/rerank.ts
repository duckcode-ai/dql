/**
 * An LLM reranker over the fused candidate list.
 *
 * Retrieval fuses lanes with RRF and then applies a hand-tuned additive score.
 * Neither reads the QUESTION: they rank by lexical overlap, vector distance,
 * and type weights, so the object that actually answers the turn can sit at
 * rank 30 behind ten near-synonyms and be cut by a top-N that never considered
 * what was asked. A cross-encoder pass is the cheapest thing that reads both
 * sides at once.
 *
 * Advisory by construction. It may REORDER what retrieval found and nothing
 * else — it cannot introduce an id retrieval did not return, so it can never
 * invent context, and any failure, timeout, or malformed reply leaves today's
 * ordering exactly as it was. That property is what makes it safe to put in
 * front of every governed answer.
 */

export interface RerankCandidate {
  id: string;
  /** One line the model ranks on: name, type, and description if there is one. */
  summary: string;
}

export interface RerankOutcome {
  /** Candidate ids, best first. Always a permutation of a subset of the input. */
  order: string[];
  /** Why the model put an id where it did, for the prompt and the trace. */
  reasons: Map<string, string>;
}

interface RerankProvider {
  generate(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    options?: Record<string, unknown>,
  ): Promise<string>;
}

const PROMPT = `Rank the candidates by how directly each one would help answer the question.

Reply with ONLY a JSON object:
{"ranked":[{"id":"<candidate id>","why":"<one short clause>"}]}

Rules:
- Use ONLY ids from the list. An id that is not in the list is discarded.
- Rank at most 15. Omit anything irrelevant rather than padding the list.
- "why" is one clause about THIS question, not a restatement of the description.`;

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

export function parseRerankReply(raw: string, allowed: ReadonlySet<string>): RerankOutcome | undefined {
  const parsed = extractJsonObject(raw);
  const ranked = (parsed as { ranked?: unknown } | undefined)?.ranked;
  if (!Array.isArray(ranked)) return undefined;
  const order: string[] = [];
  const reasons = new Map<string, string>();
  const seen = new Set<string>();
  for (const entry of ranked) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { id?: unknown; why?: unknown };
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    // An id retrieval did not return cannot enter the pack. This is the whole
    // safety property: the reranker reorders, it never introduces.
    if (!id || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const why = typeof record.why === 'string' ? record.why.trim() : '';
    if (why) reasons.set(id, why);
    if (order.length >= 15) break;
  }
  return order.length > 0 ? { order, reasons } : undefined;
}

/**
 * Reorder candidates, or return undefined and leave the caller's order alone.
 *
 * Bounded by a short timeout in the same spirit as `confirmMediumCertifiedFit`:
 * retrieval quality is worth a couple of seconds, an answer is not worth
 * waiting on a reranker that is not coming back.
 */
export async function rerankCandidates(
  provider: RerankProvider,
  question: string,
  candidates: readonly RerankCandidate[],
  options: { signal?: AbortSignal; timeoutMs?: number; maxCandidates?: number } = {},
): Promise<RerankOutcome | undefined> {
  const pool = candidates.slice(0, options.maxCandidates ?? 40);
  // Below a handful there is nothing to reorder that a top-N would get wrong.
  if (pool.length < 5) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_500);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const raw = await provider.generate(
      [
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: `Question: ${question}\n\nCandidates:\n${
            pool.map((candidate) => `- ${candidate.id} :: ${candidate.summary}`).join('\n')
          }`,
        },
      ],
      { signal: controller.signal },
    );
    return parseRerankReply(raw, new Set(pool.map((candidate) => candidate.id)));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Apply an outcome to the caller's list: ranked ids first, everything else after. */
export function applyRerank<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  outcome: RerankOutcome | undefined,
): T[] {
  if (!outcome) return [...items];
  const position = new Map(outcome.order.map((id, index) => [id, index]));
  // Anything the model omitted keeps its original order BEHIND what it ranked.
  // Dropping omissions would let one bad reply silently shrink the context.
  return [...items].sort((left, right) => {
    const leftRank = position.get(idOf(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = position.get(idOf(right)) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}
