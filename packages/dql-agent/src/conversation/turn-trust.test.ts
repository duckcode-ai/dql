import { describe, expect, it } from 'vitest';
import { conversationTurnTrust, isTrustedConversationTurn } from './turn-trust.js';

describe('conversationTurnTrust', () => {
  it('trusts a completed answer that returned data', () => {
    expect(conversationTurnTrust({
      runStatus: 'completed',
      trustLabel: 'certified',
      result: { columns: ['region'], rowCount: 3 },
    })).toBe('answered');
  });

  // The trap this predicate exists to avoid: `needs_review` is the status of
  // EVERY successful uncertified generated answer — the majority of Ask
  // answers. Excluding the status wholesale would delete all follow-up context.
  it('trusts an ordinary uncertified generated answer', () => {
    expect(conversationTurnTrust({
      runStatus: 'needs_review',
      trustLabel: 'review_required',
      result: { columns: ['customer', 'revenue'], rowCount: 10 },
    })).toBe('provisional');
    expect(isTrustedConversationTurn({
      runStatus: 'needs_review',
      trustLabel: 'review_required',
      result: { columns: ['customer'], rowCount: 1 },
    })).toBe(true);
  });

  it('trusts a prose answer that legitimately has no result set', () => {
    expect(conversationTurnTrust({
      runStatus: 'needs_review',
      answerText: 'Net revenue is revenue minus refunds.',
    })).toBe('provisional');
  });

  // The reported bug: "I couldn't find the answer" was persisted as
  // `needs_review`, identical to a good answer, and every trust check passed it.
  it('does NOT trust a grounding or modeling gap', () => {
    for (const refusalCode of ['grounding_gap', 'modeling_gap', 'model_declined', 'policy_blocked', 'provider_error']) {
      const turn = {
        runStatus: 'needs_review',
        trustLabel: 'review_required',
        refusalCode,
        answerSummary: "I couldn't find the answer.",
      };
      expect(conversationTurnTrust(turn), refusalCode).toBe('failed');
      expect(isTrustedConversationTurn(turn), refusalCode).toBe(false);
    }
  });

  it('does NOT trust a turn that recorded an execution error', () => {
    expect(conversationTurnTrust({
      runStatus: 'needs_review',
      executionError: 'Binder Error: no such column: amt',
      result: { columns: ['a'], rowCount: 1 },
    })).toBe('failed');
  });

  it('does not trust blocked or clarifying turns', () => {
    expect(conversationTurnTrust({ runStatus: 'blocked' })).toBe('blocked');
    expect(conversationTurnTrust({ route: 'blocked' })).toBe('blocked');
    expect(conversationTurnTrust({ runStatus: 'needs_clarification' })).toBe('unresolved');
    expect(conversationTurnTrust({ route: 'clarify' })).toBe('unresolved');
  });

  it('does not grant conversation authority to a cancelled run', () => {
    const turn = {
      runStatus: 'cancelled',
      route: 'sql_cell',
      stopReason: 'cancelled',
      answerSummary: 'Stopped by user.',
      result: { columns: ['region'], rowCount: 1 },
    };
    expect(conversationTurnTrust(turn)).toBe('failed');
    expect(isTrustedConversationTurn(turn)).toBe(false);
  });

  it('does not trust a turn with neither a result nor any answer text', () => {
    expect(conversationTurnTrust({ runStatus: 'needs_review' })).toBe('failed');
  });

  // Turns written before `refusalCode`/`executionError` existed must not crash
  // and must keep their historical reading.
  it('degrades safely for a legacy turn missing the trust fields', () => {
    expect(conversationTurnTrust({
      runStatus: 'needs_review',
      trustLabel: 'review_required',
      result: { columns: ['region'], rowCount: 2 },
    })).toBe('provisional');
    expect(conversationTurnTrust({})).toBe('failed');
  });
});
