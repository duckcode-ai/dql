import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DQLContext, findProjectRoot } from '@duckcodeailabs/dql-mcp';
import type { AgentRunRequest, AgentRunner, AgentTurn, BlockProposal } from './types.js';
import { buildAgentTools, type AgentTool } from './tools.js';

const MODEL = 'claude-opus-4-7';
const MAX_TOOL_ITERATIONS = 16;

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicThinkingBlock = { type: 'thinking'; thinking: string };
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type AnthropicBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock | { type: string };

interface AnthropicResponse {
  id: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
}

interface AnthropicClient {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicResponse>;
  };
}

function loadApiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (process.env.DQL_LLM_KEY) return process.env.DQL_LLM_KEY;
  const credPath = join(homedir(), '.dql', 'credentials');
  if (!existsSync(credPath)) return null;
  try {
    const content = readFileSync(credPath, 'utf-8');
    const match = content.match(/^\s*anthropic\s*=\s*"?([^"\n]+)"?/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function loadAnthropic(): Promise<AnthropicClient | { error: string }> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    return {
      error:
        'No Anthropic API key found. Set ANTHROPIC_API_KEY, or add `anthropic = "sk-..."` to ~/.dql/credentials.',
    };
  }
  try {
    const mod = (await import('@anthropic-ai/sdk' as string)) as unknown as {
      default?: new (o: { apiKey: string }) => AnthropicClient;
      Anthropic?: new (o: { apiKey: string }) => AnthropicClient;
    };
    const Ctor = mod.default ?? mod.Anthropic;
    if (!Ctor) return { error: '@anthropic-ai/sdk is installed but does not export a client.' };
    return new Ctor({ apiKey });
  } catch {
    return {
      error:
        '@anthropic-ai/sdk is not installed. Run `pnpm add -w @anthropic-ai/sdk` to enable the Claude Agent SDK provider, or switch to the Claude Code provider.',
    };
  }
}

function systemPrompt(ctx: DQLContext, upstreamSql?: string): string {
  const domains = Array.from(new Set(Object.values(ctx.manifest.blocks).map((b) => b.domain).filter(Boolean))).sort();
  const metricCount = ctx.semanticLayer.listMetrics().length;
  const dimensionCount = ctx.semanticLayer.listDimensions().length;
  return [
    'You are the DQL authoring agent. Your job is to help the analyst turn a business question into a certified, governed DQL block.',
    '',
    'Always ground answers in existing blocks, semantic metrics, and dimensions — do not invent SQL from scratch without checking what already exists. Use the provided tools:',
    '- search_blocks: find existing blocks before writing new ones.',
    '- get_block: inspect a block\'s SQL, dependencies, and lineage.',
    '- list_metrics / list_dimensions: enumerate the semantic layer.',
    '- lineage_impact: understand upstream/downstream blast radius.',
    '- certify: check governance rules against a proposed block.',
    '- suggest_block: END of turn — write a reviewable draft to blocks/_drafts/ once the user is ready.',
    '',
    'When the conversation has produced a concrete block design, call `suggest_block` with all required fields (name, domain, owner, description, sql). The response includes a governance gate — if it fails, refine and retry.',
    '',
    `Project context: ${Object.keys(ctx.manifest.blocks).length} blocks, ${metricCount} metrics, ${dimensionCount} dimensions. Domains: ${domains.join(', ') || '(none yet)'}.`,
    upstreamSql ? `The user is authoring a cell with this upstream SQL:\n\`\`\`sql\n${upstreamSql}\n\`\`\`` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function runToolLoop(
  client: AnthropicClient,
  tools: AgentTool[],
  system: string,
  initialMessages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
  emit: (turn: AgentTurn) => void,
  signal: AbortSignal,
): Promise<void> {
  const messages = [...initialMessages];
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (signal.aborted) {
      emit({ kind: 'error', message: 'Aborted by user.' });
      return;
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
      system,
      tools: toolDefs,
      messages,
    });

    const toolUses: AnthropicToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'thinking') emit({ kind: 'thinking', text: (block as AnthropicThinkingBlock).thinking });
      else if (block.type === 'text') emit({ kind: 'text', text: (block as AnthropicTextBlock).text });
      else if (block.type === 'tool_use') {
        const tu = block as AnthropicToolUseBlock;
        toolUses.push(tu);
        emit({ kind: 'tool_call', id: tu.id, name: tu.name, input: tu.input });
      }
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      emit({ kind: 'done', stopReason: response.stop_reason ?? undefined });
      return;
    }

    const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
    for (const tu of toolUses) {
      const tool = tools.find((t) => t.name === tu.name);
      let output: unknown;
      let isError = false;
      if (!tool) {
        output = { error: `Unknown tool: ${tu.name}` };
        isError = true;
      } else {
        try {
          output = await tool.run(tu.input);
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
          isError = true;
        }
      }
      emit({ kind: 'tool_result', id: tu.id, output, isError });

      if (tu.name === 'suggest_block') emitProposal(tu.input, output, emit);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(output), is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }

  emit({ kind: 'error', message: `Tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations.` });
}

function emitProposal(input: unknown, output: unknown, emit: (turn: AgentTurn) => void): void {
  if (!input || typeof input !== 'object') return;
  const p = input as Partial<BlockProposal>;
  if (!p.name || !p.sql) return;
  const proposal: BlockProposal = {
    name: String(p.name),
    domain: String(p.domain ?? ''),
    owner: String(p.owner ?? ''),
    description: String(p.description ?? ''),
    sql: String(p.sql),
    tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
    chartType: typeof p.chartType === 'string' ? p.chartType : undefined,
  };
  const out = (output ?? {}) as { certified?: boolean; errors?: string[]; warnings?: string[] };
  emit({
    kind: 'proposal',
    proposal,
    governance: {
      certified: Boolean(out.certified),
      errors: Array.isArray(out.errors) ? out.errors.map(String) : [],
      warnings: Array.isArray(out.warnings) ? out.warnings.map(String) : [],
    },
  });
}

export const claudeAgentSdkRunner: AgentRunner = {
  async run(req: AgentRunRequest, emit, signal) {
    const client = await loadAnthropic();
    if ('error' in client) {
      emit({ kind: 'error', message: client.error });
      return;
    }
    const ctx = new DQLContext({ projectRoot: findProjectRoot(req.projectRoot) });
    const tools = buildAgentTools(ctx);
    const system = systemPrompt(ctx, req.upstream?.sql);
    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    try {
      await runToolLoop(client, tools, system, messages, emit, signal);
    } catch (err) {
      emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  },
};
