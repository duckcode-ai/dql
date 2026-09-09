import { describe, expect, it } from 'vitest';
import { extractBlockContract } from './block-contract.js';
import { applyDerivedColumns, classifyWarehouseError, executeCandidate } from './execute.js';
import { ANALYTICAL_INTENT_JSON_SCHEMA, describeIntent, intentExecutionFingerprint, intentRefs, parseIntent, unaccountedInheritedRefs, type AnalyticalIntentV1 } from './intent.js';
import { applyGovernedDefaults, applySelectedMeaning, auditLedger, bindExactNames, identityClauseWords, preferGovernedDefinition, relativePeriodProblem, scopedColumnOf, buildIntentSystemPrompt, buildLedger, calendarBasisProblem, droppedGrain, droppedYears, proveClauseCoverage, proveTimeRoles, resolveIntent, widenedPopulation, unaccountedQuestionWords, uncoveredQuestionTerms, validateIntentRefs } from './resolve-intent.js';
import { bindSemanticRequest } from './prepare/index.js';
import { composeAnsweredText, describeResultColumns, formatValue } from './outcomes.js';
import { runAskPipeline, unmetDisplayObligation } from './pipeline.js';
import { fillPeriodGaps } from './execute.js';
import { suggestSameGrainColumns, suggestSameRelationFields, buildVocabularyIndex, trigramSimilarity, type VocabularySource } from './vocabulary.js';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import { extractFirstJsonObject } from '../providers/structured-output.js';

const TOP_BEVERAGE_SQL = `
    SELECT
      customers.customer_name,
      SUM(order_items.product_price) AS beverage_revenue,
      COUNT(DISTINCT order_items.order_id) AS beverage_orders,
      COUNT(DISTINCT products.product_id) AS beverage_product_types
    FROM dev.order_items AS order_items
    JOIN dev.products AS products ON order_items.product_id = products.product_id
    JOIN dev.orders AS orders ON order_items.order_id = orders.order_id
    JOIN dev.customers AS customers ON orders.customer_id = customers.customer_id
    WHERE products.is_drink_item = true
    GROUP BY customers.customer_name
    ORDER BY beverage_revenue DESC, beverage_product_types DESC, customer_name
    LIMIT 10`;

const jaffle: VocabularySource = {
  metrics: [
    { name: 'revenue', model: 'order_item', label: 'Revenue', description: 'Sum of product prices (pretax product revenue).', aggregation: 'sum' },
    { name: 'drink_revenue', model: 'order_item', label: 'Drink Revenue', description: 'Revenue from drink items.', aggregation: 'sum', aliases: ['beverage revenue'] },
    { name: 'food_revenue', model: 'order_item', label: 'Food Revenue', aggregation: 'sum' },
    { name: 'order_total', model: 'orders', label: 'Order Total', description: 'Total including tax.', aggregation: 'sum' },
    { name: 'lifetime_spend_pretax', model: 'customers', label: 'Lifetime Spend Pretax', aggregation: 'sum' },
    { name: 'lifetime_spend', model: 'customers', label: 'Lifetime Spend', aggregation: 'sum' },
    { name: 'supply_cost', model: 'supplies', label: 'Supply Cost', aggregation: 'sum' },
    { name: 'customers', model: 'customers', label: 'Customers', description: 'Count of customers.', aggregation: 'count_distinct' },
  ],
  dimensions: [
    { name: 'customer_name', model: 'customers', dataType: 'string' },
    { name: 'customer_type', model: 'customers', dataType: 'string' },
    { name: 'product_type', model: 'products', dataType: 'string' },
    { name: 'product_name', model: 'products', dataType: 'string' },
    { name: 'supply_name', model: 'supplies', dataType: 'string' },
    { name: 'product_id', model: 'supplies', dataType: 'string' },
    { name: 'is_drink_item', model: 'order_item', dataType: 'boolean' },
    { name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
  ],
  entities: [
    { name: 'customer', model: 'customers', type: 'primary' },
    { name: 'product', model: 'products', type: 'primary' },
    { name: 'order_id', model: 'orders', type: 'primary' },
  ],
  blocks: [
    {
      name: 'customer_profile', domain: 'commerce', certified: true, description: 'Customer lifetime profile. One row per customer.',
      contract: extractBlockContract({ name: 'customer_profile', domain: 'commerce', entities: ['customer'], sql: 'SELECT customer_name, customer_type, lifetime_spend FROM dev.customers ORDER BY lifetime_spend DESC, customer_name', declaredOutputs: ['customer_name', 'customer_type', 'lifetime_spend'] }),
    },
    {
      name: 'top_beverage_customers', domain: 'commerce', certified: true, description: 'Top customers ranked by beverage revenue.',
      contract: extractBlockContract({ name: 'top_beverage_customers', domain: 'commerce', sql: TOP_BEVERAGE_SQL, declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'] }),
      examples: ['Who are the top customers by beverage revenue?'],
    },
  ],
  relations: [
    { schema: 'dev', name: 'orders', columns: [{ name: 'order_id', dataType: 'VARCHAR' }, { name: 'customer_id', dataType: 'VARCHAR' }, { name: 'order_total', dataType: 'DOUBLE' }, { name: 'ordered_at', dataType: 'TIMESTAMP' }] },
    { schema: 'dev', name: 'supplies', columns: [{ name: 'supply_uuid', dataType: 'VARCHAR' }, { name: 'product_id', dataType: 'VARCHAR' }, { name: 'supply_name', dataType: 'VARCHAR' }, { name: 'supply_cost', dataType: 'DOUBLE' }] },
  ],
};

function scripted(replies: string[]): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  return {
    name: 'ollama',
    calls,
    available: async () => true,
    generate: async (messages) => { calls.push(messages); return replies[Math.min(calls.length - 1, replies.length - 1)] ?? ''; },
  };
}

describe('block contract', () => {
  it('reads measures, grouping, static scope, ordering and limit from a simple SELECT', () => {
    const contract = extractBlockContract({ name: 'top_beverage_customers', sql: TOP_BEVERAGE_SQL });
    expect(contract.structural).toBe(true);
    expect(contract.measures.map((m) => `${m.output}:${m.aggregate}:${m.sourceColumn ?? ''}`)).toEqual([
      'beverage_revenue:sum:product_price', 'beverage_orders:count_distinct:order_id', 'beverage_product_types:count_distinct:product_id',
    ]);
    expect(contract.groupBy).toEqual(['customer_name']);
    expect(contract.staticScope).toEqual([{ column: 'is_drink_item', op: 'is_true', values: [] }]);
    expect(contract.orderBy?.[0]).toEqual({ column: 'beverage_revenue', direction: 'desc' });
    expect(contract.limit).toBe(10);
  });
  it('declared outputs win and a non-structural block keeps only declarations', () => {
    const contract = extractBlockContract({ name: 'x', sql: 'WITH a AS (SELECT 1) SELECT * FROM a UNION SELECT 2', declaredOutputs: ['n'], dimensions: ['n'] });
    expect(contract.structural).toBe(false);
    expect(contract.outputs).toEqual(['n']);
    expect(contract.groupBy).toEqual(['n']);
  });
});

describe('vocabulary index', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  it('holds every object with an exact ref and resolves names and bare ids', () => {
    expect(vocabulary.get('metric:order_item.drink_revenue')?.kind).toBe('metric');
    expect(vocabulary.resolve('order_item.drink_revenue')?.ref).toBe('metric:order_item.drink_revenue');
    expect(vocabulary.resolve('customer_name')?.ref).toBe('dimension:customers.customer_name');
    expect(vocabulary.resolve('Drink Revenue')?.ref).toBe('metric:order_item.drink_revenue');
    expect(vocabulary.resolve('revenue', ['metric'])?.ref).toBe('metric:order_item.revenue');
  });
  it('tolerates spelling: "bevereage" finds the drink metrics and "catogery" finds product_type', () => {
    expect(trigramSimilarity('bevereage', 'beverage')).toBeGreaterThan(0.6);
    const drink = vocabulary.lookup('bevereage', { limit: 5 }).map((hit) => hit.entry.ref);
    expect(drink).toContain('metric:order_item.drink_revenue');
    // Nothing here is called "category", so a lone misspelling proposes nothing rather than a guess…
    expect(vocabulary.lookup('catogery', { limit: 5 })).toHaveLength(0);
    // …while the surrounding words still find the product dimension.
    expect(vocabulary.lookup('product catogery', { limit: 5 }).map((hit) => hit.entry.ref)).toContain('dimension:products.product_type');
  });
  it('assigns roles: names are labels, entities are keys, timestamps are time', () => {
    expect(vocabulary.get('dimension:customers.customer_name')?.roles).toEqual(['label']);
    expect(vocabulary.get('entity:customers.customer')?.roles).toEqual(['key']);
    expect(vocabulary.get('dimension:order_item.ordered_at')?.roles).toEqual(['time']);
    expect(vocabulary.get('dimension:order_item.is_drink_item')?.roles).toEqual(['boolean']);
  });
  it('renders deterministic cards with the block contract visible and a budget that still names every kind', () => {
    const cards = vocabulary.renderCards({ seeds: ['beverage', 'customers'] });
    expect(cards).toContain('block:commerce.top_beverage_customers');
    expect(cards).toContain('scope: is_drink_item is_true');
    expect(cards).toContain('limit 10');
    expect(vocabulary.renderCards({ seeds: ['beverage'] })).toBe(cards.replace(/x/g, 'x'));
    const small = vocabulary.renderCards({ maxChars: 600, seeds: ['beverage'] });
    expect(small).toContain('of');
    expect(small).toContain('lookup_vocabulary');
  });
});

describe('intent contract', () => {
  it('parses a valid intent and rejects a shapeless one', () => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], filters: [], ordering: { ref: 'metric:order_item.drink_revenue', direction: 'desc' }, limit: 10, expectedShape: 'ranking', unresolved: [], provenance: {} });
    expect(parsed.intent?.limit).toBe(10);
    expect(parseIntent({ kind: 'analytics', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).errors.length).toBeGreaterThan(0);
    expect(parseIntent('nope').errors[0]?.message).toContain('not a JSON object');
  });
  it('execution fingerprint ignores prose and provenance', () => {
    const base = parseIntent({ version: 1, kind: 'analytics', reading: 'a', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' } }).intent!;
    const other = { ...base, reading: 'b', provenance: {} };
    expect(intentExecutionFingerprint(base)).toBe(intentExecutionFingerprint(other));
    expect(describeIntent(base)).toContain('metric:order_item.revenue');
  });
  it('a follow-up that drops an inherited ref without saying so is caught', () => {
    const prior = parseIntent({ version: 1, kind: 'analytics', reading: 'a', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: [], filters: [], expectedShape: 'ranking', limit: 10, unresolved: [], provenance: {} }).intent!;
    const next = parseIntent({ version: 1, kind: 'analytics', reading: 'b', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'entity:customers.customer': 'removed:new subject' } }).intent!;
    expect(unaccountedInheritedRefs(prior, next)).toEqual(['metric:order_item.drink_revenue']);
  });
});

describe('intent resolution', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const good = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Top 10 customers by beverage revenue, showing names',
    measures: [{ ref: 'metric:order_item.drink_revenue' }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }],
    display: ['dimension:customers.customer_name'], filters: [],
    ordering: { ref: 'metric:order_item.drink_revenue', direction: 'desc' }, limit: 10,
    expectedShape: 'ranking', unresolved: [], provenance: { 'metric:order_item.drink_revenue': 'q:beverage', 'entity:customers.customer': 'q:customers' },
  });
  it('the prompt teaches identity, per-measure scope, literals and clarification', () => {
    const prompt = buildIntentSystemPrompt({ cards: vocabulary.renderCards(), hasPrior: true });
    expect(prompt).toContain('IDENTITY IS THE KEY');
    expect(prompt).toContain('RESTRICTS ONLY THE MEASURE');
    expect(prompt).toContain('FOLLOW-UP');
    expect(prompt).toContain('metric:order_item.drink_revenue');
  });
  it('a valid reply resolves in one dispatch', async () => {
    const provider = scripted([good]);
    const result = await resolveIntent({ question: 'who are the top customers for beverage product category', vocabulary, provider });
    expect(result.status).toBe('resolved');
    expect(result.attempts).toBe(1);
    if (result.status === 'resolved') expect(result.intent.display).toEqual(['dimension:customers.customer_name']);
  });
  it('an invented ref is corrected once with the nearest authorized refs, then accepted', async () => {
    const bad = good.replace('metric:order_item.drink_revenue', 'metric:beverage_revenue');
    const provider = scripted([bad, good]);
    const dispatches: string[] = [];
    const result = await resolveIntent({ question: 'top beverage customers', vocabulary, provider, onDispatch: (event) => dispatches.push(event.purpose) });
    expect(dispatches).toEqual(['resolve', 'correct']);
    expect(result.status).toBe('resolved');
    const correction = provider.calls[1]!.at(-1)!.content;
    expect(correction).toContain('metric:beverage_revenue is not in the vocabulary');
    expect(correction).toContain('metric:order_item.drink_revenue');
  });
  it('grouping by a label is refused with the key suggested', () => {
    const intent = parseIntent(JSON.parse(good.replace('"groupBy":[{"ref":"entity:customers.customer","role":"key"}]', '"groupBy":[{"ref":"dimension:customers.customer_name","role":"key"}]'))).intent!;
    const validation = validateIntentRefs(intent, vocabulary);
    expect(validation.problems.some((problem) => problem.message.includes('is a label'))).toBe(true);
  });
  it('a conversation reply and a material clarification each end the turn without execution', async () => {
    const hello = JSON.stringify({ version: 1, kind: 'conversation', reading: 'greeting', reply: 'Hi! Ask me about revenue, customers or orders.', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {} });
    expect((await resolveIntent({ question: 'hi', vocabulary, provider: scripted([hello]) })).status).toBe('conversation');
    const ambiguous = JSON.stringify({ version: 1, kind: 'analytics', reading: 'total revenue', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [{ clause: 'total revenue', options: ['metric:order_item.revenue', 'metric:orders.order_total'], material: true, question: 'Do you mean product revenue before tax, or order totals including tax?' }], provenance: {} });
    const result = await resolveIntent({ question: 'how much money did we take', vocabulary, provider: scripted([ambiguous]) });
    expect(result.status).toBe('clarify');
    if (result.status === 'clarify') expect(result.options).toHaveLength(2);
    // The same ambiguity when the question NAMES one option is the governed default, not a question back.
    const defaulted = await resolveIntent({ question: 'total revenue', vocabulary, provider: scripted([ambiguous]) });
    expect(defaulted.status).toBe('resolved');
    if (defaulted.status === 'resolved') expect(defaulted.intent.measures.map((measure) => measure.ref)).toEqual(['metric:order_item.revenue']);
  });
  it('a clarification-only reply that the governed default resolves is sent back for the rest of the question, never executed as a scalar', async () => {
    const bareTrend = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly revenue trend', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'trend', unresolved: [{ clause: 'revenue by month', options: ['metric:orders.order_total', 'metric:order_item.revenue'], material: true, question: 'Gross order revenue or product revenue?' }], provenance: {} });
    const full = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly product revenue', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], display: [], filters: [], expectedShape: 'trend', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue', 'dimension:order_item.ordered_at': 'q:by month' } });
    const dispatches: string[] = [];
    const result = await resolveIntent({ question: 'revenue by month', vocabulary, provider: scripted([bareTrend, full]), onDispatch: (event) => dispatches.push(event.purpose) });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.intent.groupBy).toEqual([{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }]);
    expect(dispatches).toHaveLength(2);
    const stubborn = await resolveIntent({ question: 'revenue by month', vocabulary, provider: scripted([bareTrend, bareTrend]) });
    expect(stubborn.status).toBe('clarify');
    if (stubborn.status === 'clarify') expect(stubborn.question).toBe('Gross order revenue or product revenue?');
    expect(unaccountedQuestionWords('what is the total revenue', parseIntent(JSON.parse(full)).intent!, vocabulary)).toEqual([]);
    expect(unaccountedQuestionWords('revenue for Ryan Byrd by month', parseIntent(JSON.parse(full)).intent!, vocabulary)).toEqual(['ryan', 'byrd']);
  });
  it('prose that never becomes JSON fails with a typed reason after the bounded attempts', async () => {
    const result = await resolveIntent({ question: 'x', vocabulary, provider: scripted(['I cannot help with that.']) });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('unparseable');
    expect(extractFirstJsonObject('text {"a":1} more')).toEqual({ a: 1 });
  });
});

