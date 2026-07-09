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
  const usable = tools.filter((tool) => tool.name && tool.description);
  const policyMessages: AgentMessage[] = options.toolPolicy
    ? [{ role: 'system', content: options.toolPolicy }]
    : [];

  if (usable.length === 0) {
    return provider.generate([...messages, ...policyMessages], options);
  }

  // Native tool use owns its own loop; hand it the same policy + tools.
  if (provider.generateWithTools) {
    return provider.generateWithTools([...messages, ...policyMessages], usable, options);
  }

  return runTextProtocolToolLoop(provider, [...messages, ...policyMessages], usable, options);
}

/**
 * Text-protocol ReAct loop for providers without native tool use. The model
 * chooses ONE action per turn: call a tool, or emit the final answer. We parse its
 * JSON, execute, feed back an observation, and repeat until it answers or the tool
 * budget is spent.
 */
async function runTextProtocolToolLoop(
  provider: AgentProvider,
  baseMessages: AgentMessage[],
  tools: AgentToolDefinition[],
  options: AgenticToolLoopOptions,
): Promise<string> {
  const maxToolCalls = Math.max(0, Math.min(30, options.maxToolCalls ?? 8));
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const runOptions = { signal: options.signal, reasoningEffort: options.reasoningEffort, model: options.model };

  const messages: AgentMessage[] = [
    ...baseMessages,
    { role: 'system', content: buildTextToolContract(tools, maxToolCalls) },
  ];

  let toolCallsUsed = 0;
  let lastText = '';
  while (toolCallsUsed < maxToolCalls) {
    const text = await provider.generate(messages, runOptions);
    if (text.trim()) lastText = text;
    const call = parseTextToolCall(text);
    if (!call) return text || lastText; // final answer (or unparseable → treat as final)

    const tool = toolMap.get(call.name);
    toolCallsUsed += 1;
    let output: unknown;
    let isError = false;
    if (!tool) {
      output = { error: `Unknown tool: ${call.name}. Available: ${tools.map((t) => t.name).join(', ')}` };
      isError = true;
    } else {
      try {
        output = await tool.run(call.input ?? {});
      } catch (err) {
        output = { error: err instanceof Error ? err.message : String(err) };
        isError = true;
      }
    }
    options.onToolCall?.({ name: call.name, input: call.input, output, isError });

    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: renderObservation(call.name, output) });
  }

  // Budget spent: force a final answer with the tool contract omitted so the model
  // cannot request another tool and the loop is guaranteed to terminate.
  messages.push({
    role: 'user',
    content: 'Tool budget reached — do not call any more tools. Answer now using only the tool results above, as a single ```json fenced object with summary, sql, viz, outputs.',
  });
  const finalText = await provider.generate(messages, runOptions).catch(() => '');
  return finalText.trim() ? finalText : lastText;
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
