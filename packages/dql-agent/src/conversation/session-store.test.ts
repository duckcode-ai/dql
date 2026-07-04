import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, defaultConversationPath } from './session-store.js';

describe('ConversationStore', () => {
  let root: string;
  let store: ConversationStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-conversation-'));
    store = new ConversationStore(defaultConversationPath(root));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates threads and appends turns with monotonic seq', () => {
    const thread = store.createThread({ surface: 'notebook' });
    const first = store.appendTurn(thread.id, { question: 'revenue by category' });
    const second = store.appendTurn(thread.id, { question: 'top 5 customers for these categories?' });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    const recent = store.recentTurns(thread.id, 4);
    expect(recent.map((turn) => turn.question)).toEqual([
      'revenue by category',
      'top 5 customers for these categories?',
    ]);
    // Thread title defaults to the first question.
    expect(store.getThread(thread.id)?.title).toBe('revenue by category');
  });

  it('persists turn payloads with caps applied', () => {
    const thread = store.createThread();
    const turn = store.appendTurn(thread.id, {
      question: 'revenue by category',
      answerSummary: 'Food and Drink revenue split.',
      route: 'certified_answer',
      trustLabel: 'certified',
      sourceCertifiedBlock: 'food_vs_drink_revenue',
      contextPackId: 'ctx_abc',
      result: {
        columns: Array.from({ length: 40 }, (_, i) => `col_${i}`),
        rowsSample: Array.from({ length: 20 }, () => ['Food', 240877]),
        dimensionValues: { category: Array.from({ length: 40 }, (_, i) => `value_${i}`) },
        rowCount: 2,
      },
      contract: { measures: ['revenue'], dimensions: ['category'] },
    });

    const [stored] = store.recentTurns(thread.id, 1);
    expect(stored.id).toBe(turn.id);
    expect(stored.result?.columns).toHaveLength(24);
    expect(stored.result?.rowsSample).toHaveLength(8);
    expect(stored.result?.dimensionValues?.category).toHaveLength(24);
    expect(stored.result?.rowCount).toBe(2);
    expect(stored.contract).toEqual({ measures: ['revenue'], dimensions: ['category'] });
    expect(stored.sourceCertifiedBlock).toBe('food_vs_drink_revenue');
    expect(stored.contextPackId).toBe('ctx_abc');
  });

  it('searches turns by keyword, scoped to a thread', () => {
    const revenueThread = store.createThread();
    const signupThread = store.createThread();
    store.appendTurn(revenueThread.id, {
      question: 'revenue split between food and drink',
      answerSummary: 'Food and Drink revenue totals.',
    });
    store.appendTurn(signupThread.id, {
      question: 'how many signups last quarter',
      answerSummary: 'Signup counts by month.',
    });

    const hits = store.searchTurns({ query: 'revenue drink', threadId: revenueThread.id });
    expect(hits).toHaveLength(1);
    expect(hits[0].question).toContain('revenue split');

    const crossThread = store.searchTurns({ query: 'signups' });
    expect(crossThread).toHaveLength(1);
    expect(crossThread[0].threadId).toBe(signupThread.id);
  });

  it('updates working state, rolling summary, and the compaction cursor', () => {
    const thread = store.createThread();
    store.updateThreadState(thread.id, {
      workingState: { measures: ['revenue'], topicKey: 'orders|revenue' },
      rollingSummary: 'Q: revenue by category | A: Food/Drink split',
      summaryTurnSeq: 3,
    });
    const loaded = store.getThread(thread.id);
    expect(loaded?.workingState).toEqual({ measures: ['revenue'], topicKey: 'orders|revenue' });
    expect(loaded?.rollingSummary).toContain('Food/Drink');
    expect(loaded?.summaryTurnSeq).toBe(3);
  });

  it('lists non-archived threads by recency and archives on request', () => {
    const a = store.createThread({ title: 'thread a' });
    const b = store.createThread({ title: 'thread b' });
    store.archiveThread(a.id);
    const active = store.listThreads();
    expect(active.map((thread) => thread.id)).toEqual([b.id]);
    const all = store.listThreads({ includeArchived: true });
    expect(all).toHaveLength(2);
  });

  it('returns turns for compaction between the cursor and the recent window', () => {
    const thread = store.createThread();
    for (let i = 1; i <= 6; i++) {
      store.appendTurn(thread.id, { question: `question ${i}` });
    }
    // Cursor at 1, recent window starts at seq 5 → compact turns 2..4.
    const compactable = store.turnsForCompaction(thread.id, 1, 5);
    expect(compactable.map((turn) => turn.seq)).toEqual([2, 3, 4]);
  });

  it('prunes archived threads older than the cutoff', () => {
    const thread = store.createThread();
    store.appendTurn(thread.id, { question: 'old question' });
    store.archiveThread(thread.id);
    // Archived just now — a 0-day cutoff prunes anything archived before "now".
    const pruned = store.pruneThreads(-1);
    expect(pruned).toBe(1);
    expect(store.getThread(thread.id)).toBeNull();
    expect(store.searchTurns({ query: 'old question' })).toHaveLength(0);
  });
});
