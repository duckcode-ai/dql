import { describe, expect, it } from 'vitest';
import type { AnalyticalIntentV1 } from './intent.js';
import { runAskPipeline } from './pipeline.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentProvider } from '../providers/types.js';

const source: VocabularySource = {
  metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
  dimensions: [
    { name: 'region', model: 'orders', label: 'Region', dataType: 'string' },
    { name: 'is_test', model: 'orders', dataType: 'boolean' },
    { name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] },
  ],
  relations: [{ schema: 'dev', name: 'orders', columnCompleteness: 'complete', columns: [{ name: 'amount', dataType: 'NUMBER' }, { name: 'status', dataType: 'VARCHAR' }] }],
  skills: [{ ref: 'skill:commerce.clean-orders', id: 'clean-orders', domain: 'commerce', requiredFilters: ['is_test = false'] }],
};
const vocabulary = buildVocabularyIndex(source);

/** A provider that fails the test if the pipeline ever asks it anything. */
function silentProvider(): AgentProvider & { calls: number } {
  const provider = {
    name: 'ollama' as const,
    calls: 0,
    available: async () => true,
    generate: async () => { provider.calls += 1; throw new Error('a settled reading must not be read again'); },
  };
  return provider;
}

const reading = (overrides: Partial<AnalyticalIntentV1> = {}): AnalyticalIntentV1 => ({
  version: 1, kind: 'analytics', reading: 'Revenue by region in August 2025.',
  measures: [{ ref: 'metric:orders.revenue' }],
  groupBy: [{ ref: 'dimension:orders.region', role: 'categorical' }],
  display: [], filters: [], expectedShape: 'grouped', unresolved: [], provenance: {},
  time: { ref: 'dimension:orders.ordered_at', grain: 'month', window: { start: '2025-08-01', end: '2025-09-01' } },
  ...overrides,
} as AnalyticalIntentV1);

describe('a reading settled elsewhere runs without an AI reading', () => {
  it('stops at the proven, policed reading: required filters applied, nothing prepared or executed', async () => {
    const provider = silentProvider();
    let executed = 0;
    const outcome = await runAskPipeline({
      question: 'why did revenue drop', vocabulary, provider,
      resolvedIntent: { intent: reading(), origin: 'research_program' }, stopAfter: 'reading',
      prepareDeps: { compileSemantic: async () => { throw new Error('nothing is prepared when only the reading is asked for'); } },
      executeDeps: { run: async () => { executed += 1; return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }; } },
    });
    expect(provider.calls).toBe(0);
    expect(executed).toBe(0);
    expect(outcome.kind).toBe('reading');
    if (outcome.kind !== 'reading') return;
    expect(outcome.lane).toBe('governed');
    expect(outcome.intent.filters).toContainEqual(expect.objectContaining({ ref: 'dimension:orders.is_test', op: 'eq', values: [false] }));
    expect(outcome.receipt.reuse).toBe('interpretation');
    expect(outcome.receipt.dispatches).toEqual([]);
    expect(outcome.receipt.story?.[0]).toMatchObject({ phase: 'read', title: 'Used the settled reading', state: 'done' });
  });

  it('applying the policies again to a reading that already carries the required filter adds nothing', async () => {
    const policed = reading({ filters: [{ ref: 'dimension:orders.is_test', op: 'eq', values: [false], source: 'question' }] as AnalyticalIntentV1['filters'] });
    const outcome = await runAskPipeline({
      question: 'x', vocabulary, provider: silentProvider(),
      resolvedIntent: { intent: policed, origin: 'research_program' }, stopAfter: 'reading',
      prepareDeps: {}, executeDeps: { run: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('reading');
    if (outcome.kind === 'reading') expect(outcome.intent.filters.filter((filter) => filter.ref === 'dimension:orders.is_test')).toHaveLength(1);
  });

  it('a settled reading that names things that do not exist fails as an invalid reading, without asking the AI', async () => {
    const provider = silentProvider();
    const outcome = await runAskPipeline({
      question: 'x', vocabulary, provider,
      resolvedIntent: { intent: reading({ measures: [{ ref: 'metric:nowhere.nothing' }] }), origin: 'research_program' },
      prepareDeps: {}, executeDeps: { run: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }) },
    });
    expect(provider.calls).toBe(0);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.stage).toBe('resolve');
      expect(outcome.receipt.failure?.reason).toBe('invalid');
    }
  });

  it('a reading over tables drafts SQL only when the caller allows it, and is answered with no reading dispatch', async () => {
    const tables = reading({ measures: [{ ref: 'column:dev.orders.amount', aggregation: 'sum' }], groupBy: [{ ref: 'column:dev.orders.status', role: 'categorical' }], time: undefined });
    let drafts = 0;
    const deps = {
      prepareDeps: { draftSql: async () => { drafts += 1; return { sql: 'SELECT status, SUM(amount) AS amount FROM dev.orders GROUP BY status', relations: ['dev.orders'], proof: [] }; } },
      executeDeps: { run: async () => ({ columns: ['status', 'amount'], rows: [{ status: 'open', amount: 3 }], rowCount: 1, executionTimeMs: 1 }) },
    };
    const withheld = await runAskPipeline({ question: 'x', vocabulary, provider: silentProvider(), resolvedIntent: { intent: tables, origin: 'research_program' }, ...deps });
    expect(drafts).toBe(0);
    expect(withheld.kind).not.toBe('answered');

    const onlyReading = await runAskPipeline({ question: 'x', vocabulary, provider: silentProvider(), resolvedIntent: { intent: tables, origin: 'research_program' }, explorationAuto: true, stopAfter: 'reading', ...deps });
    expect(drafts).toBe(0);
    expect(onlyReading).toMatchObject({ kind: 'reading', lane: 'ai' });

    const provider = silentProvider();
    const answered = await runAskPipeline({ question: 'x', vocabulary, provider, resolvedIntent: { intent: tables, origin: 'research_program' }, explorationAuto: true, ...deps });
    expect(provider.calls).toBe(0);
    expect(drafts).toBe(1);
    expect(answered.kind).toBe('answered');
    if (answered.kind === 'answered') {
      expect(answered.receipt.reuse).toBe('interpretation');
      expect(answered.receipt.dispatches.filter((dispatch) => dispatch.purpose.startsWith('intent:resolve'))).toEqual([]);
    }
  });

  it('a settled governed reading the engine cannot compile is never sent back to the AI to re-read', async () => {
    const provider = silentProvider();
    const outcome = await runAskPipeline({
      question: 'x', vocabulary, provider,
      resolvedIntent: { intent: reading(), origin: 'research_program' },
      prepareDeps: { compileSemantic: async () => { throw new Error('Dimension region not found for metric revenue'); } },
      executeDeps: { run: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }) },
    });
    expect(provider.calls).toBe(0);
    expect(outcome.kind).not.toBe('answered');
    expect(outcome.receipt.dispatches).toEqual([]);
  });
});
