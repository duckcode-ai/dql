import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, defaultConversationPath } from './session-store.js';
import { recallRelevantTurns } from './snapshot.js';
import { MemoryStore, defaultMemoryPath } from '../memory/sqlite-memory.js';

describe('semantic recall over conversation history', () => {
  let root: string;
  let store: ConversationStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dql-recall-'));
    store = new ConversationStore(defaultConversationPath(root));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('ranks the matching topic first and respects the limit', async () => {
    const thread = store.createThread();
    store.appendTurn(thread.id, { question: 'revenue split between food and drink', answerSummary: 'Food 240877, Drink 396567' });
    store.appendTurn(thread.id, { question: 'top products by revenue', answerSummary: 'Jaffle A leads revenue' });
    store.appendTurn(thread.id, { question: 'how many signups last quarter', answerSummary: '412 signups in Q2' });
    store.appendTurn(thread.id, { question: 'signup conversion rate by channel', answerSummary: 'Organic converts best' });

    const hits = await recallRelevantTurns(store, thread.id, 'what did we discuss about revenue?', { limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits[0].question).toMatch(/revenue/);
    expect(hits.every((turn) => !/signups last quarter/.test(turn.question))).toBe(true);
  });

  it('excludes turns already in the recent verbatim window', async () => {
    const thread = store.createThread();
    const first = store.appendTurn(thread.id, { question: 'revenue by category', answerSummary: 'Food/Drink split' });
    const hits = await recallRelevantTurns(store, thread.id, 'revenue by category', {
      excludeTurnIds: [first.id],
    });
    expect(hits).toHaveLength(0);
  });

  it('promotion is the only path into durable memory (isolation)', () => {
    const thread = store.createThread();
    store.appendTurn(thread.id, { question: 'revenue by category', answerSummary: 'Food/Drink split' });

    const memory = new MemoryStore(defaultMemoryPath(root));
    try {
      // Nothing auto-promotes: durable memory stays empty after turns are stored.
      expect(memory.search({ query: 'revenue category', scopes: ['project'] })).toHaveLength(0);

      // An explicit promotion (what the /promote endpoint does) becomes searchable.
      memory.upsert({
        scope: 'project',
        title: 'revenue by category',
        content: 'Q: revenue by category\nA: Food/Drink split',
        tags: ['conversation', thread.id],
        source: 'conversation',
        confidence: 0.6,
        importance: 0.5,
        enabled: true,
      });
      const promoted = memory.search({ query: 'revenue category', scopes: ['project'] });
      expect(promoted).toHaveLength(1);
      expect(promoted[0].source).toBe('conversation');
    } finally {
      memory.close();
    }
  });
});
