import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { themes } from '../../themes/notebook-theme';
import { explainAskRun } from './ask-run-explanation';
import { AskRunChecks, AskRunDataUsed, AskRunFlow } from './AskRunFlow';

const receipt = (overrides: Record<string, unknown>) => ({ version: 1, candidates: [], refusals: [], story: [], tiers: [], dispatches: [], timings: {}, ...overrides });

const aiAnswer = receipt({
  reading: 'Lost opportunities to Splunk.',
  intent: { kind: 'analytics', reading: 'Lost opportunities to Splunk.' },
  tiers: [{ round: 97, tier: 'exploratory', outcome: 'prepared' }],
  refusals: [{ tier: 'exploratory', code: 'exploration_not_opted_in', message: 'x' }],
  dispatches: [
    { purpose: 'intent:resolve', ms: 12_000, label: 'read', promptChars: 18_400 },
    { purpose: 'intent:draft', ms: 5_000, label: 'draft', outcome: 'sql', reply: 'SELECT COUNT(*) FROM sales.opportunities', promptChars: 9_100 },
    { purpose: 'intent:draft', ms: 4_000, label: 'fix', outcome: 'sql', reply: "SELECT COUNT(*) FROM sales.opportunities WHERE competitor = 'Splunk'" },
  ],
  checks: [
    { id: 'stated_values', label: 'Applies every value the question states', passed: false, message: 'misses "Splunk"', attempt: 1 },
    { id: 'stated_values', label: 'Applies every value the question states', passed: true, message: 'applies Splunk', attempt: 2 },
  ],
  executed: { tier: 'exploratory', rowCount: 1, ms: 120, proofs: ["applied on the data: competitor = 'Splunk'"] },
  context: { used: { relations: ['sales.opportunities'], joins: [] } },
  timings: { total: 22_000, context: 500 },
});

describe('the "How it was answered" flow', () => {
  it('renders numbered steps with outcomes and reasons, the time split and a way into the full trace', () => {
    const explanation = explainAskRun({ receipt: aiAnswer, payload: { sql: "SELECT COUNT(*) FROM sales.opportunities WHERE competitor = 'Splunk'" }, status: 'completed' })!;
    const markup = renderToStaticMarkup(createElement(AskRunFlow, { explanation, t: themes.paper, onOpenTrace: () => undefined }));
    expect(markup).toContain('aria-label="How it was answered"');
    expect(markup).toContain('Answered from SQL written by AI from the tables (review before relying on it).');
    expect(markup).toContain('Worked for 23 s');
    for (const title of ['Read the question', 'AI wrote SQL', 'Checked before running', 'Ran on the warehouse', 'Answer']) expect(markup).toContain(title);
    expect(markup).toContain('All checks passed after 1 failed check was fixed.');
    expect(markup).toContain('Open full trace');
    expect(markup).not.toMatch(/exploration_|sha256:|intent:draft/);
  });

  it('opens a failed step by itself, showing its AI call', () => {
    const failed = explainAskRun({
      receipt: receipt({ dispatches: [{ purpose: 'intent:resolve', ms: 60_000, label: 'read', promptChars: 20_000 }], failure: { stage: 'resolve', message: 'the AI model took too long to read the question' } }),
      payload: { failedStage: 'resolve', executionError: 'timeout' },
      status: 'blocked',
    })!;
    const markup = renderToStaticMarkup(createElement(AskRunFlow, { explanation: failed, t: themes.paper }));
    expect(markup).toContain('AI calls');
    expect(markup).toContain('20k characters sent');
    expect(markup).not.toContain('Open full trace');
  });

  it('checks group by the draft they judged; data used lists tables and applied filters', () => {
    const explanation = explainAskRun({ receipt: aiAnswer, payload: {}, status: 'completed' })!;
    const checks = renderToStaticMarkup(createElement(AskRunChecks, { checks: explanation.checks, t: themes.paper }));
    expect(checks).toContain('Draft 1');
    expect(checks).toContain('Draft 2');
    expect(renderToStaticMarkup(createElement(AskRunChecks, { checks: [], t: themes.paper }))).toContain('No checks were recorded');
    const data = renderToStaticMarkup(createElement(AskRunDataUsed, { data: explanation.dataUsed, t: themes.paper }));
    expect(data).toContain('sales.opportunities');
    expect(data).toContain('Filters applied');
  });
});
