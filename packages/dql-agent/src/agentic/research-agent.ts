/**
 * Hypothesis-driven research planning.
 *
 * `planResearch` emits a fixed template — baseline, compare over time, break
 * down by a dimension scraped out of the question with a regex — bound to one
 * metric and frozen before any observation. That is why deep research answers
 * one question instead of telling a story: the shape of the investigation is
 * decided before the investigation starts, so nothing it learns can change what
 * it does next.
 *
 * This produces HYPOTHESES instead: falsifiable statements about why the
 * observed thing happened, each mapped to a step that would support or refute
 * it. The existing executor runs them unchanged, because the output is still a
 * `ResearchStep[]` — the strangler seam is the plan, not the runner.
 *
 * Grounding is unchanged and non-negotiable: every hypothesis must name a real
 * metric, block, or dimension from the catalog. A hypothesis about an asset
 * that does not exist cannot be investigated, and inventing one is how a
 * research dossier ends up confidently discussing a table nobody has.
 */

import type { ResearchStep } from '../research-loop.js';

/** The assets a hypothesis may reference. Nothing outside this may appear. */
export interface ResearchAssets {
  metrics: string[];
  blocks: string[];
  dimensions: string[];
}

export interface ResearchHypothesis {
  /** A falsifiable statement, not a task. */
  statement: string;
  /** Belief before evidence, 0..1 — decides what is tested first. */
  priorConfidence: number;
  /** The asset whose inspection would settle it. Must exist in ResearchAssets. */
  target: string;
  action: ResearchStep['action']['kind'];
  /** What an observation must show for the statement to hold. */
  expectation: string;
}

interface PlanProvider {
  generate(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    options?: Record<string, unknown>,
  ): Promise<string>;
}

const ACTION_KINDS: ReadonlySet<ResearchStep['action']['kind']> = new Set([
  'lookup_metric', 'lookup_block', 'breakdown', 'compare_time', 'check_lineage', 'compose_app',
]);

const PROMPT = `You plan a data investigation. Do not answer the question and do not write SQL.

Propose competing HYPOTHESES for what the data will show — falsifiable statements
about WHY, not a list of tasks. "Revenue fell because enterprise customers churned"
is a hypothesis. "Break revenue down by segment" is a task; do not write those.

Rules:
- Every hypothesis must name one asset from the catalog list you are given, exactly
  as spelled there. A hypothesis about an asset that does not exist cannot be tested.
- Propose competing explanations, not one explanation in several phrasings. If two
  hypotheses would be settled by the same observation, keep only the stronger.
- priorConfidence is your belief BEFORE evidence, 0..1. Do not make them all equal.
- expectation must state what an observation has to show for the statement to HOLD,
  so that seeing the opposite refutes it.

Reply with ONLY a JSON object:
{"hypotheses":[{"statement":"...","priorConfidence":0.6,"target":"<asset>",
  "action":"lookup_metric|lookup_block|breakdown|compare_time|check_lineage",
  "expectation":"..."}]}
Between three and six hypotheses when the catalog has enough distinct grounded
assets. If it does not, return only the grounded hypotheses; do not invent one.`;

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

/** Match a model-named asset to a real one, tolerating case and qualification. */
function resolveAsset(target: string, assets: ResearchAssets): string | undefined {
  const pool = [...assets.metrics, ...assets.blocks, ...assets.dimensions];
  const wanted = target.trim().toLowerCase();
  if (!wanted) return undefined;
  const exact = pool.find((asset) => asset.toLowerCase() === wanted);
  if (exact) return exact;
  // `orders.revenue` offered as `revenue`, and the reverse.
  return pool.find((asset) => {
    const leaf = asset.toLowerCase().split('.').at(-1) ?? '';
    return leaf === wanted || asset.toLowerCase() === wanted.split('.').at(-1);
  });
}

export function parseResearchHypotheses(raw: string, assets: ResearchAssets): ResearchHypothesis[] {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { hypotheses?: unknown }).hypotheses;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ResearchHypothesis[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const statement = typeof record.statement === 'string' ? record.statement.trim() : '';
    const expectation = typeof record.expectation === 'string' ? record.expectation.trim() : '';
    if (!statement || !expectation) continue;
    // UNGROUNDED HYPOTHESES ARE DROPPED, not repaired. A statement about an
    // asset nobody has cannot be investigated, and keeping it would put an
    // invented table into a dossier that reads as governed.
    const target = resolveAsset(typeof record.target === 'string' ? record.target : '', assets);
    if (!target) continue;
    const action = typeof record.action === 'string' && ACTION_KINDS.has(record.action as never)
      ? record.action as ResearchStep['action']['kind']
      : 'lookup_metric';
    const key = statement.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const prior = typeof record.priorConfidence === 'number' && Number.isFinite(record.priorConfidence)
      ? Math.max(0, Math.min(1, record.priorConfidence))
      : 0.5;
    out.push({ statement, priorConfidence: prior, target, action, expectation });
    if (out.length >= 6) break;
  }
  return out.sort((left, right) => right.priorConfidence - left.priorConfidence);
}

/** One structured call. Returns [] on any failure, so the caller keeps its template. */
export async function planResearchHypotheses(
  provider: PlanProvider,
  question: string,
  assets: ResearchAssets,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ResearchHypothesis[]> {
  if (assets.metrics.length === 0 && assets.blocks.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  // A signal may already be cancelled when an explicit Research executor gets
  // scheduled (for example after a client navigation races with routing).
  // `addEventListener` does not replay that event, so carry the reason into
  // the planner controller before `generate` can admit a late provider send.
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    onAbort();
    clearTimeout(timer);
    return [];
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const catalog = [
      assets.metrics.length ? `metrics: ${assets.metrics.join(', ')}` : '',
      assets.blocks.length ? `certified blocks: ${assets.blocks.join(', ')}` : '',
      assets.dimensions.length ? `dimensions: ${assets.dimensions.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const raw = await provider.generate(
      [
        { role: 'system', content: `${PROMPT}\n\nCatalog:\n${catalog}` },
        { role: 'user', content: question },
      ],
      { signal: controller.signal },
    );
    return parseResearchHypotheses(raw, assets);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Render hypotheses as the steps the existing executor already knows how to run. */
export function hypothesesToSteps(hypotheses: ResearchHypothesis[]): ResearchStep[] {
  return hypotheses.map((hypothesis) => ({
    // The thought IS the hypothesis, so the trace and the dossier show what is
    // being tested rather than which tool is being called.
    thought: hypothesis.statement,
    action: { kind: hypothesis.action, target: hypothesis.target },
    expectation: hypothesis.expectation,
  }));
}