describe('governed defaults', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('an exact metric name resolves the ambiguity and the ranking order follows the replaced measure', () => {
    const next = intent({
      measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }],
      ordering: { ref: 'metric:orders.order_total', direction: 'desc' }, limit: 5,
      unresolved: [{ clause: 'revenue', options: ['metric:orders.order_total', 'metric:order_item.revenue'], material: true }],
      provenance: { 'metric:orders.order_total': 'q:revenue' },
    });
    applyGovernedDefaults(next, 'top 5 customers by revenue', vocabulary);
    expect(next.unresolved[0]!.material).toBe(false);
    expect(next.measures.map((measure) => measure.ref)).toEqual(['metric:order_item.revenue']);
    expect(next.ordering).toEqual({ ref: 'metric:order_item.revenue', direction: 'desc' });
    expect(next.provenance['metric:order_item.revenue']).toMatch(/^q:revenue/);
  });
  it('a word spent on the grain never names the default measure: "customers" is the grain, not the customer count', () => {
    // No certified precedent applies here (no key grain), so the clause must stay open.
    const next = intent({
      measures: [{ ref: 'metric:customers.customers' }], groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }],
      unresolved: [{ clause: 'top customers', options: ['metric:customers.lifetime_spend', 'metric:customers.lifetime_spend_pretax', 'metric:customers.customers'], material: true }],
    });
    applyGovernedDefaults(next, 'who are the top customers by type', vocabulary);
    expect(next.unresolved[0]!.material).toBe(true);
    expect(next.measures.map((measure) => measure.ref)).toEqual(['metric:customers.customers']);
  });
  it('a material clause with one option the intent already uses is a reachability worry, not an ambiguity', () => {
    const next = intent({
      measures: [{ ref: 'metric:order_item.food_revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }],
      unresolved: [{ clause: 'food revenue by product', options: ['metric:order_item.food_revenue'], material: true, question: 'Is product reachable from order_item?' }],
    });
    applyGovernedDefaults(next, 'food revenue by product', vocabulary);
    expect(next.unresolved[0]!.material).toBe(false);
    expect(next.unresolved[0]!.question).toMatch(/host proves reachability/);
  });
});

describe('host proofs on the interpreted intent', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('a label finer than the grain is replaced by the grain entity\'s own label', () => {
    const next = validateIntentRefs(intent({
      measures: [{ ref: 'metric:supplies.supply_cost' }], groupBy: [{ ref: 'dimension:supplies.product_id', role: 'key' }], display: ['dimension:supplies.supply_name'],
    }), vocabulary);
    expect(next.problems).toEqual([]);
    expect(next.intent.display).toEqual(['dimension:products.product_name']);
    expect(next.intent.provenance['dimension:supplies.supply_name']).toMatch(/finer than the grain products/);
  });
  it('a customer name beside the customer key is the grain\'s label and stays', () => {
    const next = validateIntentRefs(intent({
      measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
    }), vocabulary);
    expect(next.intent.display).toEqual(['dimension:customers.customer_name']);
  });
  it('a follow-up keeps the previous period unless the message names one', () => {
    const prior = intent({
      measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }],
      time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01' } }, expectedShape: 'ranking',
    });
    const edit = () => intent({ measures: [{ ref: 'metric:order_item.revenue' }, { ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], provenance: { 'metric:order_item.revenue': 'inherited', 'entity:customers.customer': 'inherited' }, expectedShape: 'ranking' });
    const kept = validateIntentRefs(edit(), vocabulary, prior, 'also show the number of orders');
    expect(kept.problems).toEqual([]);
    expect(kept.intent.time?.window).toEqual({ start: '2025-01-01', end: '2026-01-01' });
    expect(kept.intent.provenance['time:dimension:order_item.ordered_at']).toBe('inherited');
    const renamed = validateIntentRefs(edit(), vocabulary, prior, 'same for all time');
    expect(renamed.intent.time?.window).toBeUndefined();
  });
  it('a follow-up made only of the previous analysis\'s words (misspelt) cannot replace its measures on the first reading', () => {
    const prior = intent({
      reading: 'Top customers by beverage revenue', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      provenance: { 'metric:order_item.drink_revenue': 'q:top customers for beverage product category' }, expectedShape: 'ranking',
    });
    const replaced = intent({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }], provenance: { 'metric:order_item.drink_revenue': 'removed:asks for products', 'entity:customers.customer': 'removed:asks for products', 'dimension:customers.customer_name': 'removed:asks for products' } });
    const first = validateIntentRefs(replaced, vocabulary, prior, 'I need to get the bevereage catogery');
    expect(first.problems.map((problem) => problem.path)).toEqual(['measures']);
    expect(first.problems[0]!.message).toMatch(/corrects that analysis rather than replacing it/);
    const newSubject = validateIntentRefs(replaced, vocabulary, prior, 'what is the Ryan Byrd revenue by product');
    expect(newSubject.problems).toEqual([]);
    const second = validateIntentRefs(replaced, vocabulary, prior, undefined);
    expect(second.problems).toEqual([]);
  });
  it('a generic classifier word ("catogery") names nothing new even when the previous analysis never used it', () => {
    const prior = intent({
      reading: 'Rank customers by their beverage revenue, showing the top customers along with customer name', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      provenance: { 'metric:order_item.drink_revenue': 'q:beverage revenue', 'dimension:customers.customer_name': 'q:customer name' }, expectedShape: 'ranking',
    });
    const replaced = intent({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }], provenance: { 'metric:order_item.drink_revenue': 'removed:asks for products' } });
    const first = validateIntentRefs(replaced, vocabulary, prior, 'I need to get the bevereage catogery');
    expect(first.followUpReplacement).toMatch(/corrects that analysis rather than replacing it/);
  });
});

describe('the intent schema survives strict validators', () => {
  it('uses anyOf, never a union type keyword (the Claude Code CLI validates in Ajv strict mode)', () => {
    expect(JSON.stringify(ANALYTICAL_INTENT_JSON_SCHEMA)).not.toMatch(/"type":\[/);
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [{ ref: 'dimension:customers.customer_name', op: 'in', values: ['a', 2, true], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    expect(parsed.intent?.filters[0]?.values).toEqual(['a', 2, true]);
  });
});

describe('certified precedent and the second follow-up reading', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('"top customers" resolves to the measure the certified customer block ranks by', () => {
    const next = intent({
      measures: [{ ref: 'metric:customers.customers' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], limit: 10,
      unresolved: [{ clause: 'top customers', options: ['metric:customers.lifetime_spend', 'metric:customers.lifetime_spend_pretax', 'metric:customers.customers'], material: true }],
    });
    applyGovernedDefaults(next, 'who are the top customers', vocabulary);
    expect(next.unresolved[0]!.material).toBe(false);
    expect(next.measures.map((measure) => measure.ref)).toEqual(['metric:customers.lifetime_spend']);
    expect(next.provenance['metric:customers.lifetime_spend']).toMatch(/certified precedent block:commerce.customer_profile/);
  });
  it('a second reading that still replaces the previous analysis becomes a clarification between the two', async () => {
    const prior = intent({
      reading: 'Top customers by beverage revenue', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
      provenance: { 'metric:order_item.drink_revenue': 'q:top customers for beverage product category' },
    });
    const replaced = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Beverage revenue by product', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }], display: [], filters: [], unresolved: [], expectedShape: 'ranking',
      provenance: { 'entity:customers.customer': 'removed:asks for products', 'dimension:customers.customer_name': 'removed:asks for products' },
    }).replace('metric:order_item.drink_revenue', 'metric:order_item.revenue');
    const provider = scripted([replaced, replaced]);
    const result = await resolveIntent({ question: 'I need to get the bevereage catogery', vocabulary, provider, prior });
    expect(result.status).toBe('clarify');
    if (result.status === 'clarify') {
      expect(result.options).toEqual(['metric:order_item.drink_revenue', 'metric:order_item.revenue']);
      expect(result.question).toMatch(/Keep the previous analysis/);
    }
    expect(result.attempts).toBe(2);
  });
});

describe('"not modeled" is checked against the whole vocabulary', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('a gap claimed for words that name a numeric column is sent back with the column as a measure', () => {
    const next = validateIntentRefs(intent({ groupBy: [{ ref: 'entity:products.product', role: 'key' }], unresolved: [{ clause: 'supply cost by product', options: [], material: true }] }), vocabulary);
    const problem = next.problems.find((candidate) => candidate.path === 'unresolved');
    expect(problem?.message).toMatch(/is modeled: .*column:dev.supplies.supply_cost/);
    expect(problem?.message).toMatch(/as a measure/);
  });
  it('a gap for words that name nothing stands', () => {
    const next = validateIntentRefs(intent({ unresolved: [{ clause: 'weather in Philadelphia', options: [], material: true }] }), vocabulary);
    expect(next.problems.filter((candidate) => candidate.path === 'unresolved')).toEqual([]);
  });
});

describe('an empty aggregate is not an answer about a member', () => {
  const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  const candidate = { tier: 'semantic' as const, trust: 'governed' as const, sql: "SELECT SUM(x) AS revenue FROM t WHERE customer_name = 'Ryan byrd'", proof: [] };
  it('a single all-null row over a member filter is reported as no rows matched', async () => {
    const outcome = await executeCandidate(candidate, intent, { run: async () => ({ columns: ['revenue'], rows: [{ revenue: null }], rowCount: 1, executionTimeMs: 1 }) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) { expect(outcome.code).toBe('no_rows_matched'); expect(outcome.message).toMatch(/no rows matched "Ryan byrd"/); }
  });
  it('a real value passes', async () => {
    const outcome = await executeCandidate(candidate, intent, { run: async () => ({ columns: ['revenue'], rows: [{ revenue: 2581 }], rowCount: 1, executionTimeMs: 1 }) });
    expect(outcome.ok).toBe(true);
  });
});

describe('no partial answers: a clause nothing models stays material', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const intent = (raw: Record<string, unknown>): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', display: [], filters: [], groupBy: [], measures: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...raw });
    if (!parsed.intent) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.intent;
  };
  it('a material clause with no options is never demoted', () => {
    const next = intent({
      measures: [{ ref: 'metric:order_item.revenue' }],
      unresolved: [{ clause: 'weather in Philadelphia', options: [], material: true, question: 'What is weather?' }],
    });
    applyGovernedDefaults(next, 'revenue and the weather in Philadelphia', vocabulary);
    expect(next.unresolved[0]!.material).toBe(true);
  });
  it('the gap names the reading that was answerable, and executes nothing', async () => {
    const reply = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Total revenue alongside the weather.', measures: [{ ref: 'metric:order_item.revenue' }],
      groupBy: [], display: [], filters: [], unresolved: [{ clause: 'weather in Philadelphia', options: [], material: true }], provenance: {}, expectedShape: 'scalar',
    });
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply };
    let executed = 0;
    const outcome = await runAskPipeline({
      question: 'total revenue and the weather in Philadelphia', vocabulary, provider, prepareDeps: {},
      executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } },
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') {
      expect(outcome.gap).toBe('not_modeled');
      expect(outcome.text).toMatch(/Answerable from this reading: .*Revenue/);
    }
    expect(executed).toBe(0);
  });
});

