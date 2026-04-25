import type {
  AgentProvider,
  AgentMessage,
  ProviderRunOptions,
} from './types.js';

/**
 * Google Gemini provider via the v1beta REST surface. Reads GEMINI_API_KEY.
 * Maps system messages by prepending them to the first user turn since
 * Gemini's API doesn't have a first-class system role.
 */
export class GeminiProvider implements AgentProvider {
  readonly name = 'gemini' as const;
  private readonly apiKey?: string;
  private readonly defaultModel: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.defaultModel = opts.model ?? 'gemini-2.5-pro';
  }

  async available(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('gemini: GEMINI_API_KEY is not set');
    }
    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages.filter((m) => m.role !== 'system');
    if (systemText) {
      const firstUser = turns.findIndex((m) => m.role === 'user');
      if (firstUser >= 0) {
        turns[firstUser] = {
          ...turns[firstUser],
          content: `${systemText}\n\n${turns[firstUser].content}`,
        };
      } else {
        turns.unshift({ role: 'user', content: systemText });
      }
    }

    const model = options.model ?? this.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: turns.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens ?? 1024,
        },
      }),
      signal: options.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`gemini: ${res.status} ${body}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  }
}
