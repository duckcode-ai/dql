/**
 * Deterministic conversation working state: the entities / measures / dimensions /
 * filters "in play" across turns, plus explicit topic-relation classification
 * (continuation | refinement | shift | return).
 *
 * This replaces regex guesswork with state: a topic SHIFT deterministically
 * clears carried filters (stale-context protection), and a RETURN to a prior
 * topic restores its filters and source block.
 */

import type { ConversationTurn } from './session-store.js';

export type TopicRelation = 'continuation' | 'refinement' | 'shift' | 'return';

export interface ConversationTopicFrame {
  topicKey: string;
  filters: string[];
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  measures: string[];
  dimensions: string[];
}

export interface ConversationWorkingState {
  entities: string[];
  measures: string[];
  dimensions: string[];
  filters: Array<{ value: string; sourceTurnId: string }>;
  timeframe?: string;
  limit?: number;
  sourceCertifiedBlock?: string;
  lastContextPackId?: string;
  lastResultColumns?: string[];
  lastResultDimensionValues?: Record<string, string[]>;
  /** Normalized entity+measure key of the CURRENT topic, for shift detection. */
  topicKey?: string;
  /** Small ring of prior topics so a "return" can restore filters/block. */
  priorTopics?: ConversationTopicFrame[];
}

const MAX_TERMS = 12;
const MAX_FILTERS = 16;
const MAX_PRIOR_TOPICS = 4;

/** Shape of the per-turn contract we read (the plan's requestedShape, stored loosely). */
interface TurnShape {
  entities: string[];
  measures: string[];
  dimensions: string[];
  filters: string[];
  timeframe?: string;
  limit?: number;
}

export function emptyWorkingState(): ConversationWorkingState {
  return { entities: [], measures: [], dimensions: [], filters: [] };
}

export function parseWorkingState(raw: Record<string, unknown> | undefined): ConversationWorkingState {
  if (!raw) return emptyWorkingState();
  return {
    entities: stringArray(raw.entities),
    measures: stringArray(raw.measures),
    dimensions: stringArray(raw.dimensions),
    filters: filterArray(raw.filters),
    timeframe: optionalString(raw.timeframe),
    limit: typeof raw.limit === 'number' ? raw.limit : undefined,
    sourceCertifiedBlock: optionalString(raw.sourceCertifiedBlock),
    lastContextPackId: optionalString(raw.lastContextPackId),
    lastResultColumns: raw.lastResultColumns ? stringArray(raw.lastResultColumns) : undefined,
    lastResultDimensionValues: stringRecord(raw.lastResultDimensionValues),
    topicKey: optionalString(raw.topicKey),
    priorTopics: Array.isArray(raw.priorTopics)
      ? raw.priorTopics.map(parseTopicFrame).filter((frame): frame is ConversationTopicFrame => Boolean(frame)).slice(0, MAX_PRIOR_TOPICS)
      : undefined,
  };
}

/**
 * Fold a completed turn into the working state and classify how it relates to
 * the ongoing topic. Pure and deterministic — safe to re-run.
 */
export function reduceWorkingState(
  prev: ConversationWorkingState,
  turn: ConversationTurn,
): { state: ConversationWorkingState; topicRelation: TopicRelation } {
  const shape = shapeFromTurn(turn);
  const newKey = topicKeyFor(shape);
  const relation = classifyTopicRelation(prev, shape, newKey);

  if (relation === 'shift') {
    // Stale-context protection: a new topic starts with a CLEAN filter slate.
    // The outgoing topic is remembered so a later "return" can restore it.
    const priorTopics = prev.topicKey
      ? [frameFromState(prev), ...(prev.priorTopics ?? [])].slice(0, MAX_PRIOR_TOPICS)
      : prev.priorTopics;
    return {
      topicRelation: relation,
      state: {
        entities: shape.entities.slice(0, MAX_TERMS),
        measures: shape.measures.slice(0, MAX_TERMS),
        dimensions: shape.dimensions.slice(0, MAX_TERMS),
        filters: shape.filters.map((value) => ({ value, sourceTurnId: turn.id })).slice(0, MAX_FILTERS),
        timeframe: shape.timeframe,
        limit: shape.limit,
        sourceCertifiedBlock: turn.sourceCertifiedBlock,
        lastContextPackId: turn.contextPackId,
        lastResultColumns: turn.result?.columns,
        lastResultDimensionValues: turn.result?.dimensionValues,
        topicKey: newKey || undefined,
        priorTopics,
      },
    };
  }

  if (relation === 'return') {
    const returned = (prev.priorTopics ?? []).find((frame) => overlaps(frame.topicKey, newKey) >= 0.5);
    const remaining = (prev.priorTopics ?? []).filter((frame) => frame !== returned);
    const currentFrame = prev.topicKey ? [frameFromState(prev)] : [];
    return {
      topicRelation: relation,
      state: {
        entities: merge(shape.entities, returned?.topicKey.split('|') ?? []),
        measures: merge(shape.measures, returned?.measures ?? []),
        dimensions: merge(shape.dimensions, returned?.dimensions ?? []),
        filters: [
          ...(returned?.filters ?? []).map((value) => ({ value, sourceTurnId: turn.id })),
          ...shape.filters.map((value) => ({ value, sourceTurnId: turn.id })),
        ].slice(0, MAX_FILTERS),
        timeframe: shape.timeframe ?? prev.timeframe,
        limit: shape.limit ?? prev.limit,
        sourceCertifiedBlock: turn.sourceCertifiedBlock ?? returned?.sourceCertifiedBlock,
        lastContextPackId: turn.contextPackId ?? returned?.contextPackId,
        lastResultColumns: turn.result?.columns ?? prev.lastResultColumns,
        lastResultDimensionValues: turn.result?.dimensionValues ?? prev.lastResultDimensionValues,
        topicKey: returned?.topicKey ?? newKey ?? prev.topicKey,
        priorTopics: [...currentFrame, ...remaining].slice(0, MAX_PRIOR_TOPICS),
      },
    };
  }

  // continuation / refinement: accumulate.
  return {
    topicRelation: relation,
    state: {
      entities: merge(prev.entities, shape.entities),
      measures: merge(prev.measures, shape.measures),
      dimensions: merge(prev.dimensions, shape.dimensions),
      filters: mergeFilters(prev.filters, shape.filters.map((value) => ({ value, sourceTurnId: turn.id }))),
      timeframe: shape.timeframe ?? prev.timeframe,
      limit: shape.limit ?? prev.limit,
      sourceCertifiedBlock: turn.sourceCertifiedBlock ?? prev.sourceCertifiedBlock,
      lastContextPackId: turn.contextPackId ?? prev.lastContextPackId,
      lastResultColumns: turn.result?.columns ?? prev.lastResultColumns,
      lastResultDimensionValues: turn.result?.dimensionValues ?? prev.lastResultDimensionValues,
      topicKey: prev.topicKey && newKey && prev.topicKey !== newKey
        ? mergeTopicKeys(prev.topicKey, newKey)
        : prev.topicKey ?? newKey ?? undefined,
      priorTopics: prev.priorTopics,
    },
  };
}