describe('an empty aggregate under any restriction is not an answer', () => {
  const base = { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' };
  const candidate = { tier: 'semantic' as const, trust: 'governed' as const, sql: 'SELECT SUM(x) AS revenue FROM t', proof: [] };
  const nullRow = async () => ({ columns: ['revenue'], rows: [{ revenue: null }], rowCount: 1, executionTimeMs: 1 });
  it('a null scalar under a time window names the window', async () => {
    const windowed = parseIntent({ ...base, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2027-01-01', end: '2028-01-01' } } }).intent!;
    const outcome = await executeCandidate({ ...candidate, sql: "SELECT SUM(x) AS revenue FROM t WHERE ordered_at >= '2027-01-01' AND ordered_at < '2028-01-01'" }, windowed, { run: nullRow });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('no_rows_matched');
      expect(outcome.message).toMatch(/no rows fell inside the window 2027-01-01\.\.2028-01-01/);
      expect(outcome.cause).toEqual({ kind: 'window', start: '2027-01-01', end: '2028-01-01' });
    }
  });
  it('a null scalar under a boolean scope names the predicate', async () => {
    const scoped = parseIntent({ ...base, measures: [{ ref: 'metric:order_item.revenue', scope: [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }] }] }).intent!;
    const outcome = await executeCandidate({ ...candidate, sql: 'SELECT SUM(x) AS revenue FROM t WHERE is_drink_item' }, scoped, { run: nullRow });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/no rows matched the restriction on dimension:order_item.is_drink_item/);
  });
  it('zero rows under a window is the same gap: an engine that filters before aggregating returns nothing, not null', async () => {
    const windowed = parseIntent({ ...base, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2031-01-01', end: '2032-01-01' } } }).intent!;
    const outcome = await executeCandidate({ ...candidate, sql: 'SELECT SUM(x) AS revenue FROM t WHERE ordered_at >= ? AND ordered_at < ?', params: ['2031-01-01', '2032-01-01'] }, windowed, { run: async () => ({ columns: ['revenue'], rows: [], rowCount: 0, executionTimeMs: 1 }) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toEqual({ kind: 'window', start: '2031-01-01', end: '2032-01-01' });
  });
  it('a query that does not bind the window bounds never runs', async () => {
    const windowed = parseIntent({ ...base, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2031-01-01', end: '2032-01-01' } } }).intent!;
    let ran = 0;
    const outcome = await executeCandidate(candidate, windowed, { run: async () => { ran += 1; return { columns: ['revenue'], rows: [{ revenue: 637444 }], rowCount: 1, executionTimeMs: 1 }; } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) { expect(outcome.code).toBe('filter_not_applied'); expect(outcome.message).toMatch(/does not apply the time window 2031-01-01\.\.2032-01-01/); }
    expect(ran).toBe(0);
  });
  it('an unrestricted null scalar or empty result is still an answer: the table is empty', async () => {
    const outcome = await executeCandidate(candidate, parseIntent(base).intent!, { run: nullRow });
    expect(outcome.ok).toBe(true);
    const empty = await executeCandidate(candidate, parseIntent(base).intent!, { run: async () => ({ columns: ['revenue'], rows: [], rowCount: 0, executionTimeMs: 1 }) });
    expect(empty.ok).toBe(true);
  });
});

describe('calendar cells render as dates, never through the host timezone', () => {
  it('a UTC-midnight instant is the calendar day; other values are untouched', () => {
    expect(formatValue('2025-03-01T00:00:00.000Z')).toBe('2025-03-01');
    expect(formatValue('2025-03-01T00:00:00Z')).toBe('2025-03-01');
    expect(formatValue(new Date('2025-12-01T00:00:00.000Z'))).toBe('2025-12-01');
    expect(formatValue('2025-03-01T13:45:00.000Z')).toBe('2025-03-01T13:45:00.000Z');
    expect(formatValue(1234.5)).toBe('1234.50');
    expect(formatValue('Philadelphia')).toBe('Philadelphia');
  });
});

describe('a question word is covered when the used measure embodies it', () => {
  const source: VocabularySource = {
    metrics: [{ name: 'drink_revenue', model: 'order_item', label: 'Drink Revenue', description: 'The revenue from drinks in each order.', aggregation: 'sum', expr: 'SUM(case when is_drink_item then product_price else 0 end)' }],
    dimensions: [{ name: 'is_drink_item', model: 'order_item', dataType: 'boolean' }],
    terms: [{ name: 'Beverage', description: 'Filter on products.is_drink_item = true for beverage analysis.' }],
  };
  const local = buildVocabularyIndex(source);
  it('"beverage" is covered by drink_revenue through the term that names is_drink_item', () => {
    const used = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(uncoveredQuestionTerms('total beverage revenue', used, local)).toEqual([]);
  });
  it('a term whose definition the used measures do not embody is still reported', () => {
    const withoutRule = buildVocabularyIndex({ ...source, terms: [{ name: 'Beverage', description: 'Drinks sold at the counter.' }] });
    const used = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(uncoveredQuestionTerms('total beverage revenue', used, withoutRule)).toEqual(['beverage']);
  });
});

describe('a time window without an axis', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const windowed = (measure: string) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: measure }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar', time: { window: { start: '2031-01-01', end: '2032-01-01', expression: 'in 2031' } } }).intent!;
  it("is bound to the measure's own time axis when the model has exactly one, and says so", () => {
    const next = validateIntentRefs(windowed('metric:order_item.revenue'), vocabulary);
    expect(next.intent.time?.ref).toBe('dimension:order_item.ordered_at');
    expect(next.intent.provenance['dimension:order_item.ordered_at']).toMatch(/host:time window "in 2031"/);
  });
  it('stays unbound when the model declares no time dimension', () => {
    const next = validateIntentRefs(windowed('metric:customers.lifetime_spend'), vocabulary);
    expect(next.intent.time?.ref).toBeUndefined();
  });
});

describe('contract v1.1: derived ratio and population', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const legacy = { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', limit: 10, ordering: { ref: 'measure:0', direction: 'desc' } };
  it('an intent without the new fields parses and fingerprints exactly as before', () => {
    const parsed = parseIntent(legacy).intent!;
    expect(parsed.population).toBeUndefined();
    expect(parsed.measures[0]!.derived).toBeUndefined();
    // Pinned: the execution fingerprint of this legacy intent must never move.
    expect(intentExecutionFingerprint(parsed)).toBe(intentExecutionFingerprint(parseIntent({ ...legacy, population: 'matching' }).intent!));
    expect(intentExecutionFingerprint(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(intentExecutionFingerprint(parseIntent({ ...legacy, population: 'all' }).intent!)).not.toBe(intentExecutionFingerprint(parsed));
  });
  it('a derived ratio needs no ref: one is synthesized, and its parts are its refs', () => {
    const parsed = parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }] }).intent!;
    expect(parsed.measures[0]).toEqual({ ref: 'ratio:metric:order_item.revenue/metric:orders.orders', derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' });
    expect(intentRefs(parsed)).toEqual(['dimension:customers.customer_name', 'entity:customers.customer', 'metric:order_item.revenue', 'metric:orders.orders']);
    expect(describeIntent(parsed, (ref) => ref.split('.').pop()!)).toMatch(/^revenue per orders/);
    expect(parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue' } }] }).errors[0]?.path).toBe('measures[0].derived');
  });
  it('ratio parts are canonicalised as metrics or measures; a column part needs its aggregation', () => {
    const ok = validateIntentRefs(parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }] }).intent!, vocabulary);
    expect(ok.intent.measures[0]!.derived).toEqual({ kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' });
    expect(ok.intent.measures[0]!.ref).toBe('ratio:metric:order_item.revenue/metric:orders.orders');
    const bad = validateIntentRefs(parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'column:dev.orders.order_total', denominator: 'metric:orders.orders' } }] }).intent!, vocabulary);
    expect(bad.problems.some((problem) => problem.path === 'measures[0].derived.numerator' && /needs numeratorAggregation/.test(problem.message))).toBe(true);
    const column = validateIntentRefs(parseIntent({ ...legacy, measures: [{ derived: { kind: 'ratio', numerator: 'column:dev.orders.order_total', numeratorAggregation: 'sum', denominator: 'column:dev.orders.order_id', denominatorAggregation: 'count_distinct' } }] }).intent!, vocabulary);
    expect(column.problems).toEqual([]);
  });
  it('population "all" rewrites the key to the entity\'s primary owner and needs a key', () => {
    const source: VocabularySource = {
      metrics: [{ name: 'order_total', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_total"', aggregate: 'sum' } }],
      entities: [
        { name: 'location', model: 'orders', type: 'foreign', physical: { relation: 'dev.orders', column: 'location_id' } },
        { name: 'location', model: 'locations', type: 'primary', physical: { relation: 'dev.locations', column: 'location_id' } },
      ],
      dimensions: [{ name: 'location_name', model: 'locations', dataType: 'string', physical: { relation: 'dev.locations', column: 'location_name' } }],
    };
    const local = buildVocabularyIndex(source);
    const base = { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:orders.order_total' }], display: ['dimension:locations.location_name'], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped', population: 'all' };
    const rewritten = validateIntentRefs(parseIntent({ ...base, groupBy: [{ ref: 'entity:orders.location', role: 'key' }] }).intent!, local);
    expect(rewritten.problems).toEqual([]);
    expect(rewritten.intent.groupBy[0]!.ref).toBe('entity:locations.location');
    expect(rewritten.intent.provenance['entity:locations.location']).toMatch(/host:population "all"/);
    const keyless = validateIntentRefs(parseIntent({ ...base, groupBy: [] }).intent!, local);
    expect(keyless.problems.some((problem) => /exactly one entity key/.test(problem.message))).toBe(true);
  });
});

describe('time roles under one window', () => {
  const source: VocabularySource = {
    metrics: [
      { name: 'revenue', model: 'order_item', aggregation: 'sum', aggTimeDimension: 'ordered_at', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } },
      { name: 'orders', model: 'orders', aggregation: 'count', aggTimeDimension: 'ordered_at', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_id"', aggregate: 'count' } },
      { name: 'customers', model: 'customers', aggregation: 'count_distinct', aggTimeDimension: 'first_ordered_at', physical: { relation: 'dev.customers', expr: '"dev"."customers"."customer_id"', aggregate: 'count_distinct' } },
    ],
    dimensions: [
      { name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.order_items', column: 'ordered_at' } },
      { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.orders', column: 'ordered_at' } },
      { name: 'first_ordered_at', model: 'customers', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.customers', column: 'first_ordered_at' } },
      { name: 'metric_time', model: 'order_item', dataType: 'timestamp', isTime: true },
    ],
  };
  const local = buildVocabularyIndex(source);
  const windowed = (measures: unknown[], time: Record<string, unknown> = {}, provenance: Record<string, string> = {}) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures, groupBy: [], display: [], filters: [], unresolved: [], provenance, expectedShape: 'scalar', time: { ...time, window: { start: '2025-01-01', end: '2026-01-01', expression: 'in 2025' } } }).intent!;
  it('the card says which time a metric aggregates over', () => {
    expect(local.get('metric:customers.customers')?.timeRef).toBe('dimension:customers.first_ordered_at');
    expect(local.renderCards()).toMatch(/metric:customers\.customers \[[^\]]*time first_ordered_at/);
  });
  it('one shared role (the same-named order date on two models) becomes the window axis, and a metric_time axis is replaced by it', () => {
    const intent = windowed([{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }]);
    proveTimeRoles(intent, local);
    expect(intent.time?.ref).toBe('dimension:order_item.ordered_at');
    expect(intent.unresolved).toEqual([]);
    const kept = windowed([{ ref: 'metric:order_item.revenue' }, { ref: 'metric:orders.orders' }], { ref: 'dimension:orders.ordered_at' }, { 'dimension:orders.ordered_at': 'q:in 2025' });
    proveTimeRoles(kept, local);
    expect(kept.time?.ref).toBe('dimension:orders.ordered_at');
    expect(intent.provenance['dimension:order_item.ordered_at']).toMatch(/host:time window "in 2025"/);
    const generic = windowed([{ ref: 'metric:order_item.revenue' }], { ref: 'dimension:order_item.metric_time' });
    proveTimeRoles(generic, local);
    expect(generic.time?.ref).toBe('dimension:order_item.ordered_at');
  });
  it('two roles become one bounded clarification, never a silent choice', () => {
    const intent = windowed([{ ref: 'metric:order_item.revenue' }, { ref: 'metric:customers.customers' }]);
    proveTimeRoles(intent, local);
    expect(intent.time?.ref).toBeUndefined();
    expect(intent.unresolved).toHaveLength(1);
    expect(intent.unresolved[0]).toMatchObject({ clause: 'in 2025', material: true, options: ['dimension:order_item.ordered_at', 'dimension:customers.first_ordered_at'] });
    expect(intent.unresolved[0]!.question).toMatch(/different time for these measures/);
  });
  it('an axis the question named itself is kept and the difference is disclosed', () => {
    const intent = windowed([{ ref: 'metric:order_item.revenue' }, { ref: 'metric:customers.customers' }], { ref: 'dimension:customers.first_ordered_at' }, { 'dimension:customers.first_ordered_at': 'q:first acquired in 2025' });
    proveTimeRoles(intent, local);
    expect(intent.time?.ref).toBe('dimension:customers.first_ordered_at');
    expect(intent.unresolved).toEqual([]);
    expect(intent.provenance['dimension:customers.first_ordered_at']).toMatch(/applies on first_ordered_at to every measure/);
  });
  it('the semantic tier compiles both parts of a ratio and divides after execution; ordering by the ratio is relational', () => {
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    const bound = bindSemanticRequest(intent, local);
    expect(bound.request?.metrics).toEqual(['revenue', 'orders']);
    expect(bound.derived).toEqual([{ alias: 'aov', numerator: 'revenue', denominator: 'orders' }]);
    const windowedRatio = { ...intent, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01' } }, provenance: { 'dimension:order_item.ordered_at': 'host:time window "in 2025" applied on the measures\' time role' } };
    expect(bindSemanticRequest(windowedRatio, local).request?.filters).toEqual([{ dimension: 'order_item.ordered_at', operator: 'gte', values: ['2025-01-01'] }, { dimension: 'order_item.ordered_at', operator: 'lt', values: ['2026-01-01'] }]);
    // On MetricFlow and dbt Cloud a host-chosen window is every metric's own aggregation time.
    expect(bindSemanticRequest(windowedRatio, local, 'metricflow-cli').request?.filters?.map((filter) => filter.dimension)).toEqual(['metric_time', 'metric_time']);
    expect(bindSemanticRequest(windowedRatio, local, 'native').request?.filters?.map((filter) => filter.dimension)).toEqual(['order_item.ordered_at', 'order_item.ordered_at']);
    // A month trend over a measure's own aggregation time is `metric_time` on
    // MetricFlow (offset metrics resolve only on it), ordered by the same item.
    const trend = { ...intent, measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time' as const, grain: 'month' as const }], ordering: { ref: 'dimension:order_item.ordered_at', direction: 'asc' as const }, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-07-01', end: '2025-09-01' } } };
    const onMetricFlow = bindSemanticRequest(trend, local, 'metricflow-cli').request!;
    expect(onMetricFlow.timeDimension).toEqual({ name: 'metric_time', granularity: 'month' });
    expect(onMetricFlow.orderBy).toEqual([{ name: 'metric_time', direction: 'asc' }]);
    expect(onMetricFlow.filters?.map((filter) => filter.dimension)).toEqual(['metric_time', 'metric_time']);
    const onNative = bindSemanticRequest(trend, local, 'native').request!;
    expect(onNative.timeDimension).toEqual({ name: 'order_item.ordered_at', granularity: 'month' });
    expect(onNative.orderBy).toEqual([{ name: 'order_item.ordered_at', direction: 'asc' }]);
    // A time the question chose on another model stays concrete everywhere.
    const cohort = { ...trend, groupBy: [{ ref: 'dimension:customers.first_ordered_at', role: 'time' as const, grain: 'year' as const }], ordering: undefined, time: undefined };
    expect(bindSemanticRequest(cohort, local, 'metricflow-cli').request?.timeDimension).toEqual({ name: 'customers.first_ordered_at', granularity: 'year' });
    const ordered = bindSemanticRequest({ ...intent, ordering: { ref: 'measure:0', direction: 'desc' } }, local);
    expect(ordered.refusal?.message).toMatch(/ordering by the ratio/);
    const population = bindSemanticRequest({ ...intent, population: 'all' }, local);
    expect(population.refusal?.code).toBe('not_semantic');
    const divided = applyDerivedColumns({ columns: ['revenue', 'orders'], rows: [{ revenue: 546503, orders: 53559 }, { revenue: 10, orders: 0 }], rowCount: 2, executionTimeMs: 1 }, bound.derived!);
    expect(divided.columns).toEqual(['aov']);
    expect(divided.rows[0]!.aov).toBeCloseTo(10.2038, 3);
    expect(divided.rows[1]!.aov).toBeNull();
    const kept = applyDerivedColumns({ columns: ['revenue', 'orders'], rows: [{ revenue: 4, orders: 2 }], rowCount: 1, executionTimeMs: 1 }, [{ alias: 'aov', numerator: 'revenue', denominator: 'orders', keepInputs: true }]);
    expect(kept.columns).toEqual(['revenue', 'orders', 'aov']);
  });
});

