import type {
  AgentProvider,
  AgentMessage,
  ProviderRunOptions,
} from './types.js';

/**
 * Local Ollama provider — talks to a local Ollama daemon on
 * http://127.0.0.1:11434 (overridable via OLLAMA_BASE_URL).
 *
 * `available()` does a HEAD request and returns true on any 2xx/4xx — a
 * 4xx still means a daemon is listening. Use OLLAMA_MODEL or pass `model`
 * to pin the served model.
 */
export class OllamaProvider implements AgentProvider {
  readonly name = 'ollama' as const;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.defaultModel = opts.model ?? process.env.OLLAMA_MODEL ?? 'llama3.1';
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET' });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model ?? this.defaultModel,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          temperature: options.temperature ?? 0.2,
          num_predict: options.maxTokens ?? 1024,
        },
      }),
      signal: options.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`ollama: ${res.status} ${body}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? '';
  }
}
