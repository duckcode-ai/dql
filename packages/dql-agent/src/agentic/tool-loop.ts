/**
 * Transport-agnostic agentic tool loop.
 *
 * Stage B of the answer pipeline is a SINGLE tool-driven generation call: one
 * capable model decides its own retrieval sequence (search blocks → semantic
 * layer → schema → compile/validate → run) instead of walking a fixed tier
 * cascade. This module runs that loop over ANY provider:
 *
 *   - Providers with native tool use (`generateWithTools`: Claude/OpenAI APIs)
 *     drive the loop through the provider's own tool protocol.
 *   - Providers with only `generate` (subscription CLI passthrough, Ollama, …)
 *     drive an equivalent loop over a TEXT protocol: the model emits one fenced
 *     JSON tool call per turn, the host executes it and appends the observation,
 *     then re-invokes. A malformed / absent tool call is treated as the final
 *     answer, so a weak-tool-calling model degrades to "answer from context now"
 *     rather than dead-ending.
 *
 * Governance is NOT enforced here — it lives in the tool backends (the semantic
 * compiler owns semantic SQL, certified execution keeps its grain gate, run_sql
 * is read-only). This module only orchestrates the conversation.
 */

import type {
  AgentMessage,
  AgentProvider,
  AgentToolDefinition,
  ProviderToolLoopOptions,
} from '../providers/types.js';
import { assertProviderPayloadAllowed, boundProviderResultRows } from '../provider-egress.js';

export interface AgenticToolLoopOptions extends ProviderToolLoopOptions {
  /**
   * Extra system guidance appended before the tool contract (e.g. "prefer
   * semantic compile before deep warehouse search"). Applies to both transports.
   */
  toolPolicy?: string;
}

/**
 * Run the agentic tool loop and return the model's final assistant text. Tool
 * observations are surfaced through `options.onToolCall` (same contract the native
 * providers already use), so callers can record evidence regardless of transport.
 */
export async function runAgenticToolLoop(
  provider: AgentProvider,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  options: AgenticToolLoopOptions = {},
): Promise<string> {
  return (await runAgenticToolLoopDetailed(provider, messages, tools, options)).text;
}

/**
 * Run the agentic loop while retaining its terminal reason for internal
 * callers. The public `runAgenticToolLoop` compatibility API remains a string,
 * but an analytical caller must not mistake a budget-stopped tool request for
 * final SQL.
 */
export async function runAgenticToolLoopDetailed(
  provider: AgentProvider,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  options: AgenticToolLoopOptions = {},
): Promise<TextToolLoopResult> {
  const resultRowBudgetUsage = new Map<string, number>();
  const usable = tools
    .filter((tool) => tool.name && tool.description)
    .map((tool) => guardToolOutput(tool, options, resultRowBudgetUsage));
  const policyMessages: AgentMessage[] = options.toolPolicy
    ? [{ role: 'system', content: options.toolPolicy }]
    : [];

  if (usable.length === 0) {
    try {
      return { text: await provider.generate([...messages, ...policyMessages], options), stop: 'final', toolCalls: 0 };
    } catch (error) {
      const terminal = providerDispatchTerminal(error);
      if (terminal) return terminal;
      throw error;
    }
  }

  // Native tool use owns its own loop; hand it the same policy + tools.
  if (provider.generateWithTools) {
    try {
      return {
        text: await provider.generateWithTools([...messages, ...policyMessages], usable, options),
        stop: 'final',
        toolCalls: 0,
      };
    } catch (error) {
      const terminal = providerDispatchTerminal(error);
      if (terminal) return terminal;
      throw error;
    }
  }

  return runTextProtocolToolLoopDetailed(provider, [...messages, ...policyMessages], usable, options);
}

/**
 * Internal terminal state for the text transport.
 *
 * The public compatibility API above intentionally remains `Promise<string>`:
 * callers outside the analyst lane use it as a normal completion helper.  The
 * text transport itself must not, however, confuse "the model asked for a
 * tool after its budget" with a normal final answer.  Keeping that distinction
 * here makes a caller able to turn it into a typed, non-executing outcome.
 */
export interface TextToolLoopResult {
  text: string;
  stop: 'final' | 'tool_budget_exhausted' | 'provider_dispatch_budget_exhausted';
  toolCalls: number;
}

function providerDispatchTerminal(error: unknown): TextToolLoopResult | undefined {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED'
    ? { text: '', stop: 'provider_dispatch_budget_exhausted', toolCalls: 0 }
    : undefined;
}

