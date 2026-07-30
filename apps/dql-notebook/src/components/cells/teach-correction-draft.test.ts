import { describe, expect, it } from 'vitest';
import type { Cell } from '../../store/types';
import {
  buildTeachCorrectionDraft,
  parseTeachLessonLines,
  teachScopeHasRecallAnchor,
  teachScopeLabels,
} from './teach-correction-draft';

function cell(overrides: Partial<Cell> = {}): Cell {
  return {
    id: 'cell-1',
    type: 'sql',
    content: 'select sum(net_amount) from orders where status != \'refunded\'',
    status: 'success',
    dqlArtifact: {
      source: 'block "revenue" {}',
      metrics: ['revenue'],
    },
    ...overrides,
  };
}

describe('Teach DQL correction draft', () => {
  it('turns a SQL edit into editable guidance and a high-signal scope', () => {
    const draft = buildTeachCorrectionDraft(cell(), {
      question: 'Which region has the most revenue?',
      previousSql: 'select sum(gross_amount) from orders',
      correctedSql: 'select sum(net_amount) from orders where status != \'refunded\'',
      domain: 'commerce',
    });

    expect(draft).toMatchObject({
      title: 'Correct revenue logic',
      scope: { metric: 'revenue', domain: 'commerce' },
      filtersChanged: true,
    });
    expect(draft.guidance).toContain('net_amount');
    expect(draft.guidance).toContain('gross_amount');
    expect(draft.guidance).toContain('corrected filter conditions');
    expect(draft.lesson).toMatchObject({
      version: 1,
      category: 'filter_rule',
      rule: draft.guidance,
      intentExamples: ['Which region has the most revenue?'],
    });
    expect(teachScopeHasRecallAnchor(draft.scope)).toBe(true);
    expect(teachScopeLabels(draft.scope)).toEqual([
      'domain commerce',
      'metric revenue',
    ]);
  });

  it('does not treat dialect alone as a safe cross-question recall anchor', () => {
    expect(teachScopeHasRecallAnchor({ dialect: 'snowflake' })).toBe(false);
    expect(teachScopeHasRecallAnchor({ domain: '   ' })).toBe(false);
  });

  it('normalizes optional reusable examples and avoid rules entered one per line', () => {
    expect(parseTeachLessonLines('Revenue by region\n revenue by region \nTop markets\n')).toEqual([
      'Revenue by region',
      'Top markets',
    ]);
  });

  it('uses conservative guidance when the SQL change cannot be summarized safely', () => {
    const draft = buildTeachCorrectionDraft(cell({ dqlArtifact: undefined }), {
      question: 'Show the governed answer',
      previousSql: 'select amount from orders',
      correctedSql: 'select amount from orders',
    });

    expect(draft.guidance).toContain('follow the reviewed SQL pattern');
    expect(teachScopeHasRecallAnchor(draft.scope)).toBe(false);
  });
});
