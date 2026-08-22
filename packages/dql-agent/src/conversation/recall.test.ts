import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, defaultConversationPath } from './session-store.js';
import {
  buildConversationSnapshot,
  conversationHistoryFromContext,
  isLikelyClarificationReply,
  recallRelevantTurns,
  renderConversationEnvelopeForPrompt,
} from './snapshot.js';
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

  it('never semantically recalls blocked or unresolved turns', async () => {
    const thread = store.createThread();
    store.appendTurn(thread.id, {
      question: 'revenue by dangerous payroll region',
      answerSummary: 'Which payroll definition should I use?',
      route: 'clarify',
      runStatus: 'needs_clarification',
    });
    store.appendTurn(thread.id, {
      question: 'revenue by safe region',
      answerSummary: 'Philadelphia leads.',
      trustLabel: 'grounded',
      runStatus: 'completed',
    });

    const hits = await recallRelevantTurns(store, thread.id, 'revenue region', { limit: 4 });
    expect(hits.map((turn) => turn.question)).toEqual(['revenue by safe region']);
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
    expect(snapshot).toMatchObject({
      version: 1,
      threadId: thread.id,
      surface: 'notebook',
    });
  });

  it('keeps blocked turns in the audit envelope but excludes them from analytical history', () => {
    const thread = store.createThread({ surface: 'ask' });
    store.appendTurn(thread.id, {
      question: 'show restricted payroll',
      answerSummary: 'Access was denied.',
      route: 'blocked',
      trustLabel: 'blocked',
      runStatus: 'blocked',
      stopReason: 'blocked',
    });
    const snapshot = buildConversationSnapshot(store, thread.id, {
      question: 'what happened with that request?',
    });
    const context = { conversationEnvelope: snapshot };

    expect(snapshot?.recentTurns).toHaveLength(1);
    expect(conversationHistoryFromContext(context)).toEqual([]);
    expect(renderConversationEnvelopeForPrompt(context)).toContain(`thread: ${thread.id}`);
    expect(renderConversationEnvelopeForPrompt(context)).toContain('surface: ask');
  });

  it('makes clarification pending only for a short clarification reply', () => {
    const thread = store.createThread({ surface: 'ask' });
    store.appendTurn(thread.id, {
      question: 'filter this to one customer',
      answerSummary: 'Which customer should define the answer?',
      route: 'clarify',
      runStatus: 'needs_clarification',
    });

    const replySnapshot = buildConversationSnapshot(store, thread.id, { question: 'Melissa Lopez' });
    expect(replySnapshot?.pendingClarification).toMatchObject({
      question: 'Which customer should define the answer?',
    });

    const freshSnapshot = buildConversationSnapshot(store, thread.id, {
      question: 'what region has the most revenue',
    });
    expect(freshSnapshot?.pendingClarification).toBeUndefined();
    expect(renderConversationEnvelopeForPrompt({ conversationEnvelope: freshSnapshot }))
      .not.toContain('pending clarification:');
  });

  it('AGT-011 retains the stable clarification option contract after reopening the conversation store', () => {
    const thread = store.createThread({ surface: 'ask' });
    const requirements = {
      version: 1 as const,
      measures: ['revenue'],
      dimensions: [],
      entityTerms: [],
      entityDisplayTerms: [],
      memberTerms: [],
    };
    store.appendTurn(thread.id, {
      question: 'show me revenue',
      answerSummary: 'Which compatible revenue metric should DQL use?',
      route: 'clarify',
      runStatus: 'needs_clarification',
      contract: {
        clarificationSelection: {
          version: 1,
          optionIds: [
            'semantic:metric:order_items.product_revenue',
            'semantic:metric:orders.revenue',
          ],
          ambiguityCandidateIds: [
            'semantic:metric:order_items.product_revenue',
            'semantic:metric:orders.revenue',
          ],
          requirements,
          snapshotId: 'snapshot-revenue-clarification',
        },
      },
    });

    store.close();
    store = new ConversationStore(defaultConversationPath(root));
    const snapshot = buildConversationSnapshot(store, thread.id, { question: 'Revenue' });

    expect(snapshot?.pendingClarification?.selection).toEqual({
      version: 1,
      optionIds: [
        'semantic:metric:order_items.product_revenue',
        'semantic:metric:orders.revenue',
      ],
      ambiguityCandidateIds: [
        'semantic:metric:order_items.product_revenue',
        'semantic:metric:orders.revenue',
      ],
      requirements,
      snapshotId: 'snapshot-revenue-clarification',
    });

    // The Notebook submits the original analytical question on a button click
    // (rather than the option label). The host-only flag keeps this persisted
    // server selection available for the router's strict ID/snapshot check.
    const structuredClickSnapshot = buildConversationSnapshot(store, thread.id, {
      question: 'show me revenue',
      preservePendingClarification: true,
    });
    expect(structuredClickSnapshot?.pendingClarification).toMatchObject({
      sourceQuestion: 'show me revenue',
      selection: {
        optionIds: ['semantic:metric:order_items.product_revenue', 'semantic:metric:orders.revenue'],
        snapshotId: 'snapshot-revenue-clarification',
      },
    });
  });

  it('excludes unresolved turns while preserving the prior successful analytical context', () => {
    const thread = store.createThread({ surface: 'ask' });
    store.appendTurn(thread.id, {
      question: 'what region has the most revenue',
      answerSummary: 'Philadelphia has the highest revenue.',
      route: 'answer',
      trustLabel: 'grounded',
      runStatus: 'completed',
    });
    store.appendTurn(thread.id, {
      question: 'filter this to one customer',
      answerSummary: 'Which customer column should define the answer?',
      route: 'clarify',
      runStatus: 'needs_clarification',
    });

    const snapshot = buildConversationSnapshot(store, thread.id, {
      question: 'what region has the most revenue',
    });
    const history = conversationHistoryFromContext({ conversationEnvelope: snapshot });
    expect(history).toEqual([
      { role: 'user', text: 'what region has the most revenue' },
      { role: 'assistant', text: '[confirmed] Philadelphia has the highest revenue.' },
    ]);
    expect(snapshot?.pendingClarification).toBeUndefined();
  });

  it('distinguishes short clarification choices from complete analytical requests', () => {
    expect(isLikelyClarificationReply('yes, per product')).toBe(true);
    expect(isLikelyClarificationReply('Melissa Lopez')).toBe(true);
    expect(isLikelyClarificationReply('what region has the most revenue')).toBe(false);
    expect(isLikelyClarificationReply('revenue by region')).toBe(false);
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
