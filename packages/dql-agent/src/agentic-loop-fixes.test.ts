import { describe, expect, it } from 'vitest';
import { classifyMetadataIntent } from './metadata/catalog.js';
import { extractUserQuestion } from './answer-loop.js';

describe('classifyMetadataIntent — ranking vs diagnose', () => {
  it('classifies a superlative ranking as ad_hoc_ranking, NOT diagnose_change', () => {
    expect(classifyMetadataIntent('give me the total revenue by product who performed most?')).toBe('ad_hoc_ranking');
    expect(classifyMetadataIntent('top 5 customers by revenue')).toBe('ad_hoc_ranking');
    expect(classifyMetadataIntent('which product had the highest revenue')).toBe('ad_hoc_ranking');
  });

  it('still classifies genuine change questions as diagnose_change', () => {
    expect(classifyMetadataIntent('why did revenue drop last month?')).toBe('diagnose_change');
    expect(classifyMetadataIntent('what changed in orders this quarter')).toBe('diagnose_change');
  });

  it('leaves driver/breakdown questions (incl. "top movers") as driver_breakdown', () => {
    // The ranking guard must NOT steal driver questions even when they contain "top".
    expect(classifyMetadataIntent('show me the top movers in revenue')).toBe('driver_breakdown');
    expect(classifyMetadataIntent('break down revenue by region')).toBe('driver_breakdown');
  });

  it('does not treat a ranking of a declining metric as a plain ranking when it asks why', () => {
    // Has both "most" and "why"/"declined": the change intent wins.
    expect(classifyMetadataIntent('why did our best product decline the most?')).toBe('diagnose_change');
  });
});

describe('extractUserQuestion — strips composed prompts', () => {
  it('pulls the user question out of a composed instruction prompt', () => {
    const composed = [
      'Create review-required SQL for a notebook SQL cell.',
      'Use trusted business logic, business views, terms, dbt manifest metadata before guessing.',
      'Do not generate INSERT, UPDATE, DELETE, CREATE, DROP statements.',
      '',
      'User question: give me the total revenue by product who performed most?',
    ].join('\n');
    expect(extractUserQuestion(composed)).toBe('give me the total revenue by product who performed most?');
  });

  it('handles "User request:" marker too', () => {
    expect(extractUserQuestion('Instruction line.\nUser request: top customers by spend')).toBe('top customers by spend');
  });

  it('returns a plain question unchanged (whitespace collapsed)', () => {
    expect(extractUserQuestion('  what is total   revenue?  ')).toBe('what is total revenue?');
  });

  it('bounds length so clarify text never dumps a wall of text', () => {
    const long = 'User question: ' + 'a'.repeat(500);
    const out = extractUserQuestion(long);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });
});
