import { createHash } from 'node:crypto';
import type { BlockContractV1 } from './block-contract.js';

/**
 * OPEN-WORLD ADMISSION.
 *
 * The old runtime let the model reference only the ids that survived a
 * 24-card cut, so a dimension the cut missed was reported as "not admitted"
 * and read by the user as "not modeled". The vocabulary index holds EVERY
 * object the snapshot authorizes (metrics, measures, dimensions, entities,
 * certified blocks, relations, columns) with exact ids, aliases, roles and
 * join reach, and answers three questions: does this ref exist, what did the
 * user probably mean by this word (spelling-tolerant), and which cards should
 * the model see first when the whole catalogue does not fit in a prompt.
 *
 * Discovery is broad, authority is strict: a fuzzy hit PROPOSES a candidate;
 * only an exact ref that `resolve` returns can enter an intent.
 */

export type VocabularyKind = 'metric' | 'measure' | 'dimension' | 'entity' | 'block' | 'relation' | 'column' | 'model' | 'term';
export type VocabularyRole = 'measure' | 'key' | 'label' | 'categorical' | 'time' | 'boolean' | 'numeric' | 'text' | 'certified';

export interface VocabularyEntry {
  /** Project-relative path of a block's DQL source, for hosts that compile and bind it. */
  sourcePath?: string;
  ref: string;
  kind: VocabularyKind;
  name: string;
  label?: string;
  aliases: string[];
  description?: string;
  /** Semantic model for semantic objects; `schema.table` for columns. */
  model?: string;
  roles: VocabularyRole[];
  dataType?: string;
  aggregation?: string;
  expr?: string;
  timeGrains?: string[];
  /** Models a dimension/entity can be reached from (join reachability), for semantic objects. */
  joinReach?: string[];
  certified?: boolean;
  status?: string;
  /** Certified blocks carry their structural promise. */
  contract?: BlockContractV1;
  /** Relations list their columns; blocks list their outputs. */
  columns?: string[];
  /**
   * Documented columns that decide which rows a definition counts (a
   * participation flag, a soft delete). A reader who cannot see them counts
   * rows the project excludes.
   */
  columnNotes?: string[];
  examples?: string[];
  /** The id the host's existing compilers know this object by (semantic runtime name, catalog key). */
  sourceId?: string;
  /** For a metric or measure: the time dimension ref it aggregates over (its time role). */
  timeRef?: string;
  /** For a metric: simple, ratio, derived, cumulative, conversion. */
  metricType?: string;
  /**
   * A derived metric over inputs on more than one relation: its formula and
   * the governed inputs, for the relational composer to aggregate each input
   * on its own relation and evaluate the formula afterwards.
   */
  derived?: { expr: string; inputs: Array<{ alias: string; ref: string }> };
  /** Why only the semantic engine may compute this metric (a prior-period offset, a cumulative window). */
  engineOnly?: string;
  /** For an entity: primary, foreign, unique, natural. */
  entityType?: string;
  /** How a value of this measure is displayed (currency, percent, count...). */
  displayFormat?: { kind: 'currency' | 'percent' | 'number' | 'count' | 'duration'; currency?: string; decimals?: number };
  /**
   * Physical binding for the relational tier: the relation a semantic object
   * reads, its column (dimensions, entities, plain measures) or aggregate
   * expression (metrics). Host-attached, never rendered to the model.
   */
  physical?: { relation: string; column?: string; expr?: string; aggregate?: string };
  /** Certified block source, host-only. */
  sql?: string;
}

export interface VocabularyLookupHit {
  entry: VocabularyEntry;
  score: number;
  matchedOn: 'ref' | 'name' | 'alias' | 'token' | 'fuzzy';
}

