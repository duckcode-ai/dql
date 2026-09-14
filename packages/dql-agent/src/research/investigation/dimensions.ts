/**
 * WHICH DIMENSIONS TO BREAK A CHANGE DOWN BY. Governed dimensions the metric
 * can be grouped by (the semantic layer's compatibility when the host knows
 * it, the vocabulary's join reach otherwise), or, for a metric read from the
 * tables, the categorical columns of the relations its figures came from.
 * Ranked by fixed rules; an AI may choose from the ranked list, and a choice
 * is accepted only when every dimension it names is on that list.
 */
import { samePhysicalRelation } from '../../ask-pipeline/physical-binding.js';
import { fieldIdentity } from '../../ask-pipeline/policies.js';
import type { VocabularyEntry, VocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import type { InvestigationFrameV1 } from './types.js';

export const GOVERNED_DIMENSION_CAP = 6;
export const COLUMN_DIMENSION_CAP = 4;
/** With less time than this left, fewer dimensions are analysed. */
export const LOW_TIME_MS = 60_000;

export interface CandidateDimensionV1 {
  ref: string;
  label: string;
  description?: string;
  score: number;
  reasons: string[];
  source: 'semantic_layer' | 'join_reach' | 'relation_columns';
}

export interface ExcludedDimensionV1 {
  ref: string;
  label: string;
  reason: 'time_axis' | 'fixed_by_filter' | 'governed_alternative' | 'metric_column';
}

/** Roles a change can be split by: members, not keys, dates or numbers. */
const SPLITTABLE = new Set(['categorical', 'text', 'boolean', 'label']);
/** A dimension typed as a number is an amount, whatever role its name gives it. */
const NUMERIC_TYPE = /^(int|integer|bigint|smallint|decimal|numeric|number|double|float|real)/i;

const labelOf = (entry: VocabularyEntry) => (entry.label ?? entry.name).replace(/_/g, ' ');
const padded = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const named = (text: string, entry: VocabularyEntry) =>
  [entry.name.replace(/_/g, ' '), entry.label ?? ''].filter((word) => word.trim().length > 2).some((word) => text.includes(padded(word)));

export function dimensionCap(frame: Pick<InvestigationFrameV1, 'lane' | 'metric'>, remainingMs: number): number {
  const columns = frame.lane === 'ai' || frame.metric.ref.startsWith('column:');
  const cap = columns ? COLUMN_DIMENSION_CAP : GOVERNED_DIMENSION_CAP;
  return remainingMs < LOW_TIME_MS ? cap - (columns ? 1 : 2) : cap;
}

export function candidateDimensions(input: {
  vocabulary: VocabularyIndex;
  frame: Pick<InvestigationFrameV1, 'metric' | 'timeRef' | 'periodAxis' | 'baseFilters' | 'lane' | 'reading'>;
  question: string;
  /** Dimension refs the semantic layer says the metric can be grouped by. */
  compatibleRefs?: string[];
  /** The relations the headline's figures were read from (for a metric read from the tables). */
  relations?: string[];
  cap: number;
}): { candidates: CandidateDimensionV1[]; overCap: CandidateDimensionV1[]; excluded: ExcludedDimensionV1[] } {
  const { vocabulary, frame } = input;
  const metricRef = frame.metric.ratio?.numeratorRef ?? frame.metric.ref;
  const metric = vocabulary.get(metricRef) ?? vocabulary.resolve(metricRef);
  const model = metric?.model;
  const columns = frame.lane === 'ai' || metricRef.startsWith('column:');
  const identity = (ref: string) => fieldIdentity(ref, vocabulary);
  const fixed = new Set(frame.baseFilters.filter((filter) => filter.op === 'eq' && filter.values.length === 1 && filter.on !== 'aggregate').map((filter) => identity(filter.ref)));
  const axes = new Set([frame.timeRef, frame.periodAxis?.ref].filter((ref): ref is string => Boolean(ref)).map(identity));
  const metricFields = new Set([frame.metric.ref, frame.metric.ratio?.numeratorRef, frame.metric.ratio?.denominatorRef].filter((ref): ref is string => Boolean(ref)).map(identity));
  // A dimension over the column the metric sums (order_total_dim over order_total) splits the metric by its own amounts.
  const leaf = (expression: string | undefined) => expression?.replace(/"/g, '').split('.').pop()?.trim().toLowerCase();
  const metricColumn = metric?.physical?.relation ? leaf(metric.physical.column ?? metric.physical.expr) : undefined;
  const readsMetricColumn = (entry: VocabularyEntry) => Boolean(metricColumn && entry.physical?.column && metric?.physical?.relation
    && leaf(entry.physical.column) === metricColumn && samePhysicalRelation(entry.physical.relation, metric.physical.relation));

  type Pooled = { entry: VocabularyEntry; source: CandidateDimensionV1['source'] };
  let pool: Pooled[];
  if (columns) {
    const relations = input.relations?.length ? input.relations : metric?.physical?.relation ? [metric.physical.relation] : [];
    pool = vocabulary.entries
      .filter((entry) => entry.kind === 'column' && entry.physical?.relation && relations.some((relation) => samePhysicalRelation(entry.physical!.relation, relation)))
      .map((entry) => ({ entry, source: 'relation_columns' }));
  } else if (input.compatibleRefs) {
    pool = input.compatibleRefs
      .map((ref) => vocabulary.get(ref))
      .filter((entry): entry is VocabularyEntry => Boolean(entry && entry.kind === 'dimension'))
      .map((entry) => ({ entry, source: 'semantic_layer' }));
  } else {
    pool = model
      ? vocabulary.entries
        .filter((entry) => entry.kind === 'dimension' && (entry.model === model || Boolean(entry.joinReach?.includes(model))))
        .map((entry) => ({ entry, source: 'join_reach' }))
      : [];
  }

  const excluded: ExcludedDimensionV1[] = [];
  const governedFields = new Set(pool.filter(({ entry }) => entry.kind === 'dimension' && !entry.inventory).map(({ entry }) => identity(entry.ref)));
  const seen = new Set<string>();
  const kept: Pooled[] = [];
  for (const pooled of pool) {
    const { entry } = pooled;
    const field = identity(entry.ref);
    const exclude = (reason: ExcludedDimensionV1['reason']) => excluded.push({ ref: entry.ref, label: labelOf(entry), reason });
    if (axes.has(field)) { exclude('time_axis'); continue; }
    if (!entry.roles.some((role) => SPLITTABLE.has(role))) continue;
    if (NUMERIC_TYPE.test(entry.dataType ?? '') && !entry.roles.includes('boolean')) continue;
    if (metricFields.has(field) || readsMetricColumn(entry)) { exclude('metric_column'); continue; }
    if (fixed.has(field)) { exclude('fixed_by_filter'); continue; }
    if (entry.inventory && governedFields.has(field) ) { exclude('governed_alternative'); continue; }
    if (seen.has(field)) continue;
    seen.add(field);
    kept.push(pooled);
  }

  const asked = padded(`${input.question} ${frame.reading}`);
  const preferred = new Set(vocabulary.entries.flatMap((entry) => (entry.kind === 'skill' ? entry.skill?.preferredRefs ?? [] : [])));
  const guidance = padded(vocabulary.entries.filter((entry) => entry.kind === 'hint' || entry.kind === 'term').map((entry) => entry.description ?? '').join(' '));
  const guidedRefs = new Set(vocabulary.entries.flatMap((entry) => (entry.kind === 'term' ? entry.columns ?? [] : [])));
  const ranked: CandidateDimensionV1[] = kept.map(({ entry, source }) => {
    const reasons: string[] = [];
    let score = 0;
    if (named(asked, entry)) { score += 3; reasons.push('named in the question'); }
    if (preferred.has(entry.ref)) { score += 2; reasons.push('preferred by a skill'); }
    if (guidedRefs.has(entry.ref) || named(guidance, entry)) { score += 2; reasons.push('named by business guidance'); }
    const home = columns ? metric?.physical?.relation !== undefined && samePhysicalRelation(entry.physical?.relation, metric.physical.relation) : entry.model === model;
    if (home) { score += 1; reasons.push("on the metric's own model"); }
    if (entry.description) { score += 1; reasons.push('documented'); }
    // A category splits a change into a few members; a name splits it into many small ones.
    if (entry.roles.some((role) => role === 'categorical' || role === 'text' || role === 'boolean')) { score += 1; reasons.push('a category'); }
    if (entry.roles.includes('label')) { score -= 1; reasons.push('a name, often with many members'); }
    return { ref: entry.ref, label: labelOf(entry), ...(entry.description ? { description: entry.description } : {}), score, reasons, source };
  });
  ranked.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
  const cap = Math.max(0, input.cap);
  return { candidates: ranked.slice(0, cap), overCap: ranked.slice(cap), excluded };
}

/**
 * The request for an AI to choose dimensions: the question, the metric, the
 * periods and the ranked list, and nothing measured. Its reply is read by
 * `parseDimensionSelection` only.
 */
export function dimensionSelectionPrompt(input: {
  question: string;
  metricLabel: string;
  currentLabel: string;
  priorLabel: string;
  candidates: CandidateDimensionV1[];
  cap: number;
}): string {
  return [
    `A change in ${input.metricLabel} between ${input.priorLabel} and ${input.currentLabel} will be broken down by dimensions, to find where it came from.`,
    `Question: ${input.question}`,
    `Choose at most ${input.cap} of these dimensions, the ones most likely to explain the change, most likely first:`,
    ...input.candidates.map((candidate) => `- ${candidate.ref}: ${candidate.label}${candidate.description ? ` (${candidate.description.slice(0, 160)})` : ''}`),
    'Reply with JSON only, in exactly this form: {"dimensions": ["<id>", "<id>"]}. Use only ids from the list.',
  ].join('\n');
}

/** A choice is accepted only as JSON naming ids from the list, each once, at most `cap`; anything else is no choice. */
export function parseDimensionSelection(reply: string, candidates: CandidateDimensionV1[], cap: number): CandidateDimensionV1[] | undefined {
  const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const ids = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { dimensions?: unknown }).dimensions : undefined;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > cap || ids.some((id) => typeof id !== 'string')) return undefined;
  if (new Set(ids).size !== ids.length) return undefined;
  const byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  const chosen = (ids as string[]).map((id) => byRef.get(id));
  return chosen.every(Boolean) ? chosen as CandidateDimensionV1[] : undefined;
}
