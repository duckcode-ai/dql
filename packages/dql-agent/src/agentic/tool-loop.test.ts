import { describe, expect, it } from 'vitest';
import { runAgenticToolLoop, parseTextToolCall, runTextProtocolToolLoopDetailed } from './tool-loop.js';
import { deriveAgenticTrust, normalizeSql, type CompiledSemanticRecord } from './answer-contract.js';
import type { AgentMessage, AgentProvider, AgentToolDefinition, ProviderToolLoopOptions } from '../providers/types.js';

/** Scripted text-only provider (no generateWithTools) — the subscription-CLI/Ollama transport. */
class ScriptedTextProvider implements AgentProvider {
  readonly name = 'ollama' as const;
  calls: AgentMessage[][] = [];
  constructor(private readonly responses: string[]) {}
  async available(): Promise<boolean> { return true; }
  async generate(messages: AgentMessage[], options?: ProviderToolLoopOptions): Promise<string> {
    this.calls.push(messages);
    options?.onProviderDispatch?.({
      provider: this.name,
      operation: 'generate',
      attemptIndex: 1,
      envelope: { messages },
    });
    return this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
  }
}

/** Native tool-use provider — delegates to generateWithTools. */
class NativeToolProvider implements AgentProvider {
  readonly name = 'claude' as const;
  seenTools: string[] = [];
  async available(): Promise<boolean> { return true; }
  async generate(): Promise<string> { return 'unused'; }
  async generateWithTools(_m: AgentMessage[], tools: AgentToolDefinition[], options?: ProviderToolLoopOptions): Promise<string> {
    this.seenTools = tools.map((t) => t.name);
    const tool = tools[0];
    const output = await tool.run({ query: 'tax' });
    options?.onToolCall?.({ name: tool.name, input: { query: 'tax' }, output, isError: false });
    return '```json\n{"summary":"done","sql":"SELECT 1"}\n```';
  }
}

function echoTool(name: string, result: unknown): AgentToolDefinition {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    run: async () => result,
  };
}

describe('parseTextToolCall', () => {
  it('parses a fenced JSON tool call', () => {
    const call = parseTextToolCall('```json\n{"tool":"search_semantic_layer","input":{"query":"tax"}}\n```');
    expect(call).toEqual({ name: 'search_semantic_layer', input: { query: 'tax' } });
  });

  it('returns undefined for a final answer (no tool field)', () => {
    expect(parseTextToolCall('```json\n{"summary":"here","sql":"SELECT 1"}\n```')).toBeUndefined();
  });

  it('accepts arguments/args aliases and bare objects in prose', () => {
    expect(parseTextToolCall('I will call {"tool":"scan_manifest","arguments":{"query":"x"}} now'))
      .toEqual({ name: 'scan_manifest', input: { query: 'x' } });
  });
});