function guardToolOutput(
  tool: AgentToolDefinition,
  options: AgenticToolLoopOptions,
  resultRowBudgetUsage: Map<string, number>,
): AgentToolDefinition {
  const policy = options.providerPayloadGuard;
  if (!policy) return tool;
  return {
    ...tool,
    run: async (args) => {
      const output = await tool.run(args);
      const maxResultRows = policy.allowedResultRowTools?.[tool.name] ?? 0;
      const budgetGroup = policy.resultRowBudgetGroupByTool?.[tool.name] ?? tool.name;
      const cumulativeLimit = policy.cumulativeResultRowBudgets?.[budgetGroup] ?? maxResultRows;
      const alreadyUsed = resultRowBudgetUsage.get(budgetGroup) ?? 0;
      const bounded = boundProviderResultRows(output, Math.max(0, cumulativeLimit - alreadyUsed));
      const shape = assertProviderPayloadAllowed(bounded.value, {
        allowResultRows: maxResultRows > 0,
        maxResultRows: Math.max(0, cumulativeLimit - alreadyUsed),
        purpose: policy.purpose,
      });
      const cumulativeResultRowCount = alreadyUsed + shape.resultRowCount;
      resultRowBudgetUsage.set(budgetGroup, cumulativeResultRowCount);
      policy.onPayload?.({
        toolName: tool.name,
        output: bounded.value,
        ...shape,
        cumulativeResultRowCount,
        budgetGroup,
        budgetExhausted: bounded.exhausted || cumulativeResultRowCount >= cumulativeLimit,
      });
      return bounded.value;
    },
  };
}

/**
 * Text-only providers do not have a server-side tool protocol, so DQL drives a
 * real bounded conversation: model -> one tool -> observation -> model.  One
 * physical dispatch is always reserved for a final answer.  This mirrors native
 * tool use and prevents the old one-tool implementation from collecting schema
 * evidence and then forcing a premature, SQL-less completion.
 */
export async function runTextProtocolToolLoopDetailed(
  provider: AgentProvider,
  baseMessages: AgentMessage[],
  tools: AgentToolDefinition[],
  options: AgenticToolLoopOptions,
): Promise<TextToolLoopResult> {
  const maxToolCalls = Math.max(0, Math.min(30, options.maxToolCalls ?? 8));
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  // Preserve the complete transport contract across both text-protocol turns.
  // Reconstructing a small options subset silently dropped the physical-send
  // observer, dispatch cap, redaction guard, and egress accounting for CLI and
  // Ollama providers.
  // A tool turn without a following answer is not useful.  When callers do
  // not set a dispatch cap, make room for every permitted tool plus the final
  // composition turn.  When they do set one, reserve its last slot for that
  // composition instead of silently spending it on another observation.
  const dispatchLimit = Math.max(1, Math.min(30, options.maxProviderDispatches ?? (maxToolCalls + 1)));
  const effectiveToolBudget = Math.min(maxToolCalls, Math.max(0, dispatchLimit - 1));
  let physicalDispatches = 0;
  const outerObserver = options.onProviderDispatch;
  const runOptions: ProviderToolLoopOptions = {
    ...options,
    onProviderDispatch: (event) => {
      physicalDispatches += 1;
      if (physicalDispatches > dispatchLimit) {
        throw Object.assign(new Error(
          `Provider dispatch budget exhausted after ${dispatchLimit} physical attempt${dispatchLimit === 1 ? '' : 's'}.`,
        ), { code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' });
      }
      return outerObserver?.(event) ?? event.envelope;
    },
  };

  const messages: AgentMessage[] = [
    ...baseMessages,
    // Tell the model the *effective* ceiling, not a larger policy cap that
    // cannot physically leave room for its final response.
    { role: 'system', content: buildTextToolContract(tools, effectiveToolBudget) },
  ];

  let lastText = '';
  let toolCalls = 0;
  while (true) {
    let text: string;
    try {
      text = await provider.generate(messages, runOptions);
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') {
        return { text: lastText, stop: 'provider_dispatch_budget_exhausted', toolCalls };
      }
      throw error;
    }
    if (text.trim()) lastText = text;
    const requestedCall = parseTextToolCall(text);
    if (!requestedCall) return { text: text || lastText, stop: 'final', toolCalls };
    // A tool-shaped reply is not a final answer merely because the host has no
    // dispatch left for another observation. Keep this typed distinction so a
    // caller cannot mistake it for executable SQL or prose.
    if (toolCalls >= effectiveToolBudget) {
      return { text: text || lastText, stop: 'tool_budget_exhausted', toolCalls };
    }
    const call = requestedCall;

    const tool = toolMap.get(call.name);
    let output: unknown;
    let isError = false;
    const startedAt = Date.now();
    if (!tool) {
      output = { error: `Unknown tool: ${call.name}. Available: ${tools.map((t) => t.name).join(', ')}` };
      isError = true;
    } else {
      try {
        assertMayStartToolCall(options);
        output = await tool.run(call.input ?? {});
      } catch (err) {
        output = { error: err instanceof Error ? err.message : String(err) };
        isError = true;
      }
    }
    toolCalls += 1;
    options.onToolCall?.({ name: call.name, input: call.input, output, isError, durationMs: Date.now() - startedAt });
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: renderObservation(call.name, output) });

    if (toolCalls >= effectiveToolBudget) {
      messages.push({
        role: 'user',
        content: 'Tool budget reached — do not call any more tools. Answer now using only the tool results above, as a single ```json fenced object with summary, sql, viz, outputs.',
      });
      // The next iteration is the reserved final dispatch.  If the model
      // nevertheless emits a tool shape, `call` is deliberately disabled and
      // the caller receives that text as a typed terminal, not an execution.
      const finalText = await provider.generate(messages, runOptions).catch((error: unknown) => {
        const code = error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') return '';
        throw error;
      });
      if (!finalText.trim()) {
        return {
          text: lastText,
          stop: 'provider_dispatch_budget_exhausted',
          toolCalls,
        };
      }
      return {
        text: finalText,
        stop: parseTextToolCall(finalText) ? 'tool_budget_exhausted' : 'final',
        toolCalls,
      };
    }
  }
}

