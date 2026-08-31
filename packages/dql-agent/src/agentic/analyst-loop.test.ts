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

/** Text-only transport: exercise the loop that has to reserve its final send. */
function textOnly(replies: string[]): AgentProvider {
  let index = 0;
  return {
    name: 'ollama' as AgentProvider['name'],
    available: async () => true,
    generate: async () => replies[Math.min(index++, replies.length - 1)]!,
  } as AgentProvider;
}

function dispatchExhausted(): AgentProvider {
  return {
    name: 'ollama' as AgentProvider['name'],
    available: async () => true,
    generate: async () => {
      throw Object.assign(new Error('RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE'), {
        code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED',
      });
    },
  } as AgentProvider;
}

const input = (provider: AgentProvider): AnswerLoopInput =>
  ({ question: 'top products by revenue', provider } as unknown as AnswerLoopInput);

const deps = (over: Partial<Parameters<typeof runAnalystLoop>[1]> = {}) => ({
  extractReferences: (sql: string) => {
    const relations = [...sql.matchAll(/from\s+([a-z_.]+)/gi)].map((m) => m[1]!);
    const relation = relations[0];
    return {
      relations,
      columns: [...sql.matchAll(/select\s+([a-z_]+)/gi)]
        .map((m) => relation ? `${relation}.${m[1]!}` : m[1]!),
    };
  },
  parseSql: (raw: string) => raw.match(/```sql\s*([\s\S]*?)```/i)?.[1]?.trim(),
  tools: [tool('get_table_schema', { relation: 'order_items', columns: ['product_name', 'product_price'] })],
  maxIterations: 6,
  ...over,
});

const scopedInput = (provider: AgentProvider): AnswerLoopInput => ({
  ...input(provider),
  agenticExecutionScope: {
    runId: 'run-a',
    executionId: 'child-a',
    snapshotId: 'snapshot-a',
    planId: 'plan-a',
    targetFingerprint: 'target-a',
    bindings: { limit: 10 },
  },
});

