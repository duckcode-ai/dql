import { describe, it, expect } from 'vitest';
import { classifyConversationalTurn, decideAgentAction, looksLikeComposeApp, looksLikeFollowUp } from './intent-controller.js';

describe('decideAgentAction', () => {
  it('composes an app when asked to build a dashboard, regardless of match', () => {
    const d = decideAgentAction({
      question: 'build me a dashboard for revenue by region',
      intent: 'ad_hoc_ranking',
      signals: { certifiedScore: 0.9 },
    });
    expect(d.action).toBe('compose_app');
  });

  it('composes an app for a "monitor over time" ask', () => {
    expect(decideAgentAction({ question: 'I want to monitor orders over time', intent: 'ad_hoc_ranking' }).action).toBe('compose_app');
  });

  it('answers directly when a certified block or metric fits confidently', () => {
    const d = decideAgentAction({
      question: 'what is our total revenue',
      intent: 'exact_certified_lookup',
      signals: { metricScore: 0.8 },
    });
    expect(d.action).toBe('answer');
    expect(d.confidence).toBeGreaterThan(0.8);
  });

  it('does NOT over-investigate a lookup that has a strong governed match', () => {
    // "trend" reads investigative, but a confident metric should still answer.
    const d = decideAgentAction({
      question: 'revenue trend',
      intent: 'driver_breakdown',
      signals: { metricScore: 0.7 },
    });
    expect(d.action).toBe('answer');
  });

  it('investigates an open-ended "why" question', () => {
    const d = decideAgentAction({ question: 'why is revenue down this month?', intent: 'diagnose_change', signals: { hasRetrieval: true } });
    expect(d.action).toBe('investigate');
  });

  it('investigates a breakdown/compare even without a perfect intent label', () => {
    expect(decideAgentAction({ question: 'break down orders by region', intent: 'ad_hoc_ranking', signals: { metricScore: 0.2 } }).action).toBe('investigate');
  });

  it('clarifies when context is missing', () => {
    const d = decideAgentAction({
      question: 'show me the numbers',
      intent: 'clarify',
      signals: { missingContext: ['Need a clearer business object and measure.'] },
    });
    expect(d.action).toBe('clarify');
    expect(d.clarifyingQuestion).toContain('business object');
  });

  it('clarifies honestly when nothing governed matches and it is not analytical', () => {
    expect(decideAgentAction({ question: 'widgets', intent: 'ad_hoc_ranking', signals: { hasRetrieval: false } }).action).toBe('clarify');
  });

  it('always returns a human-facing reason', () => {
    for (const intent of ['exact_certified_lookup', 'clarify', 'driver_breakdown'] as const) {
      expect(decideAgentAction({ question: 'q', intent }).reason.length).toBeGreaterThan(10);
    }
  });
});

describe('classifyConversationalTurn', () => {
  it('classifies greetings', () => {
    for (const q of ['hi', 'hey', 'hello', 'hey!', 'good morning', 'hi there', 'yo']) {
      expect(classifyConversationalTurn(q)).toBe('greeting');
    }
  });

  it('classifies gratitude / acknowledgement', () => {
    for (const q of ['thanks', 'thank you', 'thanks!', 'got it', 'perfect', 'cheers', 'ok']) {
      expect(classifyConversationalTurn(q)).toBe('gratitude');
    }
  });

  it('classifies meta / capability questions', () => {
    for (const q of ['what can you do?', 'who are you', 'what is DQL', 'how do you work', 'how can you help']) {
      expect(classifyConversationalTurn(q)).toBe('meta_capability');
    }
  });

  it('does NOT claim a real data question, even with a polite opener', () => {
    expect(classifyConversationalTurn('hi, what is total revenue?')).toBeUndefined();
    expect(classifyConversationalTurn('thanks — now break it down by region')).toBeUndefined();
    expect(classifyConversationalTurn('show me top customers')).toBeUndefined();
    expect(classifyConversationalTurn('why is revenue down?')).toBeUndefined();
  });

  it('does NOT treat a long sentence starting with hi as a greeting', () => {
    expect(classifyConversationalTurn('hi can you compute the churn rate for enterprise accounts')).toBeUndefined();
  });
});

describe('decideAgentAction — conversational tier', () => {
  it('routes greetings/thanks/meta to converse before data routing', () => {
    expect(decideAgentAction({ question: 'hi', intent: 'clarify' }).action).toBe('converse');
    expect(decideAgentAction({ question: 'thanks!', intent: 'clarify' }).action).toBe('converse');
    const meta = decideAgentAction({ question: 'what can you do?', intent: 'clarify' });
    expect(meta.action).toBe('converse');
    expect(meta.category).toBe('capability');
  });

  it('carries the conversational kind and heuristic source', () => {
    const d = decideAgentAction({ question: 'hello', intent: 'clarify' });
    expect(d.conversationalKind).toBe('greeting');
    expect(d.source).toBe('heuristic');
  });

  it('still routes a data question with a polite opener through the data cascade', () => {
    const d = decideAgentAction({ question: 'hi, what is total revenue?', intent: 'exact_certified_lookup', signals: { metricScore: 0.8 } });
    expect(d.action).toBe('answer');
  });
});

describe('follow-up + compose-app detection', () => {
  it('detects build-an-app phrasing', () => {
    expect(looksLikeComposeApp('create a cockpit for sales')).toBe(true);
    expect(looksLikeComposeApp('what is revenue')).toBe(false);
  });

  it('detects deictic follow-ups only with history', () => {
    expect(looksLikeFollowUp('why?', true)).toBe(true);
    expect(looksLikeFollowUp('break that down by region', true)).toBe(true);
    expect(looksLikeFollowUp('why?', false)).toBe(false);
    expect(looksLikeFollowUp('what is total revenue', true)).toBe(false);
  });
});
