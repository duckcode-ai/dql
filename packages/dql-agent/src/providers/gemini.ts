import type {
  AgentProvider,
  AgentMessage,
  ProviderRunOptions,
} from './types.js';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Normalize a Gemini base URL to the path that `/models/<model>:generateContent`
 * is appended to (i.e. it includes the `/v1beta` API-version segment, matching the
 * public default). Trailing slashes are stripped. Enterprise gateways mirror this.
 */
export function normalizeGeminiBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return DEFAULT_GEMINI_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Google Gemini provider via the v1beta REST surface. Reads GEMINI_API_KEY (or
 * GOOGLE_API_KEY) and an optional GEMINI_BASE_URL (or explicit baseUrl) so
 * enterprise deployments can route through a gateway/proxy. The API key is sent
 * via the `x-goog-api-key` header rather than a `?key=` query param so it is not
 * leaked into URLs/logs and works with header-auth gateways.
 * Maps system messages by prepending them to the first user turn since
 * Gemini's API doesn't have a first-class system role.
 */
export class GeminiProvider implements AgentProvider {
  readonly name = 'gemini' as const;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.baseUrl = normalizeGeminiBaseUrl(opts.baseUrl ?? process.env.GEMINI_BASE_URL ?? process.env.GOOGLE_GEMINI_BASE_URL);
    this.defaultModel = opts.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-pro';
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
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
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
