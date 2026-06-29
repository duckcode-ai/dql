import type {
  AgentProvider,
  AgentMessage,
  ProviderRunOptions,
} from './types.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Normalize an Anthropic base URL to the SDK's "root" convention: the host (and
 * optional gateway path) that `/v1/messages` is appended to. Trailing slashes and
 * a trailing `/v1` are stripped so both `https://gw/anthropic` and
 * `https://gw/anthropic/v1` resolve to the same endpoint. Enterprise gateways
 * (LiteLLM, Portkey, Cloudflare AI Gateway, internal proxies) mirror this path.
 */
export function normalizeAnthropicBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return DEFAULT_ANTHROPIC_BASE_URL;
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Anthropic Claude provider via the Messages API. Reads ANTHROPIC_API_KEY and an
 * optional ANTHROPIC_BASE_URL (or an explicit baseUrl) so enterprise deployments
 * can route through a gateway/proxy.
 *
 * We deliberately avoid `@anthropic-ai/sdk` to keep dql-agent zero-dep —
 * the existing `apps/cli/src/llm/providers/claude-agent-sdk.ts` already
 * uses the SDK for the chat-cell agent loop, and that's a different layer.
 * Here we want a simple "generate from a message list" surface.
 */
export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.baseUrl = normalizeAnthropicBaseUrl(opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL);
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

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
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