describe('a derived metric card shows what it divides', () => {
  it('renders the formula and the time role, so a lifetime ratio is never mistaken for a period one', () => {
    const local = buildVocabularyIndex({ metrics: [{ name: 'average_order_value', model: 'customers', label: 'Average Order Value', type: 'derived', expr: 'lifetime_spend_pretax / count_lifetime_orders', aggTimeDimension: 'first_ordered_at', description: 'LTV pre-tax / number of orders' }] });
    expect(local.renderCards()).toMatch(/metric:customers\.average_order_value \[[^\]]*time first_ordered_at\] = lifetime_spend_pretax \/ count_lifetime_orders LTV pre-tax/);
  });
});

describe('the units contract of a result', () => {
  const source: VocabularySource = {
    metrics: [
      { name: 'revenue', model: 'order_item', label: 'Revenue', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } },
      { name: 'orders', model: 'orders', aggregation: 'count', physical: { relation: 'dev.orders', expr: '"dev"."orders"."order_id"', aggregate: 'count' } },
      { name: 'drink_revenue_pct', model: 'order_item', type: 'ratio', expr: 'drink_revenue / revenue' },
      { name: 'revenue_growth_mom', model: 'order_item', type: 'derived', displayFormat: { kind: 'percent', decimals: 1 } },
      { name: 'order_total', model: 'orders', aggregation: 'sum', displayFormat: { kind: 'currency', currency: 'USD' } },
      { name: 'order_count_sum', model: 'orders', label: 'Orders placed', aggregation: 'sum', expr: '1', physical: { relation: 'dev.orders', expr: '1', aggregate: 'sum' } },
      { name: 'count_order_items', model: 'orders', aggregation: 'sum', physical: { relation: 'dev.orders', expr: '"dev"."orders"."count_order_items"', aggregate: 'sum' } },
    ],
    dimensions: [{ name: 'ordered_at', model: 'order_item', dataType: 'timestamp', isTime: true, physical: { relation: 'dev.order_items', column: 'ordered_at' } }, { name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } }],
    entities: [{ name: 'customer', model: 'customers', type: 'primary', physical: { relation: 'dev.customers', column: 'customer_id' } }],
  };
  const local = buildVocabularyIndex(source);
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw }).intent!;
  it('reads currency, counts, ratios, derived formats and time grains from the vocabulary, not from the values', () => {
    const intent = make({
      measures: [{ ref: 'metric:order_item.revenue' }, { ref: 'metric:orders.orders' }, { ref: 'metric:order_item.drink_revenue_pct' }, { ref: 'metric:order_item.revenue_growth_mom' }, { ref: 'metric:orders.order_total' }, { derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }],
      groupBy: [{ ref: 'entity:customers.customer', role: 'key' }, { ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], display: ['dimension:customers.customer_name'],
    });
    const meta = describeResultColumns(intent, { columns: ['customer_id', 'customer_name', 'ordered_at_month', 'revenue', 'orders', 'drink_revenue_pct', 'revenue_growth_mom', 'order_total', 'aov', 'mystery'], rows: [{ mystery: 'x' }] }, local);
    const kinds = Object.fromEntries(meta.map((item) => [item.name, `${item.kind}${item.unit ? `:${item.unit}` : ''}${item.grain ? `@${item.grain}` : ''}`]));
    expect(kinds).toEqual({ customer_id: 'text', customer_name: 'text', ordered_at_month: 'date@month', revenue: 'currency:USD', orders: 'count', drink_revenue_pct: 'percent:fraction', revenue_growth_mom: 'percent:fraction', order_total: 'currency:USD', aov: 'currency:USD', mystery: 'text' });
    expect(meta.find((item) => item.name === 'revenue_growth_mom')?.decimals).toBe(1);
    expect(meta.find((item) => item.name === 'revenue')?.ref).toBe('metric:order_item.revenue');
    const counts = describeResultColumns(make({ measures: [{ ref: 'metric:orders.order_count_sum' }, { ref: 'metric:orders.count_order_items' }] }), { columns: ['order_count_sum', 'count_order_items'], rows: [] }, local);
    expect(counts.map((item) => item.kind)).toEqual(['count', 'count']);
    const growth = buildVocabularyIndex({ metrics: [{ name: 'revenue_growth_mom', model: 'order_item', type: 'derived', expr: '(current_revenue - revenue_prev_month)*100/revenue_prev_month' }] });
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:order_item.revenue_growth_mom' }] }), { columns: ['revenue_growth_mom'], rows: [] }, growth)[0]).toMatchObject({ kind: 'percent', unit: 'percentage_points' });
  });
  it('a semantic column name that qualifies the dimension still finds its meta', () => {
    const intent = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }] });
    const meta = describeResultColumns(intent, { columns: ['order_item__ordered_at__month', 'revenue'], rows: [] }, local);
    expect(meta[0]).toMatchObject({ name: 'order_item__ordered_at__month', kind: 'date', grain: 'month' });
  });
  it('formatValue renders by the contract: fractions as percentages, points as pp, counts whole', () => {
    expect(formatValue(0.6263, { name: 'x', kind: 'percent', unit: 'fraction' })).toBe('62.6%');
    expect(formatValue(10.84, { name: 'x', kind: 'percent', unit: 'percentage_points' })).toBe('10.8 pp');
    expect(formatValue(2085.0, { name: 'x', kind: 'count' })).toBe('2085');
    expect(formatValue(2735.7, { name: 'x', kind: 'currency', unit: 'USD' })).toBe('2735.70');
    expect(formatValue(2735.7)).toBe('2735.70');
  });
  it('the answer names shared identities and certified caveats', () => {
    const intent = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'] });
    const text = composeAnsweredText(intent, { columns: ['customer_id', 'customer_name', 'revenue'], rows: [{ customer_id: 'a', customer_name: 'Jordan Lee', revenue: 17 }, { customer_id: 'b', customer_name: 'Jordan Lee', revenue: 11 }], rowCount: 2, executionTimeMs: 1 }, local, 'governed', { notes: ['customer_name: "jordan lee" is stored as "Jordan Lee"', 'identity: 2 customers share the name "Jordan Lee"; one row per customer, keyed by customer_id'] });
    expect(text).toMatch(/2 customers share the name "Jordan Lee"; one row per customer, keyed by customer_id\./);
    expect(text).not.toMatch(/stored as/);
    const certified = composeAnsweredText(intent, { columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1, executionTimeMs: 1 }, local, 'certified', { caveats: ['the block groups by customer_name (a label) with no identity key, so two entities sharing a name would merge; recertify it with the entity key to keep them apart'] });
    expect(certified).toMatch(/Source: a certified block\. the block groups by customer_name .* recertify it with the entity key to keep them apart\.$/);
  });
});

describe('the name wins: a question word that exactly names a metric binds to it', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...raw }).intent!;
  it('unqualified revenue replaces a confidently chosen sibling, and the provenance says why', () => {
    const intent = make({ measures: [{ ref: 'metric:orders.order_total' }], provenance: { 'metric:orders.order_total': 'q:How much revenue do we have' } });
    applyGovernedDefaults(intent, 'How much revenue do we have?', vocabulary);
    expect(intent.measures[0]!.ref).toBe('metric:order_item.revenue');
    expect(intent.provenance['metric:order_item.revenue']).toMatch(/governed default: the question names the metric "revenue"/);
    expect(intent.reading).toBe('x; measured as Revenue because the question names the metric "revenue".');
  });
  it('a qualifier keeps the gross reading, and a metric the question names by alias stays', () => {
    const gross = make({ measures: [{ ref: 'metric:orders.order_total' }] });
    applyGovernedDefaults(gross, 'How much revenue do we have including tax?', vocabulary);
    expect(gross.measures[0]!.ref).toBe('metric:orders.order_total');
    const beverage = make({ measures: [{ ref: 'metric:order_item.drink_revenue' }] });
    applyGovernedDefaults(beverage, 'what is the beverage revenue', vocabulary);
    expect(beverage.measures[0]!.ref).toBe('metric:order_item.drink_revenue');
  });
  it('the rule also reaches ratio parts and ordering, and never fires when the question names several metrics', () => {
    const ratio = make({ measures: [{ derived: { kind: 'ratio', numerator: 'metric:orders.order_total', denominator: 'metric:orders.orders' }, alias: 'aov' }], ordering: { ref: 'metric:orders.order_total', direction: 'desc' } });
    bindExactNames(ratio, ' what is revenue per order ', new Set(), vocabulary);
    expect(ratio.measures[0]!.derived).toEqual({ kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' });
    expect(ratio.measures[0]!.ref).toBe('ratio:metric:order_item.revenue/metric:orders.orders');
    expect(ratio.ordering?.ref).toBe('metric:order_item.revenue');
    const two = make({ measures: [{ ref: 'metric:orders.order_total' }] });
    bindExactNames(two, ' compare revenue and order total ', new Set(), vocabulary);
    expect(two.measures[0]!.ref).toBe('metric:orders.order_total');
  });
  it('a measure whose own name spends the word is kept; only the sibling that does not is rebound', () => {
    // "beverage revenue" read as drink_revenue has used "revenue" (no alias needed).
    const plain = buildVocabularyIndex({ ...jaffle, metrics: jaffle.metrics!.map((metric) => metric.name === 'drink_revenue' ? { ...metric, aliases: [] } : metric) });
    const beverage = make({ measures: [{ ref: 'metric:order_item.drink_revenue' }] });
    bindExactNames(beverage, ' beverage revenue ', new Set(), plain);
    expect(beverage.measures[0]!.ref).toBe('metric:order_item.drink_revenue');
    const both = make({ measures: [{ ref: 'metric:orders.order_total' }, { ref: 'metric:order_item.drink_revenue' }] });
    bindExactNames(both, ' total revenue and beverage revenue give me both ', new Set(), plain);
    expect(both.measures.map((measure) => measure.ref)).toEqual(['metric:order_item.revenue', 'metric:order_item.drink_revenue']);
  });
  it('an entity noun in the question ("customers") is never the named metric, even without a grouping', () => {
    const intent = make({ measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:customers.customer_type', op: 'eq', values: ['new'], source: 'question' }] }, { ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:customers.customer_type', op: 'eq', values: ['returning'], source: 'question' }] }] });
    bindExactNames(intent, ' how much revenue comes from new versus returning customers ', new Set(), vocabulary);
    expect(intent.measures.map((measure) => measure.ref)).toEqual(['metric:order_item.revenue', 'metric:order_item.revenue']);
    expect(intent.measures[0]!.scope?.[0]?.values).toEqual(['new']);
  });
  it('a ratio or derived metric the question names never rebinds the parts of a composed ratio', () => {
    const withAov = buildVocabularyIndex({ ...jaffle, metrics: [...jaffle.metrics!, { name: 'average_order_value', model: 'customers', label: 'Average Order Value', type: 'ratio', expr: 'lifetime_spend_pretax / count_lifetime_orders', aggregation: 'sum' }] });
    const ratio = make({ measures: [{ derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'average_order_value' }] });
    bindExactNames(ratio, ' what is the average order value ', new Set(), withAov);
    expect(ratio.measures[0]!.derived).toEqual({ kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' });
  });
});

