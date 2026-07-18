import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeCliProvider,
  CodexCliProvider,
  parseClaudeResult,
  parseCodexFinalMessage,
  resolveSubscriptionCliTimeoutMs,
} from './subscription-cli.js';

describe('subscription CLI timeout', () => {
  it('keeps a hard deadline even when the caller also supplies cancellation', () => {
    expect(resolveSubscriptionCliTimeoutMs({})).toBe(60_000);
    expect(resolveSubscriptionCliTimeoutMs({ DQL_SUBSCRIPTION_CLI_TIMEOUT_MS: '15000' })).toBe(15_000);
    expect(resolveSubscriptionCliTimeoutMs({ DQL_SUBSCRIPTION_CLI_TIMEOUT_MS: '1000' })).toBe(5_000);
    expect(resolveSubscriptionCliTimeoutMs({ DQL_SUBSCRIPTION_CLI_TIMEOUT_MS: '900000' })).toBe(300_000);
    expect(resolveSubscriptionCliTimeoutMs({ DQL_SUBSCRIPTION_CLI_TIMEOUT_MS: 'invalid' })).toBe(60_000);
  });
});

describe('parseClaudeResult', () => {
  it('extracts .result and is_error from a single JSON object', () => {
    const json = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Revenue is $2.8M.' });
    expect(parseClaudeResult(json)).toEqual({ text: 'Revenue is $2.8M.', isError: false });
  });

  it('flags is_error true (e.g. not logged in)', () => {
    const json = JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' });
    expect(parseClaudeResult(json)).toEqual({ text: 'Not logged in · Please run /login', isError: true });
  });

  it('falls back to the last JSON line when stdout has leading noise', () => {
    const stdout = 'warning: something\n{"is_error":false,"result":"OK"}';
    expect(parseClaudeResult(stdout)).toEqual({ text: 'OK', isError: false });
  });

  it('returns undefined for empty / unparseable output', () => {
    expect(parseClaudeResult('')).toBeUndefined();
    expect(parseClaudeResult('plain text, no json')).toBeUndefined();
  });
});

describe('parseCodexFinalMessage', () => {
  it('extracts the final agent_message text from JSONL', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Total revenue is $2.8M."}}',
      '{"type":"turn.completed"}',
    ].join('\n');
    expect(parseCodexFinalMessage(jsonl)).toBe('Total revenue is $2.8M.');
  });

  it('returns the LAST agent_message when several are present', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
    ].join('\n');
    expect(parseCodexFinalMessage(jsonl)).toBe('second');
  });

  it('returns undefined when there is no agent_message', () => {
    expect(parseCodexFinalMessage('{"type":"turn.started"}\n{"type":"error","message":"x"}')).toBeUndefined();
    expect(parseCodexFinalMessage('')).toBeUndefined();
    expect(parseCodexFinalMessage('not json at all')).toBeUndefined();
  });
});

// ── Live tests (opt-in) ────────────────────────────────────────────────────────
// Real subscription round-trips cost money and require a logged-in CLI, so they only
// run with DQL_TEST_LIVE_CLI=1. They prove the provider works end-to-end.
const hasClaude = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
const liveClaude = process.env.DQL_TEST_LIVE_CLI === '1' && hasClaude;

describe.runIf(liveClaude)('ClaudeCodeCliProvider (live)', () => {
  it('detects an installed, logged-in Claude subscription', async () => {
    const status = await ClaudeCodeCliProvider.detect();
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
  });

  it('generates a one-shot completion via the subscription', async () => {
    const provider = new ClaudeCodeCliProvider();
    expect(await provider.available()).toBe(true);
    const text = await provider.generate([
      { role: 'system', content: 'You are a test harness. Answer with a single word only.' },
      { role: 'user', content: 'Reply with exactly the word: PONG' },
    ]);
    expect(text.toUpperCase()).toContain('PONG');
  }, 60000);
});

const hasCodex = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;
describe.runIf(process.env.DQL_TEST_LIVE_CLI === '1' && hasCodex)('CodexCliProvider (live)', () => {
  it('detects an installed Codex CLI', async () => {
    const status = await CodexCliProvider.detect();
    expect(status.installed).toBe(true);
  });
});
