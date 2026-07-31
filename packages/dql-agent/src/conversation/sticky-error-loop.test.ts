/**
 * The reported symptom, as a scripted multi-turn thread:
 *
 *   "when one error output occurred like SQL failure or could not find the
 *    answer, then following conversations are looping to the same error issue
 *    instead of answering it"
 *
 * The mechanism was that a refusal was persisted as `needs_review` — the same
 * run status as a perfectly good uncertified answer — so it was folded into the
 * thread's working state, became the follow-up anchor, and had its question,
 * failure text and FAILING SQL rendered into the next prompt.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationStore, type ConversationTurnInput } from './session-store.js';
import { advanceThreadState, buildConversationSnapshot } from './snapshot.js';
import { isTrustedConversationTurn } from './turn-trust.js';

const GOOD_TURN: ConversationTurnInput = {
  question: 'Revenue by region for 2024',
  answerSummary: 'EMEA leads with 4.2M.',
  answerText: 'EMEA leads with 4.2M.',
  route: 'generated_answer',
  runStatus: 'needs_review',
  trustLabel: 'review_required',
  sql: 'SELECT region, SUM(amount) FROM orders GROUP BY region',
  result: { columns: ['region', 'amount'], rowCount: 3 },
  contract: { measures: ['revenue'], dimensions: ['region'], filters: ['2024'] },
};

const FAILED_TURN: ConversationTurnInput = {
  question: 'Revenue by widget colour',
  answerSummary: "I couldn't find the answer with the metadata available.",
  route: 'generated_answer',
  runStatus: 'needs_review',
  trustLabel: 'review_required',
  refusalCode: 'grounding_gap',
  sql: 'SELECT colour, SUM(amount) FROM orders GROUP BY colour',
  contract: { measures: ['revenue'], dimensions: ['widget colour'] },
};

describe('a failed turn does not poison the thread', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function newThread(): { store: ConversationStore; threadId: string } {
    const root = mkdtempSync(join(tmpdir(), 'dql-sticky-'));
    dirs.push(root);
    const store = new ConversationStore(join(root, 'conversations.sqlite'));
    return { store, threadId: store.createThread({ surface: 'ask' }).id };
  }

  /** Mirrors `recordConversationTurn`: append always, fold only when trusted. */
  function record(store: ConversationStore, threadId: string, input: ConversationTurnInput): void {
    const turn = store.appendTurn(threadId, input);
    if (isTrustedConversationTurn(turn)) advanceThreadState(store, threadId, turn);
  }

  it('keeps the failed turn in history but out of working state', () => {
    const { store, threadId } = newThread();
    record(store, threadId, GOOD_TURN);
    const afterGood = store.getThread(threadId)!.workingState;
    record(store, threadId, FAILED_TURN);
    const afterFailure = store.getThread(threadId)!.workingState;

    // The user can still see both turns.
    expect(store.recentTurns(threadId, 10)).toHaveLength(2);
    // But the refusal contributed nothing to the thread's carried state.
    expect(afterFailure).toEqual(afterGood);
    expect(JSON.stringify(afterFailure)).not.toContain('colour');
  });

  it('does not render the failed turn\'s SQL or failure prose into the next prompt', () => {
    const { store, threadId } = newThread();
    record(store, threadId, GOOD_TURN);
    record(store, threadId, FAILED_TURN);

    const snapshot = buildConversationSnapshot(store, threadId, { question: 'Revenue by region for 2025' })!;
    const failed = snapshot.recentTurns.find((turn) => turn.question === FAILED_TURN.question)!;

    expect(isTrustedConversationTurn(failed)).toBe(false);
    // The refusal is persisted with its SQL for the inspector...
    expect(store.recentTurns(threadId, 10).find((t) => t.question === FAILED_TURN.question)?.sql)
      .toContain('colour');
    // ...but the good turn stays trusted and usable.
    const good = snapshot.recentTurns.find((turn) => turn.question === GOOD_TURN.question)!;
    expect(isTrustedConversationTurn(good)).toBe(true);
  });

  // The exact reported loop: the same question works, then fails, then must
  // work again rather than replaying the failure forever.
  it('answers normally again after a failure in the same thread', () => {
    const { store, threadId } = newThread();
    record(store, threadId, GOOD_TURN);
    record(store, threadId, FAILED_TURN);
    record(store, threadId, { ...GOOD_TURN, question: 'Revenue by region for 2025' });

    const thread = store.getThread(threadId)!;
    const state = JSON.stringify(thread.workingState);
    expect(state).not.toContain('colour');
    expect(state).toContain('region');

    const snapshot = buildConversationSnapshot(store, threadId, { question: 'And by product?' })!;
    const trusted = snapshot.recentTurns.filter(isTrustedConversationTurn);
    expect(trusted).toHaveLength(2);
    expect(trusted.every((turn) => turn.question !== FAILED_TURN.question)).toBe(true);
  });

  it('leaves no trusted anchor when every turn in the thread failed', () => {
    const { store, threadId } = newThread();
    record(store, threadId, FAILED_TURN);
    record(store, threadId, { ...FAILED_TURN, question: 'Revenue by widget size' });

    const snapshot = buildConversationSnapshot(store, threadId, { question: 'Revenue by region' })!;
    expect(snapshot.recentTurns.filter(isTrustedConversationTurn)).toHaveLength(0);
    expect(store.getThread(threadId)!.workingState).toEqual({});
  });
});
