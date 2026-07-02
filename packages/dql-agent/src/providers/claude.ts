import type {
  AgentProvider,
  AgentMessage,
  ProviderRunOptions,
} from './types.js';
import { supportsReasoningEffort } from './reasoning-effort.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Translate the abstract reasoning effort into Anthropic's `output_config.effort`
 * — the same mechanism the chat-cell agent loop already uses. Emits an empty
 * object (spread-friendly) when no effort is set or the model can't reason, so it
 * never sends an unsupported field to older Claude models or plain gateways.
 */
function anthropicReasoning(model: string, options: ProviderRunOptions): Record<string, unknown> {
  if (!options.reasoningEffort || !supportsReasoningEffort('claude', model)) return {};
  return { output_config: { effort: options.reasoningEffort } };
}

/** A 400 whose body implicates the effort/output_config field — safe to retry without it. */
function isEffortRejection(status: number, body: string): boolean {
  return status === 400 && /output_config|effort|unexpected|unsupported|unrecognized|not\s+supported/i.test(body);
}

/**
 * POST to the Messages API with a defensive effort fallback: if the request
 * carried `output_config.effort` and the API 400s implicating it (a model or
 * gateway that doesn't accept it despite our capability gate), retry once WITHOUT
 * the effort field so the turn degrades gracefully instead of failing.
 */
async function postMessages(
  url: string,
  headers: Record<string, string>,
  baseBody: Record<string, unknown>,
  reasoning: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...baseBody, ...reasoning }),
    signal,
  });
  if (res.ok || Object.keys(reasoning).length === 0) return res;
  const peek = await res.clone().text().catch(() => '');
  if (!isEffortRejection(res.status, peek)) return res;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(baseBody), signal });
}

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

    const model = options.model ?? this.defaultModel;
    const res = await postMessages(
      `${this.baseUrl}/v1/messages`,
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      {
        model,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.2,
        system: system || undefined,
        messages: turns,
      },
      anthropicReasoning(model, options),
      options.signal,
    );
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

  async generateStream(
    messages: AgentMessage[],
    options: ProviderRunOptions,
    onDelta: (delta: string) => void,
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('claude: ANTHROPIC_API_KEY is not set');
    }
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const model = options.model ?? this.defaultModel;
    const res = await postMessages(
      `${this.baseUrl}/v1/messages`,
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      {
        model,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.2,
        system: system || undefined,
        messages: turns,
        stream: true,
      },
      anthropicReasoning(model, options),
      options.signal,
    );
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`claude: ${res.status} ${body}`);
    }
    let full = '';
    await consumeSse(res.body, (data) => {
      try {
        const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          full += event.delta.text;
          onDelta(event.delta.text);
        }
      } catch {
        // ignore keep-alive / non-JSON lines
      }
    });
    return full;
  }
}

/** Consume an SSE stream, invoking `onData` with each `data:` payload (skips [DONE]). */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let sep = buffer.search(/\r?\n\r?\n/);
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(buffer[sep] === '\r' ? sep + 4 : sep + 2);
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') onData(data);
        }
        sep = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (done) break;
  }
}
