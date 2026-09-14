import { describe, expect, it } from 'vitest';
import { buildVocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import { candidateDimensions, dimensionCap, dimensionSelectionPrompt, parseDimensionSelection } from './dimensions.js';
import type { InvestigationFrameV1 } from './types.js';

const REVENUE = 'metric:orders.revenue';
const TIME = 'dimension:orders.ordered_at';
const CATEGORY = 'dimension:orders.category';
const LOCATION = 'dimension:locations.location';

const vocabulary = buildVocabularyIndex({
  metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
  dimensions: [
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
    { name: 'category', model: 'orders', label: 'Category', dataType: 'string', description: 'Product category of the order line' },
    { name: 'location', model: 'locations', label: 'Location', dataType: 'string', reachableFrom: ['orders'] },
    { name: 'customer_type', model: 'customers', label: 'Customer type', dataType: 'string' },
    { name: 'is_food', model: 'orders', label: 'Is food', dataType: 'boolean' },
    { name: 'order_status', model: 'orders', label: 'Order status', dataType: 'string', physical: { relation: 'main.orders', column: 'status' } },
    { name: 'status', model: 'orders', dataType: 'string', inventory: true, physical: { relation: 'main.orders', column: 'status' } },
    { name: 'order_total', model: 'orders', dataType: 'number' },
  ],
  skills: [{ ref: 'skill:ops.stores', id: 'stores', preferredRefs: [LOCATION] }],
  hints: [{ id: 'h1', guidance: 'Break revenue down by category first.' }],
  relations: [{ schema: 'main', name: 'payments', columns: [
    { name: 'amount', dataType: 'double' }, { name: 'method', dataType: 'varchar' }, { name: 'is_refund', dataType: 'boolean' },
    { name: 'payment_id', dataType: 'integer' }, { name: 'paid_at', dataType: 'timestamp' },
  ] }],
});

const frame = (overrides: Partial<InvestigationFrameV1> = {}) => ({
  metric: { ref: REVENUE, label: 'Revenue', additivity: 'additive' as const }, timeRef: TIME, baseFilters: [], lane: 'governed' as const,
  reading: 'Revenue in August 2025.', ...overrides,
});

describe('choosing the dimensions to break a change down by', () => {
  it('governed dimensions the metric reaches, ranked by the question, skills, guidance, home model and documentation', () => {
    const { candidates, excluded } = candidateDimensions({ vocabulary, frame: frame(), question: 'Why did revenue drop by category?', cap: 6 });
    expect(candidates.map((candidate) => candidate.ref)).toEqual([CATEGORY, LOCATION, 'dimension:orders.is_food', 'dimension:orders.order_status']);
    expect(candidates[0]).toMatchObject({ score: 7, reasons: ['named in the question', 'named by business guidance', "on the metric's own model", 'documented'], source: 'join_reach' });
    expect(candidates[1]).toMatchObject({ score: 2, reasons: ['preferred by a skill'] });
    // Not reachable (customer type), a number (order total): not candidates. The
    // time axis, and an inventory copy of a governed dimension, are excluded with a reason.
    expect(excluded).toEqual([
      { ref: TIME, label: 'ordered at', reason: 'time_axis' },
      { ref: 'dimension:orders.status', label: 'status', reason: 'governed_alternative' },
    ]);
  });

  it('a dimension the question fixes to one value cannot explain the change', () => {
    const { candidates, excluded } = candidateDimensions({ vocabulary, frame: frame({ baseFilters: [{ ref: LOCATION, op: 'eq', values: ['Downtown'], source: 'question' }] }), question: 'Why did Downtown revenue drop?', cap: 6 });
    expect(candidates.map((candidate) => candidate.ref)).not.toContain(LOCATION);
    expect(excluded).toContainEqual({ ref: LOCATION, label: 'Location', reason: 'fixed_by_filter' });
  });

  it("the semantic layer's compatibility, when the host has it, is the whole pool", () => {
    const { candidates } = candidateDimensions({ vocabulary, frame: frame(), question: 'Why did revenue drop?', compatibleRefs: [CATEGORY, 'dimension:customers.customer_type'], cap: 6 });
    expect(candidates.map((candidate) => [candidate.ref, candidate.source])).toEqual([[CATEGORY, 'semantic_layer'], ['dimension:customers.customer_type', 'semantic_layer']]);
  });

  it('a metric read from the tables is split by the categorical and boolean columns of the relation its figures came from', () => {
    const { candidates, excluded } = candidateDimensions({
      vocabulary, frame: frame({ lane: 'ai', metric: { ref: 'column:main.payments.amount', label: 'amount', additivity: 'additive' }, timeRef: 'column:main.payments.paid_at' }),
      question: 'Why did payments fall?', relations: ['main.payments'], cap: 4,
    });
    expect(candidates.map((candidate) => [candidate.ref, candidate.source])).toEqual([
      ['column:main.payments.is_refund', 'relation_columns'],
      ['column:main.payments.method', 'relation_columns'],
    ]);
    expect(excluded).toEqual([{ ref: 'column:main.payments.paid_at', label: 'paid_at'.replace(/_/g, ' '), reason: 'time_axis' }]);
  });

  it('beyond the cap, dimensions wait; with little time left, the cap is smaller', () => {
    const { candidates, overCap } = candidateDimensions({ vocabulary, frame: frame(), question: 'Why did revenue drop by category?', cap: 2 });
    expect(candidates).toHaveLength(2);
    expect(overCap.map((candidate) => candidate.ref)).toEqual(['dimension:orders.is_food', 'dimension:orders.order_status']);
    expect([dimensionCap(frame(), 120_000), dimensionCap(frame(), 30_000)]).toEqual([6, 4]);
    expect([dimensionCap(frame({ lane: 'ai' }), 120_000), dimensionCap(frame({ lane: 'ai' }), 30_000)]).toEqual([4, 3]);
  });
});

describe("an AI's choice of dimensions", () => {
  const { candidates } = candidateDimensions({ vocabulary, frame: frame(), question: 'Why did revenue drop?', cap: 6 });

  it('is asked with the ranked list and no figures', () => {
    const prompt = dimensionSelectionPrompt({ question: 'Why did revenue drop?', metricLabel: 'Revenue', currentLabel: 'August 2025', priorLabel: 'July 2025', candidates, cap: 2 });
    expect(prompt).toContain(`- ${CATEGORY}: Category (Product category of the order line)`);
    expect(prompt).toContain('{"dimensions": ["<id>", "<id>"]}');
    // The periods and the cap are the only numbers in it: nothing measured is sent.
    expect(prompt).toContain('Choose at most 2 of these dimensions');
    expect(prompt.replace(/July 2025|August 2025|at most 2/g, '')).not.toMatch(/\d/);
  });

  it('is accepted only as JSON naming listed ids, each once, within the cap', () => {
    expect(parseDimensionSelection(`{"dimensions": ["${LOCATION}", "${CATEGORY}"]}`, candidates, 2)?.map((candidate) => candidate.ref)).toEqual([LOCATION, CATEGORY]);
    expect(parseDimensionSelection('```json\n{"dimensions": ["' + CATEGORY + '"]}\n```', candidates, 2)?.map((candidate) => candidate.ref)).toEqual([CATEGORY]);
    expect(parseDimensionSelection('{"dimensions": ["dimension:orders.made_up"]}', candidates, 2)).toBeUndefined();
    expect(parseDimensionSelection(`{"dimensions": ["${CATEGORY}", "${CATEGORY}"]}`, candidates, 2)).toBeUndefined();
    expect(parseDimensionSelection(`{"dimensions": ["${CATEGORY}", "${LOCATION}", "dimension:orders.is_food"]}`, candidates, 2)).toBeUndefined();
    expect(parseDimensionSelection(`Category looks best: {"dimensions": ["${CATEGORY}"]}`, candidates, 2)).toBeUndefined();
    expect(parseDimensionSelection('{"dimensions": []}', candidates, 2)).toBeUndefined();
  });
});
