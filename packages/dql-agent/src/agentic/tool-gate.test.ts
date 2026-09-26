import { afterEach, describe, expect, it } from 'vitest';
import { runGatedTool, setAgentToolGate, type AgentToolCall } from './tool-gate.js';

/** RFC 0010 HH-7: every tool call passes one gate, once. */
describe('the tool gate', () => {
  afterEach(() => setAgentToolGate(null));
  const tool = { name: 'run_sql', run: async (args: { sql: string }) => ({ rows: 1, sql: args.sql }) };

  it('runs the tool as it is without a gate', async () => {
    expect(await runGatedTool(tool, { sql: 'SELECT 1' })).toEqual({ rows: 1, sql: 'SELECT 1' });
  });

  it('lets a gate see, run, reshape or refuse each call', async () => {
    const seen: AgentToolCall[] = [];
    setAgentToolGate(async (call, next) => {
      seen.push(call);
      if (call.name === 'run_sql' && String((call.args as { sql: string }).sql).includes('salaries')) throw new Error('Salaries are restricted.');
      const output = await next();
      return { ...(output as object), checked: true };
    });
    expect(await runGatedTool(tool, { sql: 'SELECT 1' })).toEqual({ rows: 1, sql: 'SELECT 1', checked: true });
    await expect(runGatedTool(tool, { sql: 'SELECT * FROM salaries' })).rejects.toThrow('Salaries are restricted.');
    expect(seen.map((call) => call.name)).toEqual(['run_sql', 'run_sql']);
  });
});
