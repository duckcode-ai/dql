import { describe, expect, it } from 'vitest';
import { runAgenticToolLoop, parseTextToolCall } from './tool-loop.js';
import { deriveAgenticTrust, normalizeSql, type CompiledSemanticRecord } from './answer-contract.js';
import type { AgentMessage, AgentProvider, AgentToolDefinition, ProviderToolLoopOptions } from '../providers/types.js';

/** Scripted text-only provider (no generateWithTools) — the subscription-CLI/Ollama transport. */
class ScriptedTextProvider implements AgentProvider {
  readonly name = 'ollama' as const;
  calls: AgentMessage[][] = [];
  constructor(private readonly responses: string[]) {}
  async available(): Promise<boolean> { return true; }
  async generate(messages: AgentMessage[]): Promise<string> {
    this.calls.push(messages);
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
    // Always asks for a tool → must be cut off and forced to answer.
    const provider = new ScriptedTextProvider([
      '```json\n{"tool":"t","input":{}}\n```',
      '```json\n{"tool":"t","input":{}}\n```',
      '```json\n{"summary":"forced final"}\n```',
    ]);
    const text = await runAgenticToolLoop(provider, [{ role: 'user', content: 'q' }], [echoTool('t', { ok: true })], { maxToolCalls: 2 });
    expect(text).toContain('forced final');
    // 2 tool turns + 1 forced-final generate = 3 generate calls.
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[2].some((m) => m.content.includes('Tool budget reached'))).toBe(true);
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
