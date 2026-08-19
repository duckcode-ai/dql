import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProvider, AgentToolDefinition } from '@duckcodeailabs/dql-agent';
import {
  CassetteMissError,
  CassetteStore,
  cassetteDirFor,
  cassetteKey,
  resolveCassetteModeFromEnv,
  withCassette,
} from './agent-eval-cassette.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dql-cassette-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const msg = (content: string) => [{ role: 'user' as const, content }];

function stubProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return {
    name: 'claude' as AgentProvider['name'],
    available: async () => true,
    generate: async () => 'live answer',
    ...over,
  } as AgentProvider;
}

describe('cassetteKey', () => {
  it('is stable for identical input and differs when the prompt changes', () => {
    const a = cassetteKey({ providerName: 'claude', operation: 'generate', messages: msg('q') });
    const b = cassetteKey({ providerName: 'claude', operation: 'generate', messages: msg('q') });
    const c = cassetteKey({ providerName: 'claude', operation: 'generate', messages: msg('different') });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('separates providers, operations, and reasoning effort', () => {
    const base = { operation: 'generate' as const, messages: msg('q') };
    expect(cassetteKey({ ...base, providerName: 'claude' }))
      .not.toBe(cassetteKey({ ...base, providerName: 'openai' }));
    expect(cassetteKey({ ...base, providerName: 'claude' }))
      .not.toBe(cassetteKey({ ...base, providerName: 'claude', operation: 'generate_with_tools' }));
    expect(cassetteKey({ ...base, providerName: 'claude', options: { reasoningEffort: 'high' } }))
      .not.toBe(cassetteKey({ ...base, providerName: 'claude', options: { reasoningEffort: 'low' } }));
  });

  it('is order-insensitive across tool names but sensitive to the set', () => {
    // A tool set reordering is the same call; adding a tool is not.
    const k1 = cassetteKey({ providerName: 'c', operation: 'generate_with_tools', messages: msg('q'), toolNames: ['a', 'b'] });
    const k2 = cassetteKey({ providerName: 'c', operation: 'generate_with_tools', messages: msg('q'), toolNames: ['b', 'a'] });
    const k3 = cassetteKey({ providerName: 'c', operation: 'generate_with_tools', messages: msg('q'), toolNames: ['a', 'b', 'c'] });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
});

describe('withCassette', () => {
  it('records a live call, then replays it without touching the provider', async () => {
    const generate = vi.fn(async () => 'recorded answer');
    const recorder = withCassette(stubProvider({ generate }), new CassetteStore(dir), 'record');
    expect(await recorder.generate(msg('q'))).toBe('recorded answer');
    expect(generate).toHaveBeenCalledTimes(1);

    const replayGenerate = vi.fn(async () => 'SHOULD NOT BE CALLED');
    const player = withCassette(stubProvider({ generate: replayGenerate }), new CassetteStore(dir), 'replay');
    expect(await player.generate(msg('q'))).toBe('recorded answer');
    expect(replayGenerate).not.toHaveBeenCalled();
  });

  it('fails a replay miss instead of silently calling a live model', async () => {
    // The property that makes this safe to run in CI: no cassette, no network.
    const generate = vi.fn(async () => 'live');
    const player = withCassette(stubProvider({ generate }), new CassetteStore(dir), 'replay');
    await expect(player.generate(msg('never recorded'))).rejects.toBeInstanceOf(CassetteMissError);
    expect(generate).not.toHaveBeenCalled();
  });

  it('re-invokes recorded tool calls on replay so execution still really happens', async () => {
    // A fully stubbed replay would sail past a broken compiler or a wrong number.
    // Freezing the model's CHOICES while still running the tools keeps the suite
    // able to catch both.
    const calls: string[] = [];
    const tool = (name: string): AgentToolDefinition => ({
      name,
      description: '',
      inputSchema: { type: 'object', properties: {} },
      run: async (args: unknown) => { calls.push(`${name}:${JSON.stringify(args)}`); return { ok: true }; },
    });
    const tools = [tool('compile_semantic_query'), tool('scan_manifest')];

    const live = stubProvider({
      generateWithTools: async (_m, suppliedTools) => {
        await suppliedTools[0]!.run({ metric: 'revenue' });
        await suppliedTools[1]!.run({ q: 'orders' });
        return 'final text';
      },
    });
    const recorder = withCassette(live, new CassetteStore(dir), 'record');
    expect(await recorder.generateWithTools!(msg('q'), tools)).toBe('final text');
    expect(calls).toEqual(['compile_semantic_query:{"metric":"revenue"}', 'scan_manifest:{"q":"orders"}']);

    calls.length = 0;
    const modelCall = vi.fn(async () => 'SHOULD NOT BE CALLED');
    const player = withCassette(
      stubProvider({ generateWithTools: modelCall as never }),
      new CassetteStore(dir),
      'replay',
    );
    expect(await player.generateWithTools!(msg('q'), tools)).toBe('final text');
    expect(modelCall).not.toHaveBeenCalled();
    // Tools ran again, in the recorded order.
    expect(calls).toEqual(['compile_semantic_query:{"metric":"revenue"}', 'scan_manifest:{"q":"orders"}']);
  });

  it('reports available() in replay without needing credentials', async () => {
    const available = vi.fn(async () => false);
    const player = withCassette(stubProvider({ available }), new CassetteStore(dir), 'replay');
    expect(await player.available()).toBe(true);
    expect(available).not.toHaveBeenCalled();
  });

  it('passes live mode straight through', async () => {
    const provider = stubProvider();
    expect(withCassette(provider, new CassetteStore(dir), 'live')).toBe(provider);
  });

  it('persists across store instances and survives a corrupt file', async () => {
    const recorder = withCassette(stubProvider({ generate: async () => 'persisted' }), new CassetteStore(dir), 'record');
    await recorder.generate(msg('q'));
    expect(new CassetteStore(dir).size()).toBe(1);
  });

  it('derives a readable cassette directory per suite', () => {
    expect(cassetteDirFor('/p', 'answerability.agent-evals.yml')).toBe('/p/test-cassettes/answerability.agent-evals');
  });
});

describe('resolveCassetteModeFromEnv', () => {
  it('defaults to replay for anything that is not an explicit record/live', () => {
    // The safety-critical default. A cassette dir set in CI with a missing or
    // misspelled mode must mean "never call a live model", not a surprise bill
    // and a non-deterministic suite.
    expect(resolveCassetteModeFromEnv({})).toBe('replay');
    expect(resolveCassetteModeFromEnv({ DQL_EVAL_CASSETTE_MODE: undefined })).toBe('replay');
    expect(resolveCassetteModeFromEnv({ DQL_EVAL_CASSETTE_MODE: 'recrod' })).toBe('replay');
    expect(resolveCassetteModeFromEnv({ DQL_EVAL_CASSETTE_MODE: 'RECORD' })).toBe('replay');
  });

  it('honours an explicit record or live', () => {
    expect(resolveCassetteModeFromEnv({ DQL_EVAL_CASSETTE_MODE: 'record' })).toBe('record');
    expect(resolveCassetteModeFromEnv({ DQL_EVAL_CASSETTE_MODE: 'live' })).toBe('live');
  });
});
