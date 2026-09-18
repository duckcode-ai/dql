import { describe, expect, it } from 'vitest';
import { ollamaContextWindow } from './ollama.js';

describe('the context window an Ollama call asks for', () => {
  const message = (chars: number) => [{ role: 'user' as const, content: 'x'.repeat(chars) }];
  it('fits the prompt and the reply budget, rounded up to 4k, never under 8k', () => {
    expect(ollamaContextWindow(message(300), 1024)).toBe(8192);
    // A 36,000-character Ask reading (~12k tokens) plus an 8k reply budget.
    expect(ollamaContextWindow(message(36_000), 8192)).toBe(24_576);
  });
  it('stops at the ceiling, which an operator can set', () => {
    expect(ollamaContextWindow(message(600_000), 8192)).toBe(65_536);
    expect(ollamaContextWindow(message(600_000), 8192, { OLLAMA_NUM_CTX_MAX: '32768' })).toBe(32_768);
  });
});
