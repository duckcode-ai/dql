import { describe, expect, it } from 'vitest';
import { resolveEffectiveQuestion } from './dql-agent-provider.js';
import type { AgentRunRequest } from '../types.js';

function req(messages: Array<{ role: 'user' | 'assistant'; content: string }>): AgentRunRequest {
  return { provider: 'ollama', messages, projectRoot: '/tmp/x' } as AgentRunRequest;
}

describe('resolveEffectiveQuestion — clarify follow-up folding', () => {
  it('folds the original question with the clarification answer', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'Can you give me total revenue based on most products performed?' },
      { role: 'assistant', content: 'Needs clarification before a governed answer can be produced. For "…", which business object and measure should I use, and at what grain?' },
      { role: 'user', content: 'I need product details with name' },
    ]));
    expect(out).toContain('Can you give me total revenue based on most products performed?');
    expect(out).toContain('clarification: I need product details with name');
  });

  it('returns the current message unchanged when the prior assistant turn was NOT a clarification', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'what is total revenue?' },
      { role: 'assistant', content: 'Revenue is $2.8M this quarter.' },
      { role: 'user', content: 'now break it down by region' },
    ]));
    expect(out).toBe('now break it down by region');
  });

  it('returns the single user message when there is no prior turn', () => {
    expect(resolveEffectiveQuestion(req([{ role: 'user', content: 'top products by revenue' }]))).toBe('top products by revenue');
  });

  it('does not merge when the original equals the current answer', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'revenue by product' },
      { role: 'assistant', content: 'I need one more detail before querying: which metric should define the answer?' },
      { role: 'user', content: 'revenue by product' },
    ]));
    expect(out).toBe('revenue by product');
  });
});
