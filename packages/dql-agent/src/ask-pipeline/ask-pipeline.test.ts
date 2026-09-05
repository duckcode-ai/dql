import { describe, expect, it } from 'vitest';
import { extractBlockContract } from './block-contract.js';
import { executeCandidate } from './execute.js';
import { ANALYTICAL_INTENT_JSON_SCHEMA, describeIntent, intentExecutionFingerprint, parseIntent, unaccountedInheritedRefs, type AnalyticalIntentV1 } from './intent.js';
import { applyGovernedDefaults, buildIntentSystemPrompt, resolveIntent, uncoveredQuestionTerms, validateIntentRefs } from './resolve-intent.js';
import { formatValue } from './outcomes.js';
import { runAskPipeline } from './pipeline.js';
import { buildVocabularyIndex, trigramSimilarity, type VocabularySource } from './vocabulary.js';
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