function classifyTopicRelation(
  prev: ConversationWorkingState,
  shape: TurnShape,
  newKey: string,
): TopicRelation {
  if (!prev.topicKey) return 'continuation';
  if (!newKey) {
    // No topical signal in the new turn: filters/limit-only turns narrow the
    // current topic (refinement); a bare deictic follow-up just continues it.
    return shape.filters.length > 0 || shape.limit !== undefined ? 'refinement' : 'continuation';
  }
  const overlap = overlaps(prev.topicKey, newKey);
  if (overlap >= 0.5) return 'continuation';
  if (overlap > 0) return 'refinement';
  const returned = (prev.priorTopics ?? []).some((frame) => overlaps(frame.topicKey, newKey) >= 0.5);
  if (returned) return 'return';
  // Zero overlap with the current topic: filters/limit-only turns are refinements;
  // a turn with its own entities/measures is a genuine shift.
  if (shape.entities.length === 0 && shape.measures.length === 0) return 'refinement';
  return 'shift';
}

function shapeFromTurn(turn: ConversationTurn): TurnShape {
  const contract = turn.contract ?? {};
  const topN = contract.topN;
  return {
    entities: stringArray(contract.entities),
    measures: stringArray(contract.measures),
    dimensions: stringArray(contract.dimensions),
    filters: stringArray(contract.filters),
    timeframe: optionalString(contract.timeframe),
    limit: typeof topN === 'number'
      ? topN
      : topN && typeof topN === 'object' && typeof (topN as { n?: unknown }).n === 'number'
        ? (topN as { n: number }).n
        : undefined,
  };
}

function topicKeyFor(shape: TurnShape): string {
  return Array.from(new Set([
    ...shape.entities.map(normalizeTerm),
    ...shape.measures.map(normalizeTerm),
  ].filter(Boolean))).sort().join('|');
}

/** Jaccard overlap of two topic keys ('|'-joined normalized term sets). */
function overlaps(a: string, b: string): number {
  const setA = new Set(a.split('|').filter(Boolean));
  const setB = new Set(b.split('|').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const term of setA) if (setB.has(term)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

function frameFromState(state: ConversationWorkingState): ConversationTopicFrame {
  return {
    topicKey: state.topicKey ?? '',
    filters: state.filters.map((filter) => filter.value),
    sourceCertifiedBlock: state.sourceCertifiedBlock,
    contextPackId: state.lastContextPackId,
    measures: state.measures,
    dimensions: state.dimensions,
  };
}

function parseTopicFrame(raw: unknown): ConversationTopicFrame | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const topicKey = optionalString(record.topicKey);
  if (!topicKey) return undefined;
  return {
    topicKey,
    filters: stringArray(record.filters),
    sourceCertifiedBlock: optionalString(record.sourceCertifiedBlock),
    contextPackId: optionalString(record.contextPackId),
    measures: stringArray(record.measures),
    dimensions: stringArray(record.dimensions),
  };
}

function mergeTopicKeys(a: string, b: string): string {
  return Array.from(new Set([...a.split('|'), ...b.split('|')].filter(Boolean))).sort().slice(0, 8).join('|');
}

function merge(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b].map(normalizeTerm).filter(Boolean))).slice(0, MAX_TERMS);
}

function mergeFilters(
  prev: Array<{ value: string; sourceTurnId: string }>,
  next: Array<{ value: string; sourceTurnId: string }>,
): Array<{ value: string; sourceTurnId: string }> {
  const seen = new Set<string>();
  const out: Array<{ value: string; sourceTurnId: string }> = [];
  for (const filter of [...prev, ...next]) {
    const key = filter.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(filter);
  }
  return out.slice(0, MAX_FILTERS);
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_ ]+/g, '').replace(/s$/, '').trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function filterArray(value: unknown): Array<{ value: string; sourceTurnId: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const filterValue = optionalString(record.value);
    if (!filterValue) return [];
    return [{ value: filterValue, sourceTurnId: optionalString(record.sourceTurnId) ?? '' }];
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringRecord(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const values = stringArray(raw);
    if (values.length > 0) out[key] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
