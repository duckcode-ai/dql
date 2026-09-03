import type {
  AgentProvider,
  AgentMessage,
  AgentToolDefinition,
  NativeToolLoopStop,
  NativeToolLoopResult,
  ProviderToolLoopOptions,
  ProviderRunOptions,
} from './types.js';
import { consumeSse } from './claude.js';
import { supportsReasoningEffort } from './reasoning-effort.js';
import { compactToolOutput } from './tool-output.js';
import { fetchProviderHttpDispatch, providerDispatchLimit } from './dispatch.js';
import { adoptProseAsFinishNarration } from '../agentic/tool-loop.js';

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
    let dispatches = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const body: Record<string, unknown> = {
        ...bodyBase,
        [useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: completionTokenBudget,
      };
      if (includeTemperature) body.temperature = options.temperature ?? 0.2;

      dispatches += 1;
      const res = await fetchProviderHttpDispatch({
        provider: this.name,
        operation: 'generate',
        attemptIndex: dispatches,
        envelope: body,
        options,
        url: `${this.baseUrl}/chat/completions`,
        init: {
          method: 'POST',
          headers,
          signal: options.signal,
        },
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
  ): Promise<NativeToolLoopResult> {
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
    const dispatchLimit = providerDispatchLimit(options);
    const requestedToolBudget = Math.max(0, Math.min(dispatchLimit <= 2 ? 4 : 30, options.maxToolCalls ?? 8));
    // Keep one physical provider turn available for a controller-selected
    // terminal action when the host publishes a live V2 tool policy. Existing
    // callers without that policy retain their prior native-loop behavior.
    const dynamicToolPolicy = Boolean(options.getCurrentToolPolicy);
    const ordinaryToolBudget = dynamicToolPolicy
      ? Math.min(requestedToolBudget, Math.max(0, dispatchLimit - 1))
      : requestedToolBudget;
    let toolCallsUsed = 0;
    let lastText = '';
    let useMaxCompletionTokens = false;
    let includeTemperature = true;
    let dispatches = 0;
    const requiresPostExecutionFinish = dynamicToolPolicy
      && tools.some((tool) => tool.name === 'finish_answer');
    let requiredActionSignature = '';
    let requiredActionProseRetries = 0;

    const send = (body: Record<string, unknown>): Promise<Response> => {
      dispatches += 1;
      return fetchProviderHttpDispatch({
        provider: this.name,
        operation: 'generate_with_tools',
        attemptIndex: dispatches,
        envelope: body,
        options,
        url: `${this.baseUrl}/chat/completions`,
        init: {
          method: 'POST',
          headers,
          signal: options.signal,
        },
      });
    };

    const forcedFinal = async (): Promise<string> => {
      const finalBody: Record<string, unknown> = {
        model,
        messages: chatMessages,
        ...openaiReasoning(model, options),
        [useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: completionTokenBudget,
      };
      if (includeTemperature) finalBody.temperature = options.temperature ?? 0.2;
      const finalRes = await send(finalBody);
      if (!finalRes.ok) return '';
      const finalMessage = extractOpenAIChatMessage(await finalRes.json());
      // Tools were physically disabled. A provider that still returns a tool
      // request cannot trigger another round.
      return finalMessage.toolCalls.length === 0 ? finalMessage.content?.trim() ?? '' : '';
    };

    for (;;) {
      const currentPolicy = nativeToolPolicy(options, tools);
      const nextRequiredActionSignature = [...currentPolicy.terminalActionToolNames].sort().join('|');
      if (nextRequiredActionSignature !== requiredActionSignature) {
        requiredActionSignature = nextRequiredActionSignature;
        requiredActionProseRetries = 0;
      }
      const narrationControlRound = currentPolicy.terminalActionToolNames.has('finish_answer');
      // A clarification is its own host terminal, while a selected execution
      // action needs the final narration send. Keep that distinction in the
      // physical reservation so invalid clarification options remain a
      // recoverable observation instead of consuming a nonexistent finish
      // slot.
      const terminalExecutionAction = [...currentPolicy.terminalActionToolNames]
        .some((name) => !isAskV2TerminalControlTool(name));
      const reservePostExecutionNarration = requiresPostExecutionFinish && terminalExecutionAction;
      // An execution decision needs one remaining physical send for the
      // post-result finish/narration control. At the last tool-followup slot,
      // expose only the host-approved execution action. This does not select
      // a route: it prevents another inspection from consuming the narration
      // reserve after the V2 kernel already established its safe choices.
      const finalExecutionActionRound = !narrationControlRound
        && dispatches >= Math.max(0, dispatchLimit - (reservePostExecutionNarration ? 2 : 1));
      const terminalActionRound = dynamicToolPolicy
        && currentPolicy.terminalActionToolNames.size > 0
        && (toolCallsUsed >= ordinaryToolBudget
          || (narrationControlRound ? dispatches >= dispatchLimit - 1 : finalExecutionActionRound));
      if (dynamicToolPolicy && toolCallsUsed >= ordinaryToolBudget && !terminalActionRound) {
        return forcedFinal();
      }
      const roundTools = terminalActionRound
        ? currentPolicy.tools.filter((tool) => currentPolicy.terminalActionToolNames.has(tool.name))
        : currentPolicy.tools;
      const roundToolMap = new Map(roundTools.map((tool) => [tool.name, tool]));
      const roundToolDefs = roundTools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      const policyInstruction = currentPolicy.instruction?.trim();
      if (policyInstruction) {
        chatMessages.push({ role: 'system', content: policyInstruction });
      }
      const bodyBase = {
        model,
        messages: chatMessages,
        tools: roundToolDefs,
        // When the host has narrowed the next V2 action to one execution or
        // host terminal control, make that contract native rather than hoping
        // the model follows prose. The tool itself still validates opaque IDs
        // and only freezes after authorization.
        tool_choice: dynamicToolPolicy && currentPolicy.terminalActionToolNames.size === 1
          ? { type: 'function' as const, function: { name: [...currentPolicy.terminalActionToolNames][0]! } }
          : 'auto',
        ...openaiReasoning(model, options),
      };
      const body: Record<string, unknown> = {
        ...bodyBase,
        [useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: completionTokenBudget,
      };
      if (includeTemperature) body.temperature = options.temperature ?? 0.2;

      let res: Response;
      try {
        res = await send(body);
      } catch (error) {
        const terminal = nativeToolLoopStopForError(error, toolCallsUsed);
        if (terminal) return terminal;
        throw error;
      }
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
      if (!message.toolCalls.length) {
        // Prose in the narration phase is the narration the host asked for.
        if (dynamicToolPolicy && message.content && await adoptProseAsFinishNarration(
          options,
          tools,
          { allowedToolNames: new Set(currentPolicy.tools.map((tool) => tool.name)), terminalActionToolNames: currentPolicy.terminalActionToolNames },
          message.content,
        )) {
          toolCallsUsed += 1;
          return message.content;
        }
        // A no-tool/prose reply cannot escape a host-required V2 action.
        // Discard it and re-dispatch while a physical controller send remains.
        if (dynamicToolPolicy && currentPolicy.terminalActionToolNames.size > 0) {
          // A final admitted send that returns prose has no physical retry
          // left. Keep it a dispatch-budget terminal so the V2 lane can
          // preserve an already validated result with deterministic facts;
          // only two ignored narrowed actions are an invalid tool response.
          if (dispatches >= dispatchLimit) {
            return nativeToolLoopStop('provider_dispatch_budget_exhausted', '', toolCallsUsed);
          }
          if (requiredActionProseRetries >= 1) {
            return nativeToolLoopStop('invalid_tool_response', '', toolCallsUsed);
          }
          requiredActionProseRetries += 1;
          chatMessages.push({
            role: 'user',
            content: `Controller progression required. Call exactly one of: ${[...currentPolicy.terminalActionToolNames].join(', ')}. Do not answer in prose.`,
          });
          continue;
        }
        if (message.content) lastText = message.content;
        return message.content ?? lastText;
      }
      if (message.content) lastText = message.content;
      const roundToolBudget = terminalActionRound ? ordinaryToolBudget + 1 : ordinaryToolBudget;
      const invalidTerminalAction = terminalActionRound && (
        message.toolCalls.length !== 1 || !currentPolicy.terminalActionToolNames.has(message.toolCalls[0]!.name)
      );
      if (invalidTerminalAction || toolCallsUsed + message.toolCalls.length > roundToolBudget) {
        options.onToolCall?.({
          name: 'tool_budget_exhausted',
          input: {
            requestedToolCalls: message.toolCalls.map((call) => call.name),
            maxToolCalls: roundToolBudget,
            toolCallsUsed,
          },
          output: { error: `Tool-call budget exhausted after ${toolCallsUsed} call(s).` },
          isError: true,
        });
        if (dynamicToolPolicy) {
          return nativeToolLoopStop('tool_budget_exhausted', '', toolCallsUsed);
        }
        // Graceful final turn: ask the model to answer NOW from what the prior tool
        // calls already returned — with `tools`/`tool_choice` OMITTED so it cannot
        // request another tool and the loop is guaranteed to terminate.
        chatMessages.push({
          role: 'user',
          content: 'Tool budget reached — do not call any more tools. Answer now using only the information the tool calls above already returned, following the required output format.',
        });
        try {
          const finalText = await forcedFinal();
          if (finalText) return finalText;
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
        const tool = roundToolMap.get(call.name) ?? (dynamicToolPolicy ? undefined : toolMap.get(call.name));
        const args = parseToolArguments(call.argumentsJson);
        let output: unknown;
        let isError = false;
        let deadlineStop: NativeToolLoopResult | undefined;
        const toolStartedAt = Date.now();
        if (!tool) {
          output = { error: `Unknown tool: ${call.name}` };
          isError = true;
        } else {
          try {
            assertMayStartToolCall(options, call.name);
            output = await tool.run(args);
          } catch (err) {
            const code = toolLoopErrorCode(err);
            output = {
              error: err instanceof Error ? err.message : String(err),
              ...(code ? { code } : {}),
            };
            isError = true;
            deadlineStop = nativeToolLoopStopForError(err, toolCallsUsed);
          }
        }
        options.onToolCall?.({ name: call.name, input: args, output, isError, durationMs: Date.now() - toolStartedAt });
        if (deadlineStop) return deadlineStop;
        chatMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: compactToolOutput(output),
        });
        // A completed Ask V2 host control already contains the answer or
        // stable clarification. A rejected control has no `finished` marker
        // and must instead become the next controller observation.
        if (isAskV2TerminalControlTool(call.name) && !isError && isFinishedToolOutput(output)) {
          return message.content ?? lastText;
        }
      }
      if (terminalActionRound) {
        const terminalCall = message.toolCalls[0];
        if (terminalCall && isAskV2TerminalControlTool(terminalCall.name)) {
          // A valid control already returned above. A denied/unfinished
          // control has spent the final action send and must retain a typed
          // budget/progression terminal rather than masquerading as prose.
          return nativeToolLoopStop('tool_budget_exhausted', '', toolCallsUsed);
        }
        // A terminal *execution* action only ends discovery. The live V2
        // policy now requires finish_answer on the reserved narration send;
        // returning here would drop a validated result or turn it into prose.
        if (reservePostExecutionNarration) continue;
        return message.content ?? lastText;
      }
      // A live Ask V2 policy reserves the final physical send for one
      // controller-selected terminal action.  The old two-turn shortcut
      // would otherwise turn that reserved action into prose before the
      // model can invoke it.
      if (dispatchLimit <= 2 && !dynamicToolPolicy) {
        try {
          const finalText = await forcedFinal();
          return finalText || lastText || JSON.stringify({
            summary: 'The provider did not return a final answer within the bounded tool round.',
          });
        } catch (error) {
          if (error && typeof error === 'object'
            && (error as { code?: unknown }).code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') {
            throw error;
          }
          return lastText || JSON.stringify({
            summary: 'The provider dispatch budget was exhausted before a final answer.',
          });
        }
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
    const body = {
      model: options.model ?? this.defaultModel,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.2,
      stream: true,
      ...openaiReasoning(options.model ?? this.defaultModel, options),
    };
    const res = await fetchProviderHttpDispatch({
      provider: this.name,
      operation: 'generate_stream',
      attemptIndex: 1,
      envelope: body,
      options,
      url: `${this.baseUrl}/chat/completions`,
      init: {
        method: 'POST',
        headers,
        signal: options.signal,
      },
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

function assertMayStartToolCall(options: ProviderToolLoopOptions, toolName?: string): void {
  // finish_answer is host-local terminal control after an already admitted
  // provider response; it must not be treated as a fresh discovery branch.
  if (toolName === 'finish_answer') return;
  if (options.mayStartToolCall?.() === false) {
    throw Object.assign(new Error('The run soft target elapsed before this tool branch could start.'), {
      code: 'RUN_SOFT_TARGET_EXCEEDED',
    });
  }
}

function isFinishedToolOutput(value: unknown): boolean {
  return Boolean(value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { finished?: unknown }).finished === true);
}

function isAskV2TerminalControlTool(name: string): boolean {
  return name === 'finish_answer' || name === 'request_clarification';
}

function nativeToolLoopStop(
  kind: NativeToolLoopStop['kind'],
  text: string,
  toolCalls: number,
): NativeToolLoopResult {
  return { version: 1, kind, text, toolCalls };
}

function toolLoopErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' ? code : undefined;
}

function nativeToolLoopStopForError(error: unknown, toolCalls: number): NativeToolLoopResult | undefined {
  const code = toolLoopErrorCode(error);
  if (code === 'RUN_SOFT_TARGET_EXCEEDED') {
    return nativeToolLoopStop('run_soft_target_exceeded', '', toolCalls);
  }
  if (code === 'RUN_DEADLINE_INSUFFICIENT') {
    return nativeToolLoopStop('run_deadline_insufficient', '', toolCalls);
  }
  if (code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') {
    return nativeToolLoopStop('provider_dispatch_budget_exhausted', '', toolCalls);
  }
  return undefined;
}

/** Resolve the host's current V2 policy immediately before a native send. */
function nativeToolPolicy(
  options: ProviderToolLoopOptions,
  tools: readonly AgentToolDefinition[],
): { tools: AgentToolDefinition[]; terminalActionToolNames: Set<string>; instruction?: string } {
  const policy = options.getCurrentToolPolicy?.();
  const allowed = new Set(policy?.allowedToolNames ?? tools.map((tool) => tool.name));
  const enabled = tools.filter((tool) => allowed.has(tool.name));
  return {
    tools: enabled,
    terminalActionToolNames: new Set((policy?.terminalActionToolNames ?? []).filter((name) => allowed.has(name))),
    ...(policy?.instruction?.trim() ? { instruction: policy.instruction.trim() } : {}),
  };
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