function assertMayStartToolCall(options: ProviderToolLoopOptions): void {
  if (options.mayStartToolCall?.() === false) {
    throw Object.assign(new Error('The run soft target elapsed before this tool branch could start.'), {
      code: 'RUN_SOFT_TARGET_EXCEEDED',
    });
  }
}

interface TextToolCall {
  name: string;
  input?: Record<string, unknown>;
}

/**
 * Parse a text-protocol tool call. A tool call is a JSON object with a `tool`
 * (string) field, optionally in a ```json fence. Anything else — prose, or a JSON
 * object WITHOUT `tool` (i.e. a final `{summary, sql, ...}` answer) — returns
 * undefined so the caller treats the response as the final answer.
 */
export function parseTextToolCall(raw: string): TextToolCall | undefined {
  for (const candidate of jsonCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const name = typeof record.tool === 'string' ? record.tool
      : typeof record.tool_name === 'string' ? record.tool_name
      : typeof record.name === 'string' && ('input' in record || 'arguments' in record || 'args' in record) ? record.name
      : undefined;
    if (!name) continue;
    const rawInput = record.input ?? record.arguments ?? record.args ?? record.parameters;
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined;
    return { name, input };
  }
  return undefined;
}

/** Candidate JSON strings from a model response: fenced blocks first, then a bare object. */
function jsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of raw.matchAll(fenceRe)) {
    const body = match[1]?.trim();
    if (body) out.push(body);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) out.push(trimmed);
  // A bare object embedded in prose (first { … last }).
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) out.push(raw.slice(first, last + 1));
  return out;
}

function renderObservation(name: string, output: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(output);
  } catch {
    body = String(output);
  }
  // Bound the observation so a large tool result can't blow the context window.
  if (body.length > 8000) body = `${body.slice(0, 8000)}… (truncated)`;
  return `Observation from ${name}:\n\`\`\`json\n${body}\n\`\`\``;
}

function buildTextToolContract(tools: AgentToolDefinition[], maxToolCalls: number): string {
  const toolLines = tools.map((tool) => {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const params = props ? Object.keys(props).join(', ') : '';
    return `- ${tool.name}(${params}): ${tool.description}`;
  });
  return [
    'You can call tools to gather grounded context before answering. On EACH turn respond with EXACTLY ONE of:',
    '',
    '1. A tool call — a single ```json fenced object: {"tool": "<name>", "input": { ... }}',
    '2. Your FINAL answer — a single ```json fenced object: {"summary": "...", "sql": "...", "viz": "...", "outputs": ["..."]}',
    '',
    'Rules:',
    `- You may make at most ${maxToolCalls} tool call(s). Stop searching as soon as you can answer.`,
    '- Prefer compiling a governed semantic query (compile_semantic_query) over hand-writing SQL when the semantic layer covers the metric/dimensions.',
    '- Only reference relations and columns you have confirmed via a tool. Do not invent tables.',
    '- Never wrap a tool call and a final answer in the same message.',
    '',
    'Available tools:',
    ...toolLines,
  ].join('\n');
}
