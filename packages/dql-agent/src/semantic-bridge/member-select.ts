/**
 * Lane-2 fallback member selection (extracted from the answer loop).
 *
 * One LLM call that picks semantic members (metrics/dimensions/grain/filters) as
 * JSON — the `query_semantic_model` contract. The compiler still owns the SQL, so
 * this keeps paraphrased metric questions on the governed tier. Returns undefined
 * on any parse/shape failure so the caller falls through to metric-first /
 * generation.
 */
import type { SemanticLayer } from '@duckcodeailabs/dql-core';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import type { ReasoningEffort } from '../providers/reasoning-effort.js';
import type { SemanticBridgeFilter, SemanticMemberSelection } from './compose.js';

export async function selectSemanticMembersViaLlm(input: {
  provider: AgentProvider;
  semanticLayer: SemanticLayer;
  question: string;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
}): Promise<SemanticMemberSelection | undefined> {
  // Show REAL metrics, not dbt measures projected into the metrics map — the
  // model shouldn't pick a raw measure when a governed metric exists. If no real
  // metric matches, fall back to the full pool so measure-backed questions work.
  const rankedRealMetrics = rankMembersForQuestion(input.semanticLayer.listMetrics(undefined, { includeMeasures: false }), input.question);
  const metrics = rankedRealMetrics.length > 0
    ? rankedRealMetrics
    : rankMembersForQuestion(input.semanticLayer.listMetrics(), input.question);
  if (metrics.length === 0) return undefined;
  const dimensions = rankMembersForQuestion(input.semanticLayer.listDimensions(), input.question);
  const rawTimeDimensions = input.semanticLayer.listTimeDimensions?.() ?? dimensions.filter((dimension) => dimension.isTimeDimension);
  const timeDimensions = rankMembersForQuestion(rawTimeDimensions, input.question);
  const visibleMetrics = metrics.slice(0, 60);

  // Only show dimensions the model can actually GROUP the candidate metrics by.
  // Showing the whole catalog let the model pick a dimension with no join path to
  // the metric, which the runtime then rejected ("does not match any group-by-
  // items") — so some questions worked and others didn't for the same metric.
  // Build the UNION of compatible dimensions across the top candidate metrics
  // (the model picks one metric, so a dim groupable by ANY candidate is valid),
  // and keep the qualified name to hand the runtime the exact group-by it wants.
  const candidateMetricNames = visibleMetrics.slice(0, 5).map((metric) => metric.name);
  const compatibleByName = new Map<string, string | undefined>();
  for (const metricName of candidateMetricNames) {
    try {
      for (const dim of input.semanticLayer.explainCompatibleDimensions([metricName]).compatible) {
        if (!compatibleByName.has(dim.name)) compatibleByName.set(dim.name, dim.qualifiedName);
      }
    } catch { /* compatibility is best-effort; fall back to the full list below */ }
  }
  const restrictToCompatible = compatibleByName.size > 0;
  const keepDimension = (name: string): boolean => !restrictToCompatible || compatibleByName.has(name);
  const visibleDimensions = dimensions.filter((dimension) => keepDimension(dimension.name)).slice(0, 80);
  const visibleTimeDimensions = timeDimensions.filter((dimension) => keepDimension(dimension.name)).slice(0, 20);
  // Real per-column grains so the model picks a grain the column actually
  // supports (a month-grain column cannot be sliced by day).
  const grainsFor = (dimension: typeof visibleTimeDimensions[number]): string[] =>
    input.semanticLayer.getTimeDimension?.(dimension.name)?.granularities ?? [];

  const catalog = [
    'METRICS:',
    ...visibleMetrics.map((metric) => `- ${metric.name}${metric.label && metric.label !== metric.name ? ` (${metric.label})` : ''}${metric.description ? `: ${metric.description}` : ''}`),
    restrictToCompatible
      ? 'DIMENSIONS (only those groupable by the metrics above — do not use any other):'
      : 'DIMENSIONS:',
    ...visibleDimensions.map((dimension) => `- ${dimension.name}${dimension.label && dimension.label !== dimension.name ? ` (${dimension.label})` : ''}`),
    ...(visibleTimeDimensions.length > 0 ? ['TIME DIMENSIONS (use for grain):', ...visibleTimeDimensions.map((dimension) => {
      const grains = grainsFor(dimension);
      return `- ${dimension.name}${grains.length > 0 ? ` [grains: ${grains.join(', ')}]` : ''}`;
    })] : []),
  ].join('\n');

  const messages: AgentMessage[] = [
    {
      role: 'system',
      content: [
        'You select governed semantic members to answer an analytics question. Choose ONLY from the metrics and dimensions listed — never invent names.',
        'Respond with a SINGLE json object, no prose, no code fences other than one ```json block:',
        '{"metrics": string[], "dimensions"?: string[], "timeDimension"?: {"name": string, "granularity": "day"|"week"|"month"|"quarter"|"year"}, "filters"?: [{"dimension": string, "operator": "equals"|"in", "values": string[]}], "limit"?: number}',
        'If no listed metric can answer the question, return {"metrics": []}.',
      ].join('\n'),
    },
    { role: 'user', content: `Question: ${input.question}\n\nAvailable governed members:\n${catalog}\n\nReturn the member selection as JSON.` },
  ];

  let raw: string;
  try {
    raw = await input.provider.generate(messages, { signal: input.signal, reasoningEffort: input.reasoningEffort });
  } catch {
    return undefined;
  }
  const parsed = extractFirstJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  // Validate against the exact bounded cards shown to the provider, not the
  // complete catalog. A real-but-unseen member is still an invented selection
  // for this call and must be rejected at the resolver boundary.
  const metricNames = new Set(visibleMetrics.map((metric) => metric.name));
  const dimensionNames = new Set(visibleDimensions.map((dimension) => dimension.name));
  const timeDimensionNames = new Set(visibleTimeDimensions.map((dimension) => dimension.name));
  const selectedMetrics = Array.isArray(record.metrics)
    ? record.metrics.filter((value): value is string => typeof value === 'string' && metricNames.has(value))
    : [];
  if (selectedMetrics.length === 0) return undefined;
  const selection: SemanticMemberSelection = { metrics: selectedMetrics };
  if (Array.isArray(record.dimensions)) {
    selection.dimensions = record.dimensions.filter((value): value is string => typeof value === 'string' && dimensionNames.has(value));
  }
  const timeDim = record.timeDimension;
  if (timeDim && typeof timeDim === 'object'
    && typeof (timeDim as Record<string, unknown>).name === 'string'
    && timeDimensionNames.has((timeDim as { name: string }).name)
    && typeof (timeDim as Record<string, unknown>).granularity === 'string') {
    selection.timeDimension = { name: (timeDim as { name: string }).name, granularity: (timeDim as { granularity: string }).granularity };
  }
  if (Array.isArray(record.filters)) {
    const filters = record.filters
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => entry && typeof entry.dimension === 'string' && dimensionNames.has(entry.dimension) && Array.isArray(entry.values))
      .map((entry) => ({
        dimension: entry.dimension as string,
        operator: (entry.operator === 'in' ? 'in' : 'equals') as SemanticBridgeFilter['operator'],
        values: (entry.values as unknown[]).filter((value): value is string => typeof value === 'string'),
      }))
      .filter((filter) => filter.values.length > 0);
    if (filters.length > 0) selection.filters = filters;
  }
  if (typeof record.limit === 'number' && Number.isFinite(record.limit) && record.limit > 0) {
    selection.limit = Math.floor(record.limit);
  }
  return selection;
}