describe('a restriction on the only measure restricts the population', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped', ...raw }).intent!;
  const scope = [{ ref: 'dimension:order_item.is_drink_item', op: 'is_true', values: [], source: 'question' }];
  it('the sole scoped measure becomes a population filter with host provenance', () => {
    const intent = make({ measures: [{ ref: 'metric:order_item.revenue', scope }], groupBy: [{ ref: 'entity:order_item.product', role: 'key' }] });
    applyGovernedDefaults(intent, 'beverage revenue by product', vocabulary);
    expect(intent.measures[0]!.scope).toBeUndefined();
    expect(intent.filters).toEqual(scope);
    expect(intent.provenance['filter:dimension:order_item.is_drink_item']).toMatch(/restricts the population/);
  });
  it('two measures, a ratio, or an explicit whole population keep their scopes', () => {
    const two = make({ measures: [{ ref: 'metric:order_item.revenue', scope }, { ref: 'metric:order_item.revenue' }] });
    applyGovernedDefaults(two, 'beverage revenue and revenue', vocabulary);
    expect(two.measures[0]!.scope).toEqual(scope);
    const all = make({ measures: [{ ref: 'metric:order_item.revenue', scope }], groupBy: [{ ref: 'entity:order_item.product', role: 'key' }], population: 'all' });
    applyGovernedDefaults(all, 'beverage revenue for every product', vocabulary);
    expect(all.measures[0]!.scope).toEqual(scope);
    expect(all.filters).toEqual([]);
  });
});

describe('full-question applicability', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:orders.order_total' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'trend', ...raw }).intent!;
  it('why and where-to-invest are unsupported operations: a material clause, nothing executes', () => {
    const intent = make({});
    proveClauseCoverage('Why is our revenue down by region, and which region should we invest in?', intent, vocabulary);
    expect(intent.unresolved).toHaveLength(2);
    expect(intent.unresolved[0]).toMatchObject({ material: true, kind: 'unsupported', options: [] });
    expect(intent.unresolved[0]!.question).toMatch(/Research can investigate/);
    // The dropped breakdown is named too, even though the month grouping stands.
    expect(intent.unresolved[1]).toMatchObject({ clause: 'by region', kind: 'not_modeled' });
    const monthly = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }] });
    proveClauseCoverage('revenue by region', monthly, vocabulary);
    expect(monthly.unresolved[0]).toMatchObject({ clause: 'by region', kind: 'not_modeled' });
  });
  it('a breakdown noun nothing models, dropped by the interpreter, is a named gap; one the intent groups by is not', () => {
    const dropped = make({});
    proveClauseCoverage('show revenue by region', dropped, vocabulary);
    expect(dropped.unresolved[0]).toMatchObject({ clause: 'by region', material: true, kind: 'not_modeled' });
    const grouped = make({ measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }] });
    proveClauseCoverage('revenue by segment', grouped, vocabulary);
    expect(grouped.unresolved).toEqual([]);
    const month = make({ measures: [{ ref: 'metric:order_item.revenue' }] });
    proveClauseCoverage('revenue by month', month, vocabulary);
    expect(month.unresolved).toEqual([]);
  });
  it('the pipeline ends an unsupported clause as a gap that names it and the answerable reading, executing nothing', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly gross revenue trend.', measures: [{ ref: 'metric:orders.order_total' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'trend' });
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'Why is our revenue down by region, and which region should we invest in?', vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => reply }, prepareDeps: {}, executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } } });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') { expect(outcome.gap).toBe('unsupported'); expect(outcome.text).toMatch(/Research can investigate/); expect(outcome.text).toMatch(/Answerable from this reading/); }
    expect(executed).toBe(0);
    const branch = await runAskPipeline({ question: 'Beverage revenue is high because a few products dominate', vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => JSON.stringify({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:products.product', role: 'key' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking' }) }, prepareDeps: {}, executeDeps: { run: async () => ({ columns: ['drink_revenue'], rows: [], rowCount: 0, executionTimeMs: 1 }) }, clauseCoverage: false });
    // A hypothesis "because ..." is not a why-question: no unsupported clause, the branch prepares normally.
    expect(branch.kind === 'gap' ? branch.gap : 'prepared').not.toBe('unsupported');
    expect(branch.receipt.intent?.unresolved).toEqual([]);
  });
});

describe('definitions in the answer', () => {
  it('a grouped dimension with a governed description is defined in one sentence', () => {
    const local = buildVocabularyIndex({
      metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum' }],
      dimensions: [{ name: 'customer_type', model: 'customers', dataType: 'string', label: 'Customer type', description: "Options are 'new' or 'returning', indicating if a customer has ordered more than once or has only placed their first order." }],
    });
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_type', role: 'categorical' }], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' }).intent!;
    const text = composeAnsweredText(intent, { columns: ['customer_type', 'revenue'], rows: [{ customer_type: 'new', revenue: 100 }, { customer_type: 'returning', revenue: 900 }], rowCount: 2, executionTimeMs: 1 }, local, 'governed');
    expect(text).toMatch(/Definitions: Customer type: Options are 'new' or 'returning'/);
  });
});

describe('a provider timeout is retried once, under the same run, when the budget allows', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const good = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Revenue', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [],
    expectedShape: 'scalar', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' },
  });
  const timeout = () => Object.assign(new Error('The AI model did not respond within 60 seconds.'), { code: 'provider_timeout', detail: 'Retry, choose a faster model, or increase DQL_SUBSCRIPTION_CLI_TIMEOUT_MS.' });
  function flaky(failures: number, error: () => Error = timeout): AgentProvider & { calls: number } {
    const provider = {
      name: 'ollama', calls: 0, available: async () => true,
      generate: async () => { provider.calls += 1; if (provider.calls <= failures) throw error(); return good; },
    };
    return provider;
  }
  it('the typed code travels through the structured reply', async () => {
    const { generateStructured } = await import('../providers/structured-output.js');
    const reply = await generateStructured(flaky(1), [{ role: 'user', content: 'q' }], {});
    expect(reply.error).toBe('provider_error');
    expect(reply.code).toBe('provider_timeout');
    expect(reply.detail).toContain('did not respond within 60 seconds');
    expect(reply.detail).toContain('DQL_SUBSCRIPTION_CLI_TIMEOUT_MS');
  });
  it('one timeout then an answer is one resolution of two dispatches', async () => {
    const provider = flaky(1);
    const dispatches: string[] = [];
    const result = await resolveIntent({ question: 'revenue', vocabulary, provider, budgetMs: 150_000, onDispatch: (event) => dispatches.push(event.purpose) });
    expect(result.status).toBe('resolved');
    expect(provider.calls).toBe(2);
    expect(dispatches).toEqual(['resolve', 'correct']);
  });
  it('a second timeout ends the turn with the typed code', async () => {
    const result = await resolveIntent({ question: 'revenue', vocabulary, provider: flaky(2), budgetMs: 150_000 });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') { expect(result.code).toBe('provider_timeout'); expect(result.attempts).toBe(2); }
  });
  it('no retry without room for another full dispatch, and none for other provider failures', async () => {
    const provider = flaky(1);
    const short = await resolveIntent({ question: 'revenue', vocabulary, provider, budgetMs: 60_000 });
    expect(short.status).toBe('failed');
    expect(provider.calls).toBe(1);
    const other = flaky(1, () => new Error('Claude Code exited before producing an answer'));
    const failed = await resolveIntent({ question: 'revenue', vocabulary, provider: other, budgetMs: 150_000 });
    expect(failed.status).toBe('failed');
    expect(other.calls).toBe(1);
    if (failed.status === 'failed') expect(failed.code).toBeUndefined();
  });
  it('the pipeline says it in one sentence and keeps the provider words in the receipt', async () => {
    const outcome = await runAskPipeline({ question: 'revenue', vocabulary, provider: flaky(3), prepareDeps: {}, executeDeps: { run: async () => { throw new Error('must not execute'); } }, deadlineMs: 150_000 });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.text).toBe('This could not be completed while reading the question: the AI model took too long to read the question; retry the same question');
    expect(outcome.text).not.toContain('DQL_SUBSCRIPTION_CLI_TIMEOUT_MS');
    expect(outcome.receipt.failure?.reason).toBe('provider_timeout');
    expect(outcome.receipt.failure?.message).toContain('DQL_SUBSCRIPTION_CLI_TIMEOUT_MS');
    expect(outcome.receipt.dispatches).toHaveLength(2);
  });
});

describe('a compiler refusal reaches the reader as one line', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  it('the gap text carries the first line of the engine message and the receipt keeps it whole', async () => {
    const reply = JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Revenue by customer name', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:customers.customer_name', role: 'categorical' }], display: [], filters: [],
      expectedShape: 'grouped', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue', 'dimension:customers.customer_name': 'q:customer name' },
    });
    const engineMessage = 'Dimension customer_name is not reachable from order_item\n  Traceback (most recent call last):\n    File "metricflow/query.py", line 12\n  ValueError: unresolvable';
    const outcome = await runAskPipeline({
      question: 'revenue by customer name', vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => reply },
      prepareDeps: { compileSemantic: async () => { throw new Error(engineMessage); } }, executeDeps: { run: async () => { throw new Error('must not execute'); } },
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.gap).toBe('unsupported');
    expect(outcome.message).toBe('the semantic engine could not compile this reading: Dimension customer_name is not reachable from order_item');
    expect(outcome.text).not.toContain('Traceback');
    expect(outcome.receipt.refusals.find((refusal) => refusal.code === 'semantic_compile_failed')?.message).toBe(engineMessage);
  });
});

describe('a year the question names is never served as an all-time total', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const bare = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total revenue for 2024', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' } });
  const windowed = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total revenue for 2024', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue', 'dimension:order_item.ordered_at': 'q:2024' }, time: { ref: 'dimension:order_item.ordered_at', window: { start: '2024-01-01', end: '2025-01-01', expression: '2024' } } });
  it('the window accounts for its years; a missing window leaves the year unaccounted', () => {
    expect(droppedYears('revenue in 2024', parseIntent(JSON.parse(windowed)).intent!, vocabulary)).toEqual([]);
    expect(droppedYears('revenue in 2024', parseIntent(JSON.parse(bare)).intent!, vocabulary)).toEqual(['2024']);
    expect(droppedYears('top 10 customers', parseIntent(JSON.parse(bare)).intent!, vocabulary)).toEqual([]);
  });
  it('the interpreter is sent back once for the window, then the complete intent resolves', async () => {
    const provider = scripted([bare, windowed]);
    const result = await resolveIntent({ question: 'revenue in 2024', vocabulary, provider });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.intent.time?.window?.start).toBe('2024-01-01');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.at(-1)!.content).toMatch(/names the period "2024"/);
  });
  it('a second reading without the window ends as a gap, never a scalar', async () => {
    const outcome = await runAskPipeline({ question: 'revenue in 2024', vocabulary, provider: scripted([bare, bare]), prepareDeps: {}, executeDeps: { run: async () => { throw new Error('must not execute'); } } });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.text).toMatch(/2024/);
  });
});

describe('a label-only certified block is the answer of last resort, after the repair re-ask', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const namesBlock = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Top customers by beverage revenue', measures: [{ ref: 'block:commerce.top_beverage_customers' }], groupBy: [], display: [], filters: [], expectedShape: 'ranking', unresolved: [], provenance: { 'block:commerce.top_beverage_customers': 'q:top customers beverage' } });
  const keyed = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Top customers by beverage revenue', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'], filters: [], ordering: { ref: 'metric:order_item.drink_revenue', direction: 'desc' }, limit: 10, expectedShape: 'ranking', unresolved: [], provenance: { 'metric:order_item.drink_revenue': 'q:beverage', 'entity:customers.customer': 'q:customers' } });
  const executed = { columns: ['customer_name', 'beverage_revenue'], rows: [{ customer_name: 'A', beverage_revenue: 1 }], rowCount: 1, executionTimeMs: 1 };
  it('an interpreter that re-expresses the analysis by entity gets the keyed governed answer', async () => {
    const provider = scripted([namesBlock, keyed]);
    const outcome = await runAskPipeline({ question: 'who are the top customers for beverage', vocabulary, provider, prepareDeps: { blockSql: (ref) => (ref === 'block:commerce.top_beverage_customers' ? TOP_BEVERAGE_SQL : undefined), compileSemantic: async () => ({ sql: 'SELECT 1', engine: 'native' }) }, executeDeps: { run: async () => executed } });
    expect(provider.calls).toHaveLength(2);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.candidate.trust).toBe('governed');
  });
  it('an interpreter that keeps naming the block gets the block as published, with the identity caveat, not a gap', async () => {
    const provider = scripted([namesBlock, namesBlock]);
    const outcome = await runAskPipeline({ question: 'who are the top customers for beverage', vocabulary, provider, prepareDeps: { blockSql: (ref) => (ref === 'block:commerce.top_beverage_customers' ? TOP_BEVERAGE_SQL : undefined) }, executeDeps: { run: async () => executed } });
    expect(provider.calls).toHaveLength(2);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.tier).toBe('certified');
    expect(outcome.candidate.trust).toBe('governed');
    expect(outcome.candidate.proof.join(' ')).toMatch(/served as published because no keyed governed answer could be composed/);
    expect(outcome.text).toMatch(/recertify it with the entity key/);
    expect(outcome.receipt.refusals.some((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message))).toBe(false);
  });
});

