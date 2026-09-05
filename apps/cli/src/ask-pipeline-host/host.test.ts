import { describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@duckcodeailabs/dql-agent';
import type { ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { buildVocabularyIndex, parseIntent, type AnalyticalIntentV1 } from '@duckcodeailabs/dql-agent';
import { createAskPipelineRouteExecutor, groundIntentLiterals } from './host.js';

function scripted(replies: string[]): AgentProvider & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  return {
    name: 'ollama',
    calls,
    available: async () => true,
    generate: async (messages) => { calls.push(messages); return replies[Math.min(calls.length - 1, replies.length - 1)] ?? ''; },
  };
}

const conversation = JSON.stringify({
  version: 1, kind: 'conversation', reading: 'A greeting.', reply: 'Hello! Ask me about the governed data.',
  measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
});
const analytics = JSON.stringify({
  version: 1, kind: 'analytics', reading: 'Total revenue.', measures: [{ ref: 'metric:order_item.revenue' }],
  groupBy: [], display: [], filters: [], unresolved: [], provenance: { 'metric:order_item.revenue': 'q:revenue' }, expectedShape: 'scalar',
});

function executorFor(provider: AgentProvider, manifest: unknown) {
  return createAskPipelineRouteExecutor({
    projectRoot: '/tmp/none',
    executor: {} as QueryExecutor,
    resolveConnection: async () => { throw new Error('No database connection is configured yet. Open Connections, add a warehouse or local DuckDB/file connection, then retry.'); },
    getSemanticLayer: () => undefined,
    getManifest: () => ({ manifest: manifest as never, snapshotId: 'snapshot:test' }),
    selectProvider: async () => provider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
}

const run = (executor: ReturnType<typeof createAskPipelineRouteExecutor>, question: string) => executor({
  runId: 'run-1', request: { question, requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
});

describe('the pipeline host without a warehouse', () => {
  it('answers a conversational turn with one interpreter send and no connection', async () => {
    const provider = scripted([conversation]);
    const result = await run(executorFor(provider, undefined), 'hi');
    expect(result.status).toBe('completed');
    expect(result.resolvedRoute).toBe('conversation');
    expect(result.answer).toBe('Hello! Ask me about the governed data.');
    expect(provider.calls).toHaveLength(1);
  });
  it('reports the missing connection verbatim only when a prepared query would execute', async () => {
    const manifest = {
      sources: [{ schema: 'dev', name: 'order_items', columns: [{ name: 'product_price', dataType: 'DOUBLE' }] }],
      blocks: [],
    };
    const provider = scripted([JSON.stringify({
      version: 1, kind: 'analytics', reading: 'Total product price.', measures: [{ ref: 'column:dev.order_items.product_price', aggregation: 'sum' }],
      groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
    }), analytics]);
    const result = await run(executorFor(provider, manifest), 'total product price');
    // Either the relational tier prepared and execution named the missing
    // connection, or no tier could prepare without a semantic layer; in
    // neither case did interpretation itself need a warehouse.
    expect(result.status).toBe('blocked');
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
    const receipt = result.askPipelineReceipt;
    expect(receipt).toBeDefined();
    if (receipt?.failure?.stage === 'execute') expect(receipt.failure.message).toMatch(/No database connection is configured yet/);
  });
});

describe('member literal grounding', () => {
  const vocabulary = buildVocabularyIndex({
    metrics: [{ name: 'revenue', model: 'order_item', aggregation: 'sum', physical: { relation: 'dev.order_items', expr: '"dev"."order_items"."product_price"', aggregate: 'sum' } }],
    dimensions: [
      { name: 'customer_name', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_name' } },
      { name: 'customer_type', model: 'customers', dataType: 'string', physical: { relation: 'dev.customers', column: 'customer_type' } },
    ],
  });
  const intent = (filters: AnalyticalIntentV1['filters']): AnalyticalIntentV1 => {
    const parsed = parseIntent({ version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:order_item.revenue' }], groupBy: [], display: [], filters, unresolved: [], provenance: {}, expectedShape: 'scalar' });
    if (!parsed.intent) throw new Error('bad intent');
    return parsed.intent;
  };
  const connection = { driver: 'duckdb' } as ConnectionConfig;
  const probes: string[] = [];
  const deps = {
    literalProbeAllowed: (relation: string, column: string) => `${relation}.${column}` === 'dev.customers.customer_name',
    probeLiteral: async (_relation: string, column: string, value: string) => {
      probes.push(`${column}=${value}`);
      return value.toLowerCase() === 'ryan byrd' ? ['Ryan Byrd'] : [];
    },
  };
  it('replaces a literal with its stored casing on an allowlisted column and says so', async () => {
    const grounded = await groundIntentLiterals(intent([{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Ryan byrd'], source: 'question' }]), vocabulary, connection, deps);
    expect(grounded.intent.filters[0]!.values).toEqual(['Ryan Byrd']);
    expect(grounded.notes).toEqual(['customer_name: "Ryan byrd" is stored as "Ryan Byrd"']);
  });
  it('records an absent member and never probes a column outside the allowlist', async () => {
    probes.length = 0;
    const grounded = await groundIntentLiterals(intent([
      { ref: 'dimension:customers.customer_name', op: 'eq', values: ['Nobody Here'], source: 'question' },
      { ref: 'dimension:customers.customer_type', op: 'eq', values: ['returning'], source: 'question' },
    ]), vocabulary, connection, deps);
    expect(grounded.intent.filters.map((filter) => filter.values)).toEqual([['Nobody Here'], ['returning']]);
    expect(grounded.notes).toEqual(['customer_name: no stored value matches "Nobody Here"']);
    expect(probes).toEqual(['customer_name=Nobody Here']);
  });
});