describe('runAnalystLoop', () => {
  it('accepts SQL whose identifiers a tool actually returned', async () => {
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const outcome = await runAnalystLoop(input(provider), deps());
    expect(outcome.stop).toBe('composed');
    expect(outcome.corrections).toEqual([]);
    expect(outcome.admitted).toEqual(expect.arrayContaining(['order_items', 'order_items.product_name']));
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
    expect(outcome.corrections[0]).toContain('did you mean order_items.product_name?');
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

  it('keeps a text-provider tool-budget terminal distinct from no final SQL', async () => {
    const provider = textOnly([
      '```json\n{"tool":"get_table_schema","input":{"canary":"RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE"}}\n```',
    ]);
    const outcome = await runAnalystLoop(input(provider), deps({ maxIterations: 0 }));
    expect(outcome).toMatchObject({
      stop: 'budget_exhausted',
      terminal: 'tool_budget_exhausted',
    });
    expect(outcome.sql).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain('RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE');
  });

  it('keeps a provider-dispatch budget terminal distinct from no final SQL', async () => {
    const outcome = await runAnalystLoop(input(dispatchExhausted()), deps());
    expect(outcome).toMatchObject({
      stop: 'budget_exhausted',
      terminal: 'provider_dispatch_budget_exhausted',
    });
    expect(outcome.sql).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain('RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE');
  });

  it('emits steps so the wait is legible rather than a spinner', async () => {
    const steps: AnalystStep[] = [];
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    await runAnalystLoop(input(provider), deps({ onStep: (s) => steps.push(s) }));
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['plan', 'observe', 'verify', 'answer']));
  });

  it('forwards a physical text-protocol tool observation to the host trace hook', async () => {
    const observed: string[] = [];
    const provider = textOnly([
      '```json\n{"tool":"get_table_schema","input":{"relation":"order_items"}}\n```',
      '```sql\nSELECT product_name FROM order_items\n```',
    ]);

    const outcome = await runAnalystLoop(input(provider), deps({
      onToolCall: (event) => observed.push(event.name),
    }));

    expect(outcome.stop).toBe('composed');
    expect(observed).toEqual(['get_table_schema']);
  });

  it('does not let a catalog-only context pack authorize generated SQL', async () => {
    // A catalog row says something was indexed under a name; it does not prove a
    // column exists in the warehouse or mint generated execution authority.
    const provider = scripted(['```sql\nSELECT lifetime_spend FROM dim_customers\n```']);
    const withPack = {
      ...input(provider),
      contextPack: { allowedSqlContext: { relations: [
        { relation: 'dim_customers', name: 'dim_customers', columns: [{ name: 'lifetime_spend' }] },
      ] } },
    } as unknown as AnswerLoopInput;
    const outcome = await runAnalystLoop(withPack, deps({ tools: [tool('noop', {})] }));
    expect(outcome.stop).toBe('unverified');
    expect(outcome.terminal).toBe('unverified_identifiers');
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

  it('AGT-054 does not re-enter legacy interpretation after an authoritative V2 tool gap', async () => {
    const legacy = vi.fn(async () => answer);
    const handler = createAnalystLaneHandler({
      legacy,
      authoritativeV2: true,
      buildDeps: () => undefined,
    });
    const result = await handler(input(scripted([''])));
    expect(legacy).not.toHaveBeenCalled();
    expect(result.askAgentV2Outcome).toMatchObject({
      kind: 'gap',
      reasonCode: 'no_final_sql',
    });
  });

  it('hands exact verified SQL to legacy only as a server-only forced proposal', async () => {
    // The legacy loop still owns trust labels, citations, narration, and
    // execution, but it cannot regenerate a replacement for analyst SQL.
    const legacy = vi.fn(async () => answer);
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    await handler(scopedInput(provider));
    const passed = legacy.mock.calls[0]![0] as AnswerLoopInput;
    expect(passed.extraContext).toBeUndefined();
    expect(passed.forcedGeneratedProposal?.sql).toBe('SELECT product_name FROM order_items');
    expect(passed.agenticSqlExecutionCapability).toMatchObject({
      runId: 'run-a', executionId: 'child-a', snapshotId: 'snapshot-a', planId: 'plan-a', targetFingerprint: 'target-a',
    });
  });

  it('uses exactly one traced frozen-plan repair after an exploratory model decline', async () => {
    const repairOptions: unknown[] = [];
    const repairMessages: unknown[] = [];
    const provider: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      // The first, bounded analyst turn uses tool mode and declines SQL.
      generateWithTools: async (_messages, tools) => {
        for (const current of tools) await current.run({});
        return '{"summary":"I need more context"}';
      },
      // Only the server-owned correction may use plain generation.
      generate: async (messages, options) => {
        repairMessages.push(messages);
        repairOptions.push(options);
        return JSON.stringify({
          summary: 'Five most expensive order items.',
          sql: 'SELECT order_id, product_id, product_price FROM order_items ORDER BY product_price DESC LIMIT 5',
          viz: 'table',
          outputs: ['order_id', 'product_id', 'product_price'],
        });
      },
    } as AgentProvider;
    const legacy = vi.fn(async () => answer);
    const prepareExploratorySqlExecution = vi.fn(async () => ({
      capability: { version: 1, sqlFingerprint: 'sql-a' },
      freeze: { version: 1, sqlFingerprint: 'sql-a' },
    }));
    const executeAgenticGeneratedSql = vi.fn(async () => ({ rows: [] }));
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });

    await handler({
      ...scopedInput(provider),
      selectedCascadeTier: 'exploratory_sql',
      resolvedAnalyticalPlan: {
        schemaVersion: 2,
        mode: 'authoritative',
        planId: 'plan-a',
        fingerprint: 'plan-fingerprint-a',
        snapshotId: 'snapshot-a',
        capability: 'bounded_exploration',
        sourceRelationIds: ['dbt:model:order_items'],
        query: { measures: [], dimensions: [], filters: [], limit: 5 },
        outputContract: {
          measures: [],
          dimensions: [],
          requiredOutputs: [
            { requested: 'order id', qualifiedId: 'dbt:column:order_items.order_id', outputName: 'order_id', status: 'resolved', candidateIds: ['dbt:column:order_items.order_id'] },
            { requested: 'product id', qualifiedId: 'dbt:column:order_items.product_id', outputName: 'product_id', status: 'resolved', candidateIds: ['dbt:column:order_items.product_id'] },
            { requested: 'product price', qualifiedId: 'dbt:column:order_items.product_price', outputName: 'product_price', status: 'resolved', candidateIds: ['dbt:column:order_items.product_price'] },
          ],
        },
      },
      contextPack: {
        allowedSqlContext: {
          relations: [{
            relation: 'order_items', name: 'order_items', source: 'runtime_schema',
            columns: [{ name: 'order_id' }, { name: 'product_id' }, { name: 'product_price' }],
          }],
          sourceBlockSql: [],
        },
      },
      prepareExploratorySqlExecution,
      executeAgenticGeneratedSql,
    } as unknown as AnswerLoopInput);

    expect(legacy).toHaveBeenCalledTimes(1);
    expect(repairOptions).toEqual([expect.objectContaining({
      dispatchPhase: 'repair', egressPurpose: 'repair_sql', maxProviderDispatches: 1,
    })]);
    expect(JSON.stringify(repairMessages[0])).toContain('one permitted correction');
    expect(JSON.stringify(repairMessages[0])).toContain('order_id <- dbt:column:order_items.order_id');
    const passed = legacy.mock.calls[0]![0] as AnswerLoopInput;
    expect(passed.forcedGeneratedProposal?.sql).toBe(
      'SELECT order_id, product_id, product_price FROM order_items ORDER BY product_price DESC LIMIT 5',
    );
    // The handler does not mint execution authority. The same frozen plan and
    // host callbacks reach the existing prepare/consume boundary unchanged.
    expect(passed.resolvedAnalyticalPlan?.fingerprint).toBe('plan-fingerprint-a');
    expect(passed.prepareExploratorySqlExecution).toBe(prepareExploratorySqlExecution);
    expect(passed.executeAgenticGeneratedSql).toBe(executeAgenticGeneratedSql);
  });

  it('does not spend a repair dispatch without a complete frozen exploratory authority', async () => {
    const directGenerate = vi.fn(async () => 'RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE');
    const provider: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: directGenerate,
      generateWithTools: async (_messages, tools) => {
        for (const current of tools) await current.run({});
        return '{"summary":"I need more context"}';
      },
    } as AgentProvider;
    const legacy = vi.fn(async () => answer);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    const result = await handler({
      ...scopedInput(provider),
      selectedCascadeTier: 'exploratory_sql',
      resolvedAnalyticalPlan: {
        schemaVersion: 2,
        mode: 'authoritative',
        planId: 'plan-a',
        // A missing fingerprint means there is no immutable tuple to repair.
        snapshotId: 'snapshot-a',
        capability: 'bounded_exploration',
        sourceRelationIds: ['dbt:model:order_items'],
        query: { measures: [], dimensions: [], filters: [] },
        outputContract: { measures: [], dimensions: [] },
      },
      prepareExploratorySqlExecution: vi.fn(),
      executeAgenticGeneratedSql: vi.fn(),
    } as unknown as AnswerLoopInput);

    expect(directGenerate).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(result.text).toContain('did not receive final SQL');
    expect(result.text).not.toContain('RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE');
  });

  it('does not invoke an ambient generated executor when scope is missing', async () => {
    const executeGeneratedSql = vi.fn(async () => ({ rows: [] }));
    const legacy = vi.fn(async (received: AnswerLoopInput) => {
      expect(received.executeGeneratedSql).toBeUndefined();
      return answer;
    });
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    await handler({ ...input(provider), executeGeneratedSql });
    expect(executeGeneratedSql).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('returns a safe, non-executing diagnostic when the text loop exhausts its tool budget', async () => {
    const executeGeneratedSql = vi.fn(async () => ({ rows: [] }));
    const legacy = vi.fn(async () => answer);
    const provider = textOnly([
      '```json\n{"tool":"get_table_schema","input":{"canary":"RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE"}}\n```',
    ]);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps({ maxIterations: 0 }) });
    const result = await handler({ ...input(provider), executeGeneratedSql });

    expect(executeGeneratedSql).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(result.text).toContain('bounded tool budget');
    expect(result.text).toContain('no generated warehouse query was run');
    expect(result.text).not.toContain('RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE');
    expect(result.evidence?.route).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'identifier_ledger',
        status: 'failed',
        label: expect.stringContaining('bounded tool budget'),
      }),
    ]));
  });

  it('returns a safe, non-executing diagnostic when the provider dispatch budget is exhausted', async () => {
    const executeGeneratedSql = vi.fn(async () => ({ rows: [] }));
    const legacy = vi.fn(async () => answer);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    const result = await handler({ ...input(dispatchExhausted()), executeGeneratedSql });

    expect(executeGeneratedSql).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(result.text).toContain('bounded AI dispatch budget');
    expect(result.text).not.toContain('RAW_PROVIDER_CANARY_MUST_NOT_ESCAPE');
    expect(result.evidence?.route).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'identifier_ledger',
        status: 'failed',
        label: expect.stringContaining('provider-dispatch budget'),
      }),
    ]));
  });

  it('records the ledger verdict even on a clean run', async () => {
    // A loop that is invisible when it works cannot be told apart from one that
    // never ran.
    const legacy = vi.fn(async () => answer);
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const handler = createAnalystLaneHandler({ legacy, buildDeps: () => deps() });
    const result = await handler(scopedInput(provider));
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
    const result = await handler(scopedInput(provider));
    const step = result.evidence?.route?.find((s) => s.tool === 'identifier_ledger');
    expect(step).toMatchObject({ status: 'checked' });
    expect(step?.detail).toContain('did you mean order_items.product_name?');
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
    const result = await handler(scopedInput(provider));
    expect(result.evidence?.route?.find((s) => s.tool === 'identifier_ledger')).toMatchObject({ status: 'checked' });
  });
});

