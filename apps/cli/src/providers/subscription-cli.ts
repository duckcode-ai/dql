/**
 * Subscription-backed providers — use an installed agentic coding CLI (Claude Code,
 * Codex) as a plain text-completion backend, authenticated by the user's *login*
 * rather than an API key.
 *
 * The value: a user with a Claude Pro/Max or ChatGPT Plus/Pro subscription can power
 * DQL's AI without pasting an API key. There is no "subscription API key" — the only
 * sanctioned path is to shell out to the vendor's own client, which owns the OAuth
 * login. We constrain each CLI to behave as a one-shot text generator (no tools, no
 * file access, isolated cwd, neutral system prompt) so it slots into the existing
 * {@link AgentProvider} interface and every downstream flow (routing, synthesis,
 * conversation) works unchanged.
 *
 * Tradeoffs the caller should know: each call spawns a fresh CLI process (seconds of
 * cold-start latency), and — for Claude — programmatic usage draws from the plan's
 * Agent-SDK credit, then standard API rates, not the interactive chat pool.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, AgentProvider, ProviderName, ProviderRunOptions } from '@duckcodeailabs/dql-agent';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  timedOut?: boolean;
}

interface RunOptions {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Spawn a process, optionally feed stdin, and collect stdout/stderr. Never throws. */
function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult) => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ code: null, stdout: '', stderr: '', spawnError: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* noop */ }
          forceKillTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* noop */ }
          }, 2_000);
        }, options.timeoutMs)
      : undefined;
    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* noop */ } };
    options.signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
      finish({ code: null, stdout: stdout.join(''), stderr: stderr.join(''), spawnError: error, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
      finish({ code, stdout: stdout.join(''), stderr: stderr.join(''), timedOut });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Surface a fired AbortSignal as its own reason (deadline TimeoutError, user AbortError). */
function throwIfAlreadyCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
}

const DEFAULT_SUBSCRIPTION_CLI_TIMEOUT_MS = 60_000;

export function resolveSubscriptionCliTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DQL_SUBSCRIPTION_CLI_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SUBSCRIPTION_CLI_TIMEOUT_MS;
  return Math.max(5_000, Math.min(300_000, Math.floor(configured)));
}

/** Split messages into a single system string and a flattened conversation prompt. */
function flattenMessages(messages: AgentMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system');
  const prompt = convo.length <= 1
    ? (convo[0]?.content ?? '')
    : convo.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  return { system, prompt };
}

/** Detection status surfaced to the UI so users know whether a CLI is usable. */
export interface CliAuthStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  detail?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code (Claude Pro / Max / Team / Enterprise subscription)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Force OAuth-subscription auth: Claude Code's credential precedence puts an API key
 * / gateway token / cloud-provider flags ABOVE the logged-in subscription. Scrubbing
 * them from the child env makes "use my Claude subscription" deterministic.
 */
function claudeSubscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  return env;
}

export class ClaudeCodeCliProvider implements AgentProvider {
  readonly name: ProviderName = 'claude';
  private readonly command: string;
  private readonly defaultModel?: string;

  constructor(opts: { command?: string; model?: string } = {}) {
    this.command = opts.command ?? 'claude';
    this.defaultModel = opts.model;
  }

  /** Installed AND logged in (checked via `claude auth status --json`). */
  async available(): Promise<boolean> {
    const status = await ClaudeCodeCliProvider.detect(this.command);
    return status.installed && status.loggedIn;
  }

