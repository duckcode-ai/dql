import { describe, it, expect, vi } from 'vitest';
import type { AgentAnswer, AnswerLoopInput } from '../answer-loop.js';
import type { AgentProvider, AgentToolDefinition } from '../providers/types.js';
import { createAnalystLaneHandler, runAnalystLoop, type AnalystStep } from './analyst-loop.js';

const tool = (name: string, output: unknown): AgentToolDefinition => ({
  name, description: 'x', inputSchema: { type: 'object', properties: {} },
  run: async () => output,
});

/** A provider that returns each scripted reply in turn, calling tools first. */
function scripted(replies: string[], callTools = true): AgentProvider {
  let index = 0;
  return {
    name: 'ollama' as AgentProvider['name'],
    available: async () => true,
    generate: async () => replies[Math.min(index++, replies.length - 1)]!,
    generateWithTools: async (_m, tools) => {
      if (callTools) for (const t of tools) await t.run({});
      return replies[Math.min(index++, replies.length - 1)]!;
    },
  } as AgentProvider;
}

const input = (provider: AgentProvider): AnswerLoopInput =>
  ({ question: 'top products by revenue', provider } as unknown as AnswerLoopInput);

const deps = (over: Partial<Parameters<typeof runAnalystLoop>[1]> = {}) => ({
  extractReferences: (sql: string) => ({
    relations: [...sql.matchAll(/from\s+([a-z_.]+)/gi)].map((m) => m[1]!),
    columns: [...sql.matchAll(/select\s+([a-z_]+)/gi)].map((m) => m[1]!),
  }),
  parseSql: (raw: string) => raw.match(/```sql\s*([\s\S]*?)```/i)?.[1]?.trim(),
  tools: [tool('get_table_schema', { relation: 'order_items', columns: ['product_name', 'product_price'] })],
  maxIterations: 6,
  ...over,
});

describe('runAnalystLoop', () => {
  it('accepts SQL whose identifiers a tool actually returned', async () => {
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const outcome = await runAnalystLoop(input(provider), deps());
    expect(outcome.stop).toBe('composed');
    expect(outcome.corrections).toEqual([]);
    expect(outcome.admitted).toEqual(expect.arrayContaining(['order_items', 'product_name']));
  });

  it('corrects an invented column and accepts the repair', async () => {
    // The dominant failure: a plausible-but-wrong name. The correction names the
    // real one, which is worth far more than reporting that something was wrong.
    const provider = scripted([
      '```sql\nSELECT product_nmae FROM order_items\n```',
      '```sql\nSELECT product_name FROM order_items\n```',
    ]);
    const outcome = await runAnalystLoop(input(provider), deps());
    expect(outcome.stop).toBe('composed');
    expect(outcome.corrections).toHaveLength(1);
    expect(outcome.corrections[0]).toContain('did you mean product_name?');
  });

  it('stops after ONE repair rather than re-spending the budget', async () => {
    // If a correction naming the exact observed identifier does not land, the
    // problem is not a typo.
    const provider = scripted(['```sql\nSELECT nonsense_col FROM order_items\n```']);
    const outcome = await runAnalystLoop(input(provider), deps());
    expect(outcome.stop).toBe('unverified');
    expect(outcome.corrections).toHaveLength(2);
  });

  it('reports no_sql when the model never proposes any', async () => {
    const provider = scripted(['I am not sure how to answer that.']);
    const outcome = await runAnalystLoop(input(provider), deps());
    expect(outcome.stop).toBe('no_sql');
    expect(outcome.sql).toBeUndefined();
  });

  it('emits steps so the wait is legible rather than a spinner', async () => {
    const steps: AnalystStep[] = [];
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    await runAnalystLoop(input(provider), deps({ onStep: (s) => steps.push(s) }));
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['plan', 'observe', 'verify', 'answer']));
  });

  it('seeds the context pack at the WEAKEST tier, not as proof', async () => {
    // A catalog row says something was indexed under a name; it does not prove a
    // column exists in the warehouse. It still must not false-alarm correct SQL.
    const provider = scripted(['```sql\nSELECT lifetime_spend FROM dim_customers\n```']);
    const withPack = {
      ...input(provider),
      contextPack: { allowedSqlContext: { relations: [
        { relation: 'dim_customers', name: 'dim_customers', columns: [{ name: 'lifetime_spend' }] },
      ] } },
    } as unknown as AnswerLoopInput;
    const outcome = await runAnalystLoop(withPack, deps({ tools: [tool('noop', {})] }));
    expect(outcome.stop).toBe('composed');
  });
});

describe('createAnalystLaneHandler', () => {
  const answer = { kind: 'uncertified', text: 'legacy', citations: [], considered: [],
    evidence: { route: [{ tool: 'legacy', status: 'checked', label: 'legacy' }] } } as unknown as AgentAnswer;

  it('falls back to legacy when there are no tools to run', async () => {
    const legacy = vi.fn(async () => answer);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps({ tools: [] }) });
    await handler(input(scripted([''])));
    expect(legacy).toHaveBeenCalledTimes(1);
    // Called with the input untouched — no analyst context appended.
    expect(legacy.mock.calls[0]![0]).not.toHaveProperty('extraContext');
  });

  it('falls back when the host supplies no deps at all', async () => {
    const legacy = vi.fn(async () => answer);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => undefined });
    await handler(input(scripted([''])));
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('hands verified SQL to legacy as CONTEXT, not as an instruction', async () => {
    // The legacy loop still owns trust labels, citations, narration, and
    // execution. This only decides whether the SQL it sees was built from
    // observed identifiers.
    const legacy = vi.fn(async () => answer);
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    await handler(input(provider));
    const passed = legacy.mock.calls[0]![0] as { extraContext?: string };
    expect(passed.extraContext).toContain('verified the following SQL');
    expect(passed.extraContext).toContain('SELECT product_name FROM order_items');
  });

  it('records the ledger verdict even on a clean run', async () => {
    // A loop that is invisible when it works cannot be told apart from one that
    // never ran.
    const legacy = vi.fn(async () => answer);
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    const result = await handler(input(provider));
    const step = result.evidence?.route?.find((s) => s.tool === 'identifier_ledger');
    expect(step).toMatchObject({ status: 'checked' });
    expect(step?.label).toMatch(/Verified \d+ identifier/);
    expect(step?.detail).toBeUndefined();
  });

  it('records the ledger verdict on the answer when it had to correct', async () => {
    const legacy = vi.fn(async () => answer);
    const provider = scripted([
      '```sql\nSELECT product_nmae FROM order_items\n```',
      '```sql\nSELECT product_name FROM order_items\n```',
    ]);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    const result = await handler(input(provider));
    const step = result.evidence?.route?.find((s) => s.tool === 'identifier_ledger');
    expect(step).toMatchObject({ status: 'checked' });
    expect(step?.detail).toContain('did you mean product_name?');
  });
});

describe('analyst evidence when the host has not initialised it yet', () => {
  it('creates the envelope rather than dropping the verdict', async () => {
    // The host sets `evidence` AFTER the answer call, so it is normally
    // undefined here. Skipping in that case dropped the verdict on every real
    // run — the loop worked and left no trace, which reads exactly like it never
    // ran. Caught live, not by a unit test.
    const bare = { kind: 'uncertified', text: 'legacy', citations: [], considered: [] } as unknown as AgentAnswer;
    const legacy = vi.fn(async () => bare);
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    const result = await handler(input(provider));
    expect(result.evidence?.route?.find((s) => s.tool === 'identifier_ledger')).toMatchObject({ status: 'checked' });
  });
});
