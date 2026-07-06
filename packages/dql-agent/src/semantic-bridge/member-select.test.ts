import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import { extractFirstJsonObject, selectSemanticMembersViaLlm } from './member-select.js';

function layer(): SemanticLayer {
  return new SemanticLayer({
    metrics: [{ name: 'total_revenue', label: 'Total Revenue', description: 'Recognized revenue.', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' }],
    dimensions: [{ name: 'channel', label: 'Channel', description: 'Sales channel.', domain: 'finance', sql: 'channel', type: 'string', table: 'orders' }],
  });
}

function providerReturning(response: string): AgentProvider {
  return {
    name: 'claude',
    available: async () => true,
    generate: async (_messages: AgentMessage[]) => response,
  } as AgentProvider;
}

describe('extractFirstJsonObject', () => {
  it('extracts a fenced JSON object and ignores trailing prose', () => {
    expect(extractFirstJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractFirstJsonObject('here you go {"a": {"b": 2}} thanks')).toEqual({ a: { b: 2 } });
  });
  it('returns undefined when there is no object', () => {
    expect(extractFirstJsonObject('no json here')).toBeUndefined();
  });
});

describe('selectSemanticMembersViaLlm', () => {
  it('parses a valid member selection restricted to real members', async () => {
    const selection = await selectSemanticMembersViaLlm({
      provider: providerReturning('{"metrics":["total_revenue"],"dimensions":["channel"],"limit":5}'),
      semanticLayer: layer(),
      question: 'revenue by channel',
    });
    expect(selection).toMatchObject({ metrics: ['total_revenue'], dimensions: ['channel'], limit: 5 });
  });

  it('returns undefined when the model selects no metric', async () => {
    const selection = await selectSemanticMembersViaLlm({
      provider: providerReturning('{"metrics":[]}'),
      semanticLayer: layer(),
      question: 'unrelated',
    });
    expect(selection).toBeUndefined();
  });

  it('returns undefined when the provider throws (offline-safe)', async () => {
    const provider = { name: 'claude', available: async () => true, generate: async () => { throw new Error('no key'); } } as AgentProvider;
    expect(await selectSemanticMembersViaLlm({ provider, semanticLayer: layer(), question: 'q' })).toBeUndefined();
  });
});