  /** Rich detection for the settings UI. */
  static async detect(command = 'claude'): Promise<CliAuthStatus> {
    const res = await runProcess(command, ['auth', 'status', '--json'], { timeoutMs: 8000 });
    if (res.spawnError) return { installed: false, loggedIn: false, detail: 'Claude Code CLI not found on PATH.' };
    try {
      const parsed = JSON.parse(res.stdout.trim()) as {
        loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string;
      };
      return {
        installed: true,
        loggedIn: parsed.loggedIn === true,
        authMethod: parsed.authMethod,
        subscriptionType: parsed.subscriptionType,
        email: parsed.email,
      };
    } catch {
      // Binary present but `auth status --json` shape unknown — treat as installed,
      // login unverified (generate() will surface a clear error if not logged in).
      return { installed: res.code === 0, loggedIn: res.code === 0, detail: res.stderr.trim() || undefined };
    }
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    // A run whose deadline already fired must not spawn a doomed child process.
    throwIfAlreadyCancelled(options.signal);
    const { system, prompt } = flattenMessages(messages);
    const model = options.model ?? this.defaultModel;
    const args = [
      '-p',
      '--output-format', 'json',
      '--tools', '',                    // pure text generation, no tool/file access
      '--max-turns', '1',
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',            // ignore any ambient MCP config
      '--no-session-persistence',
      ...(model ? ['--model', model] : []),
      ...(system ? ['--system-prompt', system] : []),
    ];
    // Isolated cwd so no project CLAUDE.md / .claude settings leak into the completion.
    const cwd = mkdtempSync(join(tmpdir(), 'dql-claude-'));
    try {
      const res = await runProcess(this.command, args, {
        input: prompt,
        cwd,
        env: claudeSubscriptionEnv(),
        // The UI always supplies an AbortSignal. The previous conditional disabled
        // the timeout in exactly that path, so a stalled CLI left Ask spinning
        // forever. User cancellation and the independent hard deadline now both
        // apply.
        timeoutMs: resolveSubscriptionCliTimeoutMs(),
        signal: options.signal,
      });
      // A mid-flight cancellation SIGTERMed the child; surface the exact abort
      // reason (e.g. the run deadline's TimeoutError), never a parse error.
      throwIfAlreadyCancelled(options.signal);
      if (res.timedOut) {
        throw new Error(`Claude Code did not respond within ${Math.round(resolveSubscriptionCliTimeoutMs() / 1_000)} seconds. Retry, choose a faster model, or increase DQL_SUBSCRIPTION_CLI_TIMEOUT_MS.`);
      }
      if (res.spawnError) {
        throw new Error(`Claude Code CLI not found. Install it (https://claude.com/claude-code) and run \`claude /login\`, or switch to an API-key provider. (${res.spawnError.message})`);
      }
      const parsed = parseClaudeResult(res.stdout);
      if (parsed === undefined) {
        throw new Error(`claude did not return a parseable result${res.stderr ? `: ${res.stderr.trim()}` : '.'}`);
      }
      if (parsed.isError) {
        const message = parsed.text || res.stderr.trim() || 'unknown error';
        if (/not logged in|\/login|unauthor/i.test(message)) {
          throw new Error('Claude Code is not logged in. Run `claude /login` with your Claude subscription, then retry.');
        }
        throw new Error(`claude returned an error: ${message}`);
      }
      return parsed.text;
    } finally {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}

/** Parse `claude -p --output-format json` stdout (a single result object). */
export function parseClaudeResult(stdout: string): { text: string; isError: boolean } | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const tryParse = (raw: string): { text: string; isError: boolean } | undefined => {
    try {
      const obj = JSON.parse(raw) as { result?: unknown; is_error?: unknown };
      return { text: typeof obj.result === 'string' ? obj.result : '', isError: obj.is_error === true };
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(trimmed);
  if (whole) return whole;
  // Fallback: last non-empty line that parses as the result object.
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(lines[i]);
    if (parsed) return parsed;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex (ChatGPT Plus / Pro / Team subscription)
// ─────────────────────────────────────────────────────────────────────────────

export class CodexCliProvider implements AgentProvider {
  readonly name: ProviderName = 'openai';
  private readonly command: string;
  private readonly defaultModel?: string;

  constructor(opts: { command?: string; model?: string } = {}) {
    this.command = opts.command ?? 'codex';
    this.defaultModel = opts.model;
  }

  async available(): Promise<boolean> {
    const status = await CodexCliProvider.detect(this.command);
    return status.installed && status.loggedIn;
  }

  /**
   * Detection: binary present + a stored auth file. Codex has no documented
   * non-interactive `login status` command, so we check `~/.codex/auth.json`
   * (written by `codex login` for both ChatGPT-account and API-key auth).
   */
  static async detect(command = 'codex'): Promise<CliAuthStatus> {
    const version = await runProcess(command, ['--version'], { timeoutMs: 8000 });
    if (version.spawnError) return { installed: false, loggedIn: false, detail: 'Codex CLI not found on PATH.' };
    const authPath = join(homedir(), '.codex', 'auth.json');
    const loggedIn = existsSync(authPath);
    return {
      installed: true,
      loggedIn,
      authMethod: loggedIn ? 'chatgpt' : undefined,
      detail: loggedIn ? undefined : 'Run `codex login` to sign in with your ChatGPT plan.',
    };
  }

  async generate(messages: AgentMessage[], options: ProviderRunOptions = {}): Promise<string> {
    // A run whose deadline already fired must not spawn a doomed child process.
    throwIfAlreadyCancelled(options.signal);
    const { system, prompt } = flattenMessages(messages);
    const model = options.model ?? this.defaultModel;
    // Codex exec has no --system-prompt; prepend the system text as a labeled preamble.
    const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
    const cwd = mkdtempSync(join(tmpdir(), 'dql-codex-'));
    const outFile = join(cwd, 'last-message.txt');
    const args = [
      'exec',
      '-',                              // read the prompt from stdin
      '--sandbox', 'read-only',         // no writes / no side effects
      '--skip-git-repo-check',
      '--cd', cwd,
      '--ephemeral',                    // do not persist a session
      '--output-last-message', outFile, // write just the final assistant text
      ...(model ? ['--model', model] : []),
    ];
    try {
      const res = await runProcess(this.command, args, {
        input: fullPrompt,
        cwd,
        timeoutMs: resolveSubscriptionCliTimeoutMs(),
        signal: options.signal,
      });
      // A mid-flight cancellation SIGTERMed the child; surface the exact abort
      // reason (e.g. the run deadline's TimeoutError), never a parse error.
      throwIfAlreadyCancelled(options.signal);
      if (res.timedOut) {
        throw new Error(`Codex did not respond within ${Math.round(resolveSubscriptionCliTimeoutMs() / 1_000)} seconds. Retry, choose a faster model, or increase DQL_SUBSCRIPTION_CLI_TIMEOUT_MS.`);
      }
      if (res.spawnError) {
        throw new Error(`Codex CLI not found. Install it and run \`codex login\` with your ChatGPT plan, or switch to an API-key provider. (${res.spawnError.message})`);
      }
      if (existsSync(outFile)) {
        const text = readFileSync(outFile, 'utf-8').trim();
        if (text) return text;
      }
      // Fallback: parse the JSONL event stream for the final agent_message.
      const fromStream = parseCodexFinalMessage(res.stdout);
      if (fromStream) return fromStream;
      const message = res.stderr.trim() || 'no output';
      if (/not (logged|signed) in|login|unauthor|401/i.test(message)) {
        throw new Error('Codex is not logged in. Run `codex login` with your ChatGPT plan, then retry.');
      }
      throw new Error(`codex exec produced no message: ${message}`);
    } finally {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}

/** Parse `codex exec --json` JSONL for the final `agent_message` text. */
export function parseCodexFinalMessage(stdout: string): string | undefined {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  let last: string | undefined;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; text?: string };
      const item = event.item;
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
        last = item.text;
      } else if (item?.type === 'agent_message' && typeof item.text === 'string') {
        last = item.text;
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return last?.trim() || undefined;
}
