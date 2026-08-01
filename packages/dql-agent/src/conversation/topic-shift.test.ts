/**
 * The reported symptom:
 *
 *   "when user having a conversation which is generating answer then if user
 *    ask different question its not giving right solution"
 *
 * Three mechanisms carried the previous question onto an unrelated one: a
 * question the planner could not parse was classified `continuation` (never a
 * shift); a detected shift cleared only `filters`, leaving the topic, entities,
 * measures and dimensions in place; and `isFilterOnlyRefinement` compared two
 * EMPTY plans as equal, so two unrelated unreadable questions reused the whole
 * prior context pack including its committed route decision.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationStore, type ConversationTurnInput } from './session-store.js';
import { advanceThreadState, buildConversationSnapshot } from './snapshot.js';
import { isFilterOnlyRefinement } from '../metadata/catalog.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';

const ANSWERED: ConversationTurnInput = {
  question: 'Top customers by beverage revenue in 2024',
  answerSummary: 'Melissa Lopez leads.',
  answerText: 'Melissa Lopez leads.',
  route: 'generated_answer',
  runStatus: 'needs_review',
  trustLabel: 'review_required',
  result: { columns: ['customer_name', 'beverage_revenue'], rowCount: 5 },
  contract: {
    measures: ['beverage revenue'],
    dimensions: ['customer'],
    filters: ['2024'],
    entities: ['customer'],
  },
};

describe('topic shift clears carried context', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function threadWithAnsweredTurn(): { store: ConversationStore; threadId: string } {
    const root = mkdtempSync(join(tmpdir(), 'dql-topic-'));
    dirs.push(root);
    const store = new ConversationStore(join(root, 'conversations.sqlite'));
    const threadId = store.createThread({ surface: 'ask' }).id;
    advanceThreadState(store, threadId, store.appendTurn(threadId, ANSWERED));
    return { store, threadId };
  }

  it('carries context for a genuine follow-up', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    const snapshot = buildConversationSnapshot(store, threadId, {
      question: 'break that down by region',
    })!;
    expect(snapshot.topicRelation).not.toBe('shift');
    expect(snapshot.workingState).toBeDefined();
  });

  it('drops the whole carried shape on a new topic, not just the filters', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    const snapshot = buildConversationSnapshot(store, threadId, {
      question: 'How many warehouse shipments were delayed last quarter?',
    })!;

    expect(snapshot.topicRelation).toBe('shift');
    const carried = JSON.stringify(snapshot.workingState ?? {});
    for (const stale of ['customer', 'beverage', '2024']) {
      expect(carried, `leaked "${stale}" onto a new topic`).not.toContain(stale);
    }
  });

  // A short fragment the planner cannot read is the MOST COMMON follow-up shape.
  // Treating those as a new topic threw away the measure and timeframe the
  // follow-up depends on — which is how a MetricFlow query lost `metric_time`.
  // Preserving context is the safer default: a stale carry gives a wrong-ish
  // answer the user can redirect, a dropped carry breaks the follow-up outright.
  it('keeps context for short follow-up fragments the planner cannot read', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    for (const question of [
      'and by month?', 'now by region', 'what about 2023', 'show monthly', 'by month', 'also weekly',
    ]) {
      const snapshot = buildConversationSnapshot(store, threadId, { question })!;
      expect(snapshot.topicRelation, question).not.toBe('shift');
      expect(JSON.stringify(snapshot.workingState ?? {}), question).toContain('beverage');
    }
  });

  it('still shifts on a self-contained new question', () => {
    const { store, threadId } = threadWithAnsweredTurn();
    const snapshot = buildConversationSnapshot(store, threadId, {
      question: 'How many warehouse shipments were delayed last quarter?',
    })!;
    expect(snapshot.topicRelation).toBe('shift');
  });
});

describe('isFilterOnlyRefinement requires evidence of sameness', () => {
  it('does not treat two unreadable questions as the same query', () => {
    const prior = buildAnalysisQuestionPlan('zzqq frobnication');
    const next = buildAnalysisQuestionPlan('wibble plough');
    // Both plans are empty; a pure set comparison called them equal, which
    // reused the earlier context pack AND its route decision for an unrelated
    // question.
    expect(isFilterOnlyRefinement(prior, next)).toBe(false);
  });

  it('still recognises a real filter-only refinement', () => {
    const prior = buildAnalysisQuestionPlan('revenue by region in 2024');
    const next = buildAnalysisQuestionPlan('revenue by region in 2025');
    expect(isFilterOnlyRefinement(prior, next)).toBe(true);
  });
});
