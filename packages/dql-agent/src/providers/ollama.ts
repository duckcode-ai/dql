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
  private readonly baseUrls: string[];
  private readonly defaultModel: string;
  private resolvedBaseUrl?: string;

  constructor(opts: { baseUrl?: string; model?: string } = {}) {
    this.baseUrls = buildOllamaBaseUrlCandidates(opts.baseUrl ?? process.env.OLLAMA_BASE_URL);
    this.defaultModel = opts.model ?? process.env.OLLAMA_MODEL ?? 'qwen3.6:latest';
  }

  async available(): Promise<boolean> {
    return Boolean(await this.resolveBaseUrl());
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    const errors: string[] = [];
    for (const baseUrl of await this.orderedBaseUrls()) {
      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: options.model ?? this.defaultModel,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: false,
            think: false,
            options: {
              temperature: options.temperature ?? 0.2,
              num_predict: options.maxTokens ?? 1024,
            },
          }),
          signal: options.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => res.statusText);
          errors.push(`${baseUrl}: ${res.status} ${body}`);
          continue;
        }
        this.resolvedBaseUrl = baseUrl;
        const json = (await res.json()) as { message?: { content?: string } };
        return json.message?.content ?? '';
      } catch (err) {
        if (options.signal?.aborted) throw err;
        errors.push(`${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`ollama: no reachable endpoint. Tried ${this.baseUrls.join(', ')}. ${errors.join(' | ')}`);
  }

  async generateStream(
    messages: AgentMessage[],
    options: ProviderRunOptions,
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const errors: string[] = [];
    for (const baseUrl of await this.orderedBaseUrls()) {
      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: options.model ?? this.defaultModel,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
            think: false,
            options: { temperature: options.temperature ?? 0.2, num_predict: options.maxTokens ?? 1024 },
          }),
          signal: options.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => res.statusText);
          errors.push(`${baseUrl}: ${res.status} ${body}`);
          continue;
        }
        this.resolvedBaseUrl = baseUrl;
        // Ollama streams newline-delimited JSON, one object per chunk.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: !done });
            let nl = buffer.indexOf('\n');
            while (nl >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (line) {
                try {
                  const obj = JSON.parse(line) as { message?: { content?: string } };
                  const delta = obj.message?.content;
                  if (delta) { full += delta; onDelta(delta); }
                } catch { /* ignore partial line */ }
              }
              nl = buffer.indexOf('\n');
            }
          }
          if (done) break;
        }
        return full;
      } catch (err) {
        if (options.signal?.aborted) throw err;
        errors.push(`${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`ollama: no reachable endpoint. Tried ${this.baseUrls.join(', ')}. ${errors.join(' | ')}`);
  }

  private async resolveBaseUrl(): Promise<string | null> {
    if (this.resolvedBaseUrl && await canReachOllama(this.resolvedBaseUrl)) {
      return this.resolvedBaseUrl;
    }
    for (const baseUrl of this.baseUrls) {
      if (await canReachOllama(baseUrl)) {
        this.resolvedBaseUrl = baseUrl;
        return baseUrl;
      }
    }
    return null;
  }

  private async orderedBaseUrls(): Promise<string[]> {
    const resolved = await this.resolveBaseUrl();
    if (!resolved) return this.baseUrls;
    return [resolved, ...this.baseUrls.filter((url) => url !== resolved)];
  }
}

function buildOllamaBaseUrlCandidates(configured?: string): string[] {
  const primary = (configured?.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const candidates = [
    primary,
    // Docker Desktop exposes host-local services through this hostname. This
    // lets the Dockerized notebook use a host Ollama daemon without requiring
    // users to know container networking details.
    'http://host.docker.internal:11434',
    // Compose profile `ollama` exposes the daemon as service name `ollama`.
    'http://ollama:11434',
    'http://127.0.0.1:11434',
  ];
  return Array.from(new Set(candidates.map((url) => url.replace(/\/+$/, ''))));
}

async function canReachOllama(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { method: 'GET' });
    return res.status < 500;
  } catch {
    return false;
  }
}
