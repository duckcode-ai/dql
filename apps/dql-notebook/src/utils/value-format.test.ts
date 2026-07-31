import { describe, expect, it } from 'vitest';
import { formatChartValue, formatDisplayValue, inferDisplayValueKind } from './value-format';

describe('semantic value formatting', () => {
  it('renders monetary measures consistently', () => {
    expect(inferDisplayValueKind('lifetime_spend', [3089.8])).toBe('currency');
    expect(formatDisplayValue('lifetime_spend', 3089.8)).toBe('$3,089.80');
    expect(formatChartValue('total_revenue', 2_800_000)).toBe('$2.8M');
  });

  it('distinguishes counts, general decimals, and percentages', () => {
    expect(formatDisplayValue('order_count', 231)).toBe('231');
    expect(formatDisplayValue('average_items', 2.3456)).toBe('2.35');
    expect(formatDisplayValue('conversion_rate_pct', 0.082)).toBe('8.2%');
    expect(formatDisplayValue('market_share', 8.2)).toBe('8.2%');
  });

  it('formats years, months, dates, and timestamps by their semantic role', () => {
    expect(formatDisplayValue('fiscal_year', 2006)).toBe('2006');
    expect(formatDisplayValue('fiscal_year', '2006')).toBe('2006');
    expect(formatDisplayValue('reporting_month', 1)).toBe('Jan');
    expect(formatDisplayValue('reporting_month', '2026-01')).toBe('Jan 2026');
    expect(formatDisplayValue('order_date', '2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDisplayValue('ordered_at', '2026-01-01T00:00:00.000Z')).toBe('Jan 1, 2026');
    expect(formatDisplayValue('event_time', '2026-01-01T14:30:00Z')).toBe('Jan 1, 2026, 2:30 PM');
  });

  it('lets authored formatting override a neutral column name', () => {
    expect(formatDisplayValue('result', 42.5, [42.5], { format: 'currency' })).toBe('$42.50');
  });
});
