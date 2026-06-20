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
  private readonly allowNoApiKey: boolean;

  constructor(opts: { apiKey?: string; baseUrl?: string; model?: string; allowNoApiKey?: boolean } = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.defaultModel = opts.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
    this.allowNoApiKey = opts.allowNoApiKey ?? false;
  }

  async available(): Promise<boolean> {
    return Boolean(this.apiKey) || this.allowNoApiKey;
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    if (!this.apiKey && !this.allowNoApiKey) {
      throw new Error('openai: OPENAI_API_KEY is not set');
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const model = options.model ?? this.defaultModel;
    const completionTokenBudget = options.maxTokens ?? 1024;
    const bodyBase = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    let useMaxCompletionTokens = false;
    let includeTemperature = true;
    let lastStatus = 0;
    let lastBody = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const body: Record<string, unknown> = {
        ...bodyBase,
        [useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: completionTokenBudget,
      };
      if (includeTemperature) body.temperature = options.temperature ?? 0.2;

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (res.ok) return extractOpenAIChatContent(await res.json());

      lastStatus = res.status;
      lastBody = await res.text().catch(() => res.statusText);
      let retry = false;
      if (!useMaxCompletionTokens && shouldRetryWithMaxCompletionTokens(lastBody)) {
        useMaxCompletionTokens = true;
        retry = true;
      }
      if (includeTemperature && shouldRetryWithoutTemperature(lastBody)) {
        includeTemperature = false;
        retry = true;
      }
      if (!retry) break;
    }
    throw new Error(`openai: ${lastStatus} ${lastBody}`);
  }
}

function shouldRetryWithMaxCompletionTokens(body: string): boolean {
  return /max_tokens/i.test(body) && /max_completion_tokens/i.test(body);
}

function shouldRetryWithoutTemperature(body: string): boolean {
  return /temperature/i.test(body) && (/unsupported/i.test(body) || /default/i.test(body));
}

function extractOpenAIChatContent(json: unknown): string {
  const parsed = json as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return parsed.choices?.[0]?.message?.content ?? '';
}
