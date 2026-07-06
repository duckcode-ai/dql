import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, defaultConversationPath } from './session-store.js';
import { buildConversationSnapshot, recallRelevantTurns } from './snapshot.js';
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

  it('keeps prior result refs rich enough for follow-up grounding', () => {
    const thread = store.createThread();
    store.appendTurn(thread.id, {
      question: 'give me product and supply info',
      answerSummary: 'Product to supply breakdown.',
      sql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies',
      dqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
        source: 'block "product_supply_breakdown" {\n  type = "custom"\n}',
      },
      cascade: {
        terminalLane: 'generated',
        routeTier: 'generated_sql',
        label: 'Lane 3 generated DQL artifact was terminal',
        artifactKind: 'sql_block',
        outcome: {
          lane: 'generated',
          routeTier: 'generated_sql',
          hasSqlPreview: true,
          executionStatus: 'executed',
          rowCount: 65,
        },
      },
      result: {
        columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        rowCount: 65,
        dimensionValues: {
          product_id: ['BEV-001', 'JAF-001'],
          supply_id: ['SUP-005', 'SUP-009'],
        },
        measureColumns: ['supply_cost'],
      },
    });

    const snapshot = buildConversationSnapshot(store, thread.id, {
      question: 'can you include product details with previous results and give final',
    });

    expect(snapshot?.recentTurns[0]).toMatchObject({
      question: 'give me product and supply info',
      resultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
      resultRowCount: 65,
      sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies',
      dqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
      },
      cascade: {
        terminalLane: 'generated',
        routeTier: 'generated_sql',
        outcome: {
          lane: 'generated',
          executionStatus: 'executed',
          rowCount: 65,
        },
      },
    });
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
