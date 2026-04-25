import type {
  AgentProvider,
  AgentMessage,
  ProviderRunOptions,
} from './types.js';

/**
 * OpenAI / Chat Completions-compatible provider. Reads OPENAI_API_KEY plus
 * an optional OPENAI_BASE_URL (e.g. point at Azure OpenAI or vLLM).
 */
export class OpenAIProvider implements AgentProvider {
  readonly name = 'openai' as const;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.defaultModel = opts.model ?? 'gpt-4.1-mini';
  }

  async available(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('openai: OPENAI_API_KEY is not set');
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model ?? this.defaultModel,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.2,
      }),
      signal: options.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`openai: ${res.status} ${body}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? '';
  }
}
