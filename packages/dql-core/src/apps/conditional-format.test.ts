import { describe, expect, it } from 'vitest';
import { conditionalCell, conditionalStats, describeConditionalRule, readConditionalFormats } from './conditional-format.js';
import { readDashboardVizStyle } from './viz-style.js';

describe('conditional formatting', () => {
  it('reads formats and drops malformed ones with a reason', () => {
    const problems: string[] = [];
    const formats = readConditionalFormats([
      { column: 'revenue', kind: 'scale' },
      { column: 'margin_rate', kind: 'rules', rules: [{ op: 'gte', value: 0.5, tone: 'good' }, { op: 'between', value: 0.3, to: 0.5, tone: 'warning' }, { op: 'lt', value: 0.3, tone: 'bad' }] },
      { column: 'bad name', kind: 'bars' },
      { column: 'orders', kind: 'sparkle' },
      { column: 'orders', kind: 'rules', rules: [{ op: 'between', value: 5, to: 1, tone: 'good' }] },
    ], 'style.conditional', (message) => problems.push(message));
    expect(formats?.map((format) => format.column)).toEqual(['revenue', 'margin_rate']);
    expect(problems).toHaveLength(3);
    expect(readDashboardVizStyle({ conditional: [{ column: 'revenue', kind: 'bars' }] }, 'viz.style', () => undefined)).toEqual({ conditional: [{ column: 'revenue', kind: 'bars' }] });
  });

  it('marks the first rule that matches, with its tone', () => {
    const format = { column: 'rate', kind: 'rules' as const, rules: [{ op: 'gte' as const, value: 0.5, tone: 'good' as const }, { op: 'between' as const, value: 0.3, to: 0.5, tone: 'warning' as const }, { op: 'lt' as const, value: 0.3, tone: 'bad' as const }] };
    expect(conditionalCell(format, 0.52, undefined)?.tone).toBe('good');
    expect(conditionalCell(format, 0.5, undefined)?.tone).toBe('good');
    expect(conditionalCell(format, 0.4, undefined)?.tone).toBe('warning');
    expect(conditionalCell(format, '0.1', undefined)?.tone).toBe('bad');
    expect(conditionalCell(format, null, undefined)).toBeUndefined();
    expect(describeConditionalRule(format.rules[1]!)).toBe('between 0.3 and 0.5 · Watch');
  });

  it('draws a one-hue scale for one sign and two hues around zero', () => {
    const positive = conditionalStats([10, 20, 30, null, 'x']);
    expect(positive).toEqual({ min: 10, max: 30 });
    expect(conditionalCell({ column: 'v', kind: 'scale' }, 10, positive)?.background).toBe('color-mix(in srgb, var(--accent, #0b7a75) 6%, transparent)');
    expect(conditionalCell({ column: 'v', kind: 'scale' }, 30, positive)?.background).toBe('color-mix(in srgb, var(--accent, #0b7a75) 40%, transparent)');
    const mixed = conditionalStats([-10, 5, 20]);
    expect(conditionalCell({ column: 'v', kind: 'scale' }, -10, mixed)?.background).toContain('var(--status-warning');
    expect(conditionalCell({ column: 'v', kind: 'scale' }, 20, mixed)?.background).toContain('var(--trust-governed');
  });

  it('sizes data bars by magnitude and colours negatives apart', () => {
    const stats = conditionalStats([-50, 25, 100]);
    expect(conditionalCell({ column: 'v', kind: 'bars' }, 25, stats)?.bar).toEqual({ color: 'color-mix(in srgb, var(--accent, #0b7a75) 28%, transparent)', width: 25 });
    expect(conditionalCell({ column: 'v', kind: 'bars' }, -50, stats)?.bar?.width).toBe(50);
    expect(conditionalCell({ column: 'v', kind: 'bars' }, -50, stats)?.bar?.color).toContain('var(--status-warning');
  });
});
