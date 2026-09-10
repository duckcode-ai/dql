import type { AnalyticalIntentV1, IntentPredicate } from './intent.js';
import type { PreparedRefusal } from './prepare/types.js';
import { applySelectedMeaning } from './resolve-intent.js';
import type { VocabularyEntry, VocabularyIndex } from './vocabulary.js';

/**
 * TYPED POLICIES ARE ENFORCED; PROSE IS GUIDANCE (SKILL-004).
 *
 * A selected skill may declare an analytical policy — the time role a metric
 * is reported on, which calendar, whether a running period counts, how two
 * periods are aligned, which period a ranking uses — and required filters.
 * Sending those words to the model proves nothing about whether it followed
 * them, so every field that can be enforced deterministically is enforced
 * here, on the typed intent, after the interpreter has read the question and
 * before anything is prepared. A required filter that cannot be bound to a
 * governed ref is a typed refusal, never a silent predicate and never a
 * silent omission. Every effect is written to the intent's provenance and to
 * the receipt, and a field this cannot yet enforce is recorded as such rather
 * than pretended.
 */

export interface PolicyEffect { policyId: string; field: string; effect: string }

export interface PolicyOutcome {
  applied: PolicyEffect[];
  requiredFilters: string[];
  gaps: string[];
  refusal?: PreparedRefusal;
}

const FILTER_KINDS = ['dimension', 'entity', 'column'] as const;
const REQUIRED_FILTER = /^\s*([A-Za-z_][\w:.]*)\s*(==|=|!=|<>|>=|<=|>|<|not in|in)\s*(.+?)\s*$/i;
const BARE_FLAG = /^\s*([A-Za-z_][\w:.]*)\s*$/;
const OPS: Record<string, IntentPredicate['op']> = { '=': 'eq', '==': 'eq', '!=': 'neq', '<>': 'neq', '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt', in: 'in', 'not in': 'not_in' };

