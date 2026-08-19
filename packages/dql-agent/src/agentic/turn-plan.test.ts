import { describe, expect, it } from 'vitest';
import { parseAnalystTurnPlan, planAnalystTurn } from './turn-plan.js';

const TOOLS = ['search_semantic_layer', 'compile_semantic_query', 'search_values'];

describe('analyst turn plan parsing', () => {
  it('reads a plain JSON reply', () => {
    const plan = parseAnalystTurnPlan(
      '{"restatement":"Revenue by region","mustEstablish":["revenue is a metric","region is a dimension"],"openingTool":"search_semantic_layer"}',
      TOOLS,
    );
    expect(plan?.restatement).toBe('Revenue by region');
    expect(plan?.mustEstablish).toHaveLength(2);
    expect(plan?.openingTool).toBe('search_semantic_layer');
  });

  it('reads a reply the model fenced or prefaced', () => {
    const plan = parseAnalystTurnPlan(
      'Sure — here is the plan:\n```json\n{"restatement":"Top customers","mustEstablish":["a ranking measure exists"]}\n```\nLet me know.',
      TOOLS,
    );
    expect(plan?.restatement).toBe('Top customers');
    expect(plan?.openingTool).toBeUndefined();
  });

  it('drops an opening tool the model cannot actually call', () => {
    // Echoing a hallucinated name would promise the user a step that never runs.
    const plan = parseAnalystTurnPlan(
      '{"restatement":"Revenue","mustEstablish":[],"openingTool":"run_python"}',
      TOOLS,
    );
    expect(plan?.openingTool).toBeUndefined();
  });

  it('caps mustEstablish and discards empty entries', () => {
    const plan = parseAnalystTurnPlan(
      '{"restatement":"R","mustEstablish":["a","","b","c","d","e"]}',
      TOOLS,
    );
    expect(plan?.mustEstablish).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns undefined rather than a plan with no restatement', () => {
    expect(parseAnalystTurnPlan('{"mustEstablish":["a"]}', TOOLS)).toBeUndefined();
    expect(parseAnalystTurnPlan('I could not produce a plan.', TOOLS)).toBeUndefined();
    expect(parseAnalystTurnPlan('{"restatement":', TOOLS)).toBeUndefined();
  });
});

describe('analyst turn planning call', () => {
  it('never fails the turn when the provider throws', async () => {
    const plan = await planAnalystTurn(
      { generate: async () => { throw new Error('provider down'); } },
      'revenue by region',
      TOOLS,
    );
    expect(plan).toBeUndefined();
  });

  it('gives up on its own timeout instead of blocking the answer', async () => {
    const plan = await planAnalystTurn(
      { generate: (_messages, options) => new Promise((_resolve, reject) => {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }) },
      'revenue by region',
      TOOLS,
      { timeoutMs: 20 },
    );
    expect(plan).toBeUndefined();
  });

  it('passes the tool list to the model so it can name a real opening move', async () => {
    let systemPrompt = '';
    const plan = await planAnalystTurn(
      { generate: async (messages) => {
        systemPrompt = messages[0]?.content ?? '';
        return '{"restatement":"Revenue by region","mustEstablish":["revenue exists"],"openingTool":"compile_semantic_query"}';
      } },
      'revenue by region',
      TOOLS,
    );
    expect(systemPrompt).toContain('compile_semantic_query');
    expect(plan?.openingTool).toBe('compile_semantic_query');
  });
});