describe('the original question is preserved through every repair (the obligation ledger)', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const base = { version: 1, kind: 'analytics', groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking' };
  // The first reading names the gap AND carries an invented ref, so the interpreter is sent back once (as NB15 was).
  const firstReading = JSON.stringify({ ...base, reading: 'Which customers had the most double-doubles', measures: [], display: ['dimension:customers.custmer_name'], unresolved: [{ clause: 'double-doubles', options: [], material: true, question: 'Double-doubles are not modeled.' }] });
  const blockReading = JSON.stringify({ ...base, reading: 'Top beverage customers as the closest available measure', measures: [{ ref: 'block:commerce.top_beverage_customers' }], unresolved: [] });
  const monthly = JSON.stringify({ ...base, reading: 'Revenue by month', expectedShape: 'trend', measures: [{ ref: 'metric:order_item.revnue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }] });
  const ranking = JSON.stringify({ ...base, reading: 'Top beverage customers', measures: [{ ref: 'block:commerce.top_beverage_customers' }] });
  it('the ledger records the first reading; a block never discharges a clause through closeness', () => {
    const first = parseIntent(JSON.parse(firstReading)).intent!;
    const ledger = buildLedger('Which customers had the most double-doubles in 2017?', first, vocabulary);
    expect(ledger.clauses).toEqual([{ clause: 'double-doubles', question: 'Double-doubles are not modeled.', words: ['double', 'doubles'] }]);
    const audit = auditLedger('', parseIntent(JSON.parse(blockReading)).intent!, ledger, vocabulary);
    expect(audit.dropped.map((item) => item.clause)).toEqual(['double-doubles']);
    const kept = auditLedger('', first, ledger, vocabulary);
    expect(kept.entries[0]).toMatchObject({ clause: 'double-doubles', disposition: 'unresolved' });
  });
  it('a correction that drops the clause is sent back once; a second drop restores it and the turn is a gap with zero SQL', async () => {
    const provider = scripted([firstReading, blockReading, blockReading]);
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'Which customers had the most double-doubles in 2017?', vocabulary, provider, prepareDeps: { blockSql: () => TOP_BEVERAGE_SQL }, executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } } });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.text).toMatch(/double-doubles/i);
    expect(outcome.receipt.ledger?.entries.map((entry) => entry.disposition)).toContain('restored');
    expect(outcome.receipt.ledger?.clauses).toEqual([{ clause: 'double-doubles' }]);
  });
  it('a monthly grain the first reading carried is an obligation: a ranking does not answer a trend', async () => {
    const provider = scripted([monthly, ranking, ranking]);
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'Show monthly revenue totals during 2025', vocabulary, provider, prepareDeps: { blockSql: () => TOP_BEVERAGE_SQL }, executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } } });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.text).toMatch(/month/);
  });
});

describe('a numeric inventory dimension aggregated is a measure over its column', () => {
  const vocabulary = buildVocabularyIndex({
    dimensions: [{ name: 'pts', model: 'player_game_stats', dataType: 'number', physical: { relation: 'dev.player_game_stats', column: 'pts' } }, { name: 'player_id', model: 'player_game_stats', dataType: 'string', physical: { relation: 'dev.player_game_stats', column: 'player_id' } }],
    relations: [{ schema: 'dev', name: 'player_game_stats', columns: [{ name: 'pts', dataType: 'DOUBLE' }, { name: 'player_id', dataType: 'VARCHAR' }] }],
  });
  it('the dimension ref is read as the column ref when the aggregation makes it a measure', () => {
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'dimension:player_game_stats.pts', aggregation: 'sum' }], groupBy: [{ ref: 'dimension:player_game_stats.player_id', role: 'key' }], display: [], filters: [], ordering: { ref: 'dimension:player_game_stats.pts', direction: 'desc' }, unresolved: [], provenance: {}, expectedShape: 'ranking' }).intent!;
    const validation = validateIntentRefs(intent, vocabulary);
    expect(validation.problems).toEqual([]);
    expect(validation.intent.measures[0]!.ref).toBe('column:dev.player_game_stats.pts');
    expect(validation.intent.ordering?.ref).toBe('column:dev.player_game_stats.pts');
  });
  it('counting a non-numeric column exposed as a dimension is a measure; ordering by a measure alias names that measure', () => {
    const intent = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'dimension:player_game_stats.pts', aggregation: 'sum', alias: 'total_points' }, { ref: 'dimension:player_game_stats.player_id', aggregation: 'count_distinct', alias: 'players' }], groupBy: [], display: [], filters: [], ordering: { ref: 'total_points', direction: 'desc' }, unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    const validation = validateIntentRefs(intent, vocabulary);
    expect(validation.problems).toEqual([]);
    expect(validation.intent.measures[1]!.ref).toBe('column:dev.player_game_stats.player_id');
    expect(validation.intent.ordering?.ref).toBe('measure:0');
    const dressed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'dimension:player_game_stats.pts', aggregation: 'sum', alias: 'total_points' }], groupBy: [], display: [], filters: [], ordering: { ref: 'metric:total_points', direction: 'desc' }, unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(validateIntentRefs(dressed, vocabulary).intent.ordering?.ref).toBe('measure:0');
    const notNumeric = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'dimension:player_game_stats.player_id', aggregation: 'sum' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(validateIntentRefs(notNumeric, vocabulary).problems.map((problem) => problem.path)).toEqual(['measures[0].ref']);
  });
});

describe('a why/should question over the previous analysis is never answered as small talk', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const prior = parseIntent({ version: 1, kind: 'analytics', reading: 'Top customers by beverage revenue', measures: [{ ref: 'metric:order_item.drink_revenue' }], groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: [], filters: [], limit: 10, unresolved: [], provenance: {}, expectedShape: 'ranking' }).intent!;
  const chat = JSON.stringify({ version: 1, kind: 'conversation', reading: 'A judgment call', reply: 'Melissa Lopez stands out as the one to build around because she leads the ranking.', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
  it('ends as the unsupported gap naming the answerable reading, with zero SQL', async () => {
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'Which of those customers should we build our loyalty program around, and why?', vocabulary, provider: scripted([chat]), prior, prepareDeps: {}, executeDeps: { run: async () => { executed += 1; throw new Error('must not execute'); } } });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') { expect(outcome.gap).toBe('unsupported'); expect(outcome.text).toMatch(/Research can investigate/); expect(outcome.text).not.toMatch(/stands out/); }
  });
  it('a greeting with no prior stays a conversation', async () => {
    const result = await resolveIntent({ question: 'why hello there', vocabulary, provider: scripted([chat]) });
    expect(result.status).toBe('conversation');
  });
});

describe('units of a ratio over columns', () => {
  const nba = buildVocabularyIndex({
    relations: [{ schema: 'dev', name: 'player_game_stats', columns: [{ name: 'pts', dataType: 'DOUBLE' }, { name: 'played', dataType: 'INTEGER' }, { name: 'game_id', dataType: 'VARCHAR' }, { name: 'fgm', dataType: 'DOUBLE' }, { name: 'fga', dataType: 'DOUBLE' }] }],
  });
  const make = (alias: string, den: string, denAgg: string) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ alias, derived: { kind: 'ratio', numerator: 'column:dev.player_game_stats.pts', numeratorAggregation: 'sum', denominator: den, denominatorAggregation: denAgg } }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
  it('points per game is a number; made over attempted with a pct alias is a fraction', () => {
    const rows = { columns: ['points_per_game'], rows: [{ points_per_game: 28.2 }], rowCount: 1, executionTimeMs: 1 };
    expect(describeResultColumns(make('points_per_game', 'column:dev.player_game_stats.game_id', 'count_distinct'), rows, nba)).toEqual([{ name: 'points_per_game', kind: 'number' }]);
    const pct = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ alias: 'field_goal_pct', derived: { kind: 'ratio', numerator: 'column:dev.player_game_stats.fgm', numeratorAggregation: 'sum', denominator: 'column:dev.player_game_stats.fga', denominatorAggregation: 'sum' } }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }).intent!;
    expect(describeResultColumns(pct, { columns: ['field_goal_pct'], rows: [{ field_goal_pct: 0.51 }], rowCount: 1, executionTimeMs: 1 }, nba)).toEqual([{ name: 'field_goal_pct', kind: 'percent', unit: 'fraction' }]);
  });
});

describe('a monthly breakdown the reading dropped is never served as a scalar', () => {
  const vocabulary = buildVocabularyIndex(jaffle);
  const windowedScalar = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly revenue for 2025, unclear which revenue', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'trend', time: { window: { start: '2025-01-01', end: '2026-01-01', expression: 'in 2025' } }, unresolved: [{ clause: 'revenue by month', options: ['metric:orders.order_total', 'metric:order_item.revenue'], material: true, question: 'Gross or product revenue?' }], provenance: {} });
  const monthly = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Monthly product revenue for 2025', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [{ ref: 'dimension:order_item.ordered_at', role: 'time', grain: 'month' }], display: [], filters: [], expectedShape: 'trend', time: { ref: 'dimension:order_item.ordered_at', window: { start: '2025-01-01', end: '2026-01-01', expression: 'in 2025' } }, unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' } });
  it('the grain is detected, the interpreter is sent back once, and a stubborn reading ends as a material clause', async () => {
    expect(droppedGrain('revenue by month in 2025', parseIntent(JSON.parse(windowedScalar)).intent!, vocabulary)).toBe('month');
    expect(droppedGrain('revenue by month in 2025', parseIntent(JSON.parse(monthly)).intent!, vocabulary)).toBeUndefined();
    const provider = scripted([windowedScalar, monthly]);
    const result = await resolveIntent({ question: 'revenue by month in 2025', vocabulary, provider });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.intent.groupBy[0]).toMatchObject({ role: 'time', grain: 'month' });
    expect(provider.calls).toHaveLength(2);
    const stubborn = await resolveIntent({ question: 'revenue by month in 2025', vocabulary, provider: scripted([windowedScalar, windowedScalar]) });
    expect(stubborn.status).toBe('clarify');
    if (stubborn.status === 'clarify') expect(stubborn.question).toMatch(/month breakdown/);
  });
});

describe('an ungrounded member literal is disclosed as a text match', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } }],
    dimensions: [{ name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } }],
    relations: [
      { schema: 'dev', name: 'order_items', columns: [{ name: 'order_id', dataType: 'VARCHAR' }, { name: 'product_price', dataType: 'DOUBLE' }] },
      { schema: 'dev', name: 'orders', columns: [{ name: 'order_id', dataType: 'VARCHAR' }, { name: 'customer_id', dataType: 'VARCHAR' }] },
      { schema: 'dev', name: 'customers', columns: [{ name: 'customer_id', dataType: 'VARCHAR' }, { name: 'customer_name', dataType: 'VARCHAR' }] },
    ],
  });
  const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: "Stephen Curry's revenue", measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [{ ref: 'dimension:customers.customer_name', op: 'contains', values: ['Curry'], source: 'question' }], unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' }, expectedShape: 'scalar' });
  it('the answer says the predicate matched text, never that it identified one person', async () => {
    const joinPath = () => [{ relation: 'dev.orders', on: '"dev"."order_items"."order_id" = "dev"."orders"."order_id"' }, { relation: 'dev.customers', on: '"dev"."orders"."customer_id" = "dev"."customers"."customer_id"' }];
    const outcome = await runAskPipeline({ question: "Show Curry's revenue", vocabulary, provider: scripted([reply]), prepareDeps: { joinPath }, executeDeps: { run: async () => ({ columns: ['revenue'], rows: [{ revenue: 12 }], rowCount: 1, executionTimeMs: 1 }) } });
    if (outcome.kind !== 'answered') throw new Error(`${outcome.kind}: ${JSON.stringify(outcome.receipt.refusals.map((r) => `${r.tier}:${r.code}:${r.message.slice(0, 200)}`))} ${'text' in outcome ? outcome.text : ''}`);
    expect(outcome.text).toMatch(/matched by text containing "Curry"; that can cover several members/);
    expect(outcome.receipt.warehouse).toEqual({ attempts: 1, failures: 0, executions: 1 });
  });
});

describe('a warehouse failure says which kind it was', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } }],
    relations: [{ schema: 'dev', name: 'order_items', columns: [{ name: 'product_price', dataType: 'DOUBLE' }] }],
  });
  const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total revenue', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' });
  const failing = async (message: string) => {
    const outcome = await runAskPipeline({ question: 'total revenue', vocabulary, provider: scripted([reply]), prepareDeps: {}, executeDeps: { run: async () => { throw new Error(message); } } });
    if (outcome.kind !== 'failed') throw new Error(`expected a failure, got ${outcome.kind}`);
    return outcome;
  };
  it('classifies the driver message and names the next action, and the receipt keeps the class', async () => {
    expect(classifyWarehouseError('Warehouse \'COMPUTE_WH\' is suspended and cannot be resumed.').class).toBe('warehouse_suspended');
    expect(classifyWarehouseError("Object 'ANALYTICS.DEV.GAMES' does not exist or not authorized.")).toEqual({ class: 'relation_missing', relations: ['ANALYTICS.DEV.GAMES'] });
    expect(classifyWarehouseError('SQL access control error: Insufficient privileges to operate on table \'GAMES\'').class).toBe('relation_denied');
    expect(classifyWarehouseError('syntax error at or near "SELCT"').class).toBe('sql_error');
    const suspended = await failing('Warehouse \'COMPUTE_WH\' is suspended; no active warehouse selected.');
    expect(suspended.text).toMatch(/warehouse is not running.*Resume it/i);
    expect(suspended.receipt.failure?.warehouse?.class).toBe('warehouse_suspended');
    expect(suspended.receipt.warehouse).toEqual({ attempts: 1, failures: 1, executions: 0 });
    const missing = await failing("Object 'ANALYTICS.DEV.ORDER_ITEMS' does not exist or not authorized.");
    expect(missing.text).toMatch(/cannot see ANALYTICS\.DEV\.ORDER_ITEMS.*catalog lists it/i);
    const denied = await failing("Insufficient privileges to operate on table 'ORDER_ITEMS'");
    expect(denied.text).toMatch(/not allowed to read ORDER_ITEMS/i);
    const broken = await failing('syntax error at position 7');
    expect(broken.text).toMatch(/could not be completed on the warehouse: syntax error/);
  });
  it('a provider failure still leaves a receipt that records the failure, so it is never read as a modeling gap', async () => {
    const outcome = await runAskPipeline({ question: 'total revenue', vocabulary, provider: { generate: async () => { throw new Error('the model did not respond'); } } as never, prepareDeps: {}, executeDeps: { run: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }) } });
    expect(outcome.kind).toBe('failed');
    expect(outcome.receipt.failure?.stage).toBe('resolve');
    expect(outcome.receipt.warehouse).toBeUndefined();
  });
});