function literal(value: string): string | number | boolean {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * THE FIELD BEHIND A REF. A semantic dimension, a cube dimension and a
 * physical column can all spell the same warehouse column; a policy is about
 * the column, so two refs that bind to one `relation.column` are one field.
 * A ref with no physical binding is its own field.
 */
export function fieldIdentity(ref: string, vocabulary: VocabularyIndex): string {
  const entry = vocabulary.get(ref);
  // One field is `schema.table.column`: a database prefix (`db.schema.table.column`)
  // names the same column, so the identity keeps the last three parts.
  const canonical = (parts: string[]) => parts.slice(-3).join('.').toLowerCase();
  if (entry?.physical?.relation && entry.physical.column) return canonical([...entry.physical.relation.replace(/"/g, '').split('.'), entry.physical.column.replace(/"/g, '')]);
  // A column ref IS its field: `column:<schema.table>.<column>`.
  if ((entry?.kind ?? ref.split(':')[0]) === 'column') return canonical(ref.slice(ref.indexOf(':') + 1).replace(/"/g, '').split('.'));
  return ref.toLowerCase();
}

/**
 * Resolve a policy's field name: an exact ref, else the one entry the name
 * matches, else — when several entries spell the same physical field — that
 * field's first entry. Several entries on DIFFERENT fields are ambiguous, and
 * the problem names them, so an author picks one instead of reading "no
 * governed dimension" about a column that plainly exists.
 */
function resolvePolicyField(name: string, vocabulary: VocabularyIndex): { entry: VocabularyEntry } | { problem: string } {
  const exact = vocabulary.resolve(name, [...FILTER_KINDS]);
  if (exact) return { entry: exact };
  const trimmed = name.trim().toLowerCase();
  const candidates = vocabulary.entries.filter((entry) => FILTER_KINDS.includes(entry.kind as typeof FILTER_KINDS[number]) && (
    entry.ref.slice(entry.ref.indexOf(':') + 1).toLowerCase() === trimmed
    || entry.name.toLowerCase() === trimmed
    || entry.sourceId?.toLowerCase() === trimmed
    || (entry.kind === 'column' && entry.ref.toLowerCase().endsWith(`.${trimmed}`))
    || entry.aliases.some((alias) => alias.toLowerCase() === trimmed)
  ));
  if (candidates.length === 0) return { problem: `"${name}" names no governed dimension, entity or column exactly` };
  const fields = new Set(candidates.map((entry) => fieldIdentity(entry.ref, vocabulary)));
  // One field under several names: the governed dimension is the ref to bind, the raw column the last resort.
  const rank = (entry: VocabularyEntry) => entry.kind === 'dimension' ? 0 : entry.kind === 'entity' ? 1 : 2;
  if (fields.size === 1) return { entry: [...candidates].sort((left, right) => rank(left) - rank(right))[0]! };
  return { problem: `"${name}" is ambiguous: it names ${candidates.map((entry) => `${entry.ref}${entry.physical?.column ? ` (${entry.physical.relation}.${entry.physical.column})` : ''}`).join(', ')}; write the policy with one of those refs` };
}

/** Parse "<ref or name> <op> <value>" (or a bare boolean flag) into a predicate bound to a governed ref, or say why not. */
export function bindRequiredFilter(text: string, vocabulary: VocabularyIndex): { predicate: IntentPredicate } | { problem: string } {
  const bare = BARE_FLAG.exec(text);
  const match = bare ? null : REQUIRED_FILTER.exec(text);
  const name = bare?.[1] ?? match?.[1];
  if (!name) return { problem: `"${text}" is not a filter this host can read (expected <field> <op> <value>)` };
  const resolved = resolvePolicyField(name, vocabulary);
  if ('problem' in resolved) return resolved;
  const entry = resolved.entry;
  if (bare) return { predicate: { ref: entry.ref, op: 'eq', values: [true], source: 'question' } };
  const op = OPS[match![2]!.toLowerCase()];
  if (!op) return { problem: `"${match![2]}" is not an operator this host can read` };
  const raw = match![3]!.trim();
  const values = op === 'in' || op === 'not_in'
    ? raw.replace(/^\(|\)$/g, '').split(',').map((part) => literal(part))
    : [literal(raw)];
  return { predicate: { ref: entry.ref, op, values, source: 'question' } };
}

/** How an existing restriction relates to a required one on the same field. */
export function comparePredicates(existing: IntentPredicate, required: IntentPredicate): 'equal' | 'stronger' | 'contradicts' | 'unrelated' {
  const norm = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : value;
  const ev = existing.values.map(norm); const rv = required.values.map(norm);
  const setEq = ev.length === rv.length && ev.every((value) => rv.includes(value));
  const eqLike = (op: string) => op === 'eq' || op === 'in';
  const neqLike = (op: string) => op === 'neq' || op === 'not_in';
  const rangeLike = (op: string) => op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte';
  // The semantics are set intersection: the rule and the question both hold.
  // An empty intersection is a contradiction; a question already inside the
  // rule needs nothing added; anything else applies both, which IS the
  // intersection ("EMEA or APAC" under "not APAC" is EMEA, not a refusal).
  if (eqLike(existing.op) && eqLike(required.op)) {
    if (setEq) return 'equal';
    if (ev.every((value) => rv.includes(value))) return 'stronger';
    if (ev.some((value) => rv.includes(value))) return 'unrelated';
    return 'contradicts';
  }
  if (neqLike(existing.op) && eqLike(required.op)) return rv.every((value) => ev.includes(value)) ? 'contradicts' : 'unrelated';
  if (eqLike(existing.op) && neqLike(required.op)) {
    if (ev.every((value) => rv.includes(value))) return 'contradicts';
    return ev.some((value) => rv.includes(value)) ? 'unrelated' : 'stronger';
  }
  if (neqLike(existing.op) && neqLike(required.op)) return setEq ? 'equal' : 'unrelated';
  // Ranges: `score >= 10` against `score < 10` is empty; `score > 20` is inside it.
  if ((rangeLike(existing.op) || eqLike(existing.op)) && (rangeLike(required.op) || eqLike(required.op)) && (rangeLike(existing.op) || rangeLike(required.op))) {
    const a = intervalOf(existing); const b = intervalOf(required);
    if (a && b) {
      if (!intervalsOverlap(a, b)) return 'contradicts';
      if (intervalWithin(a, b)) return intervalWithin(b, a) ? 'equal' : 'stronger';
      return 'unrelated';
    }
    // A list of points against a range: none inside is empty, all inside is already met.
    if (eqLike(existing.op) && b) {
      const points = ev.map(scalarOf);
      if (points.every((point) => point !== undefined)) {
        const inside = points.filter((point) => intervalWithin({ lo: point!, hi: point!, loOpen: false, hiOpen: false }, b));
        return inside.length === 0 ? 'contradicts' : inside.length === points.length ? 'stronger' : 'unrelated';
      }
    }
    if (eqLike(required.op) && a) {
      const points = rv.map(scalarOf);
      if (points.every((point) => point !== undefined)) return points.some((point) => intervalWithin({ lo: point!, hi: point!, loOpen: false, hiOpen: false }, a)) ? 'unrelated' : 'contradicts';
    }
    return 'unrelated';
  }
  if (existing.op === required.op && setEq) return 'equal';
  return 'unrelated';
}

interface Interval { lo: number; hi: number; loOpen: boolean; hiOpen: boolean }

/** A number, or an ISO date, as a point on one line; anything else is not comparable. */
function scalarOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) { const ms = Date.parse(text); return Number.isFinite(ms) ? ms : undefined; }
  return undefined;
}

function intervalOf(predicate: IntentPredicate): Interval | undefined {
  if (predicate.values.length !== 1) return undefined;
  const point = scalarOf(predicate.values[0]);
  if (point === undefined) return undefined;
  switch (predicate.op) {
    case 'eq': return { lo: point, hi: point, loOpen: false, hiOpen: false };
    case 'gt': return { lo: point, hi: Infinity, loOpen: true, hiOpen: true };
    case 'gte': return { lo: point, hi: Infinity, loOpen: false, hiOpen: true };
    case 'lt': return { lo: -Infinity, hi: point, loOpen: true, hiOpen: true };
    case 'lte': return { lo: -Infinity, hi: point, loOpen: true, hiOpen: false };
    default: return undefined;
  }
}

function intervalsOverlap(a: Interval, b: Interval): boolean {
  const lo = Math.max(a.lo, b.lo); const hi = Math.min(a.hi, b.hi);
  if (lo < hi) return true;
  if (lo > hi) return false;
  // They meet at one point: it is in the intersection only if closed on both sides.
  const loOpen = (a.lo === lo && a.loOpen) || (b.lo === lo && b.loOpen);
  const hiOpen = (a.hi === hi && a.hiOpen) || (b.hi === hi && b.hiOpen);
  return !loOpen && !hiOpen;
}

/** Every point of `a` lies in `b`. */
function intervalWithin(a: Interval, b: Interval): boolean {
  const loOk = a.lo > b.lo || (a.lo === b.lo && (a.loOpen || !b.loOpen));
  const hiOk = a.hi < b.hi || (a.hi === b.hi && (a.hiOpen || !b.hiOpen));
  return loOk && hiOk;
}

function describePredicate(predicate: IntentPredicate, vocabulary: VocabularyIndex): string {
  const entry = vocabulary.get(predicate.ref);
  const label = entry?.label ?? entry?.name ?? predicate.ref;
  const op = ({ eq: '=', neq: '≠', in: 'in', not_in: 'not in', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains' } as Record<string, string>)[predicate.op] ?? predicate.op;
  return `${label} ${op} ${predicate.values.join('/')}`;
}

const GRAIN_MS: Record<string, number> = { day: 86_400_000, week: 7 * 86_400_000 };

/** The first instant of the period that contains `now`, at a grain. */
function periodStart(now: Date, grain: string): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (grain === 'day') return start;
  if (grain === 'week') { const day = start.getUTCDay(); start.setUTCDate(start.getUTCDate() - ((day + 6) % 7)); return start; }
  if (grain === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (grain === 'quarter') return new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
  return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
}

/** The grain a window's length suggests, when the intent declares none. */
function grainOfWindow(start: string, end: string): string {
  const days = (Date.parse(end) - Date.parse(start)) / GRAIN_MS.day!;
  if (days <= 1.5) return 'day';
  if (days <= 8) return 'week';
  if (days <= 32) return 'month';
  if (days <= 93) return 'quarter';
  return 'year';
}

export function applySkillPolicies(
  intent: AnalyticalIntentV1,
  vocabulary: VocabularyIndex,
  options: { now?: () => number; extraRequiredFilters?: string[] } = {},
): PolicyOutcome {
  const outcome: PolicyOutcome = { applied: [], requiredFilters: [], gaps: [] };
  if (intent.kind !== 'analytics') return outcome;
  const now = new Date(options.now?.() ?? Date.now());
  const skills = vocabulary.entries.filter((entry) => entry.kind === 'skill');
  const measureIds = new Set(intent.measures.flatMap((measure) => {
    const refs = measure.derived ? [measure.derived.numerator, measure.derived.denominator] : measure.ref ? [measure.ref] : [];
    return refs.flatMap((ref) => { const entry = vocabulary.get(ref); return [ref.toLowerCase(), ...(entry?.sourceId ? [entry.sourceId.toLowerCase()] : []), ...(entry ? [entry.name.toLowerCase()] : [])]; });
  }));
  const record = (policyId: string, field: string, effect: string) => outcome.applied.push({ policyId, field, effect });

  // Required filters: every selected skill's, then the domain's.
  const required = [
    ...skills.flatMap((entry) => (entry.skill?.requiredFilters ?? []).map((text) => ({ policyId: entry.ref, text }))),
    ...(options.extraRequiredFilters ?? []).map((text) => ({ policyId: 'domain', text })),
  ];
  for (const item of required) {
    const bound = bindRequiredFilter(item.text, vocabulary);
    if ('problem' in bound) {
      outcome.gaps.push(`${item.policyId}: required filter ${bound.problem}`);
      outcome.refusal = { tier: 'relational', code: 'policy_filter_unbindable', message: `a required filter of ${item.policyId === 'domain' ? 'this domain' : item.policyId} could not be bound: ${bound.problem}; the question is not answered without it`, repairable: false };
      return outcome;
    }
    // The question may already restrict the SAME FIELD — through this ref or
    // an equivalent one. Equal restriction: nothing to add. A contradiction
    // (the rule says true, the question says false) is a typed refusal that
    // names the rule: never two predicates that cancel to a governed zero,
    // never the rule silently dropped because "the field is restricted".
    const field = fieldIdentity(bound.predicate.ref, vocabulary);
    const same = intent.filters.filter((filter) => filter.on !== 'aggregate' && fieldIdentity(filter.ref, vocabulary) === field);
    const verdicts = same.map((filter) => comparePredicates(filter, bound.predicate));
    if (verdicts.includes('contradicts')) {
      const clash = same[verdicts.indexOf('contradicts')]!;
      outcome.gaps.push(`${item.policyId}: the question restricts ${clash.ref} ${clash.op} ${clash.values.join('/')}, which contradicts the required ${item.text}`);
      outcome.refusal = { tier: 'relational', code: 'policy_conflict', message: `${item.policyId === 'domain' ? 'this domain' : item.policyId} requires ${item.text}, and the question asks for ${describePredicate(clash, vocabulary)} — a rule the question contradicts is not applied and not dropped: the reading is refused, and the rule is named so it can be changed by whoever owns it`, repairable: false };
      return outcome;
    }
    if (verdicts.includes('equal') || verdicts.includes('stronger')) { record(item.policyId, 'requiredFilter', `already restricted on ${bound.predicate.ref}`); continue; }
    intent.filters.push(bound.predicate);
    intent.provenance[bound.predicate.ref] = `policy:${item.policyId}:required filter ${item.text}`;
    outcome.requiredFilters.push(item.text);
    record(item.policyId, 'requiredFilter', `added ${bound.predicate.ref} ${bound.predicate.op} ${bound.predicate.values.join('/')}`);
  }

  for (const entry of skills) {
    const policy = entry.policy as { policyId?: string; metricIds?: string[]; timeRole?: string; calendarId?: string; timezone?: string; completenessPolicy?: string; comparisonAlignment?: string; defaultRankingPeriod?: string } | undefined;
    if (!policy) continue;
    const policyId = policy.policyId ?? entry.ref;
    // Applicability: a policy scoped to metrics applies only when one of them is read.
    if (policy.metricIds?.length && !policy.metricIds.some((id) => measureIds.has(id.toLowerCase()))) { record(policyId, 'applicability', 'skipped: none of its metrics is read'); continue; }

    if (policy.timeRole) {
      const role = vocabulary.resolve(policy.timeRole, ['dimension']);
      const clause = intent.unresolved.find((item) => item.material && item.options.length > 1 && item.options.every((option) => vocabulary.get(option)?.roles.includes('time')));
      if (role && clause && clause.options.includes(role.ref)) {
        applySelectedMeaning(intent, { ref: role.ref, ...(role.label ? { label: role.label } : {}) }, vocabulary);
        intent.provenance[role.ref] = `policy:${policyId}:time role`;
        record(policyId, 'timeRole', `resolved the period basis to ${role.ref}`);
      } else if (role && intent.time && !intent.time.ref) {
        intent.time = { ...intent.time, ref: role.ref };
        intent.provenance[role.ref] = `policy:${policyId}:time role`;
        record(policyId, 'timeRole', `bound the window to ${role.ref}`);
      } else if (!role) outcome.gaps.push(`${policyId}: time role "${policy.timeRole}" names no time dimension`);
    }

    if ((policy.completenessPolicy === 'latest_complete' || policy.completenessPolicy === 'closed_period') && intent.time?.window) {
      const window = intent.time.window;
      if (Date.parse(window.end) > now.getTime()) {
        const grain = intent.time.grain ?? intent.groupBy.find((group) => group.role === 'time')?.grain ?? grainOfWindow(window.start, window.end);
        const closed = periodStart(now, grain).toISOString().slice(0, 10);
        if (Date.parse(closed) <= Date.parse(window.start)) {
          outcome.gaps.push(`${policyId}: no complete ${grain} lies inside "${window.expression ?? `${window.start}..${window.end}`}"`);
        } else {
          intent.time = { ...intent.time, window: { ...window, end: closed, expression: `${window.expression ?? `${window.start}..${window.end}`} (complete ${grain}s only)` } };
          intent.provenance.time = `policy:${policyId}:${policy.completenessPolicy} — the running ${grain} is left out`;
          record(policyId, 'completenessPolicy', `closed the window at ${closed} (${policy.completenessPolicy})`);
        }
      }
    }

    if (policy.defaultRankingPeriod && intent.expectedShape === 'ranking' && !intent.ordering) {
      const scoped = intent.measures.map((measure, index) => ({ index, end: measure.scope?.find((scope) => scope.op === 'lt' && typeof scope.values[0] === 'string' && /^\d{4}-\d{2}/.test(String(scope.values[0])))?.values[0] as string | undefined }))
        .filter((item): item is { index: number; end: string } => Boolean(item.end)).sort((left, right) => left.end.localeCompare(right.end));
      if (scoped.length >= 2) {
        const chosen = policy.defaultRankingPeriod === 'comparison' ? scoped[0]! : scoped[scoped.length - 1]!;
        intent.ordering = { ref: `measure:${chosen.index}`, direction: 'desc' };
        intent.provenance[`measure:${chosen.index}`] = `policy:${policyId}:default ranking period ${policy.defaultRankingPeriod}`;
        record(policyId, 'defaultRankingPeriod', `ordered by the ${policy.defaultRankingPeriod} period`);
      }
    }

    if (policy.comparisonAlignment === 'fiscal_period' && !policy.calendarId) outcome.gaps.push(`${policyId}: fiscal alignment declared with no calendar`);
    else if (policy.comparisonAlignment) record(policyId, 'comparisonAlignment', `recorded (${policy.comparisonAlignment}); not yet applied to period scopes`);
    if (policy.calendarId) record(policyId, 'calendarId', `recorded (${policy.calendarId})`);
    if (policy.timezone) record(policyId, 'timezone', `recorded (${policy.timezone})`);
  }
  return outcome;
}