export const normalizeVocabularyText = (value: string): string =>
  value.toLowerCase().replace(/[_./:-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokensOf = (value: string): string[] => normalizeVocabularyText(value).split(' ').filter((token) => token.length > 1);
const singular = (word: string): string => word.replace(/ies$/, 'y').replace(/(ses|xes|shes|ches)$/, (m) => m.slice(0, -2)).replace(/s$/, '');

function trigrams(value: string): Set<string> {
  const padded = `  ${normalizeVocabularyText(value).replace(/ /g, '')} `;
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) grams.add(padded.slice(index, index + 3));
  return grams;
}

/** Dice coefficient over character trigrams: 'bevereage' vs 'beverage' scores about 0.7. */
export function trigramSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

const KIND_PRIORITY: Record<VocabularyKind, number> = { block: 0, metric: 1, measure: 2, dimension: 3, entity: 4, model: 5, relation: 6, column: 7, term: 8 };

export class VocabularyIndex {
  readonly entries: VocabularyEntry[];
  readonly fingerprint: string;
  private readonly byRef = new Map<string, VocabularyEntry>();
  private readonly byAlias = new Map<string, VocabularyEntry[]>();
  private readonly tokenIndex = new Map<string, Set<VocabularyEntry>>();

  constructor(entries: VocabularyEntry[]) {
    this.entries = [...entries].sort((a, b) => a.ref.localeCompare(b.ref));
    this.fingerprint = `sha256:${createHash('sha256').update(this.entries.map((entry) => `${entry.ref}|${entry.kind}|${entry.roles.join(',')}`).join('\n')).digest('hex').slice(0, 24)}`;
    for (const entry of this.entries) {
      this.byRef.set(entry.ref.toLowerCase(), entry);
      const tail = entry.ref.slice(entry.ref.indexOf(':') + 1);
      const names = new Set(
        [entry.name, entry.label ?? '', ...entry.aliases, tail, tail.split('.').pop() ?? '']
          .map(normalizeVocabularyText)
          .filter(Boolean),
      );
      for (const name of names) {
        const list = this.byAlias.get(name) ?? [];
        list.push(entry);
        this.byAlias.set(name, list);
      }
      for (const token of new Set([...names].flatMap((name) => name.split(' ')).map(singular))) {
        const bucket = this.tokenIndex.get(token) ?? new Set();
        bucket.add(entry);
        this.tokenIndex.set(token, bucket);
      }
    }
  }

  get(ref: string): VocabularyEntry | undefined {
    return this.byRef.get(ref.trim().toLowerCase());
  }

  /**
   * Turn what the model wrote into an authorized entry: an exact ref, a ref
   * missing its kind prefix (`order_item.drink_revenue`), the host's own id,
   * or a name that belongs to exactly one entry. Anything ambiguous is NOT
   * resolved.
   */
  resolve(reference: string, kinds?: VocabularyKind[]): VocabularyEntry | undefined {
    const exact = this.get(reference);
    if (exact && (!kinds || kinds.includes(exact.kind))) return exact;
    const trimmed = reference.trim().toLowerCase();
    if (!trimmed) return undefined;
    const candidates = new Set<VocabularyEntry>();
    for (const entry of this.entries) {
      if (kinds && !kinds.includes(entry.kind)) continue;
      const tail = entry.ref.slice(entry.ref.indexOf(':') + 1).toLowerCase();
      if (tail === trimmed || entry.sourceId?.toLowerCase() === trimmed) candidates.add(entry);
    }
    if (candidates.size === 1) return [...candidates][0];
    if (candidates.size > 1) return undefined;
    const named = (this.byAlias.get(normalizeVocabularyText(trimmed)) ?? []).filter((entry) => !kinds || kinds.includes(entry.kind));
    return named.length === 1 ? named[0] : undefined;
  }

  /** Spelling-tolerant discovery. Returns proposals, never authority. */
  lookup(term: string, options: { kinds?: VocabularyKind[]; limit?: number; minScore?: number } = {}): VocabularyLookupHit[] {
    const limit = options.limit ?? 8;
    const minScore = options.minScore ?? 0.42;
    const query = normalizeVocabularyText(term);
    if (!query) return [];
    const queryTokens = query.split(' ').map(singular).filter(Boolean);
    const scored = new Map<VocabularyEntry, VocabularyLookupHit>();
    const consider = (entry: VocabularyEntry, score: number, matchedOn: VocabularyLookupHit['matchedOn']) => {
      if (options.kinds && !options.kinds.includes(entry.kind)) return;
      const existing = scored.get(entry);
      if (!existing || existing.score < score) scored.set(entry, { entry, score, matchedOn });
    };
    const direct = this.get(term);
    if (direct) consider(direct, 1, 'ref');
    for (const entry of this.byAlias.get(query) ?? []) consider(entry, 0.98, normalizeVocabularyText(entry.name) === query ? 'name' : 'alias');
    for (const token of queryTokens) {
      for (const entry of this.tokenIndex.get(token) ?? []) {
        const entryTokens = new Set(tokensOf(`${entry.name} ${entry.label ?? ''} ${entry.aliases.join(' ')}`).map(singular));
        const overlap = queryTokens.filter((candidate) => entryTokens.has(candidate)).length;
        consider(entry, 0.5 + 0.45 * (overlap / Math.max(queryTokens.length, entryTokens.size)), 'token');
      }
    }
    for (const entry of this.entries) {
      if (options.kinds && !options.kinds.includes(entry.kind)) continue;
      const names = [entry.name, entry.label ?? '', ...entry.aliases].filter(Boolean);
      let best = 0;
      for (const name of names) {
        best = Math.max(best, trigramSimilarity(query, name));
        for (const token of queryTokens) if (token.length >= 4) best = Math.max(best, trigramSimilarity(token, name) * 0.95);
      }
      if (best >= minScore) consider(entry, Math.min(0.9, best), 'fuzzy');
    }
    return [...scored.values()]
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score || KIND_PRIORITY[a.entry.kind] - KIND_PRIORITY[b.entry.kind] || a.entry.ref.localeCompare(b.entry.ref))
      .slice(0, limit);
  }

  /** Nearest authorized refs for a ref that does not exist. */
  suggest(reference: string, limit = 5): VocabularyEntry[] {
    const tail = reference.includes(':') ? reference.slice(reference.indexOf(':') + 1) : reference;
    const leaf = tail.split('.').pop() ?? tail;
    const hits = this.lookup(leaf, { limit, minScore: 0.35 });
    return hits.map((hit) => hit.entry);
  }

  /**
   * Render the cards the model reads. Deterministic order (by kind, then ref)
   * so cassettes stay stable; when the whole catalogue exceeds `maxChars`,
   * the entries most related to `seeds` (the question) come first and the
   * rest is summarised as a count the model can reach through lookup.
   */
  renderCards(options: { maxChars?: number; seeds?: string[] } = {}): string {
    const maxChars = options.maxChars ?? 24_000;
    const seedScore = new Map<VocabularyEntry, number>();
    for (const seed of options.seeds ?? []) {
      for (const hit of this.lookup(seed, { limit: 40, minScore: 0.35 })) {
        seedScore.set(hit.entry, Math.max(seedScore.get(hit.entry) ?? 0, hit.score));
      }
    }
    const ordered = [...this.entries].sort((a, b) =>
      (seedScore.get(b) ?? 0) - (seedScore.get(a) ?? 0) || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.ref.localeCompare(b.ref));
    const included = new Set<VocabularyEntry>();
    let chars = 0;
    for (const entry of ordered) {
      const line = renderCard(entry);
      if (chars + line.length > maxChars) continue;
      included.add(entry);
      chars += line.length + 1;
    }
    const sections: Array<[VocabularyKind, string]> = [
      ['block', 'CERTIFIED BLOCKS (a block answers exactly the question it declares; name it as a measure ref)'],
      ['metric', 'METRICS (governed semantic layer; use as measure refs)'],
      ['measure', 'MEASURES (semantic measures; use as measure refs)'],
      ['dimension', 'DIMENSIONS (group-by, display and filter refs; the role says key, label, categorical, time, boolean)'],
      ['entity', 'ENTITY KEYS (the identity of a thing; group rankings by these and display the label beside them)'],
      ['model', 'SEMANTIC MODELS'],
      ['relation', 'PHYSICAL RELATIONS (for governed SQL when no metric fits; columns listed)'],
      ['column', 'COLUMNS'],
      ['term', 'BUSINESS TERMS'],
    ];
    const out: string[] = [];
    for (const [kind, title] of sections) {
      const rows = this.entries.filter((entry) => entry.kind === kind && included.has(entry));
      const total = this.entries.filter((entry) => entry.kind === kind).length;
      if (total === 0) continue;
      out.push(`${title}${rows.length < total ? ` (${rows.length} of ${total} shown; use lookup_vocabulary for the rest)` : ''}`);
      for (const entry of rows) out.push(renderCard(entry));
      out.push('');
    }
    return out.join('\n').trim();
  }
}