describe('a follow-up may not quietly answer for everyone', () => {
  const vocabulary = buildVocabularyIndex({
    dimensions: [
      { name: 'player_id', model: 'journey', dataType: 'VARCHAR', physical: { relation: 'dev.journey', column: 'player_id' } },
      { name: 'season', model: 'journey', dataType: 'INTEGER', physical: { relation: 'dev.journey', column: 'season' } },
    ],
    relations: [{ schema: 'dev', name: 'journey', columns: [{ name: 'player_id' }, { name: 'season', dataType: 'INTEGER' }, { name: 'points' }, { name: 'rebounds' }, { name: 'games_played' }] }],
  });
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw }).intent!;
  const prior = make({
    measures: [{ ref: 'column:dev.journey.points', aggregation: 'sum', alias: 'total_points' }],
    groupBy: [{ ref: 'dimension:journey.player_id', role: 'key' }],
    filters: [{ ref: 'dimension:journey.season', op: 'eq', values: ['2017'], source: 'question' }],
    ordering: { ref: 'measure:0', direction: 'desc' }, limit: 10,
  });
  it('names the period, ranking and limit the reading dropped', () => {
    const widened = make({ measures: [{ ref: 'column:dev.journey.rebounds', aggregation: 'sum', alias: 'total_rebounds' }], groupBy: [{ ref: 'dimension:journey.player_id', role: 'key' }] });
    expect(widenedPopulation('Add rebounds for those same players', widened, prior))
      .toEqual(['the restriction on dimension:journey.season', 'the limit of 10', 'the ranking']);
    // Keeping them is not a widening.
    const kept = make({
      measures: [{ ref: 'column:dev.journey.rebounds', aggregation: 'sum', alias: 'total_rebounds' }],
      groupBy: [{ ref: 'dimension:journey.player_id', role: 'key' }],
      filters: [{ ref: 'dimension:journey.season', op: 'eq', values: ['2017'], source: 'inherited' }],
      ordering: { ref: 'measure:0', direction: 'desc' }, limit: 10,
    });
    expect(widenedPopulation('Add rebounds for those same players', kept, prior)).toEqual([]);
    // The user may ask for the wider population.
    expect(widenedPopulation('now show rebounds for all players', widened, prior)).toEqual([]);
    // A new subject accounts for the previous measures as removed.
    const newSubject = make({ measures: [{ ref: 'column:dev.journey.rebounds', aggregation: 'sum' }], provenance: { 'column:dev.journey.points': 'removed:asks about rebounds only' } });
    expect(widenedPopulation('what about rebounds by season', newSubject, prior)).toEqual([]);
  });
  it('the interpreter is corrected once, and a stubborn reading ends as a clarification with zero SQL', async () => {
    const wide = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Rebounds by player', measures: [{ ref: 'column:dev.journey.rebounds', aggregation: 'sum', alias: 'total_rebounds' }], groupBy: [{ ref: 'dimension:journey.player_id', role: 'key' }], display: [], filters: [], unresolved: [], provenance: { 'column:dev.journey.player_id': 'inherited', 'column:dev.journey.points': 'removed:replaced by rebounds' }, expectedShape: 'ranking' });
    let executed = 0;
    const outcome = await runAskPipeline({
      question: 'Add total rebounds for those same players', vocabulary, prior, provider: scripted([wide, wide]),
      prepareDeps: { joinPath: () => [] }, executeDeps: { run: async () => { executed += 1; return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }; } },
    });
    expect(executed).toBe(0);
    if (outcome.kind !== 'clarify') throw new Error(`${outcome.kind}: ${JSON.stringify(outcome.receipt.intent?.unresolved ?? [])} dispatches=${outcome.receipt.dispatches.length}`);
    // Either continuity question is safe: the turn ends by asking which
    // population was meant, and no query runs.
    expect(outcome.question).toMatch(/previous analysis (also used|was restricted to)/);
    expect(outcome.question).not.toMatch(/dimension:|column:/);
  });
});

describe('a period named on a field that is not a date', () => {
  const vocabulary = buildVocabularyIndex({
    dimensions: [{ name: 'season', model: 'journey', dataType: 'INTEGER', physical: { relation: 'dev.journey', column: 'season' } }],
    relations: [{ schema: 'dev', name: 'journey', columns: [{ name: 'season', dataType: 'INTEGER' }, { name: 'points' }] }],
  });
  it('is read as a value on that field instead of failing the whole reading', () => {
    const raw = parseIntent({ version: 1, kind: 'analytics', reading: 'Points in 2017', measures: [{ ref: 'column:dev.journey.points', aggregation: 'sum', alias: 'total_points' }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar', time: { ref: 'dimension:journey.season', window: { start: '2017-01-01', end: '2018-01-01', expression: 'in 2017' } } }).intent!;
    const validated = validateIntentRefs(raw, vocabulary);
    expect(validated.problems).toEqual([]);
    expect(validated.intent.time).toBeUndefined();
    expect(validated.intent.filters).toEqual([expect.objectContaining({ ref: 'dimension:journey.season', op: 'eq', values: ['2017'] })]);
    expect(validated.intent.provenance['dimension:journey.season']).toMatch(/not a date/);
  });
});

describe('meaning before execution: shares, calendar periods and units', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', aggregation: 'sum', physical: { relation: 'dev.season_facts', expr: '"dev"."season_facts"."total_points"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'player_id', model: 'season_facts', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'player_id' } },
      { name: 'season', model: 'season_facts', dataType: 'number', description: 'Season value carried by the source; it is not silently converted to a calendar year', physical: { relation: 'dev.season_facts', column: 'season' } },
      { name: 'game_date', model: 'game_facts', dataType: 'date', isTime: true, physical: { relation: 'dev.game_facts', column: 'game_date' } },
    ],
    relations: [
      { schema: 'dev', name: 'season_facts', columns: [{ name: 'player_id' }, { name: 'season', dataType: 'INTEGER' }, { name: 'total_points' }] },
      { schema: 'dev', name: 'game_facts', columns: [{ name: 'game_date', dataType: 'DATE' }, { name: 'points' }] },
    ],
  });
  const make = (raw: Record<string, unknown>) => parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'ranking', ...raw }).intent!;
  it('a measure divided by itself becomes a share of the whole period when its name says so, and is sent back otherwise', () => {
    const share = validateIntentRefs(make({ measures: [{ alias: 'share_of_points', derived: { kind: 'ratio', numerator: 'metric:total_points', denominator: 'metric:total_points' } }], groupBy: [{ ref: 'dimension:season_facts.player_id', role: 'key' }] }), vocabulary);
    expect(share.problems).toEqual([]);
    expect(share.intent.measures[0]!.derived?.denominatorScope).toBe('overall');
    expect(share.intent.provenance['measures[0].denominatorScope']).toMatch(/whole period/);
    const rate = validateIntentRefs(make({ measures: [{ alias: 'points_rate', derived: { kind: 'ratio', numerator: 'metric:total_points', denominator: 'metric:total_points' } }] }), vocabulary);
    expect(rate.problems.map((problem) => problem.message)).toEqual([expect.stringMatching(/divided by itself is 1 for every row/)]);
  });
  it('a calendar period restricted on a non-date field is named with the date dimensions that would honour it', () => {
    const seasonal = make({ measures: [{ ref: 'metric:total_points' }], filters: [{ ref: 'dimension:season_facts.season', op: 'in', values: [2016, 2017], source: 'question' }] });
    const basis = calendarBasisProblem('top players by total points in calendar years 2016 and 2017', seasonal, vocabulary);
    expect(basis).toMatchObject({ field: 'dimension:season_facts.season', dates: ['dimension:game_facts.game_date'] });
    expect(basis?.measuresAt[0]).toBe('column:dev.game_facts.points (sum, for metric:total_points)');
    // Without the calendar word the season value is what was asked for.
    expect(calendarBasisProblem('top players by total points in 2017', seasonal, vocabulary)).toBeUndefined();
    // A date restriction honours it.
    const dated = make({ measures: [{ ref: 'metric:total_points' }], time: { ref: 'dimension:game_facts.game_date', window: { start: '2017-01-01', end: '2018-01-01' } } });
    expect(calendarBasisProblem('total points in calendar 2017', dated, vocabulary)).toBeUndefined();
  });
  it('the interpreter is corrected once, then the turn asks which basis was meant, with zero SQL', async () => {
    const seasonal = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Points by season', measures: [{ ref: 'metric:total_points' }], groupBy: [], display: [], filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: [2017], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' });
    let executed = 0;
    const outcome = await runAskPipeline({ question: 'total points in calendar year 2017', vocabulary, provider: scripted([seasonal, seasonal]), prepareDeps: { joinPath: () => [] }, executeDeps: { run: async () => { executed += 1; return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }; } } });
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind === 'clarify') {
      expect(outcome.question).toMatch(/calendar period.*not a date/);
      expect(outcome.options.map((option) => option.ref)).toEqual(['dimension:game_facts.game_date']);
    }
    expect(outcome.receipt.dispatches).toHaveLength(2);
  });
  it('points are a number, never dollars; money words still are', () => {
    const rows = (name: string) => ({ columns: [name], rows: [{ [name]: 12 }], rowCount: 1, executionTimeMs: 1 });
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:total_points' }], expectedShape: 'scalar' }), rows('total_points'), vocabulary)[0]).toMatchObject({ name: 'total_points', kind: 'number' });
    const money = buildVocabularyIndex({ metrics: [{ name: 'order_total', aggregation: 'sum' }, { name: 'revenue', aggregation: 'sum' }, { name: 'total_value', aggregation: 'sum' }] });
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:order_total' }], expectedShape: 'scalar' }), rows('order_total'), money)[0]!.kind).toBe('currency');
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:revenue' }], expectedShape: 'scalar' }), rows('revenue'), money)[0]!.kind).toBe('currency');
    expect(describeResultColumns(make({ measures: [{ ref: 'metric:total_value' }], expectedShape: 'scalar' }), rows('total_value'), money)[0]!.kind).toBe('number');
  });
});

describe('the same fact at another grain', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', aggregation: 'sum', physical: { relation: 'dev.season_facts', expr: '"dev"."season_facts"."total_points"', aggregate: 'sum' } }],
    relations: [
      { schema: 'dev', name: 'season_facts', columns: [{ name: 'player_id' }, { name: 'total_points', dataType: 'INTEGER' }, { name: 'games_played', dataType: 'INTEGER' }] },
      { schema: 'dev', name: 'game_facts', columns: [{ name: 'game_id', dataType: 'VARCHAR' }, { name: 'game_date', dataType: 'DATE' }, { name: 'points', dataType: 'DOUBLE' }, { name: 'assists', dataType: 'DOUBLE' }] },
    ],
  });
  it('matches a metric and a counted column to the date relation by name stem', () => {
    expect(suggestSameGrainColumns(vocabulary, ['metric:total_points', 'column:dev.season_facts.games_played'], 'dev.game_facts')).toEqual([
      { from: 'metric:total_points', to: 'column:dev.game_facts.points', aggregation: 'sum' },
      { from: 'column:dev.season_facts.games_played', to: 'column:dev.game_facts.game_id', aggregation: 'count_distinct' },
    ]);
    expect(suggestSameGrainColumns(vocabulary, ['column:dev.season_facts.player_id'], 'dev.game_facts')).toEqual([]);
  });
});

