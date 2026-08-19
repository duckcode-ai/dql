import { describe, it, expect, vi } from 'vitest';
import type { AgentAnswer, AnswerLoopInput } from '../answer-loop.js';
import {
  ORCHESTRATOR_FALLBACK_STEP,
  answerAgentic,
  type OrchestratorDiagnostic,
} from './orchestrator.js';
import { resolveOrchestratorPolicy } from './orchestrator-policy.js';

const input = { question: 'who are the top customers' } as unknown as AnswerLoopInput;
const answerOf = (text: string): AgentAnswer => ({
  kind: 'uncertified', text, citations: [], considered: [],
  evidence: { route: [{ tool: 'legacy', status: 'ok', label: 'legacy step' }] },
} as unknown as AgentAnswer);

describe('answerAgentic', () => {
  it('runs legacy when the policy is legacy — the default must be byte-identical', () => {
    const legacy = vi.fn(async () => answerOf('legacy answer'));
    const handler = vi.fn(async () => answerOf('agentic answer'));
    return answerAgentic(input, {
      policy: resolveOrchestratorPolicy(),
      lane: 'generated', legacy, handlers: { generated: handler },
    }).then((result) => {
      expect(result.text).toBe('legacy answer');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it('runs legacy for a lane that is not in the allowlist', async () => {
    const legacy = vi.fn(async () => answerOf('legacy answer'));
    const handler = vi.fn(async () => answerOf('agentic answer'));
    const result = await answerAgentic(input, {
      policy: resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['certified'] } }),
      lane: 'generated', legacy, handlers: { generated: handler },
    });
    expect(result.text).toBe('legacy answer');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs legacy when a lane is enabled but has no handler registered', async () => {
    // Enabling a lane before its handler exists must not break the lane.
    const legacy = vi.fn(async () => answerOf('legacy answer'));
    const result = await answerAgentic(input, {
      policy: resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['generated'] } }),
      lane: 'generated', legacy, handlers: {},
    });
    expect(result.text).toBe('legacy answer');
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('dispatches to the agentic handler for an enabled lane', async () => {
    const legacy = vi.fn(async () => answerOf('legacy answer'));
    const events: OrchestratorDiagnostic[] = [];
    const result = await answerAgentic(input, {
      policy: resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['generated'] } }),
      lane: 'generated', legacy,
      handlers: { generated: async () => answerOf('agentic answer') },
      onDiagnostic: (event) => events.push(event),
    });
    expect(result.text).toBe('agentic answer');
    expect(legacy).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'dispatch', lane: 'generated' }));
  });

  it('falls back on a handler throw and RECORDS it on the answer', async () => {
    // A silently-degrading migration looks exactly like a working one until
    // someone notices the new path never ran.
    const legacy = vi.fn(async () => answerOf('legacy answer'));
    const events: OrchestratorDiagnostic[] = [];
    const result = await answerAgentic(input, {
      policy: resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['generated'] } }),
      lane: 'generated', legacy,
      handlers: { generated: async () => { throw new Error('compile blew up'); } },
      onDiagnostic: (event) => events.push(event),
    });
    expect(result.text).toBe('legacy answer');
    expect(result.evidence?.route?.[0]).toMatchObject({
      tool: ORCHESTRATOR_FALLBACK_STEP,
      status: 'failed',
      detail: 'compile blew up',
    });
    // The legacy trace is preserved beneath the marker, not replaced.
    expect(result.evidence?.route?.[1]).toMatchObject({ tool: 'legacy' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'fallback', reason: 'compile blew up' }));
  });

  it('never re-runs legacy after a user cancellation', async () => {
    // Re-running would ignore an abort the caller already made.
    const legacy = vi.fn(async () => answerOf('legacy answer'));
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(answerAgentic(input, {
      policy: resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['generated'] } }),
      lane: 'generated', legacy,
      handlers: { generated: async () => { throw abort; } },
    })).rejects.toBe(abort);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('propagates the error when fallback is disabled', async () => {
    const legacy = vi.fn(async () => answerOf('legacy answer'));
    await expect(answerAgentic(input, {
      policy: resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['generated'], fallbackOnError: false } }),
      lane: 'generated', legacy,
      handlers: { generated: async () => { throw new Error('boom'); } },
    })).rejects.toThrow('boom');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('shadow mode never serves the agentic answer', async () => {
    const legacy = vi.fn(async () => answerOf('legacy answer'));
    const handler = vi.fn(async () => answerOf('agentic answer'));
    const result = await answerAgentic(input, {
      policy: resolveOrchestratorPolicy({ config: { mode: 'shadow', lanes: ['generated'] } }),
      lane: 'generated', legacy, handlers: { generated: handler },
    });
    expect(result.text).toBe('legacy answer');
    expect(handler).not.toHaveBeenCalled();
  });
});