export function renderCard(entry: VocabularyEntry): string {
  const bits: string[] = [];
  if (entry.roles.length) bits.push(entry.roles.join('/'));
  if (entry.model && entry.kind !== 'relation') bits.push(`model ${entry.model}`);
  if (entry.aggregation) bits.push(entry.aggregation);
  if (entry.dataType) bits.push(entry.dataType);
  if (entry.timeGrains?.length) bits.push(`grains ${entry.timeGrains.join(',')}`);
  // The time role: which dimension a measure aggregates over. Two measures
  // under one window must agree on it.
  if (entry.timeRef) bits.push(`time ${entry.timeRef.split('.').pop()}`);
  if (entry.certified) bits.push('certified');
  // A derived or ratio metric shows its formula: what it divides decides
  // whether it is a period ratio or a lifetime one.
  const formula = (entry.metricType === 'derived' || entry.metricType === 'ratio') && entry.expr ? ` = ${entry.expr.replace(/\s+/g, ' ').slice(0, 120)}` : '';
  const description = entry.description ? ` ${entry.description.replace(/\s+/g, ' ').slice(0, entry.kind === 'term' || entry.kind === 'block' ? 400 : entry.kind === 'relation' ? 300 : 160)}` : '';
  const columns = entry.columns?.length ? ` columns: ${entry.columns.slice(0, 40).join(', ')}${entry.columns.length > 40 ? ', ...' : ''}` : '';
  const notes = entry.columnNotes?.length ? ` which rows count: ${entry.columnNotes.join('; ')}` : '';
  const scope = entry.contract?.staticScope.length
    ? ` scope: ${entry.contract.staticScope.map((p) => `${p.column} ${p.op}${p.values.length ? ` ${p.values.join('/')}` : ''}`).join(' and ')}`
    : '';
  const groupBy = entry.contract?.groupBy.length ? ` grouped by: ${entry.contract.groupBy.join(', ')}` : '';
  const limit = entry.contract?.limit ? ` limit ${entry.contract.limit}` : '';
  const examples = entry.examples?.length ? ` e.g. "${entry.examples[0]}"` : '';
  const aliases = entry.aliases.filter((alias) => normalizeVocabularyText(alias) !== normalizeVocabularyText(entry.name)).slice(0, 4);
  const aka = aliases.length ? ` aka ${aliases.join(', ')}` : '';
  return `- ${entry.ref} [${bits.join('; ')}]${formula}${description}${aka}${columns}${notes}${groupBy}${scope}${limit}${examples}`;
}

