import { describe, it, expect } from 'vitest';
import { decideAgentAction, looksLikeComposeApp, looksLikeFollowUp } from './intent-controller.js';

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
