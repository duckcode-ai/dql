import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunRequest, AgentRunner, AgentTurn, BlockProposal } from './types.js';

/**
 * `claude-code` provider: spawns the `claude` CLI in headless print mode and
 * connects it to DQL's stdio MCP server via `--mcp-config`. Requires the user
 * to have `claude` on PATH — no API key needed (Claude Code uses its own auth).
 */
export const claudeCodeRunner: AgentRunner = {
  async run(req: AgentRunRequest, emit, signal) {
    const tempDir = mkdtempSync(join(tmpdir(), 'dql-claude-'));
    const mcpConfigPath = join(tempDir, 'mcp.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          dql: { command: 'dql', args: ['mcp'], cwd: req.projectRoot },
        },
      }),
    );

    const prompt = buildPrompt(req);
    const child = spawn(
      'claude',
      [
        '-p',
        prompt,
        '--mcp-config',
        mcpConfigPath,
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        'mcp__dql__search_blocks mcp__dql__get_block mcp__dql__list_metrics mcp__dql__list_dimensions mcp__dql__lineage_impact mcp__dql__certify mcp__dql__suggest_block',
      ],
      { cwd: req.projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const cleanup = () => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
    };

    signal.addEventListener('abort', () => child.kill('SIGTERM'));

    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    const toolNameById = new Map<string, string>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          mapClaudeCodeEvent(event, emit, toolNameById);
        } catch {
          /* skip non-JSON lines */
        }
      }
    });

    return new Promise<void>((resolve) => {
      child.on('error', (err) => {
        emit({
          kind: 'error',
          message:
            `Failed to spawn 'claude': ${err.message}. Install Claude Code (https://claude.com/claude-code) or switch to the Claude Agent SDK provider.`,
        });
        cleanup();
        resolve();
      });
      child.on('close', (code) => {
        if (code !== 0) {
          const detail = stderr.join('').trim();
          emit({ kind: 'error', message: `claude exited with code ${code}${detail ? `: ${detail}` : ''}` });
        }
        emit({ kind: 'done' });
        cleanup();
        resolve();
      });
    });
  },
};

function buildPrompt(req: AgentRunRequest): string {
  const history = req.messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  const upstream = req.upstream?.sql
    ? `\n\nThe user is authoring a notebook cell with this upstream SQL:\n\`\`\`sql\n${req.upstream.sql}\n\`\`\`\n`
    : '';
  return [
    'You are the DQL authoring agent. Ground every answer in existing DQL blocks, metrics, and dimensions. Use the mcp__dql__* tools to search, inspect, and ultimately propose a new block.',
    '',
    'When the user is ready for a concrete block, call mcp__dql__suggest_block with name, domain, owner, description, and sql. The response returns governance-gate results.',
    upstream,
    '',
    history,
  ].join('\n');
}

function mapClaudeCodeEvent(
  event: Record<string, unknown>,
  emit: (turn: AgentTurn) => void,
  toolNameById: Map<string, string>,
): void {
  const type = event.type;
  if (type === 'assistant') {
    const message = event.message as { content?: unknown[] } | undefined;
    for (const block of message?.content ?? []) {
      const b = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && b.text) emit({ kind: 'text', text: b.text });
      else if (b.type === 'thinking' && b.thinking) emit({ kind: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use' && b.id && b.name) {
        const short = stripMcpPrefix(b.name);
        toolNameById.set(b.id, short);
        emit({ kind: 'tool_call', id: b.id, name: short, input: b.input ?? {} });
      }
    }
    return;
  }
  if (type === 'user') {
    const message = event.message as { content?: unknown[] } | undefined;
    for (const block of message?.content ?? []) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type === 'tool_result' && b.tool_use_id) {
        const output = parseToolOutput(b.content);
        emit({ kind: 'tool_result', id: b.tool_use_id, output, isError: Boolean(b.is_error) });
        if (toolNameById.get(b.tool_use_id) === 'suggest_block') emitProposalFromResult(output, emit);
      }
    }
  }
}

function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__dql__/, '');
}

function parseToolOutput(content: unknown): unknown {
  if (typeof content === 'string') {
    try { return JSON.parse(content); } catch { return content; }
  }
  if (Array.isArray(content)) {
    const text = content.map((c) => (c as { text?: string }).text ?? '').join('');
    try { return JSON.parse(text); } catch { return text; }
  }
  return content;
}

function emitProposalFromResult(output: unknown, emit: (turn: AgentTurn) => void): void {
  if (!output || typeof output !== 'object') return;
  const o = output as { name?: string; path?: string; certified?: boolean; errors?: string[]; warnings?: string[] };
  if (!o.name || !o.path) return;
  const proposal: BlockProposal = {
    name: String(o.name),
    domain: '',
    owner: '',
    description: '',
    sql: '',
  };
  emit({
    kind: 'proposal',
    proposal,
    governance: {
      certified: Boolean(o.certified),
      errors: Array.isArray(o.errors) ? o.errors.map(String) : [],
      warnings: Array.isArray(o.warnings) ? o.warnings.map(String) : [],
    },
  });
}