// Building from host-neutral sources.

export interface VocabularySource {
  metrics?: Array<{ name: string; model?: string; label?: string; description?: string; aggregation?: string; type?: string; expr?: string; sourceId?: string; aliases?: string[]; status?: string; timeGrains?: string[]; physical?: VocabularyEntry['physical']; aggTimeDimension?: string; displayFormat?: VocabularyEntry['displayFormat']; derived?: VocabularyEntry['derived']; engineOnly?: string }>;
  measures?: Array<{ name: string; model: string; label?: string; description?: string; aggregation?: string; expr?: string; sourceId?: string; physical?: VocabularyEntry['physical']; aggTimeDimension?: string; displayFormat?: VocabularyEntry['displayFormat'] }>;
  dimensions?: Array<{ name: string; model: string; label?: string; description?: string; dataType?: string; isTime?: boolean; timeGrains?: string[]; sourceId?: string; aliases?: string[]; reachableFrom?: string[]; physical?: VocabularyEntry['physical'] }>;
  entities?: Array<{ name: string; model: string; type: string; label?: string; description?: string; sourceId?: string; reachableFrom?: string[]; physical?: VocabularyEntry['physical'] }>;
  models?: Array<{ name: string; label?: string; description?: string; relation?: string }>;
  blocks?: Array<{ name: string; domain?: string; description?: string; certified: boolean; status?: string; contract: BlockContractV1; examples?: string[]; tags?: string[]; sourceId?: string; sql?: string; sourcePath?: string }>;
  relations?: Array<{ schema?: string; name: string; description?: string; columns: Array<{ name: string; dataType?: string; description?: string }>; sourceId?: string }>;
  terms?: Array<{ name: string; synonyms?: string[]; description?: string; metricRefs?: string[] }>;
}

