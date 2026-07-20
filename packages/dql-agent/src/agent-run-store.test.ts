import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgentRunStore } from './agent-run-store.js';
import type { AgentRun } from './agent-run-engine.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
function tmp(): string { const dir = mkdtempSync(join(tmpdir(), 'run-store-')); dirs.push(dir); return dir; }

function run(id: string, startedAt: string, events = 3): AgentRun {
  return {
    id,
    question: `question ${id}`,
    route: 'generated_answer',
    status: 'completed',
    startedAt,
    completedAt: startedAt,
    events: Array.from({ length: events }, (_, index) => ({ type: 'executor.started', message: `event ${index}` })),
    artifacts: [{ kind: 'answer', payload: { answer: `answer ${id}` } }],
    evaluations: [],
  } as unknown as AgentRun;
}

describe('SqliteAgentRunStore', () => {
  it('round-trips save/get/list ordered newest-first', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    store.save(run('b', '2026-07-20T11:00:00Z'));
    expect(store.get('a')?.question).toBe('question a');
    expect(store.list().map((r) => r.id)).toEqual(['b', 'a']);
    store.close();
  });

  it('updates in place when the same run id is saved twice', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    store.save({ ...run('a', '2026-07-20T10:00:00Z'), question: 'updated' } as AgentRun);
    expect(store.list()).toHaveLength(1);
    expect(store.get('a')?.question).toBe('updated');
    store.close();
  });

  it('enforces retention on write (oldest pruned)', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite'), maxRuns: 20 });
    for (let index = 0; index < 30; index += 1) {
      store.save(run(`r${index}`, `2026-07-20T10:${String(index).padStart(2, '0')}:00Z`));
    }
    const ids = store.list().map((r) => r.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('r29');
    expect(ids).not.toContain('r0');
    store.close();
  });

  it('compacts event streams for runs beyond the recent window but keeps artifacts', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite'), maxRuns: 50, fullPayloadRuns: 2 });
    for (let index = 0; index < 5; index += 1) {
      store.save(run(`r${index}`, `2026-07-20T10:0${index}:00Z`));
    }
    const all = store.list();
    const newest = all[0]!;
    const oldest = all.at(-1)!;
    expect(newest.events.length).toBeGreaterThan(0);
    expect(oldest.events).toEqual([]);
    expect(oldest.artifacts).toHaveLength(1);
    store.close();
  });

  it('imports a legacy JSON store once and renames it to *.migrated', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, runs: [run('legacy1', '2026-07-19T10:00:00Z'), { junk: true }] }));
    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    expect(store.get('legacy1')?.question).toBe('question legacy1');
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
    // Re-opening must not double-import or crash.
    store.close();
    const reopened = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    expect(reopened.list()).toHaveLength(1);
    reopened.close();
  });

  it('tolerates a corrupt legacy file (kept on disk, store still works)', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    writeFileSync(legacy, 'not json {');
    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    expect(store.list()).toHaveLength(1);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
    store.close();
  });
});