describe('safety verifiers feed back as corrections, not refusals', () => {
  it('sends the specific failing check to the model and accepts the repair', async () => {
    // The inversion this is for: the legacy path turned "this would double-count"
    // into "nothing was executed" — true and useless. Telling the model that
    // joining those tables fans out is something it can act on.
    let calls = 0;
    const provider = scripted([
      '```sql\nSELECT product_name FROM order_items\n```',
      '```sql\nSELECT product_name FROM order_items\n```',
    ]);
    const outcome = await runAnalystLoop(input(provider), deps({
      verifySql: () => (calls++ === 0 ? 'joining those tables multiplies rows, so the total would be inflated' : undefined),
    }));
    expect(outcome.stop).toBe('composed');
    expect(outcome.corrections).toEqual(['joining those tables multiplies rows, so the total would be inflated']);
  });

  it('reports unverified when the safety check never clears', async () => {
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    const outcome = await runAnalystLoop(input(provider), deps({ verifySql: () => 'still unsafe' }));
    expect(outcome.stop).toBe('unverified');
  });

  it('checks identifiers BEFORE safety', async () => {
    // A safety verdict over SQL naming a column that does not exist is noise,
    // and would send the model chasing the wrong correction.
    const verifySql = vi.fn(() => 'unsafe aggregation');
    const provider = scripted(['```sql\nSELECT invented_col FROM order_items\n```']);
    const outcome = await runAnalystLoop(input(provider), deps({ verifySql }));
    expect(outcome.corrections[0]).toContain('never returned by a tool');
    expect(verifySql).not.toHaveBeenCalled();
  });

  it('is optional — a host that supplies no verifier still composes', async () => {
    const provider = scripted(['```sql\nSELECT product_name FROM order_items\n```']);
    expect((await runAnalystLoop(input(provider), deps())).stop).toBe('composed');
  });
});