const LABEL_WORD = /(^|_)(name|label|title|description|display)(_|$)/i;
const KEY_WORD = /(^|_)(id|key|uuid|code|number)$/i;
const TIME_TYPE = /(date|time|timestamp)/i;
const NUMERIC_TYPE = /(int|decimal|float|double|numeric|number|real)/i;

function columnRoles(name: string, dataType: string | undefined, isTime?: boolean): VocabularyRole[] {
  if (isTime || TIME_TYPE.test(dataType ?? '')) return ['time'];
  if (/bool/i.test(dataType ?? '') || /^is_|^has_/.test(name)) return ['boolean'];
  if (LABEL_WORD.test(name)) return ['label'];
  if (KEY_WORD.test(name)) return ['key'];
  if (NUMERIC_TYPE.test(dataType ?? '')) return ['numeric'];
  return ['categorical'];
}

const STEM_STOP = new Set(['total', 'sum', 'count', 'avg', 'average', 'num', 'number', 'of', 'per', 'the', 'all', 'distinct', 'played']);
const stems = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STEM_STOP.has(word)).map((word) => word.replace(/s$/, ''));

/**
 * The same fact at another grain. A metric defined on a season table has no
 * join to the game table that carries the calendar date, but the game table
 * usually holds the column the metric sums. Each measure is matched to the
 * target relation's columns by word stem (total_points -> points,
 * games_played -> game_id counted distinct) so a correction can say exactly
 * what to aggregate instead of asking the reader to guess.
 */
