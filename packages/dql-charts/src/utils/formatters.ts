/**
 * Locale-aware number formatting utilities for enterprise charts.
 */

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat('en-US', options).format(value);
}

export function formatCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toFixed(value % 1 === 0 ? 0 : 1);
}

export function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatDate(date: Date | string, style: 'short' | 'medium' | 'long' = 'medium'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const options: Intl.DateTimeFormatOptions =
    style === 'short'
      ? { month: 'short', day: 'numeric' }
      : style === 'long'
        ? { year: 'numeric', month: 'long', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat('en-US', options).format(d);
}

export type FormatType = 'number' | 'compact' | 'currency' | 'percent' | 'date';

export function autoFormat(value: unknown, type?: FormatType): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    switch (type) {
      case 'compact': return formatCompact(value);
      case 'currency': return formatCurrency(value);
      case 'percent': return formatPercent(value);
      default: return formatNumber(value);
    }
  }
  return String(value);
}
