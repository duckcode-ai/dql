/**
 * Provider registry. The `pickProvider()` helper falls back through the
 * configured list and returns the first one that has its credentials.
 *
 * Order is intentional: closed-source first (Claude → OpenAI → Gemini),
 * Ollama last as the local-only fallback.
 */

import type { AgentProvider, ProviderName } from './types.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';

export type { AgentProvider, AgentMessage, ProviderName, ProviderRunOptions } from './types.js';
export { ClaudeProvider, OpenAIProvider, GeminiProvider, OllamaProvider };

const FALLBACK_ORDER: ProviderName[] = ['claude', 'openai', 'gemini', 'ollama'];

export function buildProvider(name: ProviderName): AgentProvider {
  switch (name) {
    case 'claude':
      return new ClaudeProvider();
    case 'openai':
      return new OpenAIProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'ollama':
      return new OllamaProvider();
  }
}

/**
 * Pick a provider:
 *   - If `preferred` is set, return it (no availability check, fail-fast at use time).
 *   - Otherwise probe FALLBACK_ORDER and return the first available.
 *   - If nothing is available, return the Ollama provider (so callers get
 *     a usable error message at generate time).
 */
export async function pickProvider(preferred?: ProviderName): Promise<AgentProvider> {
  if (preferred) return buildProvider(preferred);
  for (const name of FALLBACK_ORDER) {
    const p = buildProvider(name);
    if (await p.available()) return p;
  }
  return buildProvider('ollama');
}
