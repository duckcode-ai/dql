import type { AgentTurn, ChatTurn, ProviderId } from './types';

export interface RunAgentOptions {
  provider: ProviderId;
  messages: ChatTurn[];
  upstream?: { cellId?: string; sql?: string };
  signal?: AbortSignal;
}

/**
 * Stream AgentTurn events from POST /api/llm/run (SSE).
 * Resolves when the server closes the stream; rejects on HTTP error.
 */
export async function runAgent(opts: RunAgentOptions, onTurn: (turn: AgentTurn) => void): Promise<void> {
  const res = await fetch('/api/llm/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ provider: opts.provider, messages: opts.messages, upstream: opts.upstream }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('Response has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          onTurn(JSON.parse(dataLine.slice(6)) as AgentTurn);
        } catch {
          /* skip malformed events */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
