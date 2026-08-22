import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from './client';

let api: typeof ClientModule.api;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  ({ api } = await import('./client'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent-run stream transport', () => {
  it('emits the server-issued accepted identity and never sends a browser runId', async () => {
    const completed = {
      id: 'server-run-123',
      question: 'show revenue',
      route: 'generated_answer',
      status: 'completed',
      trustState: 'review_required',
      events: [],
      steps: [],
      artifacts: [],
    };
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response([
      'event: agent-run-accepted',
      'data: {"runId":"server-run-123","operationId":"operation-123"}',
      '',
      'event: agent-run-complete',
      `data: ${JSON.stringify(completed)}`,
      '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const messages: Array<{ kind: string; runId?: string; operationId?: string }> = [];
    const run = await api.createAgentRunStream(
      // Untyped callers can still supply a legacy field.  The public client
      // must omit it before it reaches server-owned capability scope.
      { question: 'show revenue', runId: 'browser-controlled-id' } as any,
      (message) => { messages.push(message as { kind: string; runId?: string; operationId?: string }); },
    );

    expect(run.id).toBe('server-run-123');
    expect(messages[0]).toEqual({ kind: 'accepted', runId: 'server-run-123', operationId: 'operation-123' });
    expect(messages[1]?.kind).toBe('complete');
    expect(JSON.parse(String(requestInit?.body))).toEqual({ question: 'show revenue' });
  });
});