function rankMembersForQuestion<T extends { name: string; label?: string; description?: string }>(
  members: T[],
  question: string,
): T[] {
  const terms = Array.from(new Set((question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length > 1 && !SEMANTIC_SELECTION_STOPWORDS.has(term))));
  if (terms.length === 0) return [...members].sort((left, right) => left.name.localeCompare(right.name));
  return members
    .map((member) => {
      const normalizedName = member.name.toLowerCase().replace(/[_.-]+/g, ' ');
      const label = member.label?.toLowerCase() ?? '';
      const description = member.description?.toLowerCase() ?? '';
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        if (normalizedName === term || label === term) {
          score += 12;
          matched += 1;
        } else if (normalizedName.includes(term) || label.includes(term)) {
          score += 5;
          matched += 1;
        } else if (description.includes(term)) {
          score += 1;
          matched += 1;
        }
      }
      return { member, score: score + matched / Math.max(terms.length, 1) };
    })
    .sort((left, right) => right.score - left.score || left.member.name.localeCompare(right.member.name))
    .map((entry) => entry.member);
}

const SEMANTIC_SELECTION_STOPWORDS = new Set([
  'what', 'which', 'who', 'show', 'give', 'tell', 'find', 'the', 'a', 'an', 'our', 'my',
  'is', 'are', 'was', 'were', 'of', 'for', 'in', 'on', 'to', 'by', 'and', 'or',
  'top', 'bottom', 'highest', 'lowest', 'total', 'value', 'values', 'amount',
]);

/** Extract the first balanced JSON object from model text (tolerant of fences/prose). */
export function extractFirstJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
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
