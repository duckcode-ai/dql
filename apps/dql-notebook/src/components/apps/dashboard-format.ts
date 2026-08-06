import type { QueryResult } from '../../store/types';
import { formatDisplayValue } from '../../utils/value-format';

/**
 * Value formatting and column heuristics shared by the dashboard renderer and
 * the presentation rules extracted from it.
 */
export type DashboardStory = {
  title: string;
  summary: string;
  sourceTitle: string;
  trust: string | null;
  filters: Array<{ label: string; value: string }>;
  chips: string[];
};

export function formatDashboardValue(
  column: string,
  value: unknown,
  values: unknown[] = [],
  options: { compact?: boolean; format?: string } = {},
): string {
  if (value === null || value === undefined || value === '') return 'N/A';
  const formatted = formatDisplayValue(column, value, values, options);
  if (!formatted) return 'N/A';
  return typeof value === 'string' && formatted === value ? formatted.replace(/_/g, ' ') : formatted;
}

export function formatGenUiLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isNumericColumn(column: string, rows: QueryResult['rows']): boolean {
  const sample = rows.slice(0, 8).map((row) => row[column]).filter((value) => value !== null && value !== undefined && value !== '');
  if (sample.length === 0) return false;
  return sample.every((value) => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function pickEvidenceLabelColumn(columns: string[], rows: QueryResult['rows'], hint?: string): string | undefined {
  if (columns.length === 0) return undefined;
  const normalizedHint = hint?.toLowerCase();
  if (normalizedHint) {
    const hinted = columns.find((column) => {
      const lower = column.toLowerCase();
      return lower === normalizedHint || lower.includes(normalizedHint) || normalizedHint.includes(lower);
    });
    if (hinted) return hinted;
  }
  return columns.find((column) => /\b(name|label|title|dataset|table|block|player|customer|account)\b/i.test(column))
    ?? columns.find((column) => !isNumericColumn(column, rows))
    ?? columns[0];
}

export function evidenceMetricRank(column: string): number {
  const lower = column.toLowerCase();
  if (/(total|count|records|rows|volume)/.test(lower)) return 1;
  if (/(rate|percent|pct|score|quality|freshness)/.test(lower)) return 2;
  if (/(amount|revenue|arr|value)/.test(lower)) return 3;
  if (/(date|time|season)/.test(lower)) return 6;
  if (/(^|_)id($|_)/.test(lower)) return 20;
  return 100;
}

export function resultValueSamples(columns: string[], rows: QueryResult['rows']): Map<string, unknown[]> {
  return new Map(columns.map((column) => [column, rows.slice(0, 32).map((row) => row[column])]));
}