describe('runAgenticToolLoop — text protocol (no native tools)', () => {
  it('executes a tool call, feeds the observation back, then returns the final answer', async () => {
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"search_semantic_layer","input":{"query":"tax"}}\n```',
      '```json\n{"summary":"Tax by region","sql":"SELECT region, SUM(tax) FROM o GROUP BY region"}\n```',
    ]);
    const observed: unknown[] = [];
    const text = await runAgenticToolLoop(
      provider,
      [{ role: 'user', content: 'region tax' }],
      [echoTool('search_semantic_layer', { metrics: [{ name: 'tax_amount' }] })],
      {
        maxToolCalls: 4,
        onToolCall: (e) => observed.push(e),
      },
    );
    expect(text).toContain('SELECT region, SUM(tax)');
    expect(observed).toHaveLength(1);
    // The tool call is timed so the UI can show where the run spent its wall-clock.
    expect(typeof (observed[0] as { durationMs?: number }).durationMs).toBe('number');
    // Second generate call must have received the observation.
    const secondCall = provider.calls[1].map((m) => m.content).join('\n');
    expect(secondCall).toContain('Observation from search_semantic_layer');
  });

  it('treats an immediate final answer (no tool call) as done in one turn', async () => {
    const provider = new ScriptedTextProvider(['```json\n{"summary":"no tools needed","sql":"SELECT 1"}\n```']);
    const text = await runAgenticToolLoop(provider, [{ role: 'user', content: 'q' }], [echoTool('t', {})], { maxToolCalls: 4 });
    expect(text).toContain('no tools needed');
    expect(provider.calls).toHaveLength(1);
  });

  it('forces a final answer when the tool budget is exhausted', async () => {
    // The first response asks for a tool; the second is the one permitted final.
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"t","input":{}}\n```',
      '```json\n{"summary":"forced final"}\n```',
    ]);
    const text = await runAgenticToolLoop(provider, [{ role: 'user', content: 'q' }], [echoTool('t', { ok: true })], { maxToolCalls: 1 });
    expect(text).toContain('forced final');
    // One tool proposal + one forced final is the complete provider budget.
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].some((m) => m.content.includes('Tool budget reached'))).toBe(true);
  });

  it('executes three sequential tool calls and reserves a fourth dispatch for final composition', async () => {
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"first","input":{}}\n```',
      '```json\n{"tool":"second","input":{}}\n```',
      '```json\n{"tool":"third","input":{}}\n```',
      '```json\n{"summary":"final after three observations","sql":"SELECT 1"}\n```',
    ]);
    const observed: string[] = [];
    const text = await runAgenticToolLoop(provider, [{ role: 'user', content: 'q' }], [
      echoTool('first', { first: true }),
      echoTool('second', { second: true }),
      echoTool('third', { third: true }),
    ], {
      maxToolCalls: 3,
      onToolCall: (event) => observed.push(event.name),
    });
    expect(text).toContain('final after three observations');
    expect(observed).toEqual(['first', 'second', 'third']);
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[3]!.map((message) => message.content).join('\n')).toContain('Observation from third');
  });

  it('uses the physical dispatch cap to permit three tools plus final SQL, even when the policy tool cap is higher', async () => {
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"first","input":{}}\n```',
      '```json\n{"tool":"second","input":{}}\n```',
      '```json\n{"tool":"third","input":{}}\n```',
      '```json\n{"summary":"final SQL after physical cap","sql":"SELECT 1"}\n```',
    ]);
    const observed: string[] = [];
    const text = await runAgenticToolLoop(provider, [{ role: 'user', content: 'q' }], [
      echoTool('first', { first: true }),
      echoTool('second', { second: true }),
      echoTool('third', { third: true }),
    ], {
      // The policy allows more discovery, but the wrapper has only four sends.
      maxToolCalls: 8,
      maxProviderDispatches: 4,
      onToolCall: (event) => observed.push(event.name),
    });
    expect(observed).toEqual(['first', 'second', 'third']);
    expect(text).toContain('final SQL after physical cap');
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[0]!.map((message) => message.content).join('\n')).toContain('at most 3 tool call');
  });

  it('uses the reserved final dispatch for canonical Ask V2 finish_answer after five ordinary tools', async () => {
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"one","input":{}}\n```',
      '```json\n{"tool":"two","input":{}}\n```',
      '```json\n{"tool":"three","input":{}}\n```',
      '```json\n{"tool":"four","input":{}}\n```',
      '```json\n{"tool":"five","input":{}}\n```',
      '```json\n{"tool":"finish_answer","input":{"answer":"validated result"}}\n```',
    ]);
    const observed: string[] = [];
    const result = await runTextProtocolToolLoopDetailed(
      provider,
      [{ role: 'user', content: 'q' }],
      [
        echoTool('one', { ok: 1 }), echoTool('two', { ok: 2 }), echoTool('three', { ok: 3 }),
        echoTool('four', { ok: 4 }), echoTool('five', { ok: 5 }), echoTool('finish_answer', { finished: true }),
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 6,
        onToolCall: (event) => observed.push(event.name),
      },
    );

    expect(result).toMatchObject({ stop: 'final', toolCalls: 6 });
    expect(provider.calls).toHaveLength(6);
    expect(observed).toEqual(['one', 'two', 'three', 'four', 'five', 'finish_answer']);
  });

  it('publishes a live narrowed tool policy to text follow-ups and reserves the final send for its terminal action', async () => {
    let semanticReady = false;
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"inspect_semantic","input":{}}\n```',
      // The text provider receives an updated allowed-tool instruction after
      // the inspection and may use the last controller send for execution.
      '```json\n{"tool":"compile_semantic","input":{}}\n```',
    ]);
    const result = await runTextProtocolToolLoopDetailed(
      provider,
      [{ role: 'user', content: 'revenue by month' }],
      [
        {
          name: 'inspect_semantic', description: 'inspect semantic', inputSchema: { type: 'object' },
          run: async () => {
            semanticReady = true;
            return { compatible: true };
          },
        },
        echoTool('compile_semantic', { executed: true }),
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 2,
        getCurrentToolPolicy: () => semanticReady
          ? {
              allowedToolNames: ['compile_semantic'],
              terminalActionToolNames: ['compile_semantic'],
              instruction: 'Semantic evidence is sufficient. Compile now.',
            }
          : { allowedToolNames: ['inspect_semantic'] },
      },
    );

    expect(result).toMatchObject({ stop: 'final', toolCalls: 2 });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.map((message) => message.content).join('\n')).toContain('only: compile_semantic');
  });

  it('feeds a rejected Ask V2 finish control into the reserved semantic action instead of stopping early', async () => {
    let phase: 'inspect' | 'rejected_finish' | 'execute' | 'narrate' = 'inspect';
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"inspect_semantic","input":{}}\n```',
      '```json\n{"tool":"finish_answer","input":{"answer":"too early"}}\n```',
      '```json\n{"tool":"compile_and_run_semantic","input":{}}\n```',
      '```json\n{"tool":"finish_answer","input":{"answer":"result ready"}}\n```',
    ]);
    const seen: string[] = [];
    let semanticExecutions = 0;
    const result = await runTextProtocolToolLoopDetailed(
      provider,
      [{ role: 'user', content: 'revenue by month' }],
      [
        {
          name: 'inspect_semantic', description: 'inspect admitted semantic context', inputSchema: { type: 'object' },
          run: async () => {
            phase = 'rejected_finish';
            return { compatible: true };
          },
        },
        {
          name: 'finish_answer', description: 'finish only after a validated result', inputSchema: { type: 'object' },
          run: async () => {
            if (phase === 'rejected_finish') {
              phase = 'execute';
              return {
                ok: false,
                reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
                safeNextTools: ['compile_and_run_semantic'],
              };
            }
            return { finished: true, hasResult: true };
          },
        },
        {
          name: 'compile_and_run_semantic', description: 'compile admitted semantic selection', inputSchema: { type: 'object' },
          run: async () => {
            semanticExecutions += 1;
            phase = 'narrate';
            return { executed: true };
          },
        },
      ],
      {
        // The semantic action and its host-required finish receive separate
        // physical sends after the rejected finish proposal.
        maxToolCalls: 8,
        maxProviderDispatches: 4,
        getCurrentToolPolicy: () => phase === 'inspect'
          ? { allowedToolNames: ['inspect_semantic'] }
          : phase === 'rejected_finish'
            ? { allowedToolNames: ['finish_answer'] }
            : phase === 'narrate'
              ? { allowedToolNames: ['finish_answer'], terminalActionToolNames: ['finish_answer'] }
            : {
                allowedToolNames: ['compile_and_run_semantic'],
                terminalActionToolNames: ['compile_and_run_semantic'],
                instruction: 'The prior finish was rejected. Compile semantic now.',
              },
        onToolCall: ({ name }) => seen.push(name),
      },
    );

    expect(result).toMatchObject({ stop: 'final', toolCalls: 4 });
    expect(semanticExecutions).toBe(1);
    expect(seen).toEqual(['inspect_semantic', 'finish_answer', 'compile_and_run_semantic', 'finish_answer']);
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[2]!.map((message) => message.content).join('\n')).toContain('Final controller action for this phase. Call exactly one of: compile_and_run_semantic');
  });

  it('discards prose and re-dispatches the required semantic action instead of treating it as a final answer', async () => {
    let phase: 'inspect' | 'execute' | 'narrate' = 'inspect';
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"inspect_semantic","input":{}}\n```',
      'Revenue looks ready, so I would answer now.',
      '```json\n{"tool":"compile_and_run_semantic","input":{}}\n```',
      '```json\n{"tool":"finish_answer","input":{"answer":"result ready"}}\n```',
    ]);
    let semanticExecutions = 0;
    const result = await runTextProtocolToolLoopDetailed(
      provider,
      [{ role: 'user', content: 'revenue by month' }],
      [
        {
          name: 'inspect_semantic', description: 'inspect admitted semantic context', inputSchema: { type: 'object' },
          run: async () => {
            phase = 'execute';
            return { compatible: true };
          },
        },
        {
          name: 'compile_and_run_semantic', description: 'compile admitted semantic selection', inputSchema: { type: 'object' },
          run: async () => {
            semanticExecutions += 1;
            phase = 'narrate';
            return { executed: true };
          },
        },
        {
          name: 'finish_answer', description: 'host-required result narration', inputSchema: { type: 'object' },
          run: async () => ({ finished: true, hasResult: true }),
        },
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 4,
        getCurrentToolPolicy: () => phase === 'inspect'
          ? { allowedToolNames: ['inspect_semantic'] }
          : phase === 'narrate'
            ? { allowedToolNames: ['finish_answer'], terminalActionToolNames: ['finish_answer'] }
          : {
              allowedToolNames: ['compile_and_run_semantic'],
              terminalActionToolNames: ['compile_and_run_semantic'],
              instruction: 'Compile semantic now.',
            },
      },
    );

    expect(result).toMatchObject({ stop: 'final', toolCalls: 3 });
    expect(semanticExecutions).toBe(1);
    expect(provider.calls).toHaveLength(4);
    const finalPrompt = provider.calls[2]!.map((message) => message.content).join('\n');
    expect(finalPrompt).toContain('Controller progression required');
    expect(finalPrompt).not.toContain('Revenue looks ready');
  });

  it('returns a precise dispatch-budget stop when required semantic action receives prose on the final send', async () => {
    let phase: 'inspect' | 'execute' = 'inspect';
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"inspect_semantic","input":{}}\n```',
      'I will answer in prose instead of compiling.',
    ]);
    const result = await runTextProtocolToolLoopDetailed(
      provider,
      [{ role: 'user', content: 'revenue by month' }],
      [
        {
          name: 'inspect_semantic', description: 'inspect admitted semantic context', inputSchema: { type: 'object' },
          run: async () => {
            phase = 'execute';
            return { compatible: true };
          },
        },
        echoTool('compile_and_run_semantic', { executed: true }),
      ],
      {
        maxToolCalls: 8,
        maxProviderDispatches: 2,
        getCurrentToolPolicy: () => phase === 'inspect'
          ? { allowedToolNames: ['inspect_semantic'] }
          : {
              allowedToolNames: ['compile_and_run_semantic'],
              terminalActionToolNames: ['compile_and_run_semantic'],
            },
      },
    );

    expect(result).toMatchObject({ stop: 'provider_dispatch_budget_exhausted', toolCalls: 1 });
    expect(provider.calls).toHaveLength(2);
  });

  it('preserves the physical observer and blocks a second subscription/Ollama text dispatch at cap one', async () => {
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"t","input":{}}\n```',
      '```json\n{"summary":"ROW_CANARY_MUST_NOT_ESCAPE"}\n```',
    ]);
    const observed: string[] = [];
    const tool = echoTool('t', { rows: [{ secret: 'ROW_CANARY_TOOL' }] });

    const result = await runTextProtocolToolLoopDetailed(
      provider,
      [{ role: 'user', content: 'q' }],
      [tool],
      {
        maxToolCalls: 1,
        maxProviderDispatches: 1,
        onProviderDispatch: (event) => {
          observed.push(JSON.stringify(event.envelope));
          return event.envelope;
        },
        providerPayloadGuard: { purpose: 'answer_generation', allowedResultRowTools: {} },
      },
    );

    expect(result).toMatchObject({ stop: 'tool_budget_exhausted', toolCalls: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(observed).toHaveLength(1);
    expect(observed.join('\n')).not.toContain('ROW_CANARY_TOOL');
    expect(observed.join('\n')).not.toContain('ROW_CANARY_MUST_NOT_ESCAPE');
  });
});