export function suggestSameGrainColumns(vocabulary: VocabularyIndex, measureRefs: string[], relation: string): Array<{ from: string; to: string; aggregation: string }> {
  const columns = vocabulary.entries.filter((entry) => entry.kind === 'column' && (entry.physical?.relation ?? entry.model) === relation);
  const out: Array<{ from: string; to: string; aggregation: string }> = [];
  for (const ref of measureRefs) {
    const entry = vocabulary.get(ref);
    if (!entry) continue;
    const words = stems(entry.name);
    if (words.length === 0) continue;
    const scored = columns
      .map((column) => ({ column, score: stems(column.name).filter((stem) => words.some((word) => stem === word || stem.startsWith(word) || word.startsWith(stem))).length }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.column.name.length - right.column.name.length);
    const best = scored[0]?.column;
    if (!best) continue;
    const counted = best.roles.includes('key') || /(^|_)(id|key)$/i.test(best.name);
    out.push({ from: ref, to: best.ref, aggregation: counted ? 'count_distinct' : (entry.aggregation === 'count_distinct' || entry.aggregation === 'count' ? 'count_distinct' : 'sum') });
  }
  return out;
}

/**
 * The documented boolean columns of a relation: the ones that say which rows a
 * definition counts. Named without a description they teach nothing, so only
 * documented ones are carried.
 */
function eligibilityNotes(columns: Array<{ name: string; dataType?: string; description?: string }>): string[] {
  return columns
    .filter((column) => column.description && columnRoles(column.name, column.dataType).includes('boolean'))
    .slice(0, 4)
    .map((column) => `${column.name} ${column.description!.replace(/\s+/g, ' ').slice(0, 120)}`);
}

/**
 * The same FIELD on another relation. A name filter bound to the season table
 * cannot restrict a metric read from the game table, but that table names its
 * players too: the repair needs to be told which column carries the same value,
 * or it will keep proposing a join nobody declared.
 */
export function suggestSameRelationFields(vocabulary: VocabularyIndex, refs: string[], relation: string): Array<{ from: string; to: string }> {
  const columns = vocabulary.entries.filter((entry) => (entry.kind === 'column' || entry.kind === 'dimension') && (entry.physical?.relation ?? entry.model) === relation);
  const out: Array<{ from: string; to: string }> = [];
  for (const ref of refs) {
    const entry = vocabulary.get(ref);
    if (!entry || entry.roles.includes('measure')) continue;
    const words = stems(entry.physical?.column ?? entry.name);
    if (words.length === 0) continue;
    const scored = columns
      .filter((column) => column.ref !== ref)
      .map((column) => ({ column, score: stems(column.physical?.column ?? column.name).filter((stem) => words.some((word) => stem === word || stem.startsWith(word) || word.startsWith(stem))).length }))
      .filter((item) => item.score > 0)
      // A label matches a label: a player NAME filter belongs on the name
      // column, never on the id that shares its stem.
      .sort((left, right) => right.score - left.score
        || Number(right.column.roles.includes('label') === entry.roles.includes('label')) - Number(left.column.roles.includes('label') === entry.roles.includes('label'))
        || left.column.name.length - right.column.name.length);
    const best = scored[0]?.column;
    if (best) out.push({ from: ref, to: best.ref });
  }
  return out;
}

export function buildVocabularyIndex(source: VocabularySource): VocabularyIndex {
  const entries: VocabularyEntry[] = [];
  for (const metric of source.metrics ?? []) {
    entries.push({
      ref: `metric:${metric.model ? `${metric.model}.` : ''}${metric.name}`,
      kind: 'metric',
      name: metric.name,
      ...(metric.label ? { label: metric.label } : {}),
      aliases: [...new Set([metric.label ?? '', ...(metric.aliases ?? [])].filter(Boolean))],
      ...(metric.description ? { description: metric.description } : {}),
      ...(metric.model ? { model: metric.model } : {}),
      roles: ['measure'],
      ...(metric.aggregation ? { aggregation: metric.aggregation } : {}),
      ...(metric.expr ? { expr: metric.expr } : {}),
      ...(metric.timeGrains?.length ? { timeGrains: metric.timeGrains } : {}),
      ...(metric.status ? { status: metric.status } : {}),
      ...(metric.sourceId ? { sourceId: metric.sourceId } : {}),
      ...(metric.physical ? { physical: metric.physical } : {}),
      ...(metric.aggTimeDimension && metric.model ? { timeRef: `dimension:${metric.model}.${metric.aggTimeDimension}` } : {}),
      ...(metric.type ? { metricType: metric.type } : {}),
      ...(metric.displayFormat ? { displayFormat: metric.displayFormat } : {}),
      ...(metric.derived ? { derived: metric.derived } : {}),
      ...(metric.engineOnly ? { engineOnly: metric.engineOnly } : {}),
    });
  }
  for (const measure of source.measures ?? []) {
    entries.push({
      ref: `measure:${measure.model}.${measure.name}`,
      kind: 'measure',
      name: measure.name,
      ...(measure.label ? { label: measure.label } : {}),
      aliases: [measure.label ?? ''].filter(Boolean),
      ...(measure.description ? { description: measure.description } : {}),
      model: measure.model,
      roles: ['measure'],
      ...(measure.aggregation ? { aggregation: measure.aggregation } : {}),
      ...(measure.expr ? { expr: measure.expr } : {}),
      ...(measure.sourceId ? { sourceId: measure.sourceId } : {}),
      ...(measure.physical ? { physical: measure.physical } : {}),
      ...(measure.aggTimeDimension ? { timeRef: `dimension:${measure.model}.${measure.aggTimeDimension}` } : {}),
      ...(measure.displayFormat ? { displayFormat: measure.displayFormat } : {}),
    });
  }
  for (const dimension of source.dimensions ?? []) {
    entries.push({
      ref: `dimension:${dimension.model}.${dimension.name}`,
      kind: 'dimension',
      name: dimension.name,
      ...(dimension.label ? { label: dimension.label } : {}),
      aliases: [...new Set([dimension.label ?? '', ...(dimension.aliases ?? [])].filter(Boolean))],
      ...(dimension.description ? { description: dimension.description } : {}),
      model: dimension.model,
      roles: columnRoles(dimension.name, dimension.dataType, dimension.isTime),
      ...(dimension.dataType ? { dataType: dimension.dataType } : {}),
      ...(dimension.timeGrains?.length ? { timeGrains: dimension.timeGrains } : {}),
      ...(dimension.reachableFrom?.length ? { joinReach: dimension.reachableFrom } : {}),
      ...(dimension.sourceId ? { sourceId: dimension.sourceId } : {}),
      ...(dimension.physical ? { physical: dimension.physical } : {}),
    });
  }
  for (const entity of source.entities ?? []) {
    entries.push({
      ref: `entity:${entity.model}.${entity.name}`,
      kind: 'entity',
      name: entity.name,
      ...(entity.label ? { label: entity.label } : {}),
      aliases: [entity.label ?? '', `${entity.name} id`, `${entity.name}_id`].filter(Boolean),
      description: `${entity.type} entity${entity.description ? `: ${entity.description}` : ''}`,
      model: entity.model,
      roles: ['key'],
      entityType: entity.type,
      ...(entity.reachableFrom?.length ? { joinReach: entity.reachableFrom } : {}),
      ...(entity.sourceId ? { sourceId: entity.sourceId } : {}),
      ...(entity.physical ? { physical: entity.physical } : {}),
    });
  }
  for (const model of source.models ?? []) {
    entries.push({
      ref: `model:${model.name}`,
      kind: 'model',
      name: model.name,
      ...(model.label ? { label: model.label } : {}),
      aliases: [model.label ?? ''].filter(Boolean),
      ...(model.description ? { description: model.description } : {}),
      roles: [],
      ...(model.relation ? { model: model.relation } : {}),
    });
  }
  for (const block of source.blocks ?? []) {
    entries.push({
      ref: `block:${block.domain ?? 'global'}.${block.name}`,
      kind: 'block',
      name: block.name,
      aliases: [block.name.replace(/_/g, ' '), ...(block.tags ?? [])],
      ...(block.description ? { description: block.description } : {}),
      ...(block.domain ? { model: block.domain } : {}),
      roles: block.certified ? ['certified'] : [],
      certified: block.certified,
      ...(block.status ? { status: block.status } : {}),
      contract: block.contract,
      columns: block.contract.outputs,
      ...(block.examples?.length ? { examples: block.examples } : {}),
      ...(block.sourceId ? { sourceId: block.sourceId } : {}),
      ...(block.sql ? { sql: block.sql } : {}),
      ...(block.sourcePath ? { sourcePath: block.sourcePath } : {}),
    });
  }
  for (const relation of source.relations ?? []) {
    const qualified = relation.schema ? `${relation.schema}.${relation.name}` : relation.name;
    entries.push({
      ref: `relation:${qualified}`,
      kind: 'relation',
      name: relation.name,
      aliases: [qualified],
      ...(relation.description ? { description: relation.description } : {}),
      model: qualified,
      roles: [],
      columns: relation.columns.map((column) => column.name),
      ...(eligibilityNotes(relation.columns).length ? { columnNotes: eligibilityNotes(relation.columns) } : {}),
      ...(relation.sourceId ? { sourceId: relation.sourceId } : {}),
    });
    for (const column of relation.columns) {
      entries.push({
        ref: `column:${qualified}.${column.name}`,
        kind: 'column',
        name: column.name,
        aliases: [],
        ...(column.description ? { description: column.description } : {}),
        model: qualified,
        roles: columnRoles(column.name, column.dataType).map((role) => (role === 'categorical' ? 'text' : role)),
        ...(column.dataType ? { dataType: column.dataType } : {}),
      });
    }
  }
  for (const term of source.terms ?? []) {
    entries.push({
      ref: `term:${term.name}`,
      kind: 'term',
      name: term.name,
      aliases: term.synonyms ?? [],
      ...(term.description ? { description: term.description } : {}),
      roles: [],
      ...(term.metricRefs?.length ? { columns: term.metricRefs } : {}),
    });
  }
  return new VocabularyIndex(entries);
}
