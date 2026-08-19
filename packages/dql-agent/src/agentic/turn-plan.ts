/**
 * One structured planning call, made before the analyst loop starts acting.
 *
 * The loop can already sequence its own tools, so this is not what makes it
 * work — it is what makes it legible. Without a plan the trace can only emit a
 * hardcoded "working on it" string, and the user waits in silence exactly as
 * they do today. With one, the trace names what the agent intends to establish
 * before it establishes it, which is the difference between a progress bar and
 * an analyst thinking out loud.
 *
 * It is therefore strictly optional: any failure, timeout, or malformed reply
 * returns `undefined` and the loop proceeds exactly as it would have. A
 * planning call that blocked an answer would be a bad trade.
 */

export interface AnalystTurnPlan {
  /** The question as the agent understood it. */
  restatement: string;
  /** What must be verified before SQL can be written. */
  mustEstablish: string[];
  /** The tool the agent intends to call first, when it named a real one. */
  openingTool?: string;
}

interface PlanProvider {
  generate(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    options?: Record<string, unknown>,
  ): Promise<string>;
}

const PLAN_PROMPT = `You are planning one analytical turn. Do not answer the question.
Reply with ONLY a JSON object:
{"restatement": "<the question in your own words, one sentence>",
 "mustEstablish": ["<fact to verify before writing SQL>", "..."],
 "openingTool": "<the tool you will call first>"}
List at most four things under mustEstablish. Each must be something a tool can
check — a metric exists, a column exists, a value appears in a column, two
members are compatible. Never list something you would assume.`;

/** Pull the first JSON object out of a reply that may be fenced or prefaced. */
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
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function parseAnalystTurnPlan(raw: string, toolNames: readonly string[] = []): AnalystTurnPlan | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  const restatement = typeof record.restatement === 'string' ? record.restatement.trim() : '';
  if (!restatement) return undefined;
  const mustEstablish = Array.isArray(record.mustEstablish)
    ? record.mustEstablish
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
        .slice(0, 4)
    : [];
  // Only echo a tool the model can actually call. A hallucinated name in the
  // trace would promise the user a step that never happens.
  const openingTool = typeof record.openingTool === 'string'
    && toolNames.includes(record.openingTool.trim())
    ? record.openingTool.trim()
    : undefined;
  return { restatement, mustEstablish, ...(openingTool ? { openingTool } : {}) };
}

export async function planAnalystTurn(
  provider: PlanProvider,
  question: string,
  toolNames: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AnalystTurnPlan | undefined> {
  const timeoutMs = options.timeoutMs ?? 2_500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const raw = await provider.generate(
      [
        { role: 'system', content: `${PLAN_PROMPT}\n\nTools available: ${toolNames.join(', ')}` },
        { role: 'user', content: question },
      ],
      { signal: controller.signal },
    );
    return parseAnalystTurnPlan(raw, toolNames);
  } catch {
    // Planning is decoration on a working loop. Never let it fail the turn.
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