describe('runAgenticToolLoop — native transport', () => {
  it('delegates to generateWithTools when available', async () => {
    const provider = new NativeToolProvider();
    const traced: string[] = [];
    const text = await runAgenticToolLoop(
      provider,
      [{ role: 'user', content: 'q' }],
      [echoTool('search_semantic_layer', { metrics: [] })],
      { onToolCall: (e) => traced.push(e.name) },
    );
    expect(provider.seenTools).toEqual(['search_semantic_layer']);
    expect(traced).toEqual(['search_semantic_layer']);
    expect(text).toContain('SELECT 1');
  });
});

describe('deriveAgenticTrust', () => {
  const compiled: CompiledSemanticRecord[] = [
    { sql: 'SELECT region, SUM(tax) AS tax_amount FROM orders GROUP BY region', metrics: ['tax_amount'], dimensions: ['region'], dqlArtifactSource: 'block ...' },
  ];

  it('labels SQL matching a governed compile verbatim (modulo whitespace/;) as semantic_metric', () => {
    const result = deriveAgenticTrust('select region, sum(tax) as tax_amount from orders group by region;', compiled);
    expect(result.tier).toBe('semantic_metric');
    expect(result.compiled).toBe(compiled[0]);
  });

  it('labels hand-written SQL as generated', () => {
    const result = deriveAgenticTrust('SELECT product, SUM(discount) FROM line_items GROUP BY product', compiled);
    expect(result.tier).toBe('generated');
  });

  it('does NOT trust compiled SQL with an appended unvalidated clause', () => {
    // The model added a WHERE to the compiled SQL — this must fall back to generated
    // (review-required), not inherit the governed validation skip.
    const result = deriveAgenticTrust(
      "SELECT region, SUM(tax) AS tax_amount FROM orders WHERE region = 'West' GROUP BY region",
      compiled,
    );
    expect(result.tier).toBe('generated');
  });

  it('is generated when nothing was compiled', () => {
    expect(deriveAgenticTrust('SELECT 1', []).tier).toBe('generated');
  });

  it('normalizeSql collapses whitespace, comments, trailing semicolons', () => {
    expect(normalizeSql('SELECT  1 -- c\n FROM t ;')).toBe('select 1 from t');
  });
});