describe('the project\'s definition wins over the raw column', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [
      { name: 'points_scored', label: 'Points scored', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: 'CASE WHEN "dev"."game_facts"."participated" = true THEN "dev"."game_facts"."points" ELSE 0 END', aggregate: 'sum' } },
      { name: 'games_played', label: 'Games played', aggregation: 'count_distinct', physical: { relation: 'dev.game_facts', expr: 'CASE WHEN "dev"."game_facts"."participated" = true THEN "dev"."game_facts"."game_id" END', aggregate: 'count_distinct' } },
      { name: 'assists_made', label: 'Assists', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."assists"', aggregate: 'sum' } },
      { name: 'assist_total', label: 'Assist total', aggregation: 'sum', physical: { relation: 'dev.game_facts', expr: '"dev"."game_facts"."assists"', aggregate: 'sum' } },
    ],
    relations: [{ schema: 'dev', name: 'game_facts', columns: [{ name: 'game_id' }, { name: 'points' }, { name: 'assists' }, { name: 'participated', dataType: 'BOOLEAN' }] }],
  });
  const make = (measures: AnalyticalIntentV1['measures']): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'Points and games in calendar 2017', measures, groupBy: [], display: [], filters: [],
    ordering: { ref: 'column:dev.game_facts.points', direction: 'desc' }, expectedShape: 'ranking', unresolved: [],
    provenance: { 'column:dev.game_facts.points': 'q:total points' },
  });

  it('reads a scoped aggregate through to the column it aggregates', () => {
    expect(scopedColumnOf('CASE WHEN "dev"."game_facts"."participated" = true THEN "dev"."game_facts"."points" ELSE 0 END')).toEqual({ column: 'points', scoped: true });
    expect(scopedColumnOf('"dev"."game_facts"."points"')).toEqual({ column: 'points', scoped: false });
    expect(scopedColumnOf('SUM(a) / SUM(b)')).toBeUndefined();
  });

  it('replaces a raw column aggregation by the metric that defines it, and says so when the definition excludes rows', () => {
    const intent = make([
      { ref: 'column:dev.game_facts.points', aggregation: 'sum', alias: 'total_points' },
      { ref: 'column:dev.game_facts.game_id', aggregation: 'count_distinct', alias: 'games_played' },
    ]);
    preferGovernedDefinition(intent, vocabulary);
    expect(intent.measures.map((measure) => measure.ref)).toEqual(['metric:points_scored', 'metric:games_played']);
    expect(intent.measures.every((measure) => measure.aggregation === undefined)).toBe(true);
    expect(intent.ordering!.ref).toBe('metric:points_scored');
    expect(intent.provenance['metric:points_scored']).toContain('governed default: Points scored defines this column');
    expect(intent.reading).toContain('counts only the rows its definition includes');
  });

  it('leaves the raw column alone when the project declares two definitions of it, or none at that aggregation', () => {
    const ambiguous = make([{ ref: 'column:dev.game_facts.assists', aggregation: 'sum', alias: 'assists' }]);
    preferGovernedDefinition(ambiguous, vocabulary);
    expect(ambiguous.measures[0]!.ref).toBe('column:dev.game_facts.assists');
    const otherAggregate = make([{ ref: 'column:dev.game_facts.points', aggregation: 'avg', alias: 'avg_points' }]);
    preferGovernedDefinition(otherAggregate, vocabulary);
    expect(otherAggregate.measures[0]!.ref).toBe('column:dev.game_facts.points');
  });

  it('carries a ratio\'s parts to their governed definitions', () => {
    const intent = make([{ ref: 'ratio:column:dev.game_facts.points/column:dev.game_facts.game_id', alias: 'points_per_game', derived: { kind: 'ratio', numerator: 'column:dev.game_facts.points', numeratorAggregation: 'sum', denominator: 'column:dev.game_facts.game_id', denominatorAggregation: 'count_distinct' } }]);
    preferGovernedDefinition(intent, vocabulary);
    expect(intent.measures[0]!.derived).toEqual({ kind: 'ratio', numerator: 'metric:points_scored', denominator: 'metric:games_played' });
    expect(intent.measures[0]!.ref).toBe('ratio:metric:points_scored/metric:games_played');
  });
});

describe('a relative period is a population, not a column', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', aggregation: 'sum', physical: { relation: 'dev.season_facts', expr: '"dev"."season_facts"."points"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'season', model: 'season_facts', label: 'Source season', dataType: 'number', physical: { relation: 'dev.season_facts', column: 'season' } },
      { name: 'game_date', model: 'game_facts', dataType: 'date', isTime: true, physical: { relation: 'dev.game_facts', column: 'game_date' } },
    ],
  });
  const base: AnalyticalIntentV1 = {
    version: 1, kind: 'analytics', reading: 'Top scorers', measures: [{ ref: 'metric:total_points' }], groupBy: [], display: [], filters: [],
    expectedShape: 'ranking', unresolved: [], provenance: {},
  };

  it('is a problem when the reading restricts no period, however it selects one', () => {
    const selected: AnalyticalIntentV1 = { ...base, measures: [{ ref: 'metric:total_points' }, { ref: 'dimension:season_facts.season', aggregation: 'max', alias: 'current_season' }] };
    expect(relativePeriodProblem('Who are the top scorers this season?', selected, vocabulary)).toMatchObject({ unit: 'season' });
    // A period the question never named is an anchor the reading invented.
    expect(relativePeriodProblem('Who are the top scorers this season?', { ...base, filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: [2022], source: 'question' }] }, vocabulary)).toMatchObject({ unit: 'season' });
    expect(relativePeriodProblem('Who are the top scorers this season, meaning 2022?', { ...base, filters: [{ ref: 'dimension:season_facts.season', op: 'eq', values: [2022], source: 'question' }] }, vocabulary)).toBeUndefined();
    expect(relativePeriodProblem('Who are the top scorers this season?', { ...base, time: { ref: 'dimension:game_facts.game_date', window: { start: '2022-01-01', end: '2023-01-01', expression: 'in 2022' } } }, vocabulary)).toBeUndefined();
    expect(relativePeriodProblem('Who are the top scorers in 2017?', base, vocabulary)).toBeUndefined();
  });
});

describe('a clause that asks which ones is answered by identities', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'teams_played', label: 'Teams played', aggregation: 'sum' }],
    dimensions: [{ name: 'team', model: 'team_facts', label: 'Team', dataType: 'number' }, { name: 'player', model: 'season_facts', label: 'Player', dataType: 'string' }],
  });
  const intent = (overrides: Partial<AnalyticalIntentV1>): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'profile', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'grouped', unresolved: [], provenance: {}, ...overrides,
  });
  const ledger = { clauses: [{ clause: 'teams (which teams he played for)', words: ['teams', 'which', 'played'], role: 'identity' as const, roleWords: ['teams'] }], measures: [], unaccounted: [] };

  it('reads the identity words out of the clause', () => {
    expect(identityClauseWords('teams (which teams he played for)', vocabulary)).toEqual(['teams']);
    expect(identityClauseWords('how many teams he played for', vocabulary)).toEqual([]);
  });

  it('is not discharged by a measure that counts them, and is discharged by a grouping that names them', () => {
    const counted = intent({ measures: [{ ref: 'metric:teams_played', aggregation: 'sum' }] });
    expect(auditLedger('profile', counted, ledger, vocabulary).entries[0]!.disposition).toBe('dropped');
    const grouped = intent({ groupBy: [{ ref: 'dimension:team_facts.team', role: 'key' }] });
    expect(auditLedger('profile', grouped, ledger, vocabulary).entries[0]!.disposition).toBe('discharged');
  });
});

describe('an answer that could not carry the label the question asked for', () => {
  const label = (ref: string) => ref.split('.').pop()!;
  const intent = (display: string[]): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'teams by wins', measures: [{ ref: 'column:dev.team_season.wins', aggregation: 'sum' }],
    groupBy: [{ ref: 'column:dev.team_season.team_id', role: 'key' }], display, filters: [], expectedShape: 'ranking', unresolved: [], provenance: {},
  });
  const refusals = [{ tier: 'relational' as const, code: 'join_path_required' as const, message: 'no governed join path from dev.team_season to dev.teams', repairable: true }];

  it('names the omission, with the reason the label could not be reached', () => {
    const unmet = unmetDisplayObligation(['column:dev.teams.team_nickname'], intent([]), refusals as never, label);
    expect(unmet?.message).toContain('identified by team_id only');
    expect(unmet?.message).toContain('no governed relationship reaches it');
  });

  it('names the omission for a question that asks WHICH ones, even when no reading asked for the label', () => {
    const unmet = unmetDisplayObligation([], intent([]), [] as never, label, 'Which teams won the most games in the 2017 season?');
    expect(unmet?.message).toContain('no human-readable label');
    // A question that asks for the ids themselves is answered by ids.
    expect(unmetDisplayObligation([], intent([]), [] as never, label, 'Show the team ids and their wins')).toBeUndefined();
    expect(unmetDisplayObligation([], intent([]), [] as never, label, 'How many games were won in 2017?')).toBeUndefined();
  });

  it('says nothing when the label is shown, or when the reading deliberately removed it', () => {
    expect(unmetDisplayObligation(['column:dev.teams.team_nickname'], intent(['column:dev.teams.team_nickname']), refusals as never, label)).toBeUndefined();
    const removed = intent([]);
    removed.provenance['column:dev.teams.team_nickname'] = 'removed:the question asked for ids';
    expect(unmetDisplayObligation(['column:dev.teams.team_nickname'], removed, refusals as never, label)).toBeUndefined();
  });
});

describe('a meaning the user already picked', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'total_points', label: 'Total points', aggregation: 'sum' }, { name: 'points_per_game', label: 'Points per game', aggregation: 'avg' }],
    dimensions: [{ name: 'player', model: 'season_facts', label: 'Player', dataType: 'string' }],
  });
  const unresolvedIntent = (): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'the best players', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'ranking',
    unresolved: [{ clause: 'best players', material: true, options: ['metric:total_points', 'metric:points_per_game'], question: 'Which measure defines best?' }],
    provenance: {},
  });

  it('carries the chosen ref into the reading, whatever the interpreter wrote', () => {
    const intent = unresolvedIntent();
    applySelectedMeaning(intent, { ref: 'metric:total_points', label: 'Total points' }, vocabulary);
    expect(intent.measures.map((measure) => measure.ref)).toEqual(['metric:total_points']);
    expect(intent.ordering).toEqual({ ref: 'metric:total_points', direction: 'desc' });
    expect(intent.limit).toBe(10);
    expect(intent.unresolved.every((clause) => !clause.material)).toBe(true);
    expect(intent.provenance['metric:total_points']).toContain('clarification');
  });

  it('groups by a chosen dimension, and never doubles a ref the reading already carries', () => {
    const grouped = unresolvedIntent();
    applySelectedMeaning(grouped, { ref: 'dimension:season_facts.player' }, vocabulary);
    expect(grouped.groupBy).toEqual([{ ref: 'dimension:season_facts.player', role: 'categorical' }]);
    const already: AnalyticalIntentV1 = { ...unresolvedIntent(), measures: [{ ref: 'metric:total_points' }] };
    applySelectedMeaning(already, { ref: 'metric:total_points' }, vocabulary);
    expect(already.measures).toHaveLength(1);
  });

  it('tells the interpreter the choice is made, only when there is one', () => {
    expect(buildIntentSystemPrompt({ cards: '', hasPrior: false, selection: { ref: 'metric:total_points', label: 'Total points' } })).toContain('THE MEANING IS ALREADY CHOSEN');
    expect(buildIntentSystemPrompt({ cards: '', hasPrior: false })).not.toContain('THE MEANING IS ALREADY CHOSEN');
  });
});

describe('a series covers the period it claims', () => {
  const intent = (overrides: Partial<AnalyticalIntentV1> = {}): AnalyticalIntentV1 => ({
    version: 1, kind: 'analytics', reading: 'monthly points in 2017',
    measures: [{ ref: 'column:dev.game_facts.points', aggregation: 'sum', alias: 'monthly_points' }],
    groupBy: [{ ref: 'dimension:game_facts.game_date', role: 'time', grain: 'month' }],
    display: [], filters: [], expectedShape: 'trend', unresolved: [], provenance: {},
    time: { ref: 'dimension:game_facts.game_date', window: { start: '2017-01-01', end: '2018-01-01', expression: 'calendar 2017' } },
    ...overrides,
  });
  const executed = (months: string[]) => ({
    columns: ['game_date_month', 'monthly_points'],
    rows: months.map((month, index) => ({ game_date_month: `${month}T00:00:00.000Z`, monthly_points: 100 + index })),
    rowCount: months.length, executionTimeMs: 1,
    columnsMeta: [{ name: 'game_date_month', kind: 'date' as const, grain: 'month' }, { name: 'monthly_points', kind: 'number' as const }],
  });

  it('adds the months the warehouse returned nothing for, as zero, in order', () => {
    const filled = fillPeriodGaps(intent(), executed(['2017-01-01', '2017-02-01', '2017-12-01']));
    expect(filled.added).toBe(9);
    expect(filled.result.rowCount).toBe(12);
    expect(filled.result.rows.map((row) => String(row.game_date_month).slice(0, 7))).toEqual([
      '2017-01', '2017-02', '2017-03', '2017-04', '2017-05', '2017-06', '2017-07', '2017-08', '2017-09', '2017-10', '2017-11', '2017-12',
    ]);
    expect(filled.result.rows[6]!.monthly_points).toBe(0);
  });

  it('leaves an average empty rather than calling it zero, and never invents a member', () => {
    const averaged = fillPeriodGaps(intent({ measures: [{ ref: 'column:dev.game_facts.points', aggregation: 'avg', alias: 'avg_points' }] }), {
      ...executed(['2017-01-01']), columns: ['game_date_month', 'avg_points'],
      rows: [{ game_date_month: '2017-01-01T00:00:00.000Z', avg_points: 12 }],
      columnsMeta: [{ name: 'game_date_month', kind: 'date' as const }, { name: 'avg_points', kind: 'number' as const }],
    });
    expect(averaged.result.rows.find((row) => String(row.game_date_month).startsWith('2017-06'))!.avg_points).toBeNull();
    // Another grouping beside the period: which member owns an empty month is not ours to say.
    const grouped = intent({ groupBy: [{ ref: 'dimension:game_facts.game_date', role: 'time', grain: 'month' }, { ref: 'dimension:game_facts.player', role: 'key' }] });
    expect(fillPeriodGaps(grouped, executed(['2017-01-01'])).added).toBe(0);
    // A ranking of periods asks for the top ones, not for all of them.
    expect(fillPeriodGaps(intent({ limit: 3 }), executed(['2017-01-01'])).added).toBe(0);
  });
});

describe('the same field on the relation that carries the period', () => {
  const vocabulary = buildVocabularyIndex({
    dimensions: [{ name: 'player', model: 'season_facts', label: 'Player', dataType: 'string', physical: { relation: 'dev.season_facts', column: 'player_name' } }],
    relations: [{ schema: 'dev', name: 'game_facts', columns: [{ name: 'player_id', dataType: 'INTEGER' }, { name: 'player_name', dataType: 'VARCHAR' }, { name: 'points', dataType: 'INTEGER' }] }],
  });
  it('moves a name filter to the name column, not to the id that shares its stem', () => {
    expect(suggestSameRelationFields(vocabulary, ['dimension:season_facts.player'], 'dev.game_facts'))
      .toEqual([{ from: 'dimension:season_facts.player', to: 'column:dev.game_facts.player_name' }]);
  });
});
