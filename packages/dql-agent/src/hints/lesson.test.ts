import { describe, expect, it } from 'vitest';
import {
  deriveHintLesson,
  hintLessonSearchText,
  lessonForHint,
  normalizeHintLesson,
} from './lesson.js';

describe('governed hint lessons', () => {
  it('derives a reusable filter lesson from a reviewed SQL correction', () => {
    const lesson = deriveHintLesson({
      question: 'Which regions have recognized revenue?',
      wrongAnswer: 'SELECT region, SUM(gross_amount) FROM orders GROUP BY region',
      correctedSql: `
        SELECT region, SUM(net_amount)
        FROM orders
        WHERE is_refund = false
        GROUP BY region
      `,
      guidance: 'Exclude refunds and use net amount for recognized revenue.',
    });

    expect(lesson).toEqual({
      version: 1,
      category: 'filter_rule',
      rule: 'Exclude refunds and use net amount for recognized revenue.',
      intentExamples: ['Which regions have recognized revenue?'],
      avoid: [],
      expectedOutcome: undefined,
    });
  });

  it('normalizes reviewer-authored semantics without retaining duplicates or excess text', () => {
    const lesson = normalizeHintLesson({
      category: 'join_rule',
      rule: '  Join orders to customers through customer_id.  ',
      intentExamples: ['Customers by revenue', 'customers by revenue', 'Top customers'],
      avoid: ['Do not join on display name.', 'do not join on display name.'],
      expectedOutcome: ' One row per customer. ',
    }, {
      category: 'semantic_rule',
      rule: 'fallback',
      intentExamples: [],
    });

    expect(lesson).toMatchObject({
      category: 'join_rule',
      rule: 'Join orders to customers through customer_id.',
      intentExamples: ['Customers by revenue', 'Top customers'],
      avoid: ['Do not join on display name.'],
      expectedOutcome: 'One row per customer.',
    });
  });

  it('adapts legacy guidance into a searchable structured lesson without rewriting Git', () => {
    const lesson = lessonForHint({
      guidance: 'Use recognized revenue after refunds.',
    });
    expect(lesson).toMatchObject({
      version: 1,
      category: 'semantic_rule',
      rule: 'Use recognized revenue after refunds.',
      intentExamples: [],
    });
    expect(hintLessonSearchText({
      guidance: 'legacy',
      lesson: {
        version: 1,
        category: 'time_rule',
        rule: 'Use the fiscal reporting month.',
        intentExamples: ['Revenue last month'],
        avoid: ['Do not use calendar month.'],
        expectedOutcome: 'One row per fiscal month.',
      },
    })).toContain('Revenue last month');
  });
});
