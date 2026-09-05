import type { AnalyticalIntentV1 } from '../intent.js';
import type { VocabularyEntry, VocabularyIndex } from '../vocabulary.js';
import type { PrepareDeps, PreparedCandidate, PreparedRefusal } from './types.js';

/**
 * CERTIFIED = ENTAILMENT, NOT LEXICAL FIT.
 *
 * A block is a certified answer only when its contract entails the intent:
 * the intent names the block (or measures whose physical binding is one of
 * the block's aggregates over the same scope), every grouping and display
 * ref is an output the block produces, every filter is one the block
 * declares it accepts, and the ordering and limit are provable from the
 * block's own ORDER BY and LIMIT. An intent with no measures never entails.
 * Anything less makes the block evidence for the governed tiers, not an
 * answer.
 */

export interface EntailmentVerdict {
  ok: boolean;
  missing: string[];
  caveats: string[];
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const leaf = (ref: string) => (ref.split('.').pop() ?? ref).toLowerCase();

export function entails(block: VocabularyEntry, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): EntailmentVerdict {
  const contract = block.contract;
  const missing: string[] = [];
  const caveats: string[] = [];
  if (!contract) return { ok: false, missing: ['the block has no contract'], caveats };
  if (intent.measures.length === 0) return { ok: false, missing: ['the intent names no measure'], caveats };
  const outputs = new Set(contract.outputs.map(norm));

  const namesBlock = intent.measures.every((measure) => measure.ref === block.ref);
  if (!namesBlock) {
    // Measures by physical binding: same aggregate over the same source column.
    for (const measure of intent.measures) {
      const entry = vocabulary.get(measure.ref);
      const physical = entry?.physical;
      const match = contract.measures.find((candidate) =>
        physical && candidate.aggregate && physical.aggregate === candidate.aggregate
        && ((candidate.sourceColumn && physical.column && norm(candidate.sourceColumn) === norm(physical.column))
          || (candidate.expr && physical.expr && norm(candidate.expr) === norm(physical.expr))));
      if (!match) missing.push(`${measure.ref} is not one of the block's measures (${contract.measures.map((m) => m.output).join(', ') || 'none'})`);
      if (measure.scope?.length) {
        for (const predicate of measure.scope) {
          const column = leaf(predicate.ref);
          const covered = contract.staticScope.some((scope) => norm(scope.column) === norm(column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
          if (!covered) missing.push(`the block does not restrict ${column} the way the measure requires`);
        }
      }
    }
  } else if (intent.measures.length > 1) {
    missing.push('a certified answer names one block');
  }

  // IDENTITY: a ranking or breakdown of an entity must be keyed. A block whose
  // grouping columns are all labels cannot prove which customer is which, so it
  // is evidence, not a certified answer, until it is recertified with the key.
  const grouping = contract.groupBy.length ? contract.groupBy : contract.outputs.filter((output) => !contract.measures.some((m) => norm(m.output) === norm(output)));
  const keyLike = (column: string) => /(^|_)(id|key|uuid|code|number)$/i.test(column);
  const labelLike = (column: string) => /(^|_)(name|label|title)(_|$)/i.test(column);
  if (grouping.length > 0 && grouping.every(labelLike) && !grouping.some(keyLike)) {
    const note = `the block groups by ${grouping.join(', ')} (a label) with no identity key, so two entities sharing a name would merge`;
    // A block the intent NAMES is the artifact the team certified for exactly
    // this question; the pipeline records the caveat rather than overriding
    // governance. A block matched through its measures must prove identity.
    if (namesBlock) caveats.push(`${note}; the certified block is served as published`);
    else missing.push(`${note}; recertify it with the key column, or ask for the metric by entity`);
  }
  // Every grouping and display column must be an output.
  for (const group of intent.groupBy) {
    const entry = vocabulary.get(group.ref);
    const column = entry?.physical?.column ?? entry?.name ?? leaf(group.ref);
    if (!outputs.has(norm(column))) missing.push(`grouping by ${column} is not an output of the block (${contract.outputs.join(', ')})`);
    if (group.role === 'time' && group.grain) caveats.push(`time grain ${group.grain} is assumed to match the block's own grouping`);
  }
  for (const ref of intent.display) {
    const entry = vocabulary.get(ref);
    const column = entry?.physical?.column ?? entry?.name ?? leaf(ref);
    if (!outputs.has(norm(column))) missing.push(`display of ${column} is not an output of the block`);
  }

  // The block's own scope must be what the intent asked for, and every intent filter must be accepted.
  const intentPredicates = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])];
  // A block the intent names by ref was chosen FOR its declared scope; a block
  // matched through its measures must have that scope asked for explicitly.
  for (const scope of namesBlock ? [] : contract.staticScope) {
    const asked = intentPredicates.some((predicate) => norm(leaf(predicate.ref)) === norm(scope.column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
    if (!asked) missing.push(`the block is restricted to ${scope.column} ${scope.op}${scope.values.length ? ` ${scope.values.join('/')}` : ''}, which the question did not ask for`);
  }
  const accepted = new Set([...contract.allowedFilters, ...contract.parameters, ...contract.staticScope.map((scope) => scope.column), ...(namesBlock ? contract.outputs : [])].map(norm));
  for (const predicate of namesBlock ? intentPredicates : intent.filters) {
    const column = leaf(predicate.ref);
    const asStatic = contract.staticScope.some((scope) => norm(scope.column) === norm(column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
    if (!asStatic && !accepted.has(norm(column))) missing.push(`the block does not accept a filter on ${column}`);
    if (!asStatic && accepted.has(norm(column))) caveats.push(`filter on ${column} needs the block's parameter binding`);
  }

  // Ordering and limit must be provable.
  if (intent.ordering) {
    const orderColumn = intent.ordering.ref.startsWith('measure:') ? contract.measures[0]?.output : (vocabulary.get(intent.ordering.ref)?.physical?.column ?? leaf(intent.ordering.ref));
    const first = contract.orderBy?.[0];
    const sameColumn = first && orderColumn && (norm(first.column) === norm(orderColumn) || contract.measures.some((m) => norm(m.output) === norm(first.column) && vocabulary.get(intent.ordering!.ref)?.physical?.column && norm(m.sourceColumn ?? '') === norm(vocabulary.get(intent.ordering!.ref)!.physical!.column!)));
    if (!first || !sameColumn || first.direction !== intent.ordering.direction) missing.push('the block does not order the way the question asks');
  }
  if (intent.limit !== undefined) {
    if (contract.limit === undefined) missing.push(`the block has no row limit; the question asks for ${intent.limit}`);
    else if (contract.limit !== intent.limit) missing.push(`the block returns ${contract.limit} rows; the question asks for ${intent.limit}`);
  } else if (contract.limit !== undefined) {
    caveats.push(`the block returns at most ${contract.limit} rows`);
  }
  if (!contract.structural) caveats.push('the block SQL could not be read structurally; only its declarations were checked');
  return { ok: missing.length === 0, missing, caveats };
}

function scopeMatches(op: string, values: string[], intentOp: string, intentValues: Array<string | number | boolean>): boolean {
  const boolOf = (v: unknown) => (v === true || String(v).toLowerCase() === 'true') ? 'true' : (v === false || String(v).toLowerCase() === 'false') ? 'false' : undefined;
  if (op === 'is_true' || op === 'is_false') {
    if (intentOp === op) return true;
    if (intentOp === 'eq' && intentValues.length === 1) return boolOf(intentValues[0]) === (op === 'is_true' ? 'true' : 'false');
    return false;
  }
  if ((op === 'eq' || op === 'in') && (intentOp === 'eq' || intentOp === 'in')) {
    const left = new Set(values.map((value) => value.toLowerCase()));
    return intentValues.every((value) => left.has(String(value).toLowerCase())) && intentValues.length === left.size;
  }
  return op === intentOp && values.join('|').toLowerCase() === intentValues.map(String).join('|').toLowerCase();
}

export function prepareCertified(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps): { candidates: PreparedCandidate[]; refusals: PreparedRefusal[] } {
  const blocks = vocabulary.entries.filter((entry) => entry.kind === 'block' && entry.certified);
  if (blocks.length === 0) return { candidates: [], refusals: [{ tier: 'certified', code: 'no_certified_block', message: 'the project has no certified block', repairable: false }] };
  const candidates: PreparedCandidate[] = [];
  const refusals: PreparedRefusal[] = [];
  const named = intent.measures.map((measure) => measure.ref).filter((ref) => ref.startsWith('block:'));
  const considered = named.length ? blocks.filter((block) => named.includes(block.ref)) : blocks;
  for (const block of considered) {
    const verdict = entails(block, intent, vocabulary);
    const source = deps.blockSql?.(block.ref) ?? block.sql;
    if (verdict.ok && source) {
      // Filters the block declares it accepts are applied OVER its output, so
      // the certified logic runs unchanged and the filter is provably present.
      const params: unknown[] = [];
      const outputs = new Set((block.contract?.outputs ?? []).map(norm));
      const applied: string[] = [];
      const blockPredicates = [...intent.filters, ...intent.measures.filter((measure) => measure.ref === block.ref).flatMap((measure) => measure.scope ?? [])];
      for (const predicate of blockPredicates) {
        const column = leaf(predicate.ref);
        const staticMatch = block.contract?.staticScope.some((scope) => norm(scope.column) === norm(column));
        if (staticMatch) continue;
        const output = (block.contract?.outputs ?? []).find((name) => norm(name) === norm(column));
        if (!output || !outputs.has(norm(column))) continue;
        const quoted = `"${output.replace(/"/g, '""')}"`;
        const value = predicate.values[0];
        if (predicate.op === 'eq' && typeof value === 'string') { params.push(value.toLowerCase()); applied.push(`LOWER(CAST(block.${quoted} AS TEXT)) = ?`); }
        else if (predicate.op === 'eq') { params.push(value); applied.push(`block.${quoted} = ?`); }
        else if (predicate.op === 'in') { for (const item of predicate.values) params.push(typeof item === 'string' ? item.toLowerCase() : item); applied.push(`LOWER(CAST(block.${quoted} AS TEXT)) IN (${predicate.values.map(() => '?').join(', ')})`); }
        else if (predicate.op === 'is_true') applied.push(`block.${quoted} = TRUE`);
        else if (predicate.op === 'is_false') applied.push(`block.${quoted} = FALSE`);
        else { params.push(value); applied.push(`block.${quoted} ${({ neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[predicate.op] ?? '='} ?`); }
      }
      const sql = applied.length ? `SELECT * FROM (\n${source.trim().replace(/;\s*$/, '')}\n) AS block\nWHERE ${applied.join(' AND ')}` : source;
      candidates.push({
        tier: 'certified', trust: 'certified', sql, ...(params.length ? { params } : {}), sourceRef: block.ref,
        proof: [`${block.ref} entails the intent: ${block.contract?.measures.map((m) => m.output).join(', ') || 'declared outputs'}${block.contract?.staticScope.length ? ` with scope ${block.contract.staticScope.map((s) => `${s.column} ${s.op}`).join(', ')}` : ''}${applied.length ? `; ${applied.length} declared filter${applied.length > 1 ? 's' : ''} applied over its output` : ''}`, ...verdict.caveats],
      });
    } else if (named.includes(block.ref) || verdict.missing.length <= 2) {
      // A block the model named but which does not entail the intent is a
      // repairable refusal: the resolver can re-express the analysis with the
      // metric and dimension refs the block was standing in for.
      refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: ${verdict.missing.join('; ') || 'no SQL source'}`, repairable: named.includes(block.ref), detail: verdict });
    }
  }
  if (candidates.length === 0 && refusals.length === 0) {
    refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `no certified block entails the intent (${blocks.map((block) => block.ref).join(', ')})`, repairable: false });
  }
  return { candidates, refusals };
}
