import type {
  AgentProvider,
  AgentMessage,
  ProviderRunOptions,
} from './types.js';

/**
 * Anthropic Claude provider via the Messages API. Reads ANTHROPIC_API_KEY.
 *
 * We deliberately avoid `@anthropic-ai/sdk` to keep dql-agent zero-dep —
 * the existing `apps/cli/src/llm/providers/claude-agent-sdk.ts` already
 * uses the SDK for the chat-cell agent loop, and that's a different layer.
 * Here we want a simple "generate from a message list" surface.
 */
export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;
  private readonly apiKey?: string;
  private readonly defaultModel: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.defaultModel = opts.model ?? 'claude-opus-4-7';
  }

  async available(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('claude: ANTHROPIC_API_KEY is not set');
    }
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model ?? this.defaultModel,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.2,
        system: system || undefined,
        messages: turns,
      }),
      signal: options.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`claude: ${res.status} ${body}`);
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const blocks = json.content ?? [];
    return blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
}
