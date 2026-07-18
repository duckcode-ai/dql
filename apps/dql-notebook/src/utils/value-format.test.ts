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

  it('keeps dates readable while leaving exports free to use raw values', () => {
    expect(formatDisplayValue('ordered_at', '2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    expect(formatDisplayValue('event_time', '2026-01-01T14:30:00Z')).toBe('2026-01-01 14:30:00');
  });

  it('lets authored formatting override a neutral column name', () => {
    expect(formatDisplayValue('result', 42.5, [42.5], { format: 'currency' })).toBe('$42.50');
  });
});
