import type {
  AgentProvider,
  AgentMessage,
  AgentToolDefinition,
  ProviderToolLoopOptions,
  ProviderRunOptions,
} from './types.js';
import { consumeSse } from './claude.js';
import { supportsReasoningEffort } from './reasoning-effort.js';
import { compactToolOutput } from './tool-output.js';

/**
 * Translate reasoning effort into the Chat Completions `reasoning_effort` param.
 * Only o-series / gpt-5 models accept it; everything else (e.g. gpt-4.1-mini)
 * would reject the field, so we gate on capability and emit an empty spread.
 */
function openaiReasoning(model: string, options: ProviderRunOptions): Record<string, unknown> {
  if (!options.reasoningEffort || !supportsReasoningEffort('openai', model)) return {};
  return { reasoning_effort: options.reasoningEffort };
}

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
      ...openaiReasoning(model, options),
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

  async generateWithTools(
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    options: ProviderToolLoopOptions = {},
  ): Promise<string> {
    if (!this.apiKey && !this.allowNoApiKey) {
      throw new Error('openai: OPENAI_API_KEY is not set');
    }
    if (tools.length === 0) return this.generate(messages, options);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const model = options.model ?? this.defaultModel;
    const completionTokenBudget = options.maxTokens ?? 1024;
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const chatMessages: Array<Record<string, unknown>> = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const toolDefs = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const maxToolCalls = Math.max(0, Math.min(30, options.maxToolCalls ?? 8));
    let toolCallsUsed = 0;
    let lastText = '';
    let useMaxCompletionTokens = false;
    let includeTemperature = true;

    for (;;) {
      const bodyBase = {
        model,
        messages: chatMessages,
        tools: toolDefs,
        tool_choice: 'auto',
        ...openaiReasoning(model, options),
      };
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
      if (!res.ok) {
        const errorBody = await res.text().catch(() => res.statusText);
        if (!useMaxCompletionTokens && shouldRetryWithMaxCompletionTokens(errorBody)) {
          useMaxCompletionTokens = true;
          continue;
        }
        if (includeTemperature && shouldRetryWithoutTemperature(errorBody)) {
          includeTemperature = false;
          continue;
        }
        throw new Error(`openai: ${res.status} ${errorBody}`);
      }

      const message = extractOpenAIChatMessage(await res.json());
      if (message.content) lastText = message.content;
      if (!message.toolCalls.length) return message.content ?? lastText;
      if (toolCallsUsed + message.toolCalls.length > maxToolCalls) {
        options.onToolCall?.({
          name: 'tool_budget_exhausted',
          input: {
            requestedToolCalls: message.toolCalls.map((call) => call.name),
            maxToolCalls,
            toolCallsUsed,
          },
          output: { error: `Tool-call budget exhausted after ${toolCallsUsed} call(s).` },
          isError: true,
        });
        // Graceful final turn: ask the model to answer NOW from what the prior tool
        // calls already returned — with `tools`/`tool_choice` OMITTED so it cannot
        // request another tool and the loop is guaranteed to terminate.
        chatMessages.push({
          role: 'user',
          content: 'Tool budget reached — do not call any more tools. Answer now using only the information the tool calls above already returned, following the required output format.',
        });
        try {
          const finalBody: Record<string, unknown> = {
            model,
            messages: chatMessages,
            ...openaiReasoning(model, options),
            [useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: completionTokenBudget,
            // tools + tool_choice intentionally omitted — forces a final answer.
          };
          if (includeTemperature) finalBody.temperature = options.temperature ?? 0.2;
          const finalRes = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(finalBody),
            signal: options.signal,
          });
          if (finalRes.ok) {
            const finalMessage = extractOpenAIChatMessage(await finalRes.json());
            if (finalMessage.content?.trim()) return finalMessage.content;
          }
        } catch {
          // Fall through to the legacy behavior on any final-turn failure.
        }
        return lastText || JSON.stringify({
          summary: `Tool-call budget exhausted after ${toolCallsUsed} call(s).`,
        });
      }

      chatMessages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.argumentsJson },
        })),
      });

      for (const call of message.toolCalls) {
        toolCallsUsed += 1;
        const tool = toolMap.get(call.name);
        const args = parseToolArguments(call.argumentsJson);
        let output: unknown;
        let isError = false;
        if (!tool) {
          output = { error: `Unknown tool: ${call.name}` };
          isError = true;
        } else {
          try {
            output = await tool.run(args);
          } catch (err) {
            output = { error: err instanceof Error ? err.message : String(err) };
            isError = true;
          }
        }
        options.onToolCall?.({ name: call.name, input: args, output, isError });
        chatMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: compactToolOutput(output),
        });
      }
    }
  }

  async generateStream(
    messages: AgentMessage[],
    options: ProviderRunOptions,
    onDelta: (delta: string) => void,
  ): Promise<string> {
    if (!this.apiKey && !this.allowNoApiKey) {
      throw new Error('openai: OPENAI_API_KEY is not set');
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model ?? this.defaultModel,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.2,
        stream: true,
        ...openaiReasoning(options.model ?? this.defaultModel, options),
      }),
      signal: options.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => res.statusText);
      // Streaming can be rejected for param reasons (max_completion_tokens, temperature);
      // fall back to the robust non-streaming path rather than failing the turn.
      throw new Error(`openai: ${res.status} ${body}`);
    }
    let full = '';
    await consumeSse(res.body, (data) => {
      try {
        const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // ignore non-JSON keep-alive lines
      }
    });
    return full;
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

function extractOpenAIChatMessage(json: unknown): {
  content?: string;
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
} {
  const message = (json as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  }).choices?.[0]?.message;
  return {
    content: typeof message?.content === 'string' ? message.content : undefined,
    toolCalls: (message?.tool_calls ?? []).flatMap((call, index) => {
      const name = call.function?.name;
      if (!name) return [];
      return [{
        id: call.id ?? `tool_${index}`,
        name,
        argumentsJson: call.function?.arguments ?? '{}',
      }];
    }),
  };
}

function parseToolArguments(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { _raw: raw };
  }
}

