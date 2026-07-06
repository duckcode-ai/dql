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
  const metrics = input.semanticLayer.listMetrics();
  if (metrics.length === 0) return undefined;
  const dimensions = input.semanticLayer.listDimensions();
  const timeDimensions = input.semanticLayer.listTimeDimensions?.() ?? dimensions.filter((dimension) => dimension.isTimeDimension);

  const catalog = [
    'METRICS:',
    ...metrics.slice(0, 60).map((metric) => `- ${metric.name}${metric.label && metric.label !== metric.name ? ` (${metric.label})` : ''}${metric.description ? `: ${metric.description}` : ''}`),
    'DIMENSIONS:',
    ...dimensions.slice(0, 80).map((dimension) => `- ${dimension.name}${dimension.label && dimension.label !== dimension.name ? ` (${dimension.label})` : ''}`),
    ...(timeDimensions.length > 0 ? ['TIME DIMENSIONS (use for grain):', ...timeDimensions.slice(0, 20).map((dimension) => `- ${dimension.name}`)] : []),
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
  const selectedMetrics = Array.isArray(record.metrics)
    ? record.metrics.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (selectedMetrics.length === 0) return undefined;
  const selection: SemanticMemberSelection = { metrics: selectedMetrics };
  if (Array.isArray(record.dimensions)) {
    selection.dimensions = record.dimensions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }
  const timeDim = record.timeDimension;
  if (timeDim && typeof timeDim === 'object' && typeof (timeDim as Record<string, unknown>).name === 'string' && typeof (timeDim as Record<string, unknown>).granularity === 'string') {
    selection.timeDimension = { name: (timeDim as { name: string }).name, granularity: (timeDim as { granularity: string }).granularity };
  }
  if (Array.isArray(record.filters)) {
    const filters = record.filters
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => entry && typeof entry.dimension === 'string' && Array.isArray(entry.values))
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
