import { describe, expect, it } from 'vitest';
import type { AgentProvider, AgentMessage, ProviderRunOptions } from '../providers/types.js';
import { enrichProposal, enrichProposals, type EnrichFacts } from './enrich.js';

function fakeProvider(generate: (m: AgentMessage[], o?: ProviderRunOptions) => Promise<string>): AgentProvider {
  return { name: 'ollama', available: async () => true, generate };
}

const facts: EnrichFacts = {
  slug: 'customers',
  model: 'customers',
  domain: 'marts',
  grain: 'customer_id',
  pattern: 'entity_profile',
  columns: ['customer_id', 'customer_name', 'lifetime_spend'],
  entities: ['customer'],
};

describe('propose AI enrichment', () => {
  it('parses a clean JSON object response', async () => {
    const provider = fakeProvider(async () =>
      JSON.stringify({
        description: 'One row per customer with lifetime value.',
        llmContext: 'Use for customer-grain questions. One row per customer_id.',
        examples: ['How many customers are there?', 'Total lifetime spend per customer?', 'Top customers by spend?'],
      }),
    );
    const out = await enrichProposal(facts, provider);
    expect(out?.description).toContain('lifetime value');
    expect(out?.llmContext).toContain('customer_id');
    expect(out?.examples).toHaveLength(3);
  });

  it('extracts JSON even when wrapped in prose / markdown fences', async () => {
    const provider = fakeProvider(async () =>
      'Sure! Here is the metadata:\n```json\n{"description":"Customer mart.","examples":["How many customers?"]}\n```\nHope that helps.',
    );
    const out = await enrichProposal(facts, provider);
    expect(out?.description).toBe('Customer mart.');
    expect(out?.examples).toEqual(['How many customers?']);
  });

  it('returns null on unparseable output (caller keeps deterministic content)', async () => {
    const provider = fakeProvider(async () => 'I cannot help with that.');
    expect(await enrichProposal(facts, provider)).toBeNull();
  });

  it('returns null when the provider throws (best-effort, never fails generation)', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('network down');
    });
    expect(await enrichProposal(facts, provider)).toBeNull();
  });

  it('enrichProposals keys results by slug and skips failures', async () => {
    const provider = fakeProvider(async (messages) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (user.includes('orders')) throw new Error('boom');
      return JSON.stringify({ description: 'Customer mart.' });
    });
    const map = await enrichProposals(
      [facts, { ...facts, slug: 'orders', model: 'orders' }],
      provider,
      { concurrency: 2 },
    );
    expect(map.get('customers')?.description).toBe('Customer mart.');
    expect(map.has('orders')).toBe(false);
  });
});
