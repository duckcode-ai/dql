import { describe, expect, it } from 'vitest';
import { emptyWorkingState, reduceWorkingState, type ConversationWorkingState } from './working-state.js';
import { updateRollingSummary } from './rolling-summary.js';
import type { ConversationTurn } from './session-store.js';

function turn(input: Partial<ConversationTurn> & { question: string }): ConversationTurn {
  return {
    id: input.id ?? `trn_${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thr_x',
    seq: input.seq ?? 1,
    createdAt: new Date().toISOString(),
    ...input,
  };
}

describe('reduceWorkingState — topic relation matrix', () => {
  const revenueState = (): ConversationWorkingState => reduceWorkingState(
    emptyWorkingState(),
    turn({
      question: 'revenue by category',
      sourceCertifiedBlock: 'food_vs_drink_revenue',
      contextPackId: 'ctx_1',
      contract: { entities: ['orders'], measures: ['revenue'], dimensions: ['category'], filters: ['Food', 'Drink'] },
      result: { columns: ['category', 'revenue'], dimensionValues: { category: ['Food', 'Drink'] } },
    }),
  ).state;

  it('first turn establishes the topic (continuation)', () => {
    const { state, topicRelation } = reduceWorkingState(
      emptyWorkingState(),
      turn({ question: 'revenue by category', contract: { entities: ['orders'], measures: ['revenue'] } }),
    );
    expect(topicRelation).toBe('continuation');
    expect(state.topicKey).toContain('revenue');
  });

  it('carries the exact latest knowledge lens without merging skill snapshots', () => {
    const first = reduceWorkingState(emptyWorkingState(), turn({
      question: 'revenue',
      contract: { measures: ['revenue'] },
      knowledgeLens: { mode: 'auto', skillRefs: ['finance::skill::revenue'], snapshotId: 'snapshot-1' },
    })).state;
    const second = reduceWorkingState(first, turn({
      question: 'signups',
      contract: { measures: ['signups'] },
      knowledgeLens: { mode: 'pinned', skillRefs: ['growth::skill::acquisition'], snapshotId: 'snapshot-2' },
    })).state;
    expect(second.knowledgeLens).toEqual({ mode: 'pinned', skillRefs: ['growth::skill::acquisition'], snapshotId: 'snapshot-2' });
  });

  it('same-topic turn is a continuation and accumulates', () => {
    const { state, topicRelation } = reduceWorkingState(revenueState(), turn({
      question: 'revenue by product too',
      contract: { entities: ['orders'], measures: ['revenue'], dimensions: ['product'] },
    }));
    expect(topicRelation).toBe('continuation');
    expect(state.dimensions).toEqual(expect.arrayContaining(['category', 'product']));
    expect(state.filters.map((f) => f.value)).toEqual(['Food', 'Drink']);
  });

  it('filters/limit-only turn is a refinement (keeps filters)', () => {
    const { topicRelation, state } = reduceWorkingState(revenueState(), turn({
      question: 'only the top 5',
      contract: { filters: ['top'], topN: { n: 5 } },
    }));
    expect(topicRelation).toBe('refinement');
    expect(state.filters.map((f) => f.value)).toEqual(expect.arrayContaining(['Food', 'Drink']));
    expect(state.limit).toBe(5);
  });

  it('new-entity turn is a SHIFT and clears carried filters', () => {
    const { state, topicRelation } = reduceWorkingState(revenueState(), turn({
      question: 'how many signups last quarter',
      contract: { entities: ['signups'], measures: ['count'] },
    }));
    expect(topicRelation).toBe('shift');
    expect(state.filters).toEqual([]);
    expect(state.topicKey).toContain('signup');
    // The outgoing topic is remembered for a later return.
    expect(state.priorTopics?.[0]?.filters).toEqual(['Food', 'Drink']);
    expect(state.priorTopics?.[0]?.sourceCertifiedBlock).toBe('food_vs_drink_revenue');
  });

  it('returning to a prior topic restores its filters and block', () => {
    const shifted = reduceWorkingState(revenueState(), turn({
      question: 'how many signups last quarter',
      contract: { entities: ['signups'], measures: ['count'] },
    })).state;
    const { state, topicRelation } = reduceWorkingState(shifted, turn({
      question: 'back to revenue for those categories',
      contract: { entities: ['orders'], measures: ['revenue'] },
    }));
    expect(topicRelation).toBe('return');
    expect(state.filters.map((f) => f.value)).toEqual(expect.arrayContaining(['Food', 'Drink']));
    expect(state.sourceCertifiedBlock).toBe('food_vs_drink_revenue');
  });
});

describe('updateRollingSummary', () => {
  it('is bounded and keeps the newest lines', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn({
      question: `question number ${i} about revenue and categories with some padding text`,
      answerSummary: `answer ${i} with details`,
      seq: i + 1,
    }));
    const summary = updateRollingSummary({ compactedTurns: turns });
    expect(summary).toBeDefined();
    expect(summary!.length).toBeLessThanOrEqual(600);
    expect(summary).toContain('question number 19');
    expect(summary).not.toContain('question number 0 ');
  });

  it('is incremental: folding new turns preserves prior summary content within budget', () => {
    const first = updateRollingSummary({ compactedTurns: [turn({ question: 'alpha question', seq: 1 })] });
    const second = updateRollingSummary({
      previousSummary: first,
      compactedTurns: [turn({ question: 'beta question', seq: 2 })],
    });
    expect(second).toContain('alpha question');
    expect(second).toContain('beta question');
  });
});
